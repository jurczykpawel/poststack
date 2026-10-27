import { test, expect } from "@playwright/test";
import { setFree, setPro, assertTier, watchConsole, gotoOk } from "./helpers";
import { navRoutes, featureUnlocked, PAGE_LOCKED_WHEN_LOCKED, REDIRECTS } from "./routes";

// Every nav route, swept in BOTH license states. The license is instance-global and toggled via the
// app's own /api/v1/license endpoint (PROOF the gate flips live, not a stub). Server-rendered checks
// alone are insufficient — each route is driven in a real browser: navigation + console-error capture
// + gating assertions, plus real form submits (the path that catches json-enc-class bugs).

const STATES = ["free", "pro"] as const;

for (const state of STATES) {
  test.describe.serial(`license=${state}`, () => {
    // Set the instance license before each test via page.request (which shares the logged-in session
    // cookie from storageState). The license is instance-global; re-asserting per test is idempotent
    // and keeps the two serial state-blocks from leaking into each other.
    test.beforeEach(async ({ page }) => {
      if (state === "pro") await setPro(page.request);
      else await setFree(page.request);
    });

    test(`license toggle took (${state})`, async ({ page }) => {
      await assertTier(page.request, state === "pro" ? "business" : null);
    });

    // ── every nav route renders without an error page and without console errors ──────────────
    for (const route of navRoutes()) {
      test(`${state} · ${route.href} renders cleanly`, async ({ page }) => {
        const { errors } = watchConsole(page);
        await gotoOk(page, route.href);

        // api-keys redirects to settings (no own page) — assert the landing, not a dead link.
        if (REDIRECTS[route.key]) {
          await page.waitForURL((url) => url.pathname === REDIRECTS[route.key]);
        }

        // A few stable text anchors per area so we know real content rendered (not a blank/error).
        // The topbar carries a brand-suffixed <h1>; the page body has its own <h1> — scope to the
        // main content region to target the page heading, not the topbar title.
        const pageHeading = page.locator("main.content h1");
        if (route.key === "overview") {
          await expect(pageHeading).toContainText("Overview");
          if (state === "free" && process.env.E2E_SCREENSHOT) {
            await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
          }
        }
        if (route.key === "settings") await expect(pageHeading).toContainText("Settings");

        // Gating: pages that lock the WHOLE page when their feature is locked.
        if (route.feature && PAGE_LOCKED_WHEN_LOCKED.has(route.key)) {
          const unlocked = featureUnlocked(state, route.feature);
          const lockBadge = page.locator("main.content h1 .badge", { hasText: "PRO" });
          const upgradeBtn = page.getByRole("link", { name: /Upgrade to PRO/i });
          if (unlocked) {
            // PRO: the real feature UI, no full-page upsell.
            await expect(lockBadge).toHaveCount(0);
          } else {
            // FREE: the proLockMain upsell card.
            await expect(lockBadge.first()).toBeVisible();
            await expect(upgradeBtn.first()).toBeVisible();
          }
        }

        expect(errors, `console errors on ${route.href}:\n${errors.join("\n")}`).toEqual([]);
      });
    }

    // ── sidebar nav gating: feature-gated items render as 🔒 PRO locks in FREE ─────────────────
    test(`${state} · sidebar feature-gated items show correct lock state`, async ({ page }) => {
      await gotoOk(page, "/overview");
      const locked = page.locator(".sidebar .nav-locked");
      // Brands is OPEN-CORE (free gets one brand) → ALWAYS a real link in both states, never locked;
      // otherwise the brand column on /channels points at an unreachable page.
      await expect(page.locator(".sidebar a.nav-item[href='/brands']")).toHaveCount(1);
      // Managed connections moved to Settings → Sources. The legacy /sources path redirects there,
      // but it must not reappear as a duplicate top-level sidebar destination in either tier.
      await expect(page.locator(".sidebar a.nav-item[href='/sources']")).toHaveCount(0);
      await expect(page.locator(".sidebar a.sidebar-foot[href='/settings']")).toHaveCount(1);
      if (state === "free") {
        await expect(locked.first()).toBeVisible();
      } else {
        await expect(locked).toHaveCount(0);
      }
    });

    // ── command palette: filters to entitled destinations only ────────────────────────────────
    test(`${state} · command palette lists entitled destinations`, async ({ page }) => {
      await gotoOk(page, "/overview");
      await page.keyboard.press("Meta+k");
      const palette = page.locator(".cmdk");
      await expect(palette).toBeVisible();
      // Inbox is a replies destination; in both states the replies wing is visible (free shows both
      // wings, locked-by-feature) so the palette offers it. Settings is always present.
      await page.locator(".cmdk-search input").fill("settings");
      await expect(page.locator(".cmdk-item")).toContainText(["Settings"]);
      await page.locator(".cmdk-search input").fill("overview");
      await expect(page.locator(".cmdk-item").first()).toContainText("Overview");
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
    });
  });
}

