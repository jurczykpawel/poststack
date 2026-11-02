import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro, watchConsole } from "./helpers";

const PREFIX = "qsec";
let db: Client;
let workspaceId: string;
let channelId: string;

test.use({ timezoneId: "Europe/Warsaw" });

async function seed(status: string, caption: string, when: string, lastError: string | null = null): Promise<string> {
  const { rows: [d] } = await db.query(
    `INSERT INTO deliveries (workspace_id, channel_id, format, status, payload, scheduled_at, run_at, last_error)
     VALUES ($1, $2, 'text', $3, $4, ${when}, ${when}, $5) RETURNING id`,
    [workspaceId, channelId, status, { format: "text", media: [], caption }, lastError],
  );
  if (status === "scheduled") await db.query("select graphile_worker.add_job('publish',$1,job_key=>$2,run_at=>now()+interval '30 days')", [JSON.stringify({ postId: d.id }), `publish:${d.id}`]);
  return d.id;
}

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  workspaceId = ch!.workspace_id;
  channelId = ch!.id;
  const topics = ["Black Friday prices for the self-hosted course", "Webinar reminder: automations without monthly fees", "New lesson about backups on a small server", "Customer story: moving away from a paid inbox tool"];
  for (let i = 0; i < 44; i++) await seed("scheduled", `${PREFIX} ${topics[i % 4]} #${i}`, `now() + interval '${90 + i * 137} minutes'`);
  for (let i = 0; i < 30; i++) await seed("sent", `${PREFIX} ${topics[i % 4]} sent ${i}`, `now() - interval '${20 + i * 90} minutes'`);
  for (let i = 0; i < 8; i++) await seed("canceled", `${PREFIX} ${topics[i % 4]} canceled ${i}`, `now() - interval '${i + 1} days'`);
  await seed("failed", `${PREFIX} failed post`, "now() - interval '40 minutes'", "Token expired, reconnect the channel");
  await seed("failed", `${PREFIX} second failed post`, "now() - interval '2 hours'", "Provider returned 500");
  await seed("held", `${PREFIX} held post`, "now() - interval '3 hours'", "Rate limit, retry later");
});

test.afterAll(async () => {
  const { rows } = await db.query("SELECT id FROM deliveries WHERE workspace_id = $1 AND payload->>'caption' LIKE $2", [workspaceId, `${PREFIX} %`]);
  for (const r of rows) await db.query("select graphile_worker.remove_job($1)", [`publish:${r.id}`]);
  await db.query("DELETE FROM deliveries WHERE workspace_id = $1 AND payload->>'caption' LIKE $2", [workspaceId, `${PREFIX} %`]);
  await db.end();
});

const zoneCookie = (context: BrowserContext, baseURL: string) => context.addCookies([{ name: "ps_tz", value: encodeURIComponent("Europe/Warsaw"), url: baseURL }]);
const section = (page: Page, name: string) => page.locator(`[data-section="${name}"]`);
const rows = (page: Page, name: string) => section(page, name).locator(".q-row");
const wired = (page: Page) => page.waitForFunction(() => {
  const links = document.querySelectorAll("#data-list a[href]");
  return links.length > 0 && [...links].every((a) => a.closest("[hx-boost='false']") || "htmx-internal-data" in a);
});
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const captionOf = async (id: string) => (await db.query("SELECT payload->>'caption' AS c FROM deliveries WHERE id = $1", [id])).rows[0].c;

