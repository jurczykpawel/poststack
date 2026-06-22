import { test, expect } from "@playwright/test";
import { watchConsole } from "./helpers";

// Regression guard for the login captcha. The widget is INVISIBLE and auto-solves its proof-of-work
// in a blob: web worker when the form gains focus (no checkbox to click). Two things must hold and
// both are exercised in a real browser against a captcha-enabled server:
//   1. the widget renders but is not visible (invisible mode), and
//   2. focusing the form produces a captchaToken the form will submit — which only happens if the CSP
//      lets the blob: worker run. A CSP that blocks the worker leaves the token empty (the regression).
test("invisible login captcha auto-solves on focus and submits a token", async ({ page }) => {
  const { errors } = watchConsole(page);

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  const widget = page.locator("altcha-widget");
  await expect(widget).toBeAttached();
  await expect(widget, "captcha must be invisible (no checkbox)").toBeHidden();

  // Focus the form — this is what triggers the background proof-of-work (auto="onfocus").
  await page.locator('input[name="email"]').click();

  // The solved token lands on the form (form-associated), so it submits with the credentials. Reading
  // it via FormData is implementation-agnostic (light DOM or shadow). Empty under a worker-blocking CSP.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const form = document.querySelector("form");
          return form ? new FormData(form).get("captchaToken") : null;
        }),
      { timeout: 15_000, message: "captcha never produced a token (worker blocked?)" },
    )
    .toBeTruthy();

  const cspWorkerErrors = errors.filter((e) => /worker|content security policy|blob:/i.test(e));
  expect(cspWorkerErrors, cspWorkerErrors.join("\n")).toEqual([]);
});
