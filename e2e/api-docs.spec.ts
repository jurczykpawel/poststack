import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

for (const width of [1440, 390]) {
  test(`API documentation loads without browser errors (${width}px)`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    const failed: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => failed.push(`${request.url()}: ${request.failure()?.errorText}`));
    await page.setViewportSize({ width, height: 900 });
    expect((await page.goto("/api/docs"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "PostStack API", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.goto("/api/docs#tag/webhooks");
    const signature = page.getByText("X-PostStack-Signature: t=<unix>,v1=<hmac>", { exact: true });
    await signature.scrollIntoViewIfNeeded();
    await expect(signature).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`api-docs-${width}.png`) });
    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
  });
}
