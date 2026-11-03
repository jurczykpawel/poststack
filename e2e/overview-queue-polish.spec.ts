import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, gotoOk } from "./helpers";

// MQA14-B01: Overview "Needs attention" shows the real count (not the 8-row list cap).
// MQA14-B02: the row "More actions" menu on a short Queue list is not clipped by the table.
test("overview attention count is the real total; short-list row menu is fully clickable", async ({ page }) => {
  await setPro(page.request);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  const ids: string[] = [];
  try {
    const { rows: [ws] } = await client.query("select id from workspaces order by created_at limit 1");
    const { rows: [ch] } = await client.query("select id from channels where workspace_id=$1 and platform='facebook' limit 1", [ws.id]);
    const before = Number((await client.query("select count(*) n from deliveries where workspace_id=$1 and status in ('failed','unknown')", [ws.id])).rows[0].n);
    for (let i = 0; i < 10; i++) {
      const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at,last_error) values($1,$2,'text','failed',$3,now()-interval '1 hour',now()-interval '1 hour','boom') returning id", [ws.id, ch.id, { format: "text", media: [], caption: `Polish ${i}` }]);
      ids.push(d.id);
    }
    await gotoOk(page, "/overview");
    await expect(page.locator(".panel-head", { hasText: "Needs attention" }).locator(".panel-count")).toHaveText(String(before + 10));
    for (const id of ids) await client.query("delete from deliveries where id=$1", [id]);
    ids.length = 0;

    // Short Scheduled list (3 rows): the first row's menu must be fully inside a clickable area.
    for (let i = 0; i < 3; i++) {
      const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at) values($1,$2,'text','scheduled',$3,now()+interval '40 days',now()+interval '40 days') returning id", [ws.id, ch.id, { format: "text", media: [], caption: `Sched ${i}` }]);
      ids.push(d.id);
    }
    // Desktop: filtered table view (the clipped one). Phone: default sections list (table cells are hidden there).
    for (const size of [{ width: 1280, height: 800, path: "/queue?status=scheduled" }, { width: 390, height: 800, path: "/queue" }]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await gotoOk(page, size.path);
      const row = page.locator(`[data-row="${ids[0]}"]`);
      await row.getByRole("button", { name: "More actions" }).or(row.locator("summary[aria-label='More actions']")).first().click();
      const cancel = row.getByRole("button", { name: "Cancel post", exact: true });
      await expect(cancel).toBeVisible();
      const hit = await cancel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      });
      expect(hit, `Cancel post clickable at ${size.width}px`).toBe(true);
    }
  } finally {
    for (const id of ids) await client.query("delete from deliveries where id=$1", [id]);
    await client.end();
  }
});
