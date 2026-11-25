import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, watchConsole, gotoOk } from "./helpers";
import recorded from "../tests/fixtures/mqa-delivery-approval.json";

test("keeps entered endpoint fields while showing the validation error next to its field", async ({ page }) => {
  await setPro(page.request);
  await gotoOk(page, "/webhooks#outgoing");
  await page.getByRole("button", { name: "Outgoing", exact: true }).click();
  await page.getByText("Add an endpoint", { exact: true }).click();
  const form = page.locator('#wh-outbound form[hx-post="/webhooks/outbound"]');
  const url = form.getByLabel("Endpoint URL");
  const event = form.getByRole("checkbox", { name: "contact.updated", exact: true });
  const headers = form.getByLabel("Custom headers");
  const extra = form.getByLabel("Extra payload fields");
  const submit = form.getByRole("button", { name: "Add endpoint", exact: true });
  await url.fill("https://hooks.example.test/retain-draft");
  await event.check();
  await headers.fill("Host: hooks.example.test");
  await extra.fill("{bad json");
  const invalid = () => page.waitForResponse((r) => r.url().endsWith("/webhooks/outbound") && r.request().method() === "POST");
  const invalidExtra = invalid();
  await submit.click();
  expect((await invalidExtra).status()).toBe(422);
  await expect(extra).toHaveAccessibleDescription(/Extra payload fields must be valid JSON/);
  await expect(extra).toHaveAttribute("aria-invalid", "true");
  await expect(extra).toBeFocused();
  await expect(url).toHaveValue("https://hooks.example.test/retain-draft");
  await expect(event).toBeChecked();
  await expect(headers).toHaveValue("Host: hooks.example.test");
  await expect(extra).toHaveValue("{bad json");

  await extra.fill('{"source":"browser"}');
  const invalidHeaders = invalid();
  await submit.click();
  expect((await invalidHeaders).status()).toBe(422);
  await expect(headers).toHaveAccessibleDescription(/managed by the transport/);
  await expect(extra).not.toHaveAttribute("aria-invalid", "true");
  await headers.fill("X-Source: browser");
  const valid = invalid();
  await submit.click();
  expect((await valid).status()).toBe(200);
  await expect(page.locator(".wh-just-created")).toContainText("https://hooks.example.test/retain-draft");
  const { data: endpoints } = await (await page.request.get("/api/v1/webhooks")).json();
  const endpoint = endpoints.find((e: { url: string }) => e.url.endsWith("/retain-draft"));
  expect(endpoint.event_types).toEqual(["contact.updated"]);
  const card = page.locator(".wh-just-created");
  await card.getByText("Edit URL, events & headers", { exact: true }).click();
  const edit = card.locator("form");
  const editUrl = edit.getByLabel("Endpoint URL");
  const editExtra = edit.getByLabel("Extra payload fields");
  await editUrl.fill("https://hooks.example.test/edit-draft");
  await editExtra.fill("{still invalid");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(editExtra).toHaveAccessibleDescription(/Extra payload fields must be valid JSON/);
  await expect(editExtra).toBeFocused();
  await expect(editUrl).toHaveValue("https://hooks.example.test/edit-draft");
  await expect(editExtra).toHaveValue("{still invalid");
  expect((await page.request.delete(`/api/v1/webhooks/${endpoint.id}`)).status()).toBe(204);
});

test("refreshes a stale endpoint card and explains the 404", async ({ page }) => {
  await setPro(page.request);
  const response = await page.request.post("/api/v1/webhooks", { data: { url: "https://hooks.example.test/stale-card" } });
  expect(response.status()).toBe(201);
  const { data: endpoint } = await response.json();
  await gotoOk(page, "/webhooks#outgoing");
  await page.getByRole("button", { name: "Outgoing", exact: true }).click();
  const card = page.locator("#wh-outbound .card").filter({ hasText: endpoint.url });
  await card.getByRole("button", { name: "Rotate secret" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect.soft(confirm).toContainText("The previous secret keeps signing for 24 hours.", { timeout: 1000 });
  expect((await page.request.delete(`/api/v1/webhooks/${endpoint.id}`)).status()).toBe(204);
  const rejected = page.waitForResponse((r) => r.url().endsWith(`/webhooks/outbound/${endpoint.id}/rotate`));
  await confirm.getByRole("button", { name: "Rotate", exact: true }).click();
  expect((await rejected).status()).toBe(404);
  await expect(page.locator("#wh-outbound")).toContainText("This webhook endpoint no longer exists.");
  await expect(card).toHaveCount(0);
  await expect(page.getByText(/Not saved — server error/)).toHaveCount(0);
});

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
    await page.getByRole("button", { name: "Outgoing", exact: true }).click();
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
