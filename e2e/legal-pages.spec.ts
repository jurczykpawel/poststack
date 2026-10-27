import { test, expect } from "@playwright/test";

// Public pages must remain usable without a dashboard session or opening the mobile menu.
test.use({ storageState: { cookies: [], origins: [] } });

for (const width of [1440, 390]) {
  for (const path of ["/", "/privacy", "/terms"]) {
    test(`public legal navigation at ${path} (${width}px)`, async ({ page, baseURL }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === new URL(baseURL!).origin) {
          return route.continue();
        }
        return route.abort();
      });
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      const footer = page.locator("footer");
      await footer.getByRole("link", { name: "Privacy", exact: true }).scrollIntoViewIfNeeded();
      for (const [label, href] of [["Privacy", "/privacy"], ["Terms", "/terms"]]) {
        const link = footer.getByRole("link", { name: label, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", href);
        await expect(link).toBeInViewport();
        expect(await link.evaluate((el) => el.closest("details") === null)).toBe(true);
      }
      const dimensions = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

      if (path === "/") {
        await expect(page.locator("#capabilities")).toContainText(/publish|schedul/i);
        await expect(page.locator("main")).toContainText("TikTok");
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(page.locator("header").getByRole("link", { name: "PostStack home" })).toBeInViewport();
        await expect(page.locator("header").getByRole("img", { name: "PostStack logo" })).toBeVisible();
        const favicon = page.locator('link[rel="icon"]');
        await expect(favicon).toHaveAttribute("href", "/favicon.svg");
        expect((await page.request.get("/favicon.svg")).status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          path === "/terms" ? "Terms of Service" : "Privacy Policy",
        );
        await expect(page.locator("main")).toContainText("TikTok");
        await expect(page.locator("main")).toContainText("kontakt@techskills.academy");
        await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-${width}.png`), fullPage: true });
      }
      await footer.getByRole("link", { name: path === "/terms" ? "Privacy" : "Terms", exact: true }).click();
      await expect(page).toHaveURL(path === "/terms" ? /\/privacy$/ : /\/terms$/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }
}
