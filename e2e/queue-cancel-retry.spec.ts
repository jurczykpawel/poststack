import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, watchConsole, gotoOk } from "./helpers";

// MQA13-B09 / B06 / B10: failed posts can be canceled (panel + attention list), Retry and Disable ask first.
test("failed post: Cancel from panel and list, Retry and Disable confirm", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  const ids: string[] = [];
  let endpointId = "";
  const status = async (id: string) => (await client.query("select status from deliveries where id=$1", [id])).rows[0].status;
  try {
    const { rows: [ws] } = await client.query("select id from workspaces order by created_at limit 1");
    const { rows: [ch] } = await client.query("select id from channels where workspace_id=$1 and platform='facebook' limit 1", [ws.id]);
    for (const caption of ["Failed one", "Failed two", "Failed three"]) {
      const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at,last_error) values($1,$2,'text','failed',$3,now()-interval '1 hour',now()-interval '1 hour','Graph API error 190') returning id", [ws.id, ch.id, { format: "text", media: [], caption }]);
      ids.push(d.id);
    }
    const rows = () => page.locator("[data-row]");

    // Retry asks first: dismiss keeps it failed.
    await gotoOk(page, `/queue?open=${ids[0]}`);
    await page.waitForFunction(() => "htmx" in window && !!(window as unknown as { Alpine?: { store(n: string): unknown } }).Alpine?.store("ui")); // confirm needs htmx + Alpine booted
    await page.locator(".dl-detail").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toBeHidden();
    expect(await status(ids[0])).toBe("failed");

    // Screenshots of the failed post panel, both themes.
    for (const theme of ["dark", "light"]) {
      await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
      await page.goto(`/queue?open=${ids[0]}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".dl-detail").getByRole("button", { name: "Cancel post", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`queue-failed-panel-${theme}.png`), animations: "disabled" });
    }
    await page.context().clearCookies({ name: "ps_theme" });

    // Cancel from the panel.
    await page.locator(".dl-detail").getByRole("button", { name: "Cancel post", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel post", exact: true }).click();
    await expect.poll(() => status(ids[0])).toBe("canceled");

    // Cancel from the attention list: the list shrinks.
    await gotoOk(page, "/queue?status=attention");
    await expect(page.locator(`[data-row="${ids[1]}"]`)).toBeVisible();
    const before = await rows().count();
    expect(before).toBeGreaterThanOrEqual(2);
    await page.locator(`[data-row="${ids[1]}"]`).getByRole("button", { name: "Cancel post", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel post", exact: true }).click();
    await expect.poll(() => status(ids[1])).toBe("canceled");
    await expect(rows()).toHaveCount(before - 1);
    await expect(page.locator(`[data-row="${ids[1]}"]`)).toHaveCount(0);

    // Retry from the list also asks.
    await page.locator(`[data-row="${ids[2]}"]`).getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await status(ids[2])).toBe("failed");

    // Disable endpoint asks first.
    const res = await page.request.post("/api/v1/webhooks", { data: { url: "https://hooks.example.test/disable-confirm" } });
    expect(res.status()).toBe(201);
    endpointId = (await res.json()).data.id;
    await gotoOk(page, "/webhooks#outgoing");
    await page.getByRole("button", { name: "Outgoing", exact: true }).click();
    await page.locator(`[hx-post="/webhooks/outbound/${endpointId}/toggle"]`).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await client.query("select active from webhook_endpoints where id=$1", [endpointId])).rows[0].active).toBe(true);
    await page.locator(`[hx-post="/webhooks/outbound/${endpointId}/toggle"]`).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disable", exact: true }).click();
    await expect.poll(async () => (await client.query("select active from webhook_endpoints where id=$1", [endpointId])).rows[0].active).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    for (const id of ids) await client.query("delete from deliveries where id=$1", [id]);
    if (endpointId) await client.query("delete from webhook_endpoints where id=$1", [endpointId]);
    await client.end();
  }
});
