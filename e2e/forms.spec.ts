import { test, expect } from "@playwright/test";
import { setFree, setPro, watchConsole, gotoOk } from "./helpers";

// Real FORM SUBMITS — the path GET/200 checks miss. The whole reason for this suite: a missing
// htmx json-enc extension silently breaks every json-enc form (the JSON-only handlers reject the
// fallback form-encoding). The Rules "+ New rule" form posts via hx-ext="json-enc"; submitting it and
// asserting the new row appears is the canonical regression for that bug class.

for (const state of ["free", "pro"] as const) {
  test.describe.serial(`forms · license=${state}`, () => {
    test.beforeEach(async ({ page }) => {
      if (state === "pro") await setPro(page.request);
      else await setFree(page.request);
    });

    test(`${state} · create a rule via json-enc form → row appears`, async ({ page }) => {
      const { errors } = watchConsole(page);
      await gotoOk(page, "/rules");

      const before = await page.locator("#rules-list .list-row").count();

      // Open the collapsible "+ New rule" form.
      await page.getByText("+ New rule", { exact: true }).click();
      const ruleName = `E2E rule ${state} ${Date.now()}`;
      await page.locator("form input[name='name']").fill(ruleName);
      await page.locator("form input[name='keywords']").fill("hello, hi");
      await page.locator("form textarea[name='text']").fill("Auto reply from e2e");
      await page.getByRole("button", { name: "Create rule" }).click();

      // The list (#rules-list) is swapped in place with the new row — proof the json-enc POST was
      // accepted (a json-enc regression would leave the row count unchanged / show an error notice).
      await expect(page.locator("#rules-list")).toContainText(ruleName);
      await expect.poll(() => page.locator("#rules-list .list-row").count()).toBe(before + 1);
      await expect(page.locator("#rules-list .notice-err")).toHaveCount(0);

      expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
    });

    if (state === "free") {
      // Regression: a free workspace already has its 1 allowed brand (seeded), so creating a 2nd hits
      // LIMITS.free.brands=1. This MUST surface as a friendly in-page notice — NOT a 500 (the bug the
      // owner hit: createWithinLimit threw LimitExceededError, uncaught on the HTML /brands route).
      test(`free · creating a 2nd brand shows the limit notice, never a 500`, async ({ page }) => {
        const { errors } = watchConsole(page);
        await gotoOk(page, "/brands");
        await page.locator("form.brand-new-form input[name='key']").fill(`e2e-free-${Date.now()}`);
        await page.locator("form.brand-new-form input[name='name']").fill("E2E Free Overflow");
        const resp = await Promise.all([
          page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/brands")),
          page.getByRole("button", { name: "Create brand" }).click(),
        ]).then(([r]) => r);
        expect(resp.status(), "limit hit → 402, not 500").toBe(402);
        // the re-rendered page (shell intact) shows the upgrade notice, not a raw error page
        await expect(page.locator(".notice-err")).toContainText(/brand/i);
        await expect(page.locator(".sidebar")).toBeVisible();
        await expect(page.locator("body")).not.toContainText("Internal Server Error");
        // the browser logs the intentional 402 as a resource error — that one is expected; assert no OTHERS
        const unexpected = errors.filter((e) => !/402|Payment Required/.test(e));
        expect(unexpected, `unexpected console errors:\n${unexpected.join("\n")}`).toEqual([]);
      });
    }

    if (state === "pro") {
      test(`pro · create a brand (plain POST) → brand appears`, async ({ page }) => {
        const { errors } = watchConsole(page);
        await gotoOk(page, "/brands");
        const key = `e2e-pro-${Date.now()}`;
        await page.locator("form.brand-new-form input[name='key']").fill(key);
        await page.locator("form.brand-new-form input[name='name']").fill("E2E PRO Brand");
        await page.getByRole("button", { name: "Create brand" }).click();
        // 303 → back to /brands; the new brand is listed.
        await page.waitForURL((url) => url.pathname === "/brands");
        await expect(page.locator("body")).toContainText(key);
        expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
      });

      test(`pro · compose form is reachable with a brand present`, async ({ page }) => {
        const { errors } = watchConsole(page);
        await gotoOk(page, "/compose");
        // The compose form exists (json-driven). Just assert the submit affordance rendered and no
        // console errors — a full publish needs storage/worker, out of scope for UI gating.
        await expect(page.getByRole("button", { name: /Create.*publish/i })).toBeVisible();
        expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
      });
    }
  });
}
