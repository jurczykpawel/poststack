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
  const headers = await page.locator(".bm-head .bm-th").all();
  const top = (await headers[0].boundingBox())!.y;
  for (const header of headers) expect((await header.boundingBox())!.y).toBeCloseTo(top, 0);
  const slots = await rows.first().locator(".brand-slot").all();
  for (const [i, slot] of slots.entries()) {
    const cell = (await slot.boundingBox())!;
    const heading = (await headers[i + 1].boundingBox())!;
    expect(cell.x).toBeCloseTo(heading.x, 0);
    expect(cell.width).toBeCloseTo(heading.width, 0);
  }
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
    // Finish the lazy preview before the next theme reload tears down this document.
    await expect.poll(() => dlg.getByRole("img", { name: "Auto-Story preview" })
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
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
  await expect(card.locator(".brand-slot select")).toHaveCount(8);
  await expect(card.locator(".brand-slot button.ps-trigger").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await card.locator(".brand-slot button.ps-trigger").first().boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await shoot(page, testInfo.outputPath("brands-phone"), async () => {
    await card.getByRole("button", { name: /Show channels/ }).click();
    await expect(card.locator(".brand-slot button.ps-trigger")).toHaveCount(8);
    await expect(card.locator(".brand-slot button.ps-trigger").last()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  expect(errors, errors.join("\n")).toEqual([]);
});

// MQA13-B01/B03 + empty search: a legacy brand with an unsafe key must not run script, Delete brand is
// confirmable from inside the Edit panel, and a search with no match says so.
test("MQA13: legacy unsafe key stays inert, Delete confirm sits over the panel, empty search message", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  const evil = `${PREFIX}x'+(window.__p=1)+'`;
  await db.query("INSERT INTO brands (workspace_id, key, name) VALUES ($1, $2, 'Legacy probe') ON CONFLICT DO NOTHING", [workspaceId, evil]);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/brands");
  const legacy = page.locator(".bm-row[data-bn*='legacy probe']");
  await legacy.getByRole("button", { name: "Edit" }).click();
  await expect(legacy.locator("dialog img")).toHaveAttribute("src", /story-preview/);
  expect(await page.evaluate(() => (window as unknown as { __p?: number }).__p)).toBeUndefined();
  await legacy.locator("dialog").getByRole("button", { name: "Close" }).click();

  await page.getByLabel("Search brands").fill("no such brand zzz");
  await expect(page.getByText("No brands match")).toBeVisible();
  await page.getByLabel("Search brands").fill("");
  await expect(page.getByText("No brands match")).toBeHidden();

  const row = page.locator(`#brand-${PREFIX}14`);
  const dlg = row.locator("dialog");
  await row.getByRole("button", { name: "Edit" }).click();
  const preview = dlg.locator('img[src*="/story-preview"]');
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await dlg.locator("summary", { hasText: "Danger zone" }).click();
  await dlg.getByRole("button", { name: "Delete brand" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  const btn = confirm.getByRole("button", { name: "Confirm" });
  const hit = await btn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(hit).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("brands-delete-confirm.png") });
  await Promise.all([page.waitForURL((u) => u.pathname === "/brands"), btn.click()]);
  await expect(page.locator(`#brand-${PREFIX}14`)).toHaveCount(0);
  expect((await db.query("SELECT 1 FROM brands WHERE workspace_id = $1 AND key = $2", [workspaceId, `${PREFIX}14`])).rowCount).toBe(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const mode of ["create", "edit"] as const) {
  test(`brand ${mode}: one pending request, then validation permits retry`, async ({ page }) => {
    await setPro(page.request);
    await gotoOk(page, "/brands");
    const dialog = mode === "create" ? page.getByRole("dialog", { name: "New brand" }) : page.locator(`#brand-${PREFIX}3 dialog`);
    await (mode === "create" ? page.getByRole("button", { name: "Add brand" }) : page.locator(`#brand-${PREFIX}3`).getByRole("button", { name: "Edit", exact: true })).click();
    if (mode === "create") await dialog.locator('[name="key"]').fill(`${PREFIX}pending`);
    await dialog.locator('[name="name"]').fill("Pending brand");
    const save = dialog.getByRole("button", { name: mode === "create" ? "Create brand" : "Save changes" });
    const path = mode === "create" ? "/brands" : `/brands/${PREFIX}3/edit`;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests++;
      await pending;
      await route.fulfill({ status: 422, contentType: "text/html", body: '<div class="notice notice-err" role="alert">Please check the name.</div>' });
    });
    try {
      await save.click();
      await expect.poll(() => requests).toBe(1);
      await expect(save).toBeDisabled();
      await save.evaluate((el: HTMLButtonElement) => el.click());
      await dialog.locator('[name="name"]').press("Enter");
      expect(requests).toBe(1);
    } finally { release(); }
    await expect(dialog.locator(".notice-err")).toContainText("Please check the name.");
    await expect(save).toBeEnabled();
    await expect(dialog.locator('[name="name"]')).toHaveValue("Pending brand");
    await save.click();
    await expect.poll(() => requests).toBe(2);
  });
}
