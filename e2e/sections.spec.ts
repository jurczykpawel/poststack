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
        if (route.key === "overview") await expect(pageHeading).toContainText("Overview");
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

    // ── sidebar nav gating: feature-gated items render as 🔒 PRO locks in FREE, real links in PRO ──
    test(`${state} · sidebar feature-gated items show correct lock state`, async ({ page }) => {
      await gotoOk(page, "/overview");
      // Sources carries feature managed_connection (core-area, always visible). In FREE the sidebar
      // renders it as .nav-locked; in PRO as a real .nav-item link.
      const locked = page.locator(".sidebar .nav-locked");
      // Brands is OPEN-CORE (free gets one brand) → ALWAYS a real link in both states, never locked;
      // otherwise the brand column on /channels points at an unreachable page.
      await expect(page.locator(".sidebar a.nav-item[href='/brands']")).toHaveCount(1);
      if (state === "free") {
        await expect(locked.first()).toBeVisible();
        // The Sources sidebar entry is a lock (→ upgrade URL), not a link to /sources.
        await expect(page.locator(".sidebar a.nav-item[href='/sources']")).toHaveCount(0);
      } else {
        await expect(locked).toHaveCount(0);
        await expect(page.locator(".sidebar a.nav-item[href='/sources']")).toHaveCount(1);
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
