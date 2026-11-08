import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./env";
import { seedEngagement, clearEngagement, ENGAGEMENT_AT } from "../tests/fixtures/engagement";

let db: Client;
let workspace: string;
let seed: Awaited<ReturnType<typeof seedEngagement>>;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ws] } = await db.query<{ workspace_id: string }>("SELECT workspace_id FROM workspace_members ORDER BY created_at LIMIT 1");
  workspace = ws!.workspace_id;
  seed = await seedEngagement(db, workspace);
});

test.afterAll(async () => {
  if (seed) await clearEngagement(db, workspace, seed);
  await db.end();
});

const rows = (page: Page) => page.locator("#data-list [data-row]");
const ids = (page: Page) => rows(page).evaluateAll((list) => list.map((r) => r.getAttribute("data-row")));

for (const timezoneId of ["Europe/Warsaw", "America/Los_Angeles"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    test("exact totals and equal-time paging survive filters and fragment swaps", async ({ page }) => {
      const { errors } = watchConsole(page);
      await setPro(page.request);
      await gotoOk(page, "/engagement?brand=engdata-a");
      await expect(page.locator(".dl-chip", { hasText: "Posts" })).toHaveText("Posts 62");
      await expect(page.locator(".dl-chip", { hasText: "Message reactions" })).toHaveText("Message reactions 59");
      const first = await ids(page);
      expect(first).toHaveLength(50);
      await page.locator('.dl-pager [rel="next"]').click();
      await expect(page.locator(".dl-pager")).toContainText("51–62 of 62");
      const second = await ids(page);
      expect(new Set([...first, ...second]).size).toBe(62);
      await page.locator('.dl-pager [rel="prev"]').click();
      await expect(page.locator(".dl-pager")).toContainText("1–50 of 62");
      expect(await ids(page)).toEqual(first);
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.locator(".ps-select.open").getByRole("option", { name: "Facebook · Engagement Page 0", exact: true }).click();
      await expect(page.locator(".dl-chip", { hasText: "Posts" })).toHaveText("Posts 61");
      await page.locator('.dl-chip', { hasText: "Message reactions" }).click();
      await expect(page.locator(".dl-pager")).toContainText("1–50 of 57");
      const messages = await ids(page);
      await page.locator('.dl-pager [rel="next"]').click();
      await expect(page.locator(".dl-pager")).toContainText("51–57 of 57");
      expect(new Set([...messages, ...await ids(page)]).size).toBe(57);
      await rows(page).first().locator("a.dl-rowlink").click();
      const date = page.locator(".dl-detail time[data-local-time]");
      await expect(date).toHaveAttribute("datetime", ENGAGEMENT_AT);
      await expect(date).not.toContainText("UTC");
      // The same instant falls on different calendar dates in these browser zones.
      const expectedTime = timezoneId === "Europe/Warsaw" ? "25 Oct 2026, 02:30 · Europe/Warsaw" : "24 Oct 2026, 17:30 · America/Los_Angeles";
      await expect(date).toHaveText(expectedTime);
      await expect(rows(page).first().locator("[data-local-title]")).toHaveAttribute("title", expectedTime);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".dl-detail time[data-local-time]")).toHaveText(expectedTime);
      await gotoOk(page, "/engagement?brand=engdata-b");
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("7");
      await gotoOk(page, "/engagement?brand=engdata-missing");
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByText("No posts match these filters", { exact: true })).toBeVisible();
      await expect(page.locator(".dl-chip", { hasText: "Posts" })).toHaveText("Posts 0");
      await gotoOk(page, "/engagement/messages?brand=engdata-missing");
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByText("No reactions match these filters", { exact: true })).toBeVisible();
      await expect(page.locator(".dl-chip", { hasText: "Message reactions" })).toHaveText("Message reactions 0");
      expect(errors).toEqual([]);
    });
  });
}

for (const width of [390, 1440]) {
  for (const theme of ["dark", "light"]) {
    test(`${width} ${theme}: large post and message details`, async ({ page }, testInfo) => {
      const { errors } = watchConsole(page);
      await setPro(page.request);
      await page.setViewportSize({ width, height: 900 });
      await page.context().addCookies([{ name: "ps_theme", value: theme, url: E2E_BASE_URL }]);
      await gotoOk(page, `/engagement?channel=${seed.channels[0]}&q=Engagement%20course`);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("1,057");
      for (const type of ["like", "love", "care", "haha", "wow", "sad", "angry"]) {
        await expect(rows(page).first().locator(`[title="${type}"]`)).toHaveText(/151/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("posts.png"), fullPage: true });
      await rows(page).first().locator("a.dl-rowlink").click();
      await expect(page.locator(".dl-detail")).toContainText("1,057");
      await expect(page.locator(".dl-detail")).toContainText("1,037 more");
      await page.screenshot({ path: testInfo.outputPath("post-detail.png") });
      await gotoOk(page, `/engagement/messages?channel=${seed.channels[0]}`);
      await expect(rows(page)).toHaveCount(50);
      await rows(page).first().locator("a.dl-rowlink").click();
      await expect(page.locator(".dl-detail")).toContainText("Course link");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("message-detail.png") });
      expect(errors).toEqual([]);
    });
  }
}
