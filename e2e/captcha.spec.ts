import { test, expect } from "@playwright/test";
import { watchConsole } from "./helpers";

// Regression guard for the login captcha. The widget solves its proof-of-work in a blob: web worker;
// if the app CSP does not allow that worker, the checkbox hangs on "Verifying…" and nobody can sign
// in. This drives the REAL widget in a browser against a captcha-enabled server, so it catches any
// future CSP / integration breakage — not just the specific directive the unit tests happen to name.
test("login captcha completes — its blob: worker is allowed by the CSP", async ({ page }) => {
  const { errors } = watchConsole(page);

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.locator("altcha-widget")).toBeVisible();

  // Start the proof-of-work.
  await page.getByRole("checkbox", { name: /robot/i }).click();

  // It shows "Verifying…" while the worker runs; under a CSP that blocks the worker it stays there
  // forever. Success replaces it (the widget verifies).
  await expect(page.getByText("Verifying", { exact: false })).toBeHidden({ timeout: 15_000 });

  // The definitive signal: the blob: worker was never blocked by CSP.
  const cspWorkerErrors = errors.filter((e) => /worker|content security policy|blob:/i.test(e));
  expect(cspWorkerErrors, cspWorkerErrors.join("\n")).toEqual([]);
});
