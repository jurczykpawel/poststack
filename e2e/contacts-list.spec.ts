import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

let db: Client;
let workspaceId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  workspaceId = ch!.workspace_id;
  channelId = ch!.id;
  // 130 contacts: 100 with activity, 30 never seen (the NULL group sorts last); every 10th unsubscribed.
  await db.query(
    `INSERT INTO contacts (workspace_id, display_name, email, is_subscribed, last_interaction_at)
     SELECT $1, 'clist ' || (ARRAY['Anna','Piotr','Kasia','Tomasz','Marta'])[1 + i % 5] || ' ' || i, 'clist' || i || '@example.com', i % 10 <> 0,
            CASE WHEN i < 100 THEN now() - (i * interval '37 minutes') END
     FROM generate_series(0, 129) AS i`,
    [workspaceId],
  );
  await db.query(
    `INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id, platform_username)
     SELECT id, $1, 'clist-sender-' || id, 'clist_' || substr(id::text, 1, 6) FROM contacts WHERE workspace_id = $2 AND display_name LIKE 'clist %'`,
    [channelId, workspaceId],
  );
});

test.afterAll(async () => {
  await db.query("DELETE FROM contacts WHERE workspace_id = $1 AND display_name LIKE 'clist %'", [workspaceId]);
  await db.end();
});

const rows = (page: Page) => page.locator("#data-list tbody tr");
// Until htmx wires freshly swapped links they are plain navigation: a working fallback, but not what is under test.
const wired = (page: Page) => page.waitForFunction(() => {
  const links = document.querySelectorAll("#data-list a[href]");
  return links.length > 0 && [...links].every((a) => a.closest("[hx-boost='false']") || "htmx-internal-data" in a);
});

async function shoot(page: Page, base: string) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

test("search, count, page through the never-seen group, open details and go back", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/contacts?q=clist");
  await wired(page);
  await expect(rows(page)).toHaveCount(50);
  await expect(page.locator(".dl-pager")).toContainText("1–50 of 130");
  await expect(page.locator(".dl-chip", { hasText: "Unsubscribed" })).toContainText("13");

  await page.locator(".dl-pager a[rel='next']").click();
  await expect(page.locator(".dl-pager")).toContainText("51–100 of 130");
  await wired(page);
  await page.locator(".dl-pager a[rel='next']").click();
  await expect(page.locator(".dl-pager")).toContainText("101–130 of 130");
  await expect(rows(page)).toHaveCount(30);
  await expect(rows(page).first()).toContainText("Never"); // the last page is the never-seen group
  await wired(page);
  await page.locator(".dl-pager a[rel='prev']").click();
  await expect(page.locator(".dl-pager")).toContainText("51–100 of 130");

  await page.locator(".dl-chip", { hasText: "Unsubscribed" }).click();
  await expect(page).toHaveURL(/status=unsubscribed/);
  await expect(page.locator(".dl-pager")).toContainText("1–13 of 13");

  await wired(page);
  const first = rows(page).first();
  const id = await first.getAttribute("data-row");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`open=${id}`));
  const panel = page.locator(".dl-detail");
  await expect(panel).toContainText("@example.com");
  await expect(panel).toContainText("Unsubscribed");
  await expect(panel.getByRole("link", { name: "Open conversations" })).toHaveAttribute("href", `/inbox?contact=${id}`);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await gotoOk(page, `/contacts?q=clist&open=${id}`);
  await expect(panel).toBeVisible();
  await shoot(page, testInfo.outputPath("contacts-desktop-detail"));
  expect(errors).toEqual([]);
});

test("phone: one row per contact, details fill the screen, nothing scrolls sideways", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/contacts?q=clist");
  await expect(rows(page)).toHaveCount(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await rows(page).first().boundingBox())!.height).toBeLessThan(100);
  await shoot(page, testInfo.outputPath("contacts-phone"));

  await rows(page).first().locator("a.dl-rowlink").click();
  const panel = page.locator(".dl-detail");
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.width).toBe(390);
  await shoot(page, testInfo.outputPath("contacts-phone-detail"));
  expect(errors).toEqual([]);
});
