import { test, expect } from "@playwright/test";
import { PUBLIC_PAGES } from "../src/server/ui/public-site/pages";

test.use({ storageState: { cookies: [], origins: [] } });
for (const width of [1440, 390]) {
  test(`public instance navigation and contact (${width}px)`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    for (const { path, title } of PUBLIC_PAGES) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(await response!.text()).not.toContain("kontakt@techskills.academy");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.locator("header").getByRole("link", { name: "Open the app" })).toHaveAttribute("href", "/login");
      for (const region of ["header", "footer"]) {
        for (const p of PUBLIC_PAGES) await expect(page.locator(region).getByRole("link", { name: p.label, exact: true })).toBeVisible();
      }
      const links = await page.locator('a[href^="/"]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute("href")!))]);
      for (const link of links) expect((await request.get(link)).status(), link).toBe(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === "/contact") {
        await page.getByRole("button", { name: "Show contact email" }).click();
        await expect(page.getByRole("link", { name: "kontakt@techskills.academy" })).toHaveAttribute("href", "mailto:kontakt@techskills.academy");
      }
      if (path === "/" || path === "/privacy") {
        await page.screenshot({ path: testInfo.outputPath(`public-${path === "/" ? "home" : "privacy"}-${width}.png`), fullPage: true });
      }
    }
    await page.locator("header").getByRole("link", { name: "Features", exact: true }).click();
    await expect(page).toHaveURL(/\/features$/);
  });
}
