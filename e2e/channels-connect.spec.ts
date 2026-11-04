import { test, expect, type Page } from "@playwright/test";
import { setPro, setFree, gotoOk, watchConsole } from "./helpers";

// CHANUX1: "+ Connect channel" in the page header opens a side sheet of platform tiles.
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function shoot(page: Page, base: string, prepare?: () => Promise<void>) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (prepare) await prepare();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${base}-${theme} fits`).toBe(true);
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

const cta = (page: Page) => page.locator(".ch-connect-cta");
const sheet = (page: Page) => page.locator("#connect-sheet");

test("CTA above the fold, sheet opens and closes with Esc, ?connect=1 deep link, footer links", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await gotoOk(page, "/channels");
    const box = await cta(page).boundingBox();
    expect(box, "CTA rendered").toBeTruthy();
    expect(box!.y + box!.height, `CTA above the fold at ${size.width}`).toBeLessThanOrEqual(size.height);
    expect(box!.height, "touch target").toBeGreaterThanOrEqual(size.width < 768 ? 44 : 40);
    if (size.width < 768) expect(box!.width, "full width on a phone").toBeGreaterThan(size.width - 60);

    await cta(page).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator(".ct-group")).toHaveText(["Meta", "Video and social", "Messaging and email"]);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();

    await shoot(page, testInfo.outputPath(`channels-${size.width}`));
    await shoot(page, testInfo.outputPath(`channels-sheet-${size.width}`), async () => {
      await cta(page).click();
      await expect(sheet(page)).toBeVisible();
    });
  }

  await page.setViewportSize(SIZES[0]);
  await gotoOk(page, "/channels?connect=1");
  await expect(sheet(page)).toBeVisible();

  // Telegram unfolds its labelled token form in place.
  await sheet(page).getByRole("button", { name: /Telegram bot/ }).click();
  await expect(sheet(page).getByLabel("Bot token")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Connect Telegram" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("channels-sheet-telegram-1440.png"), animations: "disabled" });

  // Advanced unfolds the token form; the footer opens Managed connections.
  await sheet(page).locator("summary", { hasText: "Advanced: connect with a token" }).click();
  await expect(sheet(page).getByLabel("Long-lived or System User token")).toBeVisible();
  await sheet(page).getByRole("link", { name: "Managed connections →" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(page.locator("#sources")).toHaveAttribute("open", "");
  await expect(page.locator("#sources")).toContainText("Connect all");
  expect(errors).toEqual([]);
});

test("FREE: a PRO platform tile shows the lock and leads to the upgrade page", async ({ page }) => {
  await setFree(page.request);
  try {
    await gotoOk(page, "/channels?connect=1");
    const yt = sheet(page).locator(".ct-tile", { hasText: "YouTube" });
    await expect(yt).toHaveClass(/is-locked/);
    await expect(yt).toContainText("PRO");
    const href = await yt.getAttribute("href");
    expect(href).toMatch(/^https?:\/\//);
    expect(href).not.toContain("/api/oauth/");
    await expect(yt).toHaveAttribute("target", "_blank");
  } finally {
    await setPro(page.request);
  }
});

test("an empty workspace shows the platform tiles on the page", async ({ browser, page }, testInfo) => {
  await setPro(page.request); // a second workspace needs multitenancy
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const fresh = await ctx.newPage();
  try {
    const res = await fresh.request.post("/register", {
      headers: { "content-type": "application/json" },
      data: { email: `empty-${Date.now()}@e2e.test`, password: "e2e-password-123", name: "Empty" },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    for (const size of SIZES) {
      await fresh.setViewportSize(size);
      await gotoOk(fresh, "/channels");
      const empty = fresh.locator(".ch-empty");
      await expect(empty).toContainText("Connect your first channel");
      await expect(empty.locator('.ct-tile[href="/api/oauth/facebook"]')).toBeVisible();
      await shoot(fresh, testInfo.outputPath(`channels-empty-${size.width}`));
    }
  } finally {
    await ctx.close();
  }
});
