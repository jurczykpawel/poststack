import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
for (const theme of ["light", "dark"] as const) {
  test(`application logo in ${theme}`, async ({ browser, baseURL }, info) => {
    const directory = process.env.PUBLIC_SITE_SHOTS ?? info.outputDir;
    await mkdir(directory, { recursive: true });
    const context = await browser.newContext({ storageState: "e2e/.auth/state.json", viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await context.addCookies([{ name: "ps_theme", value: theme, url: baseURL! }]);
    const page = await context.newPage();
    await page.goto("/overview");
    await expect(page.locator('.brand img[alt="PostStack"]')).toHaveJSProperty("naturalWidth", 32);
    await page.screenshot({ path: `${directory}/overview-${theme}.png`, fullPage: true });
    await context.clearCookies();
    await page.goto("/login");
    await expect(page.locator('h1 img[alt="PostStack"]')).toHaveJSProperty("naturalWidth", 32);
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.screenshot({ path: `${directory}/login-${theme}.png`, fullPage: true });
    await context.close();
  });
}
