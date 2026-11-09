import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gotoOk, setFree, setPro, watchConsole } from "./helpers";
import { E2E_KID, signToken } from "./fixtures/keys";
import { providerDay, REACH, seedInsights, type InsightsFixture, type SeedOptions } from "./fixtures/insights";

// The account screen in a real browser: one channel, 7/30 days, cards, one SSR SVG chart and its
// table, across both reference widths and both themes. Screenshots go to a private tmp directory.
const SHOTS = process.env.E2E_INSIGHTS_SHOTS ?? join(tmpdir(), "poststack-insights-shots");
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
    await expect(page.locator("#insights-root .ins-note", { hasText: "Dates follow Instagram's Pacific reporting day" })).toBeVisible();
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

// ── Consumer acceptance (IGIA9) ────────────────────────────────────────────────────────────────────
// What a person using the screen, a keyboard, a browser without scripting, another time zone or a
// different licence actually gets. Only the platform's login dialog is replaced at the network edge.

const STATE_VIEWPORTS = VIEWPORTS.flatMap((viewport) => THEMES.map((theme) => ({ ...viewport, theme })));

/** A signed licence that unlocks only the named product areas (the e2e offline key). */
async function setLicenseAreas(request: Page["request"], products: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const token = signToken({ v: 1, kid: E2E_KID, product: "poststack", email: "e2e@example.com", order: "ord_e2e_areas", tier: "pro", products, iat: now, exp: now + 3600 });
  const res = await request.post("/api/v1/license", { headers: { "content-type": "application/json" }, data: { token } });
  expect(res.status(), await res.text()).toBe(200);
}

/** Stand-in for the platform's login dialog: the browser reaches the dialog URL, nothing leaves the machine. */
async function interceptPlatformDialog(page: Page): Promise<string[]> {
  const reached: string[] = [];
  await page.route("https://www.facebook.com/**", async (route) => {
    reached.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Platform login</title><p>Platform login dialog</p>" });
  });
  return reached;
}

async function setMetaApp(request: Page["request"], on: boolean) {
  for (const key of ["META_APP_ID", "META_APP_SECRET"]) {
    const res = await request.post("/settings/credentials", { headers: { "content-type": "application/json" }, data: on ? { key, value: `e2e-${key.toLowerCase()}-value` } : { key, clear: "1" } });
    expect(res.status(), await res.text()).toBe(200);
  }
}

/** Presses Tab until the element matching `selector` has focus; fails if it is not reachable. */
async function tabTo(page: Page, selector: string, max = 60) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`${selector} is not reachable with the keyboard`);
}

const STATES: Array<{ name: string; seed: SeedOptions; heading?: string | RegExp; text: RegExp[] }> = [
  { name: "off", seed: { mode: "off", state: "unknown", reason: "collection_off" }, text: [/Turn on Insights for/, /Previously collected data is shown below/] },
  { name: "checking", seed: { state: "unknown", reason: "first_sync", lastSuccessHoursAgo: null, withData: false }, text: [/Collecting the first data/] },
  { name: "connected", seed: {}, text: [/Last sync:/] },
  { name: "permission", seed: { state: "missing_permission" }, text: [/Insights needs additional access/, /Grant Insights access/] },
  { name: "stale", seed: { reason: "rate_limited", lastSuccessHoursAgo: 5, backoffInMinutes: 30 }, text: [/Showing data collected/, /Next attempt/] },
  { name: "delayed", seed: { lastSuccessHoursAgo: 60 }, text: [/Collection looks delayed/, /worker process is running/] },
  { name: "empty", seed: { withData: false, lastSuccessHoursAgo: 1 }, text: [/No data for this period yet/] },
];

