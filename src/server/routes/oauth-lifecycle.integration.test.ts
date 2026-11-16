import { randomBytes, createHash } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const WS = "0b0b0b0b-0000-0000-0000-000000000001";
const USER = "0b0b0b0b-0000-0000-0000-000000000002";
const REDIRECT = "https://client.example/callback";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let oauth: typeof import("@/lib/mcp/oauth");
let app: ReturnType<typeof import("../app").buildApp>;
let cookie: string;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY = "0".repeat(63) + "1";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  oauth = await import("@/lib/mcp/oauth");
  app = (await import("../app")).buildApp();
  const { signSession } = await import("@/lib/auth");
  const { BRAND } = await import("@/lib/brand");
  cookie = `${BRAND.cookieName}=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.oauthClients);
  await db.delete(s.rateLimitCounters).where(like(s.rateLimitCounters.key, "rl:oauth-%"));
  await db.insert(s.users).values({ id: USER, email: "oauth-lifecycle@test.local" });
  await db.insert(s.workspaces).values({ id: WS, name: "Lifecycle", slug: WS });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await licenseInstance("pro");
});

afterAll(async () => {
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.oauthClients);
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

const post = (path: string, params: Record<string, string>) => app.request(path, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
});
const token = (p: Record<string, string>) => post("/oauth/token", p);
const access = (t: string) => app.request("/api/v1/channels", { headers: { authorization: `Bearer ${t}` } });

async function pending(scope = "channels:read", resource = "http://localhost:3000/mcp") {
  const client = await oauth.registerClient({ client_name: "Lifecycle", redirect_uris: [REDIRECT] });
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    client_id: client.id, redirect_uri: REDIRECT, response_type: "code", scope, resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  };
  const parsed = await oauth.parseAuthorizeRequest(params);
  if (!("ok" in parsed)) throw new Error(JSON.stringify(parsed));
  const code = await oauth.createAuthorizationCode(parsed.ok, USER, WS, oauth.grantScopes("read", parsed.ok.requestedScopes));
  return { client, params, exchange: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.id, redirect_uri: REDIRECT, resource } };
}

async function connected() {
  const p = await pending();
  const res = await token(p.exchange);
  expect(res.status).toBe(200);
  return { ...p, tokens: await res.json() as { access_token: string; refresh_token: string } };
}

it("ends access when the approving member leaves", async () => {
  const { tokens } = await connected();
  expect((await access(tokens.access_token)).status).toBe(200);
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  expect((await access(tokens.access_token)).status).toBe(401);
});

it("requires current membership when exchanging a pending code", async () => {
  const p = await pending();
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  expect((await token(p.exchange)).status).toBe(400);
});

it("ends the active refresh family after a previous refresh is presented", async () => {
  const { client, tokens } = await connected();
  const refresh = (t: string) => token({ grant_type: "refresh_token", refresh_token: t, client_id: client.id });
  const rotated = await refresh(tokens.refresh_token);
  expect(rotated.status).toBe(200);
  const next = await rotated.json();
  expect((await refresh(tokens.refresh_token)).status).toBe(400);
  expect((await access(next.access_token)).status).toBe(401);
  expect((await refresh(next.refresh_token)).status).toBe(400);
});

it("rejects an unknown requested scope instead of offering all read scopes", async () => {
  const p = await pending();
  const parsed = await oauth.parseAuthorizeRequest({ ...p.params, scope: "channels:reed" });
  expect("redirect" in parsed && new URL(parsed.redirect).searchParams.get("error")).toBe("invalid_scope");
});

it("requires a supported metadata document authentication method", async () => {
  const p = await pending();
  const clientId = "https://client.example/confidential-client.json";
  const net = await import("@/lib/net/safe-fetch");
  const fetch = vi.spyOn(net, "safeFetch").mockResolvedValueOnce(Response.json({
    client_id: clientId, client_name: "Example confidential client", redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://client.example/jwks.json",
  }));
  try {
    const parsed = await oauth.parseAuthorizeRequest({ ...p.params, client_id: clientId });
    expect("ok" in parsed).toBe(false);
  } finally {
    fetch.mockRestore();
  }
});

it("accepts only one of two simultaneous refresh requests", async () => {
  const { client, tokens } = await connected();
  const responses = await Promise.all([0, 1].map(() => token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.id })));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
});

it("ends tokens from a code presented twice while pending", async () => {
  const p = await pending();
  const lock = await db.$client.connect();
  let responses: Response[];
  let inFlight: Promise<Response[]> | undefined;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM oauth_grants WHERE client_id = $1 FOR UPDATE", [p.client.id]);
    inFlight = Promise.all([token(p.exchange), token(p.exchange)]);
    const until = Date.now() + 5000;
    let waiting = 0;
    while (waiting < 2 && Date.now() < until) {
      const result = await db.$client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'update \"oauth_grants\"%'");
      waiting = result.rows[0].n;
      if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(2);
    await lock.query("COMMIT");
    responses = await inFlight;
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    if (inFlight) await inFlight;
  }
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  const winner = await responses.find((r) => r.status === 200)!.json();
  expect((await access(winner.access_token)).status).toBe(401);
});

it("keeps consent headers private and denies framing", async () => {
  const p = await pending();
  const response = await app.request(`/oauth/authorize?${new URLSearchParams(p.params)}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

