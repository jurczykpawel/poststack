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
