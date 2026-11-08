import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import { join } from "path";
import { gotoOk, setPro, watchConsole } from "./helpers";
import { providerDay, REACH, seedInsights, type InsightsFixture } from "./fixtures/insights";

// The account screen in a real browser: one channel, 7/30 days, cards, one SSR SVG chart and its
// table, across both reference widths and both themes. Screenshots go to a private tmp directory.
const SHOTS = process.env.E2E_INSIGHTS_SHOTS ?? "/private/tmp/poststack-insights-a8";
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1440, height: 900 }] as const;
const THEMES = ["dark", "light"] as const;

let fixture: InsightsFixture;

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}

async function expectNoHorizontalOverflow(page: Page, width: number) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

/** Every control a finger needs is at least 44 px tall. */
async function expectTouchTargets(page: Page) {
  const controls = page.locator("#insights-root").locator("select, button, summary");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box?.height ?? 0, `${await control.evaluate((el) => el.outerHTML.slice(0, 80))}`).toBeGreaterThanOrEqual(44);
  }
}

test.describe.serial("insights account screen", () => {
  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await seedInsights();
  });
  test.afterAll(async () => fixture.cleanup());

  test("cards, chart, table and URL state", async ({ page }) => {
    await setPro(page.request);
    const { errors } = watchConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, `/insights?channel=${fixture.channelId}`);
    await expect(page.locator("main.content h1")).toContainText("Insights");
    await expect(page.locator(".sidebar a.nav-item[href='/insights']")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("select[name=channel]")).toHaveValue(fixture.channelId);

    // Reach is a unique metric: no total from summed days, but the daily line and table work.
    const reach = page.locator("button.ins-card[value=reach]");
    await expect(reach).toHaveAttribute("aria-pressed", "true");
    await expect(reach.locator(".ins-card-v")).toHaveText("—");
    await expect(reach).toContainText("Total not available for unique metrics");
    const chart = page.locator(".ins-chart svg[role=img]");
    await expect(chart).toBeVisible();
    await expect(page.locator(".ins-chart path.ins-line")).toHaveCount(2); // the missing day splits the line
    await expect(page.locator(".ins-chart path.ins-prov")).toHaveCount(1);
    await expect(page.locator(`.ins-chart circle[data-day="${providerDay(-5)}"]`)).toHaveAttribute("data-value", "0");
    await expect(page.locator(`.ins-chart circle[data-day="${providerDay(-4)}"]`)).toHaveCount(0);

    await page.locator(".ins-table summary").click();
    for (const offset of [-7, -6, -5, -3]) {
      const row = page.locator(".ins-table tbody tr", { has: page.locator(`th:text-matches("^${providerDay(offset)}")`) });
      await expect(row.locator("td")).toHaveText(Number(REACH[offset]).toLocaleString("en-US"));
    }
    await expect(page.locator(".ins-table tbody tr", { has: page.locator(`th:text-matches("^${providerDay(-4)}")`) }).locator("td")).toHaveText("—");
    await expect(page.locator(".ins-table tbody th", { hasText: "(provisional)" }).first()).toBeVisible();

    // Range switch swaps the screen in place and keeps channel + range in the address bar.
    await page.locator(".ins-seg button[value='30']").click();
    await expect(page).toHaveURL(new RegExp(`channel=${fixture.channelId}.*range=30|range=30.*channel=${fixture.channelId}`));
    await expect(page.locator(".ins-seg button[value='30']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".ins-table tbody tr")).toHaveCount(30);
    await page.goBack();
    await expect(page.locator(".ins-seg button[value='7']")).toHaveAttribute("aria-pressed", "true");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("select[name=channel]")).toHaveValue(fixture.channelId);

    // Refresh queues a run and polls the local status; it never blocks the page.
    await page.getByRole("button", { name: "Refresh data" }).click();
    await expect(page.locator("#insights-sync")).toContainText(/Refresh queued|Next refresh available/);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`layout ${viewport.width} ${theme}`, async ({ page }) => {
        await setPro(page.request);
        await page.setViewportSize(viewport);
        await gotoOk(page, `/insights?channel=${fixture.channelId}`);
        await setTheme(page, theme);
        await page.locator(".ins-table summary").click();
        await expectNoHorizontalOverflow(page, viewport.width);
        await expectTouchTargets(page);
        const cards = page.locator(".ins-cards");
        const columns = await cards.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        expect(columns).toBe(viewport.width < 768 ? 2 : 4);
        await page.screenshot({ path: join(SHOTS, `insights-${viewport.width}-${theme}.png`), fullPage: true, animations: "disabled" });
      });
    }
  }

  test("additional access state offers consent and keeps publishing untouched", async ({ page }) => {
    await setPro(page.request);
    const denied = await seedInsights("missing_permission");
    try {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await gotoOk(page, `/insights?channel=${denied.channelId}`);
        await expect(page.getByRole("heading", { name: "Insights needs additional access" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Grant Insights access" })).toBeVisible();
        await expectNoHorizontalOverflow(page, viewport.width);
        await expectTouchTargets(page);
        await page.screenshot({ path: join(SHOTS, `insights-access-${viewport.width}.png`), fullPage: true, animations: "disabled" });
      }
      await gotoOk(page, `/channels/${denied.channelId}`);
      await expect(page.locator(".ins-channel-panel")).toContainText("Additional access required");
      await expect(page.locator(`.ins-channel-panel a[href="/insights?channel=${denied.channelId}"]`)).toBeVisible();
    } finally {
      await denied.cleanup();
    }
  });
});