test.describe.serial("insights consumer acceptance", () => {
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  test.beforeEach(async ({ page }) => setPro(page.request));

  for (const state of STATES) {
    test(`state ${state.name}: message, action, layout and screenshots`, async ({ page }) => {
      const seeded = await seedInsights(state.seed);
      try {
        for (const view of STATE_VIEWPORTS) {
          await page.setViewportSize({ width: view.width, height: view.height });
          await gotoOk(page, `/insights?channel=${seeded.channelId}`);
          await setTheme(page, view.theme);
          for (const text of state.text) await expect(page.locator("#insights-root")).toContainText(text);
          if (state.name === "connected" || state.name === "stale" || state.name === "delayed") await page.locator(".ins-table summary").click();
          await expectNoHorizontalOverflow(page, view.width);
          await expectTouchTargets(page);
          await page.screenshot({ path: join(SHOTS, `state-${state.name}-${view.width}-${view.theme}.png`), fullPage: true, animations: "disabled" });
        }
      } finally {
        await seeded.cleanup();
      }
    });
  }

  test("state locked: FREE and replies-only licences see the lock, publishing PRO sees the data, data survives", async ({ page }) => {
    const seeded = await seedInsights();
    const url = `/insights?channel=${seeded.channelId}`;
    try {
      const locked = async (label: string) => {
        await gotoOk(page, url);
        await expect(page.locator("#insights-root .ins-lock"), label).toContainText("Account Insights are a PRO feature");
        await expect(page.getByRole("button", { name: /Grant Insights access|Turn on Insights/ }), label).toHaveCount(0);
        const api = await page.request.get(`/api/v1/channels/${seeded.channelId}/insights`);
        expect(api.status(), `${label} API`).toBe(402);
      };
      const unlocked = async (label: string) => {
        await gotoOk(page, url);
        await expect(page.locator("#insights-root .ins-lock"), label).toHaveCount(0);
        await expect(page.locator("button.ins-card[value=reach]"), label).toBeVisible();
        const api = await page.request.get(`/api/v1/channels/${seeded.channelId}/insights`);
        expect(api.status(), `${label} API`).toBe(200);
      };
      await setFree(page.request);
      await locked("free");
      for (const view of STATE_VIEWPORTS) {
        await page.setViewportSize({ width: view.width, height: view.height });
        await gotoOk(page, url);
        await setTheme(page, view.theme);
        await expectNoHorizontalOverflow(page, view.width);
        await page.screenshot({ path: join(SHOTS, `state-locked-${view.width}-${view.theme}.png`), fullPage: true, animations: "disabled" });
      }
      await setLicenseAreas(page.request, ["publishing"]);
      await unlocked("publishing PRO");
      await setLicenseAreas(page.request, ["replies"]);
      await locked("replies-only PRO");
      await setFree(page.request);
      await locked("free again");
      await setLicenseAreas(page.request, ["publishing"]);
      await unlocked("publishing PRO again");
      await page.locator(".ins-table summary").click();
      await expect(page.locator(".ins-table tbody tr", { has: page.locator(`th:text-matches("^${providerDay(-3)}")`) }).locator("td")).toHaveText(Number(REACH[-3]).toLocaleString("en-US"));
    } finally {
      await seeded.cleanup();
    }
  });

  test("keyboard only: range, metric, table and consent are reachable and operable", async ({ page }) => {
    const seeded = await seedInsights("missing_permission");
    const ok = await seedInsights();
    await setMetaApp(page.request, true);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoOk(page, `/insights?channel=${ok.channelId}`);
      await tabTo(page, ".ins-seg button[value='30']");
      await page.keyboard.press("Enter");
      await expect(page.locator(".ins-seg button[value='30']")).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(/range=30/);
      await tabTo(page, "button.ins-card[value=reach]");
      await page.keyboard.press("Space");
      await expect(page).toHaveURL(/metric=reach/);
      await tabTo(page, ".ins-table summary");
      await page.keyboard.press("Enter");
      await expect(page.locator("details.ins-table")).toHaveJSProperty("open", true);
      await expect(page.locator(".ins-table tbody tr")).toHaveCount(30);

      // Channel, range and metric survive going back and a reload.
      await page.goBack();
      await expect(page).not.toHaveURL(/metric=reach/);
      await expect(page.locator(".ins-seg button[value='30']")).toHaveAttribute("aria-pressed", "true");
      await page.goBack();
      await expect(page.locator(".ins-seg button[value='7']")).toHaveAttribute("aria-pressed", "true");
      await page.goForward();
      await page.goForward();
      await expect(page).toHaveURL(/metric=reach/);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("select[name=channel]")).toHaveValue(ok.channelId);
      await expect(page.locator(".ins-seg button[value='30']")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("button.ins-card[value=reach]")).toHaveAttribute("aria-pressed", "true");

      // Consent from the keyboard goes to the platform's login dialog with the extra permission and no secrets.
      const reached = await interceptPlatformDialog(page);
      await gotoOk(page, `/insights?channel=${seeded.channelId}`);
      await tabTo(page, "form[action='/insights/consent'] button");
      await page.keyboard.press("Enter");
      await expect.poll(() => reached.length).toBe(1);
      const dialog = new URL(reached[0]);
      expect(dialog.searchParams.get("scope")).toContain("instagram_manage_insights");
      expect(dialog.href).not.toContain("e2e-insights-user-token");
      expect(dialog.searchParams.get("state")).toBeTruthy();
    } finally {
      await setMetaApp(page.request, false);
      await seeded.cleanup();
      await ok.cleanup();
    }
  });

  test("declined access keeps the collected data and the page offers the request again", async ({ page }) => {
    const seeded = await seedInsights("missing_permission");
    try {
      await gotoOk(page, `/insights?channel=${seeded.channelId}`);
      await expect(page.getByRole("heading", { name: "Insights needs additional access" })).toBeVisible();
      await expect(page.locator("#insights-root")).toContainText("If you declined the permission, grant it again. The data you already collected stays.");
      // The request can be made again; following it to the platform dialog is covered by the consent test
      // above (whether a Meta app is configured depends on the environment, so it is not exercised here).
      await expect(page.getByRole("button", { name: "Grant Insights access" })).toBeVisible();
      const from = providerDay(-7);
      const to = providerDay(0);
      const report = await page.request.get(`/api/v1/channels/${seeded.channelId}/insights/account?from=${from}&to=${to}&metrics=reach`);
      expect(report.status()).toBe(200);
      const body = await report.json();
      expect(body.data.status.displayStatus).toBe("additional_access_required");
      expect(body.data.series.map((o: { providerDay: string; value: string | null }) => o.value)).toEqual([REACH[-7], REACH[-6], REACH[-5], REACH[-3], REACH[-2], REACH[-1]]);
    } finally {
      await seeded.cleanup();
    }
  });

  test("browser without scripting: every control still works through plain forms", async ({ browser }) => {
    const seeded = await seedInsights();
    const denied = await seedInsights("missing_permission");
    const context = await browser.newContext({ javaScriptEnabled: false, storageState: "./e2e/.auth/state.json", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await setMetaApp(page.request, true);
    try {
      await gotoOk(page, `/insights?channel=${seeded.channelId}`);
      await page.locator(".ins-seg button[value='30']").click();
      await expect(page).toHaveURL(/range=30/);
      await expect(page.locator(".ins-seg button[value='30']")).toHaveAttribute("aria-pressed", "true");
      await page.locator(".ins-table summary").click();
      await expect(page.locator(".ins-table tbody tr")).toHaveCount(30);
      await page.getByRole("button", { name: "Refresh data" }).click();
      await expect(page.locator(".notice")).toContainText(/Refresh queued|A refresh was requested recently/);
      await expect(page).toHaveURL(new RegExp(`channel=${seeded.channelId}`));

      const reached = await interceptPlatformDialog(page);
      await gotoOk(page, `/insights?channel=${denied.channelId}`);
      await page.getByRole("button", { name: "Grant Insights access" }).click();
      await expect.poll(() => reached.length).toBe(1);
      expect(reached).toHaveLength(1);
      expect(new URL(reached[0]).searchParams.get("scope")).toContain("instagram_manage_insights");
    } finally {
      await setMetaApp(page.request, false);
      await context.close();
      await seeded.cleanup();
      await denied.cleanup();
    }
  });

  test("provider days do not move with the browser time zone, sync times do", async ({ browser }) => {
    const seeded = await seedInsights({ lastSuccessHoursAgo: 3 });
    const zones = ["Europe/Warsaw", "America/Los_Angeles"];
    const days: string[][] = [];
    const syncAt: string[] = [];
    try {
      for (const timezoneId of zones) {
        const context = await browser.newContext({ timezoneId, storageState: "./e2e/.auth/state.json", viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await gotoOk(page, `/insights?channel=${seeded.channelId}`);
        await page.locator(".ins-table summary").click();
        days.push(await page.locator(".ins-table tbody th").evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim().slice(0, 10))));
        const time = page.locator("#insights-sync time").first();
        syncAt.push(await time.getAttribute("datetime") ?? "");
        await expect(time).toContainText(timezoneId);
        await expect(page.locator(".ins-cards")).not.toContainText("%");
        await page.screenshot({ path: join(SHOTS, `zone-${timezoneId.replace("/", "-")}.png`), fullPage: true, animations: "disabled" });
        await context.close();
      }
      expect(days[0]).toEqual([-7, -6, -5, -4, -3, -2, -1].map(providerDay));
      expect(days[1]).toEqual(days[0]);
      expect(syncAt[0]).toBe(syncAt[1]);
      expect(syncAt[0]).not.toBe("");
    } finally {
      await seeded.cleanup();
    }
  });
});
