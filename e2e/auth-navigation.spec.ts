import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`logout and login have no page errors at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const lifecycle: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("document-lifecycle:")) lifecycle.push(message.text());
    });
    await page.addInitScript(() => {
      for (const name of ["pageswap", "pagereveal"]) {
        window.addEventListener(name, (event) => {
          const native = event as Event & { viewTransition?: unknown };
          console.log("document-lifecycle:" + JSON.stringify({ event: name, url: location.pathname, transition: !!native.viewTransition }));
        });
      }
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const documents: Array<{ url: string; status: number }> = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "document") documents.push({ url: response.url(), status: response.status() });
    });
    // A fresh login prevents logout from revoking the shared setup session.
    await page.goto("/login");
    await page.locator('input[name="email"]').fill("admin@e2e.test");
    await page.locator('input[name="password"]').fill("e2e-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    for (let i = 0; i < 1; i++) {
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(/\/login$/);
      await page.locator('input[name="email"]').fill("admin@e2e.test");
      await page.locator('input[name="password"]').fill("e2e-password-123");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(page.locator(".topbar-actions")).toBeVisible();
    }
    await testInfo.attach("document-navigation", { body: JSON.stringify({ documents, lifecycle, errors }, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
  });
}

test.describe("publishing guidance", () => {
  test.use({ timezoneId: "Europe/Warsaw" });

  test("Compose explains an empty brand and both editors explain DST before saving", async ({ page }, testInfo) => {
    const { setPro } = await import("./helpers");
    await setPro(page.request);
    const key = "empty-guidance";
    const created = await page.request.post("/api/v1/brands", { data: { key, name: "Empty guidance" } });
    expect(created.status()).toBe(201);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto("/compose");
      await page.getByLabel("Brand", { exact: true }).selectOption(key);
      const empty = page.getByRole("status").filter({ hasText: "This brand has no channels" });
      await expect(empty).toBeVisible();
      await expect(empty.getByRole("link", { name: "Brands", exact: true })).toHaveAttribute("href", "/brands");
      await page.screenshot({ path: testInfo.outputPath("empty-brand.png"), fullPage: true });
      await page.getByLabel("Brand", { exact: true }).selectOption("e2e-brand");
      await expect(empty).toBeHidden();
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      await page.locator('input[type="datetime-local"]').fill("2027-03-28T02:30");
      await expect(page.getByRole("status").filter({ hasText: "does not exist" })).toContainText("03:30 (UTC+02:00)");
      await page.screenshot({ path: testInfo.outputPath("compose-dst.png"), fullPage: true });
      const content = await (await page.request.get("/api/v1/content")).json();
      const item = content.data.items.find((row: { title: string }) => row.title === "E2E sample reel");
      expect(item).toBeTruthy();
      await page.goto(`/content/${item.id}`);
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      await page.getByLabel("Schedule time", { exact: true }).fill("2027-10-31T02:30");
      await expect(page.getByRole("status").filter({ hasText: "occurs twice" })).toContainText("earlier occurrence (UTC+02:00)");
      await page.screenshot({ path: testInfo.outputPath("content-dst.png"), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      expect((await page.request.delete(`/api/v1/brands/${key}`)).status()).toBe(204);
    }
  });
});
