import { test, expect } from "@playwright/test";
import { setFree, setPro, watchConsole, gotoOk } from "./helpers";
import { API_SCOPE_PRESETS, API_SCOPES } from "../src/lib/auth/scopes";

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

      const ruleRows = page.locator("#rules-list tbody tr");
      const before = await ruleRows.count();

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
      await expect(ruleRows).toHaveCount(before + 1);
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
        const brandField = page.locator("label.fld").filter({ has: page.locator("select[aria-label='Brand']") });
        await brandField.locator("button.ps-trigger").click();
        await brandField.getByRole("option").nth(1).click();
        // The compose form exists (json-driven). Just assert the submit affordance rendered and no
        // console errors — a full publish needs storage/worker, out of scope for UI gating.
        const submit = page.locator("form.compose-form button[type='submit']");
        await expect(submit).toBeVisible();
        await expect(submit).toContainText("Create & open");
        expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
      });

      test(`pro · API key scope presets replace the selection predictably`, async ({ page }) => {
        const { errors } = watchConsole(page);
        await gotoOk(page, "/settings#apikeys");

        const form = page.locator("form[data-api-key-form]");
        const create = form.getByRole("button", { name: "Create API key" });
        const checked = form.locator("input[data-api-scope]:checked");
        const serialized = form.locator("input[name='scopes_json']");

        await expect(create).toBeDisabled();
        await expect(checked).toHaveCount(0);

        for (const preset of API_SCOPE_PRESETS) {
          await form.getByRole("button", { name: preset.label, exact: true }).click();
          await expect(checked).toHaveCount(preset.scopes.length);
          await expect(serialized).toHaveValue(JSON.stringify(preset.scopes));
        }

        await form.getByRole("button", { name: "Deselect all", exact: true }).click();
        await expect(checked).toHaveCount(0);
        await expect(serialized).toHaveValue("[]");
        await expect(create).toBeDisabled();

        await form.getByRole("button", { name: "Select all", exact: true }).click();
        await expect(checked).toHaveCount(API_SCOPES.length);
        await expect(serialized).toHaveValue(JSON.stringify(API_SCOPES));
        await expect(create).toBeEnabled();
        expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
      });
    }
  });
}
