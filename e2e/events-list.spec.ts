import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

const TYPES = ["post.published", "post.published", "contact.created", "conversation.updated", "channel.reconnected", "post.first_comment", "post.held", "post.failed", "channel.needs_reauth"];
const SUBJECTS = ["Acme Instagram", "Acme Facebook", "Kitchen Telegram", "Studio YouTube"];
const PLATFORMS = ["instagram", "facebook", "telegram", "youtube"];

let db: Client;
let workspaceId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ workspace_id: string }>("SELECT workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  workspaceId = ch!.workspace_id;
  await db.query(
    `INSERT INTO events (workspace_id, type, subject_type, subject_id, payload, created_at)
     SELECT $1, ($2::text[])[1 + i % 9], 'channel', 'evlist-' || i,
            jsonb_build_object('displayName', ($3::text[])[1 + i % 4], 'platform', ($4::text[])[1 + i % 4],
                               'error', CASE WHEN i % 9 = 7 THEN 'Provider returned 400: invalid recipient' END),
            now() - (i * interval '7 minutes')
     FROM generate_series(0, 239) AS i`,
    [workspaceId, TYPES, SUBJECTS, PLATFORMS],
  );
});

test.afterAll(async () => {
  await db.query("DELETE FROM events WHERE workspace_id = $1 AND subject_id LIKE 'evlist-%'", [workspaceId]);
  await db.end();
});

const rows = (page: Page) => page.locator("#data-list tbody tr");
// Until htmx wires freshly swapped links they are plain navigation: a working fallback, but not what is under test.
const wired = (page: Page) => page.waitForFunction(() => {
  const links = document.querySelectorAll("#data-list a[href]");
  return links.length > 0 && [...links].every((a) => a.closest("[hx-boost='false']") || "htmx-internal-data" in a);
});
const noReloadMarker = (page: Page) => page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
const expectNoReload = async (page: Page) => expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);

// The theme comes from the cookie on a fresh load, so the shots show what a user gets rather than a transition.
async function shoot(page: Page, base: string) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

test("filter, page, open and go back on /activity?source=events without leaving the page", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/activity?source=events");
  await wired(page);
  await noReloadMarker(page);
  await expect(rows(page)).toHaveCount(50);

  await page.locator(".dl-chip", { hasText: "Problems" }).click();
  await expect(page).toHaveURL(/severity=problems/);
  await expect(page.locator(".dl-chip[aria-current='true']")).toContainText("Problems");
  await expect(page.locator(".dl-pager")).toContainText(/1–50 of/);
  await expectNoReload(page);

  const search = page.getByRole("searchbox");
  await search.pressSequentially("Acme", { delay: 20 });
  await expect(page).toHaveURL(/q=Acme/);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Acme");
  expect(new URL(page.url()).search).not.toMatch(/area=|platform=|after=/);
  await search.fill("");
  await expect(page).not.toHaveURL(/q=/);

  await page.locator("select[name='platform']").selectOption("instagram", { force: true });
  await expect(page).toHaveURL(/platform=instagram/);
  await expect(page).toHaveURL(/severity=problems/);
  await wired(page);
  await page.locator(".filter-clear").click();
  await expect(page).toHaveURL(/\/activity\?source=events$/);

  await wired(page);
  const firstBefore = await rows(page).first().getAttribute("data-row");
  await page.locator(".dl-pager a[rel='next']").click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.locator(".dl-pager")).toContainText(/51–100 of/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(200);
  await page.goBack();
  await expect(page).not.toHaveURL(/after=/);
  await expect(rows(page).first()).toHaveAttribute("data-row", firstBefore!);

  const failed = page.locator("#data-list tbody tr", { hasText: "Post failed" }).first();
  const id = await failed.getAttribute("data-row");
  await wired(page);
  await failed.click(); // anywhere on the row, not just its first cell
  await expect(page).toHaveURL(new RegExp(`open=${id}`));
  const panel = page.locator(".dl-detail");
  await expect(panel).toContainText("Provider returned 400");
  await expect(panel).toBeFocused();
  await expect(page.locator(`tr[data-row="${id}"]`)).toHaveAttribute("aria-current", "true");
  await expectNoReload(page);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  await expect(page.locator(`tr[data-row="${id}"] a.dl-rowlink`)).toBeFocused();

  // A link to a filtered view with an open row reproduces it for someone else.
  await gotoOk(page, `/activity?source=events&severity=problems&open=${id}`);
  await expect(panel).toContainText("Post failed");
  await expect(page.locator(".dl-chip[aria-current='true']")).toContainText("Problems");
  await shoot(page, testInfo.outputPath("events-desktop-detail"));
  expect(errors).toEqual([]);
});

test("details take the whole phone screen and nothing scrolls sideways", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/activity?source=events");
  await expect(rows(page)).toHaveCount(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // One row per event, not a stacked card per field.
  expect((await rows(page).first().boundingBox())!.height).toBeLessThan(90);
  await shoot(page, testInfo.outputPath("events-phone"));

  await rows(page).first().locator("a.dl-rowlink").click();
  const panel = page.locator(".dl-detail");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.width).toBe(390);
  expect(box.height).toBe(844);
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(rows(page)).toHaveCount(50);
  expect(errors).toEqual([]);
  await page.goForward();
  await expect(panel).toBeVisible();
  await shoot(page, testInfo.outputPath("events-phone-detail"));
});