test("compose media URL fills the phone form", async ({ page }) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/compose");
  const input = page.getByLabel("Media URL");
  await expect(input).toBeVisible();
  const geometry = await input.evaluate((el) => ({
    input: el.getBoundingClientRect().width,
    label: el.closest("label")!.getBoundingClientRect().width,
    row: el.closest(".media-row")!.getBoundingClientRect().width,
  }));
  expect(geometry.input).toBeGreaterThanOrEqual(geometry.row - 2);
  expect(geometry.label).toBeGreaterThanOrEqual(geometry.row - 2);
});

test("privacy cookie table scrolls within the phone page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/privacy");
  const geometry = await page.locator(".cookie-table").evaluate((el) => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    overflow: getComputedStyle(el.parentElement!).overflowX,
  }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.overflow).toBe("auto");
});

test("incoming webhook callback wraps within the phone page", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/webhooks");
  const callback = page.locator("code.mono").filter({ hasText: "/api/webhooks/meta" });
  await expect(callback).toBeVisible();
  // Include a longer deployment hostname than the loopback test server uses.
  await callback.evaluate((el) => { el.textContent = `https://${"poststack".repeat(7)}.example.com/api/webhooks/meta`; });
  const geometry = await callback.evaluate((el) => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    wrap: getComputedStyle(el).overflowWrap,
  }));
  expect(geometry.page, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.wrap).toBe("anywhere");
  await page.screenshot({ path: testInfo.outputPath("webhooks-phone.png"), fullPage: true });
});

for (const width of [1440, 390]) {
  test(`menu navigation and sign out/in have no page errors at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await setPro(page.request);
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const signIn = async () => {
      await page.locator('input[name="email"]').fill("admin@e2e.test");
      await page.locator('input[name="password"]').fill("e2e-password-123");
      await page.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.locator(".topbar h1")).toContainText("Inbox");
    };
    // Use a fresh session so sign-out never revokes the shared setup fixture.
    await gotoOk(page, "/login");
    await signIn();
    for (const route of navRoutes()) {
      if (width === 390) {
        await page.getByRole("button", { name: "Open command palette" }).click();
        await page.locator(".cmdk-search input").fill(route.href.slice(1));
        await page.locator(".cmdk-item").filter({ has: page.locator(".cmdk-label", { hasText: new RegExp(`^${route.key}$`, "i") }) }).click();
      } else {
        await page.locator(`.sidebar a[href='${route.href}']`).click();
      }
      await expect(page).toHaveURL(new RegExp(`${route.href}$`));
      await expect(page.locator(".topbar h1")).toContainText(new RegExp(route.key, "i"));
      // Let both navigation and load-triggered fragments finish before leaving.
      await page.evaluate(async () => {
        const doc = document as Document & { activeViewTransition?: { finished: Promise<void> } };
        await doc.activeViewTransition?.finished;
      });
      if (route.key === "webhooks") {
        await expect(page.locator('#wh-outbound[hx-trigger="load"]')).toHaveCount(0);
      }
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn();
    expect(errors).toEqual([]);
  });
}
