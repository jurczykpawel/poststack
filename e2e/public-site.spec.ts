import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const paths = ["/", "/features", "/how-it-works", "/faq", "/about", "/contact", "/privacy", "/terms", "/data-deletion"];
const captures = ["/", "/features", "/how-it-works", "/privacy"];
for (const width of [390, 1280, 1440]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`public pages at ${width}px in ${colorScheme}, without scripts`, async ({ browser }, info) => {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, javaScriptEnabled: false, viewport: { width, height: 900 }, colorScheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      for (const path of paths) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator("h1")).toHaveCount(1);
        await expect(page.locator("footer")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const image of await page.locator("img").all()) {
          await image.scrollIntoViewIfNeeded();
          await expect(image).toHaveJSProperty("complete", true);
        }
        await page.evaluate(() => document.fonts.ready);
        expect(await page.locator("img").evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
        await page.evaluate(() => scrollTo(0, 0));
        const menu = page.locator(".site-menu");
        await menu.locator("summary").click();
        await expect(menu.getByRole("link", { name: "Privacy", exact: true })).toBeVisible();
        await menu.locator("summary").click();
        if (captures.includes(path)) {
          const dir = process.env.PUBLIC_SITE_SHOTS ?? info.outputDir;
          await mkdir(dir, { recursive: true });
          await page.screenshot({ path: `${dir}/${path.replaceAll("/", "") || "home"}-${width}-${colorScheme}.png`, fullPage: true });
        }
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("public navigation, theme and operator contact work from the keyboard", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Make room for your next post." })).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  const summary = page.locator(".site-menu summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".site-menu")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
  await expect(page.locator(".site-menu")).not.toHaveAttribute("open", "");
  await page.getByLabel("Change colour theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/contact");
  await page.getByRole("button", { name: "Show contact email" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "operator@example.com" })).toBeFocused();
  await context.close();
});
