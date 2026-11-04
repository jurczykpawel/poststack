import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

// G42: menu scroll on a short window, forms that keep their data on a validation error, Sent cards → list.
let db: Client;
let workspaceId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const ch = (await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1")).rows[0]!;
  workspaceId = ch.workspace_id;
  channelId = ch.id;
  await db.query("INSERT INTO brands (workspace_id, key, name) VALUES ($1, 'g42-dup', 'G42 dup') ON CONFLICT DO NOTHING", [workspaceId]);
  await db.query(
    `INSERT INTO auto_reply_rules (workspace_id, channel_id, name, trigger_type, trigger_config, response_type, response_config)
     VALUES ($1, $2, 'G42 rule', 'keyword', '{"keywords":[{"value":"hi","match_type":"exact"}]}', 'text', '{"text":"Reply"}')`,
    [workspaceId, channelId],
  );
  for (const k of ["a", "b", "c"]) {
    await db.query(
      `INSERT INTO outbound_deliveries (delivery_key, workspace_id, channel_id, task_name, status, payload, created_at)
       VALUES ($1, $2, $3, 'outgoing-message', 'sent', '{}', $4) ON CONFLICT DO NOTHING`,
      [`g42-e2e-${k}`, workspaceId, channelId, k === "c" ? new Date(Date.now() - 3 * 86_400_000) : new Date()],
    );
  }
});

test.afterAll(async () => {
  await db.query("DELETE FROM auto_reply_rules WHERE workspace_id = $1 AND name = 'G42 rule'", [workspaceId]);
  await db.query("DELETE FROM brands WHERE workspace_id = $1 AND key IN ('g42-dup', 'g42-new')", [workspaceId]);
  await db.query("DELETE FROM outbound_deliveries WHERE delivery_key LIKE 'g42-e2e-%'");
  await db.end();
});

async function shoot(page: Page, base: string) {
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
}

test("B02: on a 1280x600 window the whole menu is reachable (Settings clickable after scrolling the menu)", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 1280, height: 600 });
  await gotoOk(page, "/overview");
  const side = page.locator(".sidebar");
  expect(await side.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  expect(await side.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true); // 600 px really is too short
  const settings = side.getByRole("link", { name: "Settings" });
  await settings.scrollIntoViewIfNeeded();
  expect(await settings.evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom <= window.innerHeight && el === document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("a"); })).toBe(true);
  await shoot(page, testInfo.outputPath("menu-1280x600"));
  await settings.click();
  await expect(page).toHaveURL(/\/settings/);
});

test("B07: Add brand keeps the sheet open and the typed data on an error, message next to the field", async ({ page }, testInfo) => {
  await setPro(page.request);
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 800, "390"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await gotoOk(page, "/brands");
    await page.getByRole("button", { name: "Add brand" }).click();
    const dlg = page.locator("dialog[aria-label='New brand']");
    const key = dlg.locator("input[name=key]");
    await key.fill("bad key'/x");
    expect(await key.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true); // browser stops it before the server
    await key.fill("g42-dup"); // valid shape, taken → server 409
    await dlg.locator("input[name=name]").fill("Typed name");
    await dlg.getByRole("button", { name: "Create brand" }).click();
    await expect(dlg.locator("#brand-new-err .notice-err")).toBeVisible();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("input[name=name]")).toHaveValue("Typed name");
    await expect(key).toHaveValue("g42-dup");
    await shoot(page, testInfo.outputPath(`brand-error-${tag}`));
  }
});

test("B08: Edit rule with an invalid value stays open, keeps the data and names the field", async ({ page }, testInfo) => {
  await setPro(page.request);
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 800, "390"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await gotoOk(page, "/rules");
    await page.locator("tr", { hasText: "G42 rule" }).getByRole("button", { name: "Edit" }).click();
    const form = page.locator("form[hx-post^='/rules/']");
    await form.locator("input[name=keywords]").fill("a".repeat(600));
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form.locator("[id^=rule-err-] .notice-err")).toContainText(/keyword|trigger/i);
    await expect(form.locator("input[name=name]")).toHaveValue("G42 rule");
    await expect(form.locator("input[name=keywords]")).toHaveValue("a".repeat(600));
    await shoot(page, testInfo.outputPath(`rule-error-${tag}`));
  }
});

test("B09: a rejected fallback URL shows its reason in place and keeps the field", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/webhooks#outgoing");
  const area = page.locator("[data-alert-fallback]");
  await area.scrollIntoViewIfNeeded();
  await area.locator("input[name=value]").fill("http://127.0.0.1:8080/x");
  await area.getByRole("button", { name: "Save fallback" }).click();
  await expect(area.locator("[data-alert-fallback-msg]")).toContainText("rejected");
  await expect(area.locator("input[name=value]")).toHaveValue("http://127.0.0.1:8080/x");
  await shoot(page, testInfo.outputPath("fallback-error"));
});

test("OVSENT1: Sent cards open the list and the number of rows equals the number on the card", async ({ page }, testInfo) => {
  await setPro(page.request);
  for (const [w, h, tag] of [[1440, 900, "1440"], [390, 800, "390"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [label, query] of [["Sent today (UTC)", "range=today"], ["Sent (all time)", ""]] as const) {
      await gotoOk(page, "/overview");
      const card = page.locator("a.kpi", { hasText: label });
      const n = (await card.locator(".kpi-n").innerText()).trim();
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/activity\\?source=sent${query ? `&${query}` : ""}$`));
      await expect(page.locator("#data-list")).toContainText(new RegExp(`of ${n}\\b`));
      await shoot(page, testInfo.outputPath(`sent-${query ? "today" : "all"}-${tag}`));
    }
  }
});
