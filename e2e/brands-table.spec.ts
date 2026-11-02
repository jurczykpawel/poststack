import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

const PREFIX = "bmt-";
let db: Client;
let workspaceId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  workspaceId = (await db.query<{ workspace_id: string }>("SELECT workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1")).rows[0]!.workspace_id;
  await db.query(
    `INSERT INTO brands (workspace_id, key, name, accent, icon)
     SELECT $1, $2 || i, 'Brand ' || i, (ARRAY['#3457d5','#7c4ddb','#1f8a70'])[1 + i % 3], CASE WHEN i = 0 THEN '🚀' END
     FROM generate_series(0, 14) AS i`,
    [workspaceId, PREFIX],
  );
  // Brand 1 gets two YouTube channels (ambiguous slot); two more free ones are there to pick from.
  for (const [i, pid] of ["UC-bmt-1", "UC-bmt-2"].entries()) {
    await db.query(
      `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status, connection_mode, brand_key)
       VALUES ($1, 'youtube', $2, $3, 'x', 'w', 'active', 'manual_token', $4)`,
      [workspaceId, pid, `BMT YT ${i + 1}`, `${PREFIX}1`],
    );
  }
});

test.afterAll(async () => {
  await db.query("DELETE FROM channels WHERE workspace_id = $1 AND platform_id LIKE 'UC-bmt-%'", [workspaceId]);
  await db.query("DELETE FROM brands WHERE workspace_id = $1 AND key LIKE $2", [workspaceId, `${PREFIX}%`]);
  await db.end();
});

async function shoot(page: Page, base: string, prepare?: () => Promise<void>) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await prepare?.();
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

test("desktop: one table row per brand, slot save, edit panel, search", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/brands");
  const rows = page.locator(".bm-row[data-bn]");
  expect(await rows.count()).toBeGreaterThanOrEqual(15);
  await expect(page.locator(".bm-head")).toBeVisible();
  await expect(page.getByText("several channels match")).toContainText("Brand 1 · YouTube");
  await expect(page.locator(".brand-slot.is-amb")).toHaveCount(1); // Brand 1 YouTube slot only
  // the table fits the viewport: no horizontal page scroll
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // nothing is clipped at 1440: the table needs no inner scroll, the search box sits fully in view
  expect(await page.locator(".bm").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const search = (await page.getByLabel("Search brands").boundingBox())!;
  expect(search.x + search.width).toBeLessThanOrEqual(1440);
  expect(search.width).toBeGreaterThan(150);
  const last = (await page.locator(".bm-head .bm-th").last().boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(1440);
  await shoot(page, testInfo.outputPath("brands-desktop"));

  // searching narrows the rows
  await page.getByLabel("Search brands").fill("brand 12");
  await expect(page.locator(".bm-row[data-bn]:visible")).toHaveCount(1);
  await page.getByLabel("Search brands").fill("");

  // slot save keeps working: pick the YouTube channel for Brand 2 via the same PUT endpoint
  const slot = page.locator(`#slot-${PREFIX}2-youtube`);
  await slot.locator("button.ps-trigger").click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/brands/${PREFIX}2/slot/youtube`)),
    slot.getByRole("option", { name: "BMT YT 1" }).click(),
  ]);
  const owner = (await db.query("SELECT brand_key FROM channels WHERE platform_id = 'UC-bmt-1'")).rows[0].brand_key;
  expect(owner).toBe(`${PREFIX}2`);
  await expect(page.locator(`#brand-count-${PREFIX}2`)).toHaveText("1 channel");

  // edit panel: rename, save, row shows the new name
  const row = page.locator(`#brand-${PREFIX}3`);
  const dlg = row.locator("dialog");
  await shoot(page, testInfo.outputPath("brands-edit"), async () => {
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(dlg).toBeVisible();
    // the form card fills the panel: no empty strip on the right
    const [panel, form] = await Promise.all([dlg.locator(".sheet-b").boundingBox(), dlg.locator("form.brand-edit-form").boundingBox()]);
    expect(panel!.x + panel!.width - (form!.x + form!.width)).toBeLessThanOrEqual(40);
  });
  await dlg.locator("input[name='name']").fill("Renamed three");
  await Promise.all([page.waitForURL((u) => u.pathname === "/brands"), dlg.getByRole("button", { name: "Save changes" }).click()]);
  await expect(page.locator(`#brand-${PREFIX}3 strong`)).toHaveText("Renamed three");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("phone: collapsed cards, expand to the same selects, no horizontal scroll", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/brands");
  await expect(page.locator(".bm-head")).toBeHidden();
  const card = page.locator(`#brand-${PREFIX}1`);
  await expect(card.locator(".bm-cells")).toBeHidden();
  await card.getByRole("button", { name: /Show channels/ }).click();
  await expect(card.locator(".brand-slot select")).toHaveCount(7);
  await expect(card.locator(".brand-slot button.ps-trigger").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await card.locator(".brand-slot button.ps-trigger").first().boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await shoot(page, testInfo.outputPath("brands-phone"));
  expect(errors, errors.join("\n")).toEqual([]);
});
