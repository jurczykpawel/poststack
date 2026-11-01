import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

const TEXTS = ["Our spring course opens on Monday, seats are limited", "Five mistakes people make when self-hosting n8n", "Behind the scenes of the new studio", "Live Q&A this Thursday at 7 pm"];
const TYPES = ["like", "love", "wow", "haha"];

let db: Client;
let workspaceId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  channelId = ch!.id;
  workspaceId = ch!.workspace_id;
  // 120 posts, half of them ours; each has a handful of reactions of mixed types.
  await db.query(
    `INSERT INTO posts (workspace_id, platform, status, platform_post_id, description)
     SELECT $1, 'facebook', 'published', 'englist_' || i, ($2::text[])[1 + i % 4] FROM generate_series(0, 119) AS i WHERE i % 2 = 0`,
    [workspaceId, TEXTS],
  );
  await db.query(
    `INSERT INTO post_reactions (workspace_id, channel_id, post_id, reactor_id, reactor_name, reaction_type, created_at)
     SELECT $1, $2, 'englist_' || i, 'r' || j, 'Reactor ' || j, ($3::text[])[1 + (i + j) % 4], now() - (i * interval '19 minutes') - (j * interval '1 second')
     FROM generate_series(0, 119) AS i, generate_series(0, 5) AS j`,
    [workspaceId, channelId, TYPES],
  );
  const { rows: [ct] } = await db.query<{ id: string }>("INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Maja Englist') RETURNING id", [workspaceId]);
  const { rows: [cv] } = await db.query<{ id: string }>("INSERT INTO conversations (workspace_id, channel_id, contact_id, platform) VALUES ($1, $2, $3, 'facebook') RETURNING id", [workspaceId, channelId, ct!.id]);
  await db.query("INSERT INTO messages (conversation_id, direction, text, platform_message_id) VALUES ($1, 'outbound', 'Here is your course link', 'englist-mid')", [cv!.id]);
  await db.query("INSERT INTO message_reactions (workspace_id, channel_id, conversation_id, contact_id, reacted_mid, reaction_type, emoji) VALUES ($1, $2, $3, $4, 'englist-mid', 'love', '❤️')", [workspaceId, channelId, cv!.id, ct!.id]);
});

test.afterAll(async () => {
  await db.query("DELETE FROM post_reactions WHERE workspace_id = $1 AND post_id LIKE 'englist_%'", [workspaceId]);
  await db.query("DELETE FROM posts WHERE workspace_id = $1 AND platform_post_id LIKE 'englist_%'", [workspaceId]);
  await db.query("DELETE FROM contacts WHERE workspace_id = $1 AND display_name = 'Maja Englist'", [workspaceId]);
  await db.end();
});

const rows = (page: Page) => page.locator("#data-list tbody tr");
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

test("page, search, open a post, then switch to message reactions without a reload", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/engagement");
  await wired(page);
  await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
  await expect(rows(page)).toHaveCount(50);
  await expect(page.locator("#data-list")).toContainText("Our spring course opens on Monday");

  await page.locator(".dl-pager a[rel='next']").click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.locator(".dl-pager")).toContainText(/51–100 of/);
  await wired(page);

  await page.goto("/engagement?q=spring");
  await wired(page);
  await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
  await rows(page).first().locator("a.dl-rowlink").click();
  await expect(page.locator(".dl-detail")).toContainText("Reactor 0");
  await expect(page.locator(".dl-detail a", { hasText: "View on Facebook" })).toBeVisible();
  await shoot(page, testInfo.outputPath("engagement-desktop-detail"));

  await page.goto("/engagement");
  await wired(page);
  await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
  await page.locator(".dl-chip", { hasText: "Message reactions" }).click();
  await expect(page).toHaveURL(/\/engagement\/messages$/);
  await expect(rows(page).first()).toContainText("Maja Englist");
  await expect(rows(page).first()).toContainText("Here is your course link");
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  await shoot(page, testInfo.outputPath("engagement-desktop-messages"));
  expect(errors).toEqual([]);
});

test("phone: one column per row, details take the screen, no sideways scroll", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/engagement");
  await expect(rows(page).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shoot(page, testInfo.outputPath("engagement-phone-list"));
  await rows(page).first().locator("a.dl-rowlink").click();
  await expect(page.locator(".dl-detail")).toBeVisible();
  await shoot(page, testInfo.outputPath("engagement-phone-detail"));
});
