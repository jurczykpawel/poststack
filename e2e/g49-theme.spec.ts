import { test, expect } from "@playwright/test";
import { gotoOk } from "./helpers";

for (const width of [390, 1440]) {
  test(`Compose select colors follow theme without reload at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.context().addCookies([{ name: "ps_theme", value: "dark", url: info.project.use.baseURL! }]);
    await gotoOk(page, "/compose");
    for (const theme of ["dark", "light", "dark"]) {
      await page.mouse.move(0, 0);
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        const colors = await page.evaluate(() => {
          const controls = Array.from(document.querySelectorAll(".ps-trigger"));
          controls.forEach(el => getComputedStyle(el).backgroundColor);
          (document.querySelector(".theme-toggle") as HTMLButtonElement).click();
          return controls.map(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
        });
        for (const color of colors) {
          expect(color.bg).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(29, 30, 42)");
          expect(color.fg).toBe(theme === "light" ? "rgb(24, 27, 44)" : "rgb(200, 208, 242)");
        }
      }
      await page.mouse.move(0, 0);
      for (const name of ["Brand", "Content type"]) {
        const trigger = page.getByRole("button", { name, exact: true });
        await expect(trigger).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(29, 30, 42)");
        await expect(trigger).toHaveCSS("color", theme === "light" ? "rgb(24, 27, 44)" : "rgb(200, 208, 242)");
        await trigger.click();
        await expect(page.locator(".ps-select.open .ps-panel")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(43, 45, 65)");
        await page.screenshot({ path: info.outputPath(`${width}-${theme}-${name}.png`), animations: "disabled" });
        await trigger.press("Escape");
      }
    }
  });
}
