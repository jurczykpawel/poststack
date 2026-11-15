import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash, randomBytes } from "crypto";
import { eq, inArray, like } from "drizzle-orm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP = "http://localhost:3000";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let OAUTH_ACCESS: typeof import("@/lib/mcp/oauth").OAUTH_ACCESS;
let app: Hono;
let cookie: string;

const WS_A = "0a0a0a0a-0000-0000-0000-00000000000a";
const WS_B = "0a0a0a0a-0000-0000-0000-00000000000b";
const CH_A = "0a0a0a0a-0000-0000-0000-0000000000c1";
const CH_B = "0a0a0a0a-0000-0000-0000-0000000000c2";
const USER = "0a0a0a0a-0000-0000-0000-0000000000f1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = APP;
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  ({ OAUTH_ACCESS } = await import("@/lib/mcp/oauth"));
  app = (await import("../app")).buildApp();
  const { signSession } = await import("@/lib/auth");
  const { BRAND } = await import("@/lib/brand");
  cookie = `${BRAND.cookieName}=${await signSession(USER, WS_A)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  const { encryptTokens } = await import("@/lib/crypto");
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS_A, WS_B]));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.oauthClients);
  await db.delete(s.rateLimitCounters).where(like(s.rateLimitCounters.key, "rl:oauth-%"));
  await db.insert(s.users).values({ id: USER, email: `oauth-${USER}@test.local` });
  await db.insert(s.workspaces).values([{ id: WS_A, name: "Alpha", slug: `a-${WS_A}` }, { id: WS_B, name: "Beta", slug: `b-${WS_B}` }]);
  await db.insert(s.workspaceMembers).values([{ workspace_id: WS_A, user_id: USER, role: "owner" }, { workspace_id: WS_B, user_id: USER, role: "owner" }]);
  await db.insert(s.channels).values([
    { id: CH_A, workspace_id: WS_A, platform: "facebook", platform_id: "OAUTH_PAGE_A", display_name: "Page A", token_encrypted: encryptTokens({ access_token: "a" }), webhook_secret: "wh", status: "active" },
    { id: CH_B, workspace_id: WS_B, platform: "facebook", platform_id: "OAUTH_PAGE_B", display_name: "Page B", token_encrypted: encryptTokens({ access_token: "b" }), webhook_secret: "wh", status: "active" },
  ]);
  await licenseInstance("pro");
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS_A, WS_B]));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.oauthClients);
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  await db.$client.end();
});

// ─── helpers: a client doing what Claude/ChatGPT do ───────────────────────────

const verifierPair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(redirectUris: string[] = [REDIRECT]) {
  const res = await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }) });
  return { res, body: await res.json() as { client_id: string; error?: string } };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${APP}/mcp`, ...extra });
  return `/oauth/authorize?${q}`;
}

/** Loads the consent screen with the session, submits it, returns the URL the browser is sent to. */
async function consent(clientId: string, challenge: string, form: { access?: string; workspace_id?: string; decision?: string } = {}, extra: Record<string, string> = {}) {
  const page = await app.request(authorizeUrl(clientId, challenge, extra), { headers: { cookie } });
  expect(page.status).toBe(200);
  const htmlText = await page.text();
  const hidden = Object.fromEntries([...htmlText.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
  const body = new URLSearchParams({ ...hidden, access: "read", workspace_id: WS_A, decision: "approve", ...form });
  const res = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body });
  const target = (await res.text()).match(/http-equiv="refresh" content="0;url=([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  return { res, target: target ? new URL(target) : null };
}

const token = (params: Record<string, string>) => app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });

