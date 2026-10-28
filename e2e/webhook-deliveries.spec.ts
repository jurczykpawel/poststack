import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, watchConsole, gotoOk } from "./helpers";
import recorded from "../tests/fixtures/mqa-delivery-approval.json";

test("outgoing endpoints show delivery outcomes at desktop and phone widths", async ({ page }, testInfo) => {
  await setPro(page.request);
  const response = await page.request.post("/api/v1/webhooks", { data: { url: "https://hooks.example.test/delivery-history" } });
  expect(response.status()).toBe(201);
  const { data: endpoint } = await response.json();
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows: endpoints } = await client.query<{ workspace_id: string }>("SELECT workspace_id FROM webhook_endpoints WHERE id = $1", [endpoint.id]);
    const { rows: events } = await client.query<{ id: string }>("INSERT INTO events (workspace_id, type, payload) VALUES ($1, $2, $3) RETURNING id", [endpoints[0].workspace_id, recorded.event.type, recorded.event.data]);
    await client.query(`INSERT INTO webhook_deliveries (workspace_id, endpoint_id, event_id, status, attempts, http_status, last_error)
      VALUES ($1, $2, $3, 'failed', 8, 500, 'HTTP 500')`, [endpoints[0].workspace_id, endpoint.id, events[0].id]);
    const { errors } = watchConsole(page);
    await gotoOk(page, "/webhooks#outgoing");
    await page.getByRole("button", { name: "Outgoing alert", exact: true }).click();
    const panel = page.locator(`[data-webhook-deliveries="${endpoint.id}"]`);
    await panel.getByText("Recent deliveries", { exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(panel.getByText(recorded.event.type, { exact: true })).toBeVisible();
      await expect(panel.getByText("HTTP 500", { exact: true })).toBeVisible();
      await expect(panel.getByText("failed", { exact: true })).toBeVisible();
      await expect(panel.getByText("8", { exact: true })).toBeVisible();
      await expect(panel.getByText(events[0].id, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`webhook-deliveries-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await client.query("UPDATE webhook_deliveries SET status = 'delivered', http_status = 204, last_error = null WHERE endpoint_id = $1", [endpoint.id]);
    await panel.getByRole("button", { name: "Refresh deliveries" }).click();
    await expect(panel.getByText("delivered", { exact: true })).toBeVisible();
    await expect(panel.getByText("204", { exact: true })).toBeVisible();
    await expect(panel.getByText("HTTP 500", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    expect((await page.request.delete(`/api/v1/webhooks/${endpoint.id}`)).status()).toBe(204);
    await client.end();
  }
});
