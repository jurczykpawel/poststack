import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { watchConsole } from "./helpers";

test.use({ timezoneId: "Europe/Warsaw", channel: process.env.E2E_BROWSER_CHANNEL });

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

const scheduleYear = new Date().getUTCFullYear() + 1;
for (const scenario of [
  { zone: "America/New_York", local: `${scheduleYear}-12-22T10:30`, iso: `${scheduleYear}-12-22T15:30:00.000Z`, text: `22 Dec ${scheduleYear}, 10:30` },
  { zone: "Asia/Kolkata", local: `${scheduleYear}-01-23T00:15`, iso: `${scheduleYear}-01-22T18:45:00.000Z`, text: `23 Jan ${scheduleYear}, 00:15` },
]) {
  test.describe(`schedule display in ${scenario.zone}`, () => {
    test.use({ timezoneId: scenario.zone, viewport: { width: scenario.zone === "Asia/Kolkata" ? 390 : 1440, height: 900 } });
    test("keyboard reschedule preserves local date and timezone across Queue and Content", async ({ page, browser }, testInfo) => {
      const client = new Client({ connectionString: E2E_DATABASE_URL });
      await client.connect();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      let contentId = "";
      let deliveryId = "";
      let workspaceId = "";
      try {
        const { rows: [ws] } = await client.query("select id from workspaces order by created_at limit 1");
        workspaceId = ws.id;
        const { rows: [ch] } = await client.query("select id from channels where workspace_id=$1 and platform='facebook' limit 1", [ws.id]);
        const { rows: [content] } = await client.query("insert into content(workspace_id,title) values($1,$2) returning id", [ws.id, `Timezone ${scenario.zone}`]);
        contentId = content.id;
        const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at) values($1,$2,'text','scheduled',$3,now()+interval '1 hour',now()+interval '1 hour') returning id", [ws.id, ch.id, { format: "text", media: [], caption: "Local schedule" }]);
        deliveryId = d.id;
        const { rows: [post] } = await client.query("insert into posts(workspace_id,content_id,delivery_id,platform,status,scheduled_date) values($1,$2,$3,'facebook','scheduled',now()+interval '1 hour') returning id", [ws.id, contentId, deliveryId]);
        await page.goto(`/content/${contentId}`);
        const card = page.locator(`#post-card-${post.id}`);
        await card.getByText("Zmień termin", { exact: true }).click();
        await card.getByLabel("Nowy termin", { exact: true }).fill(scenario.local);
        const save = card.getByRole("button", { name: "Zapisz termin" });
        await save.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await save.focus();
        await page.keyboard.press("Enter");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await client.query("select scheduled_at at time zone 'UTC' as scheduled_at from deliveries where workspace_id=$1 and id=$2", [workspaceId, deliveryId])).rows[0].scheduled_at.toISOString()).toBe(scenario.iso);
        await expect(card.locator("details")).not.toHaveAttribute("open");
        await expect(page.locator(".toasts")).toHaveText("Termin zmieniony.");
        // Navigate immediately after the fragment save, as in the keyboard workflow.
        await card.getByRole("link", { name: "view delivery →" }).click();
        await expect(page).toHaveURL(new RegExp(`/queue/${deliveryId}$`));
        const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
        const times = page.locator(`time[datetime="${scenario.iso}"]`);
        await expect(times.first()).toHaveText(`${scenario.text} · ${zone}`);
        await expect(times).toHaveCount(2);
        await page.screenshot({ path: testInfo.outputPath("delivery-local.png"), fullPage: true, animations: "disabled" });
        await page.goto("/queue?status=scheduled");
        const row = page.locator(`#post-row-${deliveryId}`);
        await expect(row.locator("time")).toHaveText(`${scenario.text} · ${zone}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await row.getByText("Zmień termin", { exact: true }).click();
        await row.getByLabel("Nowy termin", { exact: true }).fill(scenario.local);
        await row.getByRole("button", { name: "Zapisz termin" }).click();
        await dialog.getByRole("button", { name: "Zapisz termin" }).click();
        await expect(row.locator("details")).not.toHaveAttribute("open");
        await expect(page.locator(".toasts")).toHaveText("Termin zmieniony.");
        await expect(row.locator("time")).toHaveText(`${scenario.text} · ${zone}`);
        await page.screenshot({ path: testInfo.outputPath("queue-local.png"), fullPage: true, animations: "disabled" });
        await page.goto(`/content/${contentId}`);
        await expect(card.locator("time")).toHaveText(`${scenario.text} · ${zone}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("content-local.png"), fullPage: true, animations: "disabled" });
        const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
        try {
          const fallback = await noJs.newPage();
          await fallback.goto(page.url());
          await expect(fallback.locator(`time[datetime="${scenario.iso}"]`)).toContainText("UTC");
        } finally { await noJs.close(); }
        expect(errors).toEqual([]);
      } finally {
        if (contentId) {
          await client.query("delete from posts where workspace_id=$1 and content_id=$2", [workspaceId, contentId]);
          await client.query("delete from content where workspace_id=$1 and id=$2", [workspaceId, contentId]);
        }
        if (deliveryId) {
          await client.query("select graphile_worker.remove_job($1)", [`publish:${deliveryId}`]);
          await client.query("delete from deliveries where workspace_id=$1 and id=$2", [workspaceId, deliveryId]);
        }
        await client.end();
      }
    });
  });
}
