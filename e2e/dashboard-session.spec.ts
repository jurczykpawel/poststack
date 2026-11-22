import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro } from "./helpers";

test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } });

test("document visibility returns after a pageshow without a reload", async ({ page }) => {
  await page.goto("/content");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(page.locator("html")).toHaveCSS("visibility", "hidden");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
  await expect(page.locator("html")).toHaveCSS("visibility", "visible");
  await expect(page.locator("#main")).toBeVisible();
});

test("an open event stream finishes after signing out in another tab", async ({ page, context }) => {
  test.setTimeout(45_000);
  expect((await page.request.post("/api/auth/login", { data: { email: "admin@e2e.test", password: "e2e-password-123" } })).status()).toBe(200);
  await page.goto("/overview");
  await page.evaluate(() => {
    const source = new EventSource("/events/stream");
    document.documentElement.dataset.streamState = "connecting";
    source.addEventListener("ready", () => { document.documentElement.dataset.streamState = "ready"; });
    source.onerror = () => {
      source.close();
      document.documentElement.dataset.streamState = "finished";
    };
  });
  await expect(page.locator("html")).toHaveAttribute("data-stream-state", "ready");
  const otherTab = await context.newPage();
  try {
    await otherTab.goto("/overview");
    await otherTab.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(otherTab).toHaveURL(/\/login$/);
    await expect(page.locator("html")).toHaveAttribute("data-stream-state", "finished", { timeout: 25_000 });
    expect((await page.request.get("/events/stream")).status()).toBe(401);
  } finally {
    await otherTab.close();
  }
});

test("endpoint signing values are available on create and rotate responses", async ({ page }) => {
  await setPro(page.request);
  const create = await page.request.post("/webhooks/outbound", {
    headers: { "HX-Request": "true" }, form: { url: "https://hooks.example.test/one-time" },
  });
  expect(create.status()).toBe(200);
  const createdHtml = await create.text();
  const { data: rows } = await (await page.request.get("/api/v1/webhooks")).json();
  const id = rows.find((row: { url: string }) => row.url === "https://hooks.example.test/one-time").id;
  const first = createdHtml.match(/whsec_[a-f0-9]{48}/)![0];
  try {
    const initialRead = await page.request.get("/webhooks/outbound", { headers: { "HX-Request": "true" } });
    expect(await initialRead.text()).not.toContain(first);
    const rotated = await page.request.post(`/webhooks/outbound/${id}/rotate`, { headers: { "HX-Request": "true" } });
    const rotatedHtml = await rotated.text();
    const second = rotatedHtml.match(/whsec_[a-f0-9]{48}/)![0];
    expect(second).not.toBe(first);
    expect(rotatedHtml).not.toContain(first);
    const read = await page.request.get("/webhooks/outbound", { headers: { "HX-Request": "true" } });
    expect(await read.text()).not.toContain(second);
    await page.goto("/webhooks#outgoing");
    await page.getByRole("button", { name: "Outgoing", exact: true }).click();
    await expect(page.locator("#wh-outbound")).toContainText("https://hooks.example.test/one-time");
    expect(await page.locator("#wh-outbound").innerHTML()).not.toContain(second);
  } finally {
    expect((await page.request.delete(`/api/v1/webhooks/${id}`)).status()).toBe(204);
  }
});

for (const hx of [false, true]) {
  test(`history revisits use the current account (hx=${hx})`, async ({ page, context }) => {
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    const wsIds: string[] = [];
    const userIds: string[] = [];
    const accounts: Array<{ email: string; contentId: string }> = [];
    async function login(tab: Page, email: string) {
      await tab.goto("/login");
      await tab.locator('[name="email"]').fill(email);
      await tab.locator('[name="password"]').fill("e2e-password-123");
      await tab.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(tab).toHaveURL(/\/inbox$/);
    }
    try {
      for (let i = 0; i < 2; i++) {
        const email = `${crypto.randomUUID()}@example.test`;
        const { rows: [ws] } = await db.query("INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id", [crypto.randomUUID()]);
        wsIds.push(ws.id);
        const { rows: [user] } = await db.query("INSERT INTO users (email, password_hash) SELECT $1, password_hash FROM users WHERE email = 'admin@e2e.test' RETURNING id", [email]);
        userIds.push(user.id);
        await db.query("INSERT INTO workspace_members (user_id, workspace_id) VALUES ($1, $2)", [user.id, ws.id]);
        const { rows: [content] } = await db.query("INSERT INTO content (workspace_id, title, script) VALUES ($1, $2, $3) RETURNING id", [ws.id, `Account ${i}`, `Private account ${i} script`]);
        accounts.push({ email, contentId: content.id });
      }
      await db.query("DELETE FROM rate_limit_counters WHERE key LIKE 'rl:login:%'");
      await login(page, accounts[0].email);
      const privatePath = `/content/${accounts[0].contentId}`;
      const response = await page.goto(privatePath);
      expect(response!.headers()["cache-control"]).toContain("no-store");
      expect(await page.content()).toContain("Private account 0 script");
      if (hx) {
        await page.evaluate(() => {
          const a = document.createElement("a");
          a.id = "history-destination";
          a.textContent = "Open content list";
          a.setAttribute("hx-get", "/content");
          a.setAttribute("hx-target", "#main");
          a.setAttribute("hx-push-url", "true");
          document.body.append(a);
          (window as unknown as { htmx: { process(e: Element): void } }).htmx.process(a);
        });
        await page.locator("#history-destination").click();
        await expect(page).toHaveURL(/\/content$/);
        expect((await page.evaluate(() => localStorage.getItem("htmx-history-cache"))) ?? "").not.toContain("Private account 0 script");
      } else {
        await page.goto("/settings/api-keys");
      }
      const otherTab = await context.newPage();
      await otherTab.goto("/overview");
      await otherTab.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(otherTab).toHaveURL(/\/login$/);
      await login(otherTab, accounts[1].email);
      await page.goBack();
      await expect(page.locator("body")).not.toContainText("Private account 0 script");
      expect(await page.content()).not.toContain("Private account 0 script");
      expect((await page.request.get(privatePath)).status()).toBe(404);
      await otherTab.close();
    } finally {
      await db.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [wsIds]);
      await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
      await db.query("DELETE FROM rate_limit_counters WHERE key LIKE 'rl:login:%'");
      await db.end();
    }
  });
}

test("dashboard documents and fragments carry their response policy", async ({ page }) => {
  for (const path of ["/content", "/settings/api-keys", "/activity?source=webhooks&platform=unknown-platform", "/engagement", "/insights"]) {
    for (const hx of [false, true]) {
      const response = await page.request.get(path, { headers: hx ? { "HX-Request": "true" } : {} });
      expect(response.status()).toBe(200);
      const headers = response.headers();
      expect(headers["cache-control"]).toContain("no-store");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["content-security-policy"]).toContain("connect-src 'self'");
    }
  }
  const home = await page.request.get("/", { maxRedirects: 0 });
  expect(home.status()).toBe(302);
  const asset = await page.request.get("/static/dashboard-session.js");
  expect(asset.headers()["cache-control"]).toContain("public");
});
