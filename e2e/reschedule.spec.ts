import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { watchConsole } from "./helpers";

test.use({ timezoneId: "Europe/Warsaw" });

for (const width of [1440, 390]) {
  test(`reschedule Queue and Content at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = watchConsole(page);
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let contentId = "";
    const ids: string[] = [];
    const year = new Date().getUTCFullYear() + 1;
    const endOfOctober = new Date(Date.UTC(year, 10, 0));
    const day = String(endOfOctober.getUTCDate() - endOfOctober.getUTCDay()).padStart(2, "0");
    const repeated = `${year}-10-${day}`;
    const payload = { format: "text", media: [], caption: "Schedule", options: { privacyLevel: "SELF_ONLY", consent: true } };
    try {
      const { rows: [ws] } = await client.query("select id from workspaces order by created_at limit 1");
      const { rows: [content] } = await client.query("insert into content(workspace_id,title) values($1,$2) returning id", [ws.id, `Reschedule ${width}`]);
      contentId = content.id;
      const { rows: channels } = await client.query("select id,platform from channels where workspace_id=$1 order by id limit 2", [ws.id]);
      for (const ch of channels) {
        const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at) values($1,$2,'text','scheduled',$3,now()+interval '1 hour',now()+interval '1 hour') returning id", [ws.id, ch.id, payload]);
        ids.push(d.id);
        await client.query("insert into posts(workspace_id,content_id,delivery_id,platform,status,scheduled_date) values($1,$2,$3,$4,'scheduled',now()+interval '1 hour')", [ws.id, contentId, d.id, ch.platform]);
        await client.query("select graphile_worker.add_job('publish',$1,job_key=>$2,run_at=>now()+interval '1 hour')", [JSON.stringify({ postId: d.id }), `publish:${d.id}`]);
      }
      await page.goto("/queue?status=scheduled");
      const row = page.locator(`#post-row-${ids[0]}`);
      await row.getByText("Zmień termin", { exact: true }).click();
      const timeBounds = await row.locator('td[data-label="Time"]').boundingBox();
      expect(timeBounds!.x).toBeGreaterThanOrEqual(0);
      expect(timeBounds!.x + timeBounds!.width).toBeLessThanOrEqual(width);
      const input = row.getByLabel("Nowy termin", { exact: true });
      await input.fill(`${repeated}T02:30`);
      await expect(row.getByRole("status")).toContainText("occurs twice");
      await expect(row.locator(".reschedule")).toContainText("Europe/Warsaw");
      const bounds = await row.locator(".reschedule form").boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`queue-form-${width}.png`), fullPage: true });
      await row.getByRole("button", { name: "Zapisz termin" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Europe/Warsaw");
      await dialog.getByRole("button", { name: "Zapisz termin" }).click();
      await expect.poll(async () => (await client.query("select scheduled_at at time zone 'UTC' as scheduled_at from deliveries where id=$1", [ids[0]])).rows[0].scheduled_at.toISOString()).toBe(`${repeated}T00:30:00.000Z`);
      await expect(row.locator("details")).not.toHaveAttribute("open");
      await page.screenshot({ path: testInfo.outputPath(`queue-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.goto(`/queue/${ids[0]}`);
      await expect(page.locator(".action-bar").getByText("Zmień termin", { exact: true })).toBeVisible();
      await page.goto(`/content/${contentId}`);
      const all = page.locator(".reschedule-all");
      await all.getByText("Zmień termin", { exact: true }).click();
      await all.getByLabel("Nowy termin", { exact: true }).fill(`${year}-11-02T12:00`);
      await all.getByRole("button", { name: "Zapisz termin" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Zapisz termin" }).click();
      await expect.poll(async () => (await client.query("select count(*)::int as n from deliveries where id=any($1::uuid[]) and scheduled_at=$2", [ids, `${year}-11-02T11:00:00Z`])).rows[0].n).toBe(2);
      await expect(all.locator("details")).not.toHaveAttribute("open");
      const { rows } = await client.query("select payload from deliveries where id=any($1::uuid[])", [ids]);
      for (const row of rows) expect(row.payload).toEqual(payload);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`content-${width}.png`), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      if (contentId) await client.query("delete from posts where content_id=$1", [contentId]);
      if (contentId) await client.query("delete from content where id=$1", [contentId]);
      for (const id of ids) {
        await client.query("select graphile_worker.remove_job($1)", [`publish:${id}`]);
        await client.query("delete from deliveries where id=$1", [id]);
      }
      await client.end();
    }
  });
}
