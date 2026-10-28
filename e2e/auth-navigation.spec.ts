import { writeFileSync } from "node:fs";
import { test, expect, type Route } from "@playwright/test";
import { Client } from "pg";
import { mintProToken } from "./fixtures/keys";
import { E2E_DATABASE_URL } from "./env";

// Opt into installed Chrome for native-navigation repros; keep the default Chromium CI setup.
test.use({ channel: process.env.E2E_BROWSER_CHANNEL });

// These specs sign in repeatedly from one IP; clear the login throttle around them so later specs
// (captcha, auth) keep their own budget of 10 attempts per 15 minutes.
async function clearLoginThrottle() {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try { await client.query("DELETE FROM rate_limit_counters WHERE key LIKE 'rl:login:%'"); } finally { await client.end(); }
}
test.beforeEach(clearLoginThrottle);
test.afterEach(clearLoginThrottle);

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

test("sidebar navigation, Inbox updates and resizing before repeated sign out", async ({ page, context, browser }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const lifecycle: string[] = [];
  const consoleCalls: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.text().startsWith("session-lifecycle:")) lifecycle.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") consoleCalls.push(event);
  });
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("open", () => console.log("session-lifecycle:sseOpen:" + location.pathname));
      }
      close() {
        console.log("session-lifecycle:sseClose:" + location.pathname);
        super.close();
      }
    };
    for (const name of ["pageswap", "pagereveal"]) window.addEventListener(name, (event) => {
      const transition = (event as Event & { viewTransition?: { ready: Promise<void> } }).viewTransition;
      console.log("session-lifecycle:" + JSON.stringify({ name, path: location.pathname, transition: !!transition }));
    });
    document.addEventListener("htmx:sseError", () => console.log("session-lifecycle:sseError:" + location.pathname));
  });
  async function login() {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill("admin@e2e.test");
    await page.locator('input[name="password"]').fill("e2e-password-123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  }
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let contactId: string | undefined;
  try {
    const { rows: [channel] } = await client.query<{ id: string; workspace_id: string }>(
      "SELECT id, workspace_id FROM channels WHERE platform_id = 'fb_e2e_1'",
    );
    const { rows: [contact] } = await client.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Session navigation') RETURNING id", [channel.workspace_id],
    );
    contactId = contact.id;
    const { rows: [conversation] } = await client.query<{ id: string }>(
      "INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at) VALUES ($1, $2, $3, 'facebook', now()) RETURNING id",
      [channel.workspace_id, channel.id, contactId],
    );
    await client.query("INSERT INTO messages (conversation_id, direction, text) VALUES ($1, 'inbound', 'Session navigation message')", [conversation.id]);
    await login();
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const path of ["/overview", "/channels", "/inbox"]) {
        await page.locator(`.sidebar a[href="${path}"]`).click();
        await expect(page).toHaveURL(new RegExp(path + "$"));
      }
      const thread = page.locator(`.conv-item[hx-get="/inbox/${conversation.id}"]`);
      await thread.click();
      await expect(page.locator("#thread-msgs")).toContainText("Session navigation message");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (cycle === 1) {
        await page.locator('.sidebar a[href="/settings"]').click();
        await page.getByRole("button", { name: "Data", exact: true }).click();
        await expect(page).toHaveURL(/\/settings#data$/);
      }
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await login();
    }
    await page.screenshot({ path: testInfo.outputPath("session-navigation.png"), animations: "disabled" });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(lifecycle.some((entry) => entry.startsWith("session-lifecycle:sseClose:"))).toBe(true);
  } finally {
    writeFileSync(testInfo.outputPath("session-navigation.json"), JSON.stringify({ browser: browser.version(), errors, consoleErrors, lifecycle, consoleCalls }, null, 2));
    if (contactId) await client.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    await client.end();
  }
});

test("document teardown closes a connecting SSE stream before a disconnect", async ({ page, context, browser }, testInfo) => {
  const consoleErrors: string[] = [];
  const errors: string[] = [];
  const consoleCalls: unknown[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") consoleCalls.push(event);
  });
  async function streamState() {
    return page.locator(".app").evaluate((el) => {
      const data = (el as HTMLElement & { "htmx-internal-data"?: { sseEventSource?: EventSource } })["htmx-internal-data"];
      return data?.sseEventSource?.readyState ?? -1;
    });
  }
  let closedBeforeDisconnect = false;
  let pending: Route | undefined;
  await page.route("**/events/stream", (route) => { pending = route; });
  try {
    await page.goto("/inbox");
    await expect.poll(() => !!pending).toBe(true);
    await expect.poll(streamState).toBe(0);
    // Hold the document in place and reset its pending stream after the teardown event.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    closedBeforeDisconnect = await streamState() === 2;
    const disconnect = closedBeforeDisconnect ? null : page.waitForEvent("console", {
      predicate: (message) => message.type() === "error" && message.text() === "Event",
    });
    await pending!.abort("connectionreset");
    if (disconnect) await disconnect;
    await page.unroute("**/events/stream");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(streamState).toBe(1);
    await page.locator('.sidebar a[href="/settings"]').click();
    await expect(page).toHaveURL(/\/settings$/);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(closedBeforeDisconnect).toBe(true);
  } finally {
    await page.unroute("**/events/stream");
    writeFileSync(testInfo.outputPath("sse-disconnect.json"), JSON.stringify({ browser: browser.version(), closedBeforeDisconnect, errors, consoleErrors, consoleCalls }, null, 2));
  }
});

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
