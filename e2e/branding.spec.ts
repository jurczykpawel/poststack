import { test, expect } from "@playwright/test";
import { setFree, setPro, gotoOk, watchConsole } from "./helpers";

test.describe.serial("instance branding", () => {
  test.afterEach(async ({ request }) => {
    await setPro(request);
    expect((await request.post("/settings/branding", { data: { reset: true } })).ok()).toBe(true);
    await setFree(request);
  });

  test("free operator sees the Business requirement and cannot save", async ({ page }) => {
    await setFree(page.request);
    await gotoOk(page, "/settings#integrations");
    await expect(page.getByText("A Business license enables custom branding.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save instance branding" })).toHaveCount(0);
    const response = await page.request.post("/settings/branding", { data: { name: "Orchard" } });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("pro_required");
  });

  for (const width of [1440, 390]) {
    test(`operator saves and renders the instance at ${width}px`, async ({ page, browser }, testInfo) => {
      await setPro(page.request);
      await page.setViewportSize({ width, height: 950 });
      const { errors } = watchConsole(page);
      await gotoOk(page, "/settings#integrations");
      await page.getByLabel("Product name").fill("Orchard Social");
      await page.getByLabel("Logo URL (HTTPS or local path)").fill("/instance-favicon.svg");
      await page.getByLabel("Favicon URL (blank generates an icon)").fill("");
      await page.getByLabel("Accent colour").fill("#4263d5");
      await page.getByLabel("Default theme").selectOption("light");
      await page.getByLabel("Contact email").fill("help@orchard.example");
      await page.getByLabel("Public origin (HTTPS)").fill("https://orchard.example");
      await page.getByLabel("Footer text").fill("Orchard team");
      await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/settings/branding") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Save instance branding", exact: true }).click(),
      ]);
      await expect(page).toHaveTitle(/Orchard Social/);
      await expect(page.getByLabel("Product name")).toHaveValue("Orchard Social");
      await gotoOk(page, "/overview");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      expect(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim())).toBe("#4263d5");
      expect(await page.content()).not.toContain("PostStack");
      await page.screenshot({ path: testInfo.outputPath(`dashboard-${width}.png`), fullPage: true });

      const context = await browser.newContext({ viewport: { width, height: 950 } });
      try {
        const publicPage = await context.newPage();
        for (const path of ["/", "/privacy", "/terms", "/login"]) {
          const response = await publicPage.goto(new URL(path, page.url()).href);
          expect(response?.status()).toBe(200);
          await expect(publicPage).toHaveTitle(/Orchard Social/);
          expect(await publicPage.content()).not.toContain("PostStack");
          await expect(publicPage.locator('link[rel="icon"]')).toHaveAttribute("href", "/instance-favicon.svg");
          await expect(publicPage.getByRole("link", { name: "Privacy", exact: true })).toBeVisible();
          await expect(publicPage.getByRole("link", { name: "Terms", exact: true })).toBeVisible();
          expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await publicPage.screenshot({ path: testInfo.outputPath(`public-${path.replaceAll("/", "") || "home"}-${width}.png`), fullPage: true });
        }
        const favicon = await context.request.get(new URL("/instance-favicon.svg", page.url()).href);
        expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
        expect(await favicon.text()).toContain("#4263d5");
      } finally { await context.close(); }
      expect(errors).toEqual([]);
      await gotoOk(page, "/settings#integrations");
      await page.getByRole("button", { name: "Reset stored branding" }).click();
      await expect(page).toHaveTitle(/PostStack/);
      await expect(page.getByLabel("Product name")).toHaveValue("PostStack");
    });
  }
});