it("bounds the consent form to the OAuth endpoint body budget", async () => {
  const p = await pending();
  const page = await app.request(`/oauth/authorize?${new URLSearchParams(p.params)}`, { headers: { cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const response = await app.request("/oauth/authorize", {
    method: "POST", headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...p.params, csrf, workspace_id: WS, access: "read", decision: "approve", state: "s".repeat(20_000) }),
  });
  expect(response.status).toBe(413);
});

it("caps dynamic registration and token requests and permits public preflights", async () => {
  for (let i = 0; i < 20; i++) {
    const r = await app.request("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(r.status).toBe(201);
  }
  expect((await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).status).toBe(429);
  for (let i = 0; i < 60; i++) expect((await token({ grant_type: "invalid" })).status).toBe(400);
  expect((await token({ grant_type: "invalid" })).status).toBe(429);
  for (const path of ["/oauth/token", "/oauth/register", "/oauth/revoke"]) {
    const r = await app.request(path, { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  }
});

it("keeps current tokens after an unknown refresh or another client presents a used refresh", async () => {
  const { client, tokens } = await connected();
  const rotated = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.id });
  const next = await rotated.json();
  const other = await oauth.registerClient({ redirect_uris: [REDIRECT] });
  for (const p of [
    { refresh_token: randomBytes(32).toString("base64url"), client_id: client.id },
    { refresh_token: tokens.refresh_token, client_id: other.id },
  ]) expect((await token({ grant_type: "refresh_token", ...p })).status).toBe(400);
  expect((await access(next.access_token)).status).toBe(200);
  expect((await token({ grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: client.id })).status).toBe(200);
});

it("requires an active grant for an access token and preserves ordinary API keys", async () => {
  const { tokens } = await connected();
  await db.update(s.oauthGrants).set({ status: "pending" }).where(eq(s.oauthGrants.workspace_id, WS));
  expect((await access(tokens.access_token)).status).toBe(401);
  const key = (await import("@/lib/auth")).generateApiKey();
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "Ordinary", key_hash: key.hash, key_prefix: key.prefix });
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  expect((await access(key.plaintext)).status).toBe(200);
});

it("bounds a streamed consent body without Content-Length", async () => {
  const bytes = new TextEncoder().encode(new URLSearchParams({ state: "s".repeat(20_000) }).toString());
  const request = new Request("http://localhost/oauth/authorize", {
    method: "POST", headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), duplex: "half",
  } as RequestInit);
  expect(request.headers.has("content-length")).toBe(false);
  expect((await app.request(request)).status).toBe(413);
});

it("sets private no-store on consent and the return page", async () => {
  const p = await pending();
  const page = await app.request(`/oauth/authorize?${new URLSearchParams(p.params)}`, { headers: { cookie } });
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1];
  const response = await app.request("/oauth/authorize", {
    method: "POST", headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...p.params, csrf, decision: "deny" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("checks the license and consent budgets before reading metadata", async () => {
  const p = await pending();
  const net = await import("@/lib/net/safe-fetch");
  const fetch = vi.spyOn(net, "safeFetch");
  const url = `/oauth/authorize?${new URLSearchParams({ ...p.params, client_id: "https://client.example/budget.json" })}`;
  try {
    await licenseInstance("free");
    expect((await app.request(url, { headers: { cookie } })).status).toBe(403);
    await licenseInstance("pro");
    for (const [key, count] of [[`rl:oauth-consent-user:${USER}`, 30], ["rl:oauth-authorize:unknown", 60]] as const) {
      await db.delete(s.rateLimitCounters).where(like(s.rateLimitCounters.key, "rl:oauth-%"));
      await db.insert(s.rateLimitCounters).values({ key, count, window_start: new Date() });
      expect((await app.request(url, { headers: { cookie } })).status).toBe(429);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