test("sections, days, more and the band read in order at 1440", async ({ page, request }) => {
  await setPro(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { errors } = watchConsole(page);
  // First visit without the zone cookie: the list is fetched again once, in the browser's zone, without a reload.
  expect((await page.context().cookies()).some((c) => c.name === "ps_tz")).toBe(false);
  const refreshed = page.waitForResponse((r) => r.request().headers()["hx-request"] === "true" && new URL(r.url()).pathname === "/queue");
  await gotoOk(page, "/queue");
  await refreshed;
  const names = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
  expect(names).toEqual(["scheduled", "published", "canceled"]);
  await expect(page.locator(".q-band")).toContainText("3 posts need your attention");
  await expect(page.locator(".q-band")).toContainText("2 failed · 1 held");
  await expect(section(page, "canceled")).not.toHaveAttribute("open");

  // The zone cookie is in place and rows show local wall-clock times.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "ps_tz")?.value).toBe(encodeURIComponent("Europe/Warsaw"));
  await expect(page.locator(".q-page")).toHaveAttribute("data-view-tz", "Europe/Warsaw");
  const first = rows(page, "scheduled").first();
  const local = await first.getAttribute("data-row").then(async (id) => (await db.query("SELECT to_char(scheduled_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') AS t FROM deliveries WHERE id = $1", [id])).rows[0].t);
  await expect(first.locator(".q-t")).toHaveText(local);

  await wired(page);
  await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
  await expect(rows(page, "published")).toHaveCount(6);
  await section(page, "published").getByRole("link", { name: "Show 20 more" }).click();
  await expect(rows(page, "published")).toHaveCount(26);
  await expect(page).toHaveURL(/show_published=26/);
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);

  await wired(page);
  const chip = section(page, "scheduled").locator(".q-daychip").nth(2);
  const dayCount = Number((await chip.locator("b").textContent())!.replace(/,/g, ""));
  await chip.click();
  await expect(page).toHaveURL(/day=/);
  await expect(chip).toHaveAttribute("aria-current", "true");
  await expect(rows(page, "scheduled")).toHaveCount(Math.min(dayCount, 12));

  await wired(page);
  await page.locator(".q-band").getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/status=attention/);
  await expect(page.locator("#data-list")).toContainText("Token expired, reconnect the channel");
  await expect(page.locator('.dl-chip[aria-current="true"]')).toContainText("Needs attention");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("the panel edits text and the menu cancels, without leaving the list", async ({ page, context }, testInfo) => {
  await zoneCookie(context, testInfo.project.use.baseURL!);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { errors } = watchConsole(page);
  const id = await seed("scheduled", `${PREFIX} edit me`, "now() + interval '10 minutes'");
  const victim = await seed("scheduled", `${PREFIX} cancel me`, "now() + interval '11 minutes'");
  // A Facebook feed post with one image, the shape Compose schedules.
  await db.query("UPDATE deliveries SET format='feed_post', payload = jsonb_build_object('format','feed_post','media',jsonb_build_array(jsonb_build_object('mediaId',gen_random_uuid())),'caption',payload->>'caption') WHERE id=$1", [id]);
  await gotoOk(page, "/queue");
  await wired(page);
  const row = page.locator(`#post-row-${id}`);
  await row.locator(".q-text").click();
  await expect(page).toHaveURL(new RegExp(`open=${id}`));
  const panel = page.locator(".dl-detail");
  await expect(panel).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await panel.getByLabel("Text").fill(`${PREFIX} edited text`);
  await panel.getByRole("button", { name: "Save text" }).click();
  await expect(page.locator(".toasts")).toContainText("Text saved.");
  await expect(row.locator(".q-text")).toHaveText(`${PREFIX} edited text`);
  expect(await captionOf(id)).toBe(`${PREFIX} edited text`);
  await expect(page).toHaveURL(new RegExp(`open=${id}`));
  await expect(panel.locator(".q-chan")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(row.locator("a.dl-rowlink")).toBeFocused();

  await wired(page);
  const target = page.locator(`#post-row-${victim}`);
  await target.getByLabel("More actions").click();
  await target.getByRole("button", { name: "Cancel post" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel post" }).click();
  await expect(section(page, "scheduled").locator(`#post-row-${victim}`)).toHaveCount(0);
  await expect.poll(async () => (await db.query("SELECT status FROM deliveries WHERE id = $1", [victim])).rows[0].status).toBe("canceled");

  await wired(page);
  const again = page.locator(`#post-row-${id}`);
  await again.getByRole("button", { name: "Publish now" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Publish now" }).click();
  await expect.poll(async () => (await db.query("SELECT scheduled_at <= now() AT TIME ZONE 'UTC' AS due FROM deliveries WHERE id = $1", [id])).rows[0].due).toBe(true);
  await expect(page).not.toHaveURL(/publish-now/);
  expect(errors).toEqual([]);
});

test("full list pages and phone layout stay usable", async ({ page, context }, testInfo) => {
  await zoneCookie(context, testInfo.project.use.baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = watchConsole(page);
  await gotoOk(page, "/queue");
  expect(await noOverflow(page)).toBe(true);
  const firstRow = rows(page, "scheduled").first();
  await expect(firstRow.locator(".q-meta")).toBeVisible();
  await expect(firstRow.getByRole("button", { name: "Publish now" })).toBeHidden();
  const bounds = await firstRow.getByLabel("More actions").boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await wired(page);
  await section(page, "published").getByRole("link", { name: "Open full list" }).click();
  await expect(page).toHaveURL(/status=published/);
  await expect(page.locator("#data-list tbody tr").first()).toBeVisible();
  const next = page.locator('a[rel="next"]');
  if (await next.count()) await expect(next).toHaveText("Older");
  expect(await noOverflow(page)).toBe(true);
  await wired(page);
  await page.locator("#data-list tbody tr a.dl-rowlink").first().click();
  await expect(page.locator(".dl-detail")).toBeVisible();
  await page.locator(".dl-close").click();
  await expect(page.locator(".dl-detail")).toBeHidden();
  expect(errors).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  for (const [label, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
    test(`shots ${label} ${theme}`, async ({ page, context }, testInfo) => {
      await context.addCookies([{ name: "ps_theme", value: theme, url: testInfo.project.use.baseURL! }]);
      await zoneCookie(context, testInfo.project.use.baseURL!);
      await page.setViewportSize({ width, height });
      await gotoOk(page, "/queue");
      await page.screenshot({ path: testInfo.outputPath(`queue-${label}-${theme}.png`) });
      const id = await rows(page, "scheduled").first().getAttribute("data-row");
      await gotoOk(page, `/queue?open=${id}`);
      await page.screenshot({ path: testInfo.outputPath(`queue-panel-${label}-${theme}.png`) });
      await gotoOk(page, "/queue?status=attention");
      await page.screenshot({ path: testInfo.outputPath(`queue-attention-${label}-${theme}.png`) });
    });
  }
}
