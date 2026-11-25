import { test, expect, type Page } from "@playwright/test";
import { setPro, gotoOk, watchConsole } from "./helpers";

// UXFLOW1 stage 7: Settings pages under top tabs. Screenshots go to the test output folder.
async function shoot(page: Page, base: string, prepare?: () => Promise<void>) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (prepare) await prepare();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${base}-${theme} fits`).toBe(true);
    // Every Settings tab is on screen without scrolling the tab bar (phone wraps to two rows).
    expect(await page.evaluate(() => [...document.querySelectorAll(".settings-tab")].every((t) => t.getBoundingClientRect().right <= window.innerWidth)), `${base}-${theme} tabs visible`).toBe(true);
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

test("API keys: list first, create in the side sheet with a preset, Custom shows the Read/Write table", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  await gotoOk(page, "/settings/api-keys");
  const sheet = page.locator("#api-key-sheet");
  const open = async () => {
    await page.getByRole("button", { name: "Create API key" }).click();
    await expect(sheet).toBeVisible();
  };
  await open();
  await sheet.getByLabel("Name").fill(`e2e settings ${Date.now()}`);
  await sheet.locator(".preset-card", { hasText: "Read only" }).click();
  await sheet.getByRole("button", { name: "Create key" }).click();
  await expect(page.locator(".key-created")).toContainText("Copy this key now");
  await expect(sheet).toBeHidden();
  await expect(page.locator(".key-row").first()).toContainText("Read only");

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await shoot(page, testInfo.outputPath(`api-keys-${width}`));
    await shoot(page, testInfo.outputPath(`api-keys-sheet-${width}`), async () => {
      await open();
      await sheet.locator(".preset-card", { hasText: "Custom" }).click();
      await expect(sheet.locator("table.scope-mx")).toBeVisible();
    });
  }
  expect(errors).toEqual([]);
});

test("Integrations: one service per page, keys saved together, one key reverted to env", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  await gotoOk(page, "/settings/integrations/reelstack");
  const field = page.locator(".int-field", { hasText: "REELSTACK_WEBHOOK_SECRET" });
  await field.locator("input").fill("e2e-reelstack-secret");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#int-detail")).toContainText("Saved 1 value.");
  await expect(field).toContainText("set here");
  await expect(page.locator(".int-item[aria-current='page']")).toContainText("Set up");
  await field.getByRole("button", { name: "Use environment value" }).click();
  await expect(page.locator("#int-detail")).toContainText("Reverted to the environment variable.");
  await expect(page.locator(".int-field", { hasText: "REELSTACK_WEBHOOK_SECRET" })).toContainText("not set");

  await gotoOk(page, "/settings/integrations/meta");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await shoot(page, testInfo.outputPath(`integrations-meta-${width}`));
  }
  await gotoOk(page, "/settings/integrations");
  await shoot(page, testInfo.outputPath("integrations-list-390"));
  await expect(page.locator(".int-item")).toHaveCount(10);
  expect(errors).toEqual([]);
});

test("old #hash links land on the new pages; AI page on a phone", async ({ page }, testInfo) => {
  await setPro(page.request);
  await gotoOk(page, "/settings#automation");
  await page.waitForURL((url) => url.pathname === "/settings/ai");
  await expect(page.locator(".settings-tab.active")).toHaveText("AI");
  await gotoOk(page, "/settings#sources");
  await page.waitForURL((url) => url.pathname === "/channels");
  await expect(page.locator("#sources")).toContainText("Managed connections");
  await gotoOk(page, "/settings/ai");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await shoot(page, testInfo.outputPath(`ai-${width}`));
  }
});


test("X publishing credentials save in Integrations and show their source", async ({ page }, testInfo) => {
  await gotoOk(page, "/settings/integrations/x");
  await page.locator('[name="X_CLIENT_ID"]').fill("e2e-x-client");
  await page.locator('[name="X_CLIENT_SECRET"]').fill("e2e-x-secret");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#int-detail")).toContainText("Saved 2 values.");
  await expect(page.locator(".int-detail-head")).toContainText("Set up via Settings");
  await expect(page.locator(".int-field", { hasText: "X_CLIENT_SECRET" })).toContainText("set here");
  expect(await page.content()).not.toContain("e2e-x-secret");
  await page.reload();
  await expect(page.locator(".int-detail-head")).toContainText("Set up via Settings");
  await page.screenshot({ path: testInfo.outputPath("x-settings.png") });
  for (const key of ["X_CLIENT_SECRET", "X_CLIENT_ID"]) {
    await page.locator(".int-field", { hasText: key }).getByRole("button", { name: "Use environment value" }).click();
    await expect(page.locator("#int-detail")).toContainText("Reverted to the environment variable.");
  }
});

test("API key validation keeps the sheet, name and custom permissions until successful retry", async ({ page }, testInfo) => {
  await setPro(page.request);
  await gotoOk(page, "/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  const sheet = page.locator("#api-key-sheet");
  const name = "x".repeat(101);
  await sheet.getByLabel("Name", { exact: true }).fill(name);
  await sheet.locator(".preset-card", { hasText: "Custom" }).click();
  await sheet.getByRole("button", { name: "Deselect all" }).click();
  const scope = sheet.locator('[data-api-scope][value="brands:read"]');
  await scope.check();
  const response = page.waitForResponse((r) => r.url().endsWith("/settings/api-keys") && r.request().method() === "POST");
  await sheet.getByRole("button", { name: "Create key", exact: true }).click();
  expect((await response).status()).toBe(422);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("alert")).toContainText("Name must be at most 100 characters.");
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(sheet.locator('[name="preset"][value="custom"]')).toBeChecked();
  await expect(scope).toBeChecked();
  await expect(sheet.locator('[data-api-scope]:checked')).toHaveCount(1);
  await expect(sheet.getByRole("alert")).toBeFocused();
  await expect(sheet.getByRole("alert")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("api-key-validation.png") });
  await sheet.getByLabel("Name", { exact: true }).fill("e2e corrected key");
  await sheet.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator(".key-created")).toBeVisible();
  await page.getByRole("button", { name: "Create API key" }).click();
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(sheet.locator('[name="preset"][value="publishing"]')).toBeChecked();
});


test("callback URLs wrap on a small phone and copy in full", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 320, height: 800 });
  await gotoOk(page, "/settings/integrations/meta");
  const code = page.locator(".int-url code").filter({ hasText: "/api/oauth/instagram-login/callback" });
  await expect(code).toBeVisible();
  expect(await code.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await code.evaluate(el => el.clientWidth));
  const url = await code.textContent();
  await code.locator("..").getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
});

test("API key rate limit is shown inside the open sheet", async ({ page }) => {
  await setPro(page.request);
  await gotoOk(page, "/settings/api-keys");
  let postCount = 0;
  await page.route("**/settings/api-keys", route => {
    if (route.request().method() !== "POST") return route.continue();
    if (++postCount === 1) return route.fulfill({ status: 429, body: "Too many requests" });
    return route.fulfill({
      status: 429, contentType: "text/html",
      headers: { "HX-Retarget": "#api-key-error", "HX-Reswap": "innerHTML" },
      body: '<div class="notice notice-err">Too many API key creations. Try again later.</div>',
    });
  });
  await page.getByRole("button", { name: "Create API key" }).click();
  const sheet = page.locator("#api-key-sheet");
  await sheet.getByLabel("Name", { exact: true }).fill("Rate limit fixture");
  const create = sheet.getByRole("button", { name: "Create key", exact: true });
  await create.click();
  await expect(sheet.locator(".modal-feedback")).toHaveText("Too many requests. Wait and try again.");
  await create.click();
  await expect(sheet.getByRole("alert")).toHaveText("Too many API key creations. Try again later.");
  await expect(sheet.getByRole("alert")).toBeFocused();
});

test("a missing dashboard detail uses the dashboard layout", async ({ page }) => {
  const response = await page.goto("/queue/not-a-delivery");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator("#main .errpage-card")).toBeVisible();
});
