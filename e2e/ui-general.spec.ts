import { test, expect } from "@playwright/test";
import { setPro, gotoOk } from "./helpers";

test("mobile Compose draft actions stay above navigation and receive center clicks", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/compose");
  const brandField = page.locator("label.fld").filter({ has: page.locator("select[aria-label='Brand']") });
  await brandField.locator("button.ps-trigger").click();
  await brandField.getByRole("option", { name: "E2E Brand", exact: true }).click();
  await page.getByPlaceholder("Internal title").fill("Mobile Compose regression");
  await page.getByPlaceholder("https://cdn…/reel.mp4").fill("https://example.test/image.png");
  const submit = page.locator("form.compose-form button[type='submit']");
  await expect(submit).toBeEnabled();
  // At the top of the long form the sticky bar used to sit behind the fixed nav.
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const button of [page.getByRole("button", { name: "Draft", exact: true }), submit]) {
    const geometry = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, bottom: r.bottom, navTop: document.querySelector(".mobile-nav")!.getBoundingClientRect().top,
        hit: el.contains(document.elementFromPoint(x, y)) };
    });
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.navTop);
    expect(geometry.hit).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("compose-mobile.png") });
  // Use an actual center click, with no locator auto-scroll, to prove the draft opens.
  const box = await submit.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page).toHaveURL(/\/content\/[0-9a-f-]+$/);
  await expect(page.locator(".topbar h1")).toHaveText("Mobile Compose regression");
  const id = new URL(page.url()).pathname.split("/").pop();
  expect((await page.request.delete(`/api/v1/content/${id}`)).ok()).toBe(true);
});

test("a 500-character content title fits the desktop page", async ({ page }, testInfo) => {
  await setPro(page.request);
  const title = "MQA3_" + "L".repeat(495);
  const created = await page.request.post("/api/v1/content", { data: { title, contentType: "image" } });
  expect(created.status()).toBe(201);
  const { data } = await created.json();
  try {
    await page.setViewportSize({ width: 1280, height: 600 });
    await gotoOk(page, `/content/${data.id}`);
    await expect(page.locator(".topbar h1")).toHaveText(title);
    const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    await expect(page.locator(".topbar h1")).toHaveAttribute("title", title);
    await expect(page.locator(".crumb")).toHaveAttribute("title", `Content / ${title}`);
    await page.screenshot({ path: testInfo.outputPath("content-long-title.png") });
  } finally {
    await page.request.delete(`/api/v1/content/${data.id}`);
  }
});
