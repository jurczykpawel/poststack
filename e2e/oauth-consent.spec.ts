import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes } from "crypto";
import { E2E_BASE_URL } from "./env";
import { setPro, watchConsole } from "./helpers";

// MCP2: an MCP client (Claude, ChatGPT…) connects over OAuth. The redirect points back at this
// server on 127.0.0.1 (a loopback redirect), so the browser lands on a page we can read.
const REDIRECT = `${E2E_BASE_URL}/e2e-oauth-callback`;
// Stand-in for the client's callback page (a real client serves it from its own origin).
const CALLBACK_PAGE = { contentType: "text/html", body: "<p>client callback</p>" };
const isCallback = (url: URL) => url.href.startsWith(`${REDIRECT}?`);

async function registerClient(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/oauth/register", { data: { client_name: name, redirect_uris: [REDIRECT] } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).client_id;
}

function authorizePath(clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code", state: "e2e-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${E2E_BASE_URL}/mcp`,
  });
  return { verifier, path: `/oauth/authorize?${q}` };
}

test("consent: approve read and write, token works on /mcp, Disconnect in Settings ends it", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  await page.route(isCallback, (route) => route.fulfill(CALLBACK_PAGE));
  const name = `E2E Agent ${Date.now()}`;
  const clientId = await registerClient(page.request, name);
  const { verifier, path } = authorizePath(clientId);

  await page.goto(path);
  await expect(page.getByText(`${name} wants to use your`)).toBeVisible();
  await expect(page.getByText("127.0.0.1")).toBeVisible();
  await expect(page.locator(".notice-warn")).toContainText("program on this computer");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`consent-${width}.png`), fullPage: true });
  }
  await page.locator(".preset-card", { hasText: "Read and write" }).click();
  await expect(page.locator(".preset-card.on")).toContainText("Read and write");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/e2e-oauth-callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get("state")).toBe("e2e-state");
  expect(back.searchParams.get("iss")).toBe(E2E_BASE_URL);

  const tokenRes = await page.request.post("/oauth/token", { form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT } });
  expect(tokenRes.status()).toBe(200);
  const { access_token: accessToken, scope } = await tokenRes.json();
  expect(scope).toContain("posts:write");
  const listTools = () => page.request.post("/mcp", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect((await listTools()).status()).toBe(200);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/api-keys");
  const row = page.locator("#apps-area .key-row", { hasText: name });
  await expect(row).toContainText("All permissions");
  await page.screenshot({ path: testInfo.outputPath("connected-apps.png"), fullPage: true });
  await row.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(row).toHaveCount(0);
  expect((await listTools()).status()).toBe(401);
  expect(errors).toEqual([]);
});

test("consent: signed out → sign in → back on the consent screen; Deny returns access_denied", async ({ browser, page }) => {
  await setPro(page.request);
  const clientId = await registerClient(page.request, "E2E Signed-out client");
  const { path } = authorizePath(clientId);
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await anon.newPage();
  await p.route(isCallback, (route) => route.fulfill(CALLBACK_PAGE));
  await p.goto(path);
  await expect(p).toHaveURL(/\/login\?next=/);
  await expect(p.getByText("Sign in to connect an app")).toBeVisible();
  await p.locator("input[name=email]").fill("admin@e2e.test");
  await p.locator("input[name=password]").fill("e2e-password-123");
  await p.getByRole("button", { name: "Sign in" }).click();
  await expect(p.getByText("E2E Signed-out client wants to use your")).toBeVisible();
  await p.getByRole("button", { name: "Deny" }).click();
  await p.waitForURL(/\/e2e-oauth-callback\?/);
  expect(new URL(p.url()).searchParams.get("error")).toBe("access_denied");
  await anon.close();
});
