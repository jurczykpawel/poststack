import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

const STATUSES = ["fired", "fired", "no_match", "recorded", "ignored", "error"];
const EVENT_TYPES = ["messages", "comments", "message_reactions", "feed"];
const MODELS = ["gpt-5.2-mini", "claude-haiku-5-5"];

let db: Client;
let workspaceId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  workspaceId = ch!.workspace_id;
  channelId = ch!.id;
  await db.query(
    `INSERT INTO webhook_events (event_key, channel_id, platform, object, event_type, field, handling_status, error_detail, raw, received_at)
     SELECT 'actspec-' || i, $1, 'facebook', 'page', ($2::text[])[1 + i % 4], 'feed', (($3::text[])[1 + i % 6])::webhook_event_handling_status,
            CASE WHEN i % 6 = 5 THEN 'Provider returned 400: invalid recipient' END,
            jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('changes', jsonb_build_array(jsonb_build_object('value', jsonb_build_object('from', jsonb_build_object('id', 'S' || i, 'name', 'Noémie Pfirsch'))))))),
            now() - (i * interval '5 minutes')
     FROM generate_series(0, 119) AS i`,
    [channelId, EVENT_TYPES, STATUSES],
  );
  await db.query(
    `INSERT INTO ai_generation_logs (workspace_id, kind, model, system_prompt, user_message, response, error, duration_ms, created_at)
     SELECT $1, (CASE WHEN i % 3 = 0 THEN 'rephrase' ELSE 'draft' END)::ai_generation_kind, ($2::text[])[1 + i % 2],
            'You reply on behalf of the brand. Be brief.', 'Is the course still available?',
            CASE WHEN i % 10 = 9 THEN NULL ELSE 'Thanks for writing! The course is still open, here is the link.' END,
            CASE WHEN i % 10 = 9 THEN 'Provider timeout' END,
            500 + i * 37, now() - (i * interval '14 minutes')
     FROM generate_series(0, 79) AS i`,
    [workspaceId, MODELS],
  );
});

test.afterAll(async () => {
  await db.query("DELETE FROM webhook_events WHERE event_key LIKE 'actspec-%'");
  await db.query("DELETE FROM ai_generation_logs WHERE workspace_id = $1 AND system_prompt = 'You reply on behalf of the brand. Be brief.'", [workspaceId]);
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

test("switch sources, filter and open details on one address", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOk(page, "/activity");
  await expect(page.locator(".dl-sources a[aria-current='page']")).toHaveText("Events");

  await page.locator(".dl-sources a", { hasText: "Webhooks" }).click();
  await expect(page).toHaveURL(/\/activity\?source=webhooks$/);
  await wired(page);
  await expect(rows(page)).toHaveCount(50);
  await expect(page.locator(".dl-pager")).toContainText(/1–50 of 120/);

  await page.locator(".dl-chip", { hasText: "error" }).click();
  await expect(page).toHaveURL(/source=webhooks.*status=error|status=error.*source=webhooks/);
  await expect(rows(page).first()).toContainText("Provider returned 400");
  await wired(page);

  const first = rows(page).first();
  const id = await first.getAttribute("data-row");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`open=${id}`));
  const panel = page.locator(".dl-detail");
  await expect(panel).toContainText("Noémie Pfirsch");
  await expect(panel).toContainText("Raw payload");
  await shoot(page, testInfo.outputPath("webhooks-desktop-detail"));

  await gotoOk(page, "/activity?source=ai");
  await expect(page.locator(".dl-sources a[aria-current='page']")).toHaveText("AI log");
  await wired(page);
  await expect(rows(page)).toHaveCount(50);
  await page.locator(".dl-chip", { hasText: "Failed" }).click();
  await expect(rows(page).first()).toContainText("Provider timeout");
  await wired(page);
  await rows(page).first().click();
  await expect(page.locator(".dl-detail")).toContainText("You reply on behalf of the brand");
  await shoot(page, testInfo.outputPath("ai-desktop-detail"));

  // Old addresses land on the same lists.
  await gotoOk(page, "/events?severity=problems");
  await expect(page).toHaveURL(/\/activity\?source=events&severity=problems$/);
  await gotoOk(page, `/webhooks/${id}`);
  await expect(page).toHaveURL(new RegExp(`source=webhooks&open=${id}`));
  await expect(page.locator(".dl-detail")).toContainText("Raw payload");
  expect(errors).toEqual([]);
});

test("webhooks and AI log fit the phone, details take the screen", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const source of ["webhooks", "ai"]) {
    await gotoOk(page, `/activity?source=${source}`);
    await expect(rows(page)).toHaveCount(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await rows(page).first().boundingBox())!.height).toBeLessThan(90);
    await shoot(page, testInfo.outputPath(`${source}-phone`));
    await rows(page).first().locator("a.dl-rowlink").click();
    const box = (await page.locator(".dl-detail").boundingBox())!;
    expect([box.width, box.height]).toEqual([390, 844]);
    await shoot(page, testInfo.outputPath(`${source}-phone-detail`));
  }
  expect(errors).toEqual([]);
});

test("Settings keeps only a pointer to the AI log, and Webhooks points to the new log", async ({ page }) => {
  await setPro(page.request);
  await gotoOk(page, "/settings#automation");
  const card = page.locator("a[href='/activity?source=ai']");
  await expect(card).toBeVisible();
  await expect(page.locator("details.card", { hasText: "Thanks for writing" })).toHaveCount(0);
  await gotoOk(page, "/webhooks");
  await expect(page.locator("a[href='/activity?source=webhooks']")).toBeVisible();
  await expect(page.locator("#wh-detail")).toHaveCount(0);
});
