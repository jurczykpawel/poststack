import { test, expect } from "@playwright/test";
import { watchConsole } from "./helpers";

// Each browser context is a separate login attempt scenario, but the server sees one test IP.
// Reset only its login bucket; CAPTCHA single-use counters remain intact.
test.beforeEach(async () => {
  const { Client } = await import("pg");
  const { E2E_DATABASE_URL } = await import("./env");
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try { await client.query("DELETE FROM rate_limit_counters WHERE key = $1", ["rl:login:unknown"]); }
  finally { await client.end(); }
});

// Exercise the real invisible widget and worker under the application CSP.
test("invisible login captcha auto-solves on load without interaction", async ({ page }) => {
  const { errors } = watchConsole(page);

  await page.goto("/login", { waitUntil: "domcontentloaded" });

  const widget = page.locator("altcha-widget");
  await expect(widget).toBeAttached();
  await expect(widget, "captcha must be invisible (no checkbox)").toBeHidden();
  await page.waitForFunction(() => customElements.get("altcha-widget") !== undefined);




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
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/captcha/challenge", async (route) => { await held; await route.continue(); });
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/register") posts++; });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  try {
    await page.goto("/register");
    await page.locator('input[name="name"]').fill("Captcha registration");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill("e2e-password-123");
    await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("registration-captcha.png"), fullPage: true });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    expect(posts).toBe(0);
    release();
    await expect(page).toHaveURL(/\/inbox$/);
    expect(posts).toBe(1);
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    release();
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

for (const theme of ["dark", "light"]) {
  for (const width of [390, 1440]) {
    test(`early login waits inline and posts once (${theme} ${width})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((theme) => { document.cookie = `ps_theme=${theme}; path=/`; }, theme);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/captcha/challenge", async (route) => { await held; await route.continue(); });
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      let posts = 0;
      page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/login") posts++; });
      try {
        await page.goto("/login");
        await page.locator('[name="email"]').fill("admin@e2e.test");
        await page.locator('[name="password"]').fill("e2e-password-123");
        await page.getByRole("button", { name: "Sign in" }).click({ timeout: 3000 });
        await expect(page.getByRole("button", { name: "Verifying…" })).toBeDisabled();
        expect(posts).toBe(0);
        expect(dialogs).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`verifying-${theme}-${width}.png`), fullPage: true });
        await page.locator('[name="password"]').press("Enter");
        release();
        await expect(page).toHaveURL(/\/inbox$/);
        expect(posts).toBe(1);
        expect(dialogs).toEqual([]);
      } finally { release(); }
    });
  }
}

test("challenge failure restores submit and allows retry inline", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/captcha/challenge", async (route) => {
    await held;
    await route.fulfill({ status: 503, body: "unavailable" });
  });
  try {
    await page.goto("/login");
    await page.locator('[name="email"]').fill("admin@e2e.test");
    await page.locator('[name="password"]').fill("e2e-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    release();
    await expect(page.locator("#auth-error")).toContainText("Verification failed");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await page.unroute("**/api/captcha/challenge");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  } finally { release(); }
});

test("captcha waiting flow still validates credential fields before submitting", async ({ page }) => {
  let posts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/login") posts++; });
  await page.goto("/login");
  await page.locator('[name="email"]').fill("invalid-email");
  await page.locator('[name="password"]').fill("e2e-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('[name="email"]')).toBeFocused();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(posts).toBe(0);
});
