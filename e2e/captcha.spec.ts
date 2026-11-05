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
  await page.waitForFunction(() => customElements.get("altcha-widget") !== undefined);

  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();

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

test("login accepts corrected credentials after renewing a used captcha", async ({ page }) => {
  const { errors } = watchConsole(page);
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("admin@e2e.test");
  await page.locator('input[name="password"]').fill("wrong-password");
  const token = () => page.evaluate(() => new FormData(document.querySelector("form")!).get("captchaToken"));
  await expect.poll(token).toBeTruthy();
  const firstToken = await token();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#auth-error")).toContainText("Invalid email or password");
  await expect.poll(token).toBeTruthy();
  await expect.poll(token).not.toBe(firstToken);
  await page.locator('input[name="password"]').fill("e2e-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  expect(errors).toEqual([]);
});

test("login requires a valid unused widget token", async ({ page, request }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("admin@e2e.test");
  const readToken = () => page.evaluate(() => new FormData(document.querySelector("form")!).get("captchaToken"));
  await expect.poll(readToken).toBeTruthy();
  const captchaToken = String(await readToken());
  const credentials = { email: "admin@e2e.test", password: "e2e-password-123" };
  expect((await request.post("/api/auth/login", { data: credentials })).status()).toBe(400);
  const changed = JSON.parse(Buffer.from(captchaToken, "base64").toString("utf8"));
  changed.solution.counter += 1;
  const wrong = Buffer.from(JSON.stringify(changed)).toString("base64");
  expect((await request.post("/api/auth/login", { data: { ...credentials, captchaToken: wrong } })).status()).toBe(400);
  expect((await request.post("/api/auth/login", { data: { ...credentials, captchaToken } })).status()).toBe(200);
  expect((await request.post("/api/auth/login", { data: { ...credentials, captchaToken } })).status()).toBe(400);
});

test("registration submits a widget solution and creates an account", async ({ page }, testInfo) => {
  const { setPro } = await import("./helpers");
  const { Client } = await import("pg");
  const { E2E_DATABASE_URL, CAPTCHA_E2E_BASE_URL } = await import("./env");
  const { request: requestFactory } = await import("@playwright/test");
  const { errors } = watchConsole(page);
  const email = `captcha-${Date.now()}@e2e.test`;
  const admin = await requestFactory.newContext({ baseURL: CAPTCHA_E2E_BASE_URL, storageState: "./e2e/.auth/state.json" });
  try { await setPro(admin); } finally { await admin.dispose(); }
  try {
    await page.goto("/register");
    await page.locator('input[name="name"]').fill("Captcha registration");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill("e2e-password-123");
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("registration-captcha.png"), fullPage: true });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    expect(errors).toEqual([]);
  } finally {
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    try {
      await client.query("DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_members JOIN users ON users.id = user_id WHERE email = $1)", [email]);
      await client.query("DELETE FROM users WHERE email = $1", [email]);
    } finally {
      await client.end();
    }
  }
});