async function connectedClient(clientId: string, access = "read", workspace = WS_A) {
  const { verifier, challenge } = verifierPair();
  const { target } = await consent(clientId, challenge, { access, workspace_id: workspace });
  const code = target!.searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${APP}/mcp` });
  expect(res.status).toBe(200);
  return { code, verifier, tokens: await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string } };
}

async function mcp(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name: "oauth-integration-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const mcpStatus = async (accessToken: string) => (await app.request("/mcp", {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
})).status;

// ─── tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_DB)("OAuth for /mcp (real app + Postgres)", () => {
  it("discovery: 401 points at resource metadata, which points at this authorization server", async () => {
    const res = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const metadataUrl = res.headers.get("www-authenticate")!.match(/resource_metadata="([^"]+)"/)![1];
    expect(metadataUrl).toBe(`${APP}/.well-known/oauth-protected-resource/mcp`);
    const prm = await (await app.request(new URL(metadataUrl).pathname)).json();
    expect(prm).toMatchObject({ resource: `${APP}/mcp`, authorization_servers: [APP] });
    expect(await (await app.request("/.well-known/oauth-protected-resource")).json()).toEqual(prm);
    const as = await (await app.request("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({
      issuer: APP, authorization_endpoint: `${APP}/oauth/authorize`, token_endpoint: `${APP}/oauth/token`, registration_endpoint: `${APP}/oauth/register`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    });
    expect(as.scopes_supported.some((x: string) => x.startsWith("instance_"))).toBe(false);
  });

  it("full flow: register → consent → token → /mcp with read-only scope → refresh → revoke → 401", async () => {
    const { res: reg, body } = await register();
    expect(reg.status).toBe(201);
    expect(body).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });

    const { verifier, challenge } = verifierPair();
    const { target } = await consent(body.client_id, challenge, { access: "read", workspace_id: WS_A });
    expect(`${target!.origin}${target!.pathname}`).toBe(REDIRECT);
    expect(target!.searchParams.get("state")).toBe("st-1");
    expect(target!.searchParams.get("iss")).toBe(APP);
    const res = await token({ grant_type: "authorization_code", code: target!.searchParams.get("code")!, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT, resource: `${APP}/mcp` });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = await res.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: OAUTH_ACCESS.read.join(" ") });
    expect(tokens.access_token).toMatch(/^sk_live_/);

    const client = await mcp(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const list = await client.callTool({ name: "get_channels", arguments: {} });
    expect(JSON.parse((list.content as Array<{ text: string }>)[0].text).data.map((c: { id: string }) => c.id)).toEqual([CH_A]);
    await client.close();

    // Shown as a connected app, not as an API key.
    const settings = await (await app.request("/settings/api-keys", { headers: { cookie } })).text();
    expect(settings).toContain("Connected apps");
    expect(settings).toMatch(/key-name">Claude</);
    expect(settings).not.toContain("OAuth access token");
    const keys = await (await app.request("/api/v1/api-keys", { headers: { cookie } })).json();
    expect(keys.data).toEqual([]);

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: body.client_id, resource: `${APP}/mcp` });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await mcpStatus(tokens.access_token)).toBe(401);
    expect(await mcpStatus(next.access_token)).toBe(200);
    const reused = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: body.client_id });
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe("invalid_grant");

    expect((await app.request("/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: next.refresh_token }) })).status).toBe(200);
    expect(await mcpStatus(next.access_token)).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: body.client_id })).status).toBe(400);
    expect(await db.select().from(s.apiKeys).where(eq(s.apiKeys.workspace_id, WS_A))).toEqual([]);
  });

  it("read and write grants write tools; a refresh can narrow the scope but not widen it", async () => {
    const { body } = await register();
    const { tokens } = await connectedClient(body.client_id, "write");
    const client = await mcp(tokens.access_token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("post_content");
    await client.close();

    const narrowed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: body.client_id, scope: "channels:read" });
    const n = await narrowed.json();
    expect(n.scope).toBe("channels:read");
    const limited = await mcp(n.access_token);
    expect((await limited.listTools()).tools.every((t) => t.name.includes("channel"))).toBe(true);
    await limited.close();

    const { tokens: readOnly } = await connectedClient(body.client_id, "read");
    const widened = await token({ grant_type: "refresh_token", refresh_token: readOnly.refresh_token, client_id: body.client_id, scope: "posts:write" });
    expect((await widened.json()).error).toBe("invalid_scope");
    // The failed attempt did not consume the refresh token.
    expect((await token({ grant_type: "refresh_token", refresh_token: readOnly.refresh_token, client_id: body.client_id })).status).toBe(200);
  });

  it("a token approved for another workspace only sees that workspace", async () => {
    const { body } = await register();
    const { tokens } = await connectedClient(body.client_id, "read", WS_B);
    const client = await mcp(tokens.access_token);
    const list = await client.callTool({ name: "get_channels", arguments: {} });
    expect(JSON.parse((list.content as Array<{ text: string }>)[0].text).data.map((c: { id: string }) => c.id)).toEqual([CH_B]);
    const foreign = await client.callTool({ name: "get_channels_by_channel_id", arguments: { channelId: CH_A } });
    expect(foreign.isError).toBe(true);
    await client.close();
  });

  it("rejects a wrong PKCE verifier and burns the code", async () => {
    const { body } = await register();
    const { verifier, challenge } = verifierPair();
    const { target } = await consent(body.client_id, challenge);
    const code = target!.searchParams.get("code")!;
    const bad = await token({ grant_type: "authorization_code", code, code_verifier: verifierPair().verifier, client_id: body.client_id, redirect_uri: REDIRECT });
    expect((await bad.json()).error).toBe("invalid_grant");
    const good = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT });
    expect((await good.json()).error).toBe("invalid_grant");
  });

  it("a code works once; reusing it also revokes the tokens it issued", async () => {
    const { body } = await register();
    const { code, verifier, tokens } = await connectedClient(body.client_id);
    const again = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT });
    expect((await again.json()).error).toBe("invalid_grant");
    expect(await mcpStatus(tokens.access_token)).toBe(401);
  });

  it("rejects an expired code, a different redirect_uri or client at the token endpoint", async () => {
    const { body } = await register([REDIRECT, "https://claude.ai/other"]);
    for (const patch of [{ redirect_uri: "https://claude.ai/other" }, { client_id: (await register()).body.client_id }, { expire: "1" }]) {
      const { verifier, challenge } = verifierPair();
      const { target } = await consent(body.client_id, challenge);
      const code = target!.searchParams.get("code")!;
      if ("expire" in patch) await db.update(s.oauthGrants).set({ code_expires_at: new Date(Date.now() - 1000) }).where(eq(s.oauthGrants.client_id, body.client_id));
      const { expire: _ignored, ...override } = { expire: undefined, ...patch };
      const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT, ...override });
      expect((await res.json()).error).toBe("invalid_grant");
    }
  });

  it("never redirects to an unregistered redirect_uri, and refuses to register a non-https one", async () => {
    const { body } = await register();
    const res = await app.request(authorizeUrl(body.client_id, verifierPair().challenge, { redirect_uri: "https://evil.example/cb" }), { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const unknown = await app.request(authorizeUrl("mcp_nope", verifierPair().challenge), { headers: { cookie } });
    expect(unknown.status).toBe(400);
    const { res: bad, body: err } = await register(["http://evil.example/cb"]);
    expect(bad.status).toBe(400);
    expect(err.error).toBe("invalid_redirect_uri");
  });

  it("protocol errors go back to the client: missing PKCE, foreign resource", async () => {
    const { body } = await register();
    for (const [extra, error] of [[{ code_challenge_method: "plain" }, "invalid_request"], [{ resource: "https://other.example/mcp" }, "invalid_target"]] as const) {
      const res = await app.request(authorizeUrl(body.client_id, verifierPair().challenge, extra), { headers: { cookie } });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("iss")).toBe(APP);
    }
  });

  it("signed out: authorize sends to login and back; login ignores any other return target", async () => {
    const { body } = await register();
    const url = authorizeUrl(body.client_id, verifierPair().challenge);
    const res = await app.request(url);
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!, APP);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(url);
    const page = await (await app.request(`${login.pathname}${login.search}`)).text();
    expect(page).toContain(`hx-post="/login?next=${encodeURIComponent(url).replace(/&/g, "&amp;")}"`);
    const plain = await (await app.request("/login?next=https%3A%2F%2Fevil.example")).text();
    expect(plain).toContain('hx-post="/login"');
  });

  it("deny returns access_denied and creates nothing; a forged consent POST is refused", async () => {
    const { body } = await register();
    const { target } = await consent(body.client_id, verifierPair().challenge, { decision: "deny" });
    expect(target!.searchParams.get("error")).toBe("access_denied");
    expect(target!.searchParams.get("code")).toBeNull();
    expect(await db.select().from(s.oauthGrants)).toEqual([]);

    const q = Object.fromEntries(new URL(authorizeUrl(body.client_id, verifierPair().challenge), APP).searchParams);
    const form = new URLSearchParams({ ...q, access: "write", workspace_id: WS_A, decision: "approve", csrf: "forged" });
    const forged = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: form });
    expect(forged.status).toBe(403);
    const crossSite = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: form });
    expect(crossSite.status).toBe(403);
    expect(await db.select().from(s.oauthGrants)).toEqual([]);
  });

  it("disconnecting in Settings or leaving the workspace ends access at once", async () => {
    const { body } = await register();
    const { tokens } = await connectedClient(body.client_id);
    const [grant] = await db.select().from(s.oauthGrants);
    const del = await app.request(`/settings/connected-apps/${grant.id}`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(del.status).toBe(200);
    expect(await mcpStatus(tokens.access_token)).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: body.client_id })).status).toBe(400);

    const { tokens: second } = await connectedClient(body.client_id, "read", WS_B);
    await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS_B));
    expect((await token({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: body.client_id })).status).toBe(400);
    expect(await mcpStatus(second.access_token)).toBe(401);
  });

  it("without a PRO license the consent screen and token endpoint refuse", async () => {
    const { body } = await register();
    const { verifier, challenge } = verifierPair();
    const { target } = await consent(body.client_id, challenge);
    await db.delete(s.instanceLicense);
    gate.invalidateLicenseCache();
    expect((await app.request(authorizeUrl(body.client_id, challenge), { headers: { cookie } })).status).toBe(403);
    const res = await token({ grant_type: "authorization_code", code: target!.searchParams.get("code")!, code_verifier: verifier, client_id: body.client_id, redirect_uri: REDIRECT });
    expect((await res.json()).error).toBe("invalid_grant");
  });
});
