import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { mintProToken } from "./fixtures/keys";

// Opt into installed Chrome for native-navigation repros; keep the default Chromium CI setup.
test.use({ channel: process.env.E2E_BROWSER_CHANNEL });

test.describe("full document auth redirects", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const branded of [false, true]) {
    test(`stale Settings save redirects without page errors (branding=${branded})`, async ({ page, context, browser }, testInfo) => {
      const errors: string[] = [];
      const lifecycle: string[] = [];
      const navigation: Array<{ path: string; status: number; redirect?: string }> = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const redirect = response.headers()["hx-redirect"];
        if (redirect || response.request().resourceType() === "document") navigation.push({ path: new URL(response.url()).pathname, status: response.status(), redirect });
      });
      page.on("console", (message) => {
        if (message.text().startsWith("document-lifecycle:")) lifecycle.push(message.text());
      });
      await page.addInitScript(() => {
        for (const name of ["pageswap", "pagereveal"]) window.addEventListener(name, (event) => {
          console.log("document-lifecycle:" + JSON.stringify({ event: name, url: location.pathname, transition: !!(event as Event & { viewTransition?: unknown }).viewTransition }));
        });
      });
      async function login() {
        await page.goto("/login");
        await page.locator('input[name="email"]').fill("admin@e2e.test");
        await page.locator('input[name="password"]').fill("e2e-password-123");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page).toHaveURL(/\/inbox$/);
      }
      async function post(path: string, data: unknown) {
        return page.evaluate(async ({ path, data }) => (await fetch(path, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
        })).status, { path, data });
      }
      await login();
      expect(await post("/api/v1/license", { token: mintProToken() })).toBe(200);
      expect(await post("/settings/branding", { reset: true })).toBe(200);
      let authenticated = true;
      try {
        if (branded) {
          await page.goto("/settings#integrations");
          await page.getByLabel("Product name").fill("MQA5 Orchard");
          await page.getByRole("button", { name: "Save instance branding", exact: true }).click();
          await expect(page).toHaveTitle(/MQA5 Orchard/);
        }
        await page.goto("/settings#automation");
        await page.getByRole("button", { name: "Automation", exact: true }).click();
        const save = page.locator('form[hx-post="/settings/ai-draft-prompt"]').getByRole("button");
        await expect(save).toBeVisible();
        const cookies = await context.cookies();
        const other = await context.newPage();
        other.on("pageerror", (error) => errors.push(error.message));
        await other.goto("/overview");
        await other.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect(other).toHaveURL(/\/login$/);
        await other.close();
        authenticated = false;
        // Exercise both a cleared cookie and a still-present, revoked session cookie.
        if (branded) await context.addCookies(cookies);
        const response = page.waitForResponse((r) => r.request().method() === "POST" && r.headers()["hx-redirect"] === "/login");
        await save.click();
        expect((await response).status()).toBe(branded ? 401 : 200);
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
        await expect(page).toHaveTitle(branded ? /MQA5 Orchard/ : /PostStack/);
        await page.screenshot({ path: testInfo.outputPath("stale-login.png"), animations: "disabled" });
        // Also navigate to the branded login directly from a live dashboard document.
        await login();
        authenticated = true;
        await page.evaluate(() => { location.href = "/login"; });
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("dashboard-login.png"), animations: "disabled" });
        writeFileSync(testInfo.outputPath("auth-redirects.json"), JSON.stringify({ browser: browser.version(), branded, navigation, lifecycle, errors }, null, 2));
        expect(lifecycle.some((entry) => entry.includes('"event":"pagereveal","url":"/login","transition":true'))).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        if (!authenticated) await login();
        expect(await post("/settings/branding", { reset: true })).toBe(200);
      }
    });
  }
});

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
    const evidence = testInfo.outputPath("document-navigation.json");
    writeFileSync(evidence, JSON.stringify({ documents, lifecycle, errors }, null, 2));
    await testInfo.attach("document-navigation", { path: evidence, contentType: "application/json" });
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
      await page.getByRole("button", { name: "Brand", exact: true }).click();
      await page.getByRole("option", { name: "Empty guidance", exact: true }).click();
      const empty = page.getByRole("status").filter({ hasText: "This brand has no channels" });
      await expect(empty).toBeVisible();
      await expect(empty.getByRole("link", { name: "Brands", exact: true })).toHaveAttribute("href", "/brands");
      await page.screenshot({ path: testInfo.outputPath("empty-brand.png"), fullPage: true, animations: "disabled" });
      await page.getByRole("button", { name: "Brand", exact: true }).click();
      await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
      await expect(empty).toBeHidden();
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      await page.locator('input[type="datetime-local"]').fill("2027-03-28T02:30");
      await expect(page.getByRole("status").filter({ hasText: "does not exist" })).toContainText("03:30 (UTC+02:00)");
      await expect(page.getByRole("status").filter({ hasText: "does not exist" })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("compose-dst.png"), fullPage: true, animations: "disabled" });
      const content = await (await page.request.get("/api/v1/content")).json();
      const item = content.data.items.find((row: { title: string }) => row.title === "E2E sample reel");
      expect(item).toBeTruthy();
      await page.goto(`/content/${item.id}`);
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      await page.getByLabel("Schedule time", { exact: true }).fill("2027-10-31T02:30");
      await expect(page.getByRole("status").filter({ hasText: "occurs twice" })).toContainText("earlier occurrence (UTC+02:00)");
      await page.screenshot({ path: testInfo.outputPath("content-dst.png"), fullPage: true, animations: "disabled" });
      expect(errors).toEqual([]);
    } finally {
      expect((await page.request.delete(`/api/v1/brands/${key}`)).status()).toBe(204);
    }
  });
});
