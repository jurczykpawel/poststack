import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import pages from "../../../../tests/fixtures/provider-docs/linkedin-pages.json";

// LinkedIn Company Pages, end to end through the app: start (?pages=1) → callback → picker → channels.
const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "cccccccc-0000-0000-0000-00000000a1a1";
const USER = "cccccccc-0000-0000-0000-00000000a1a2";
const realFetch = globalThis.fetch;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let decryptTokens: typeof import("@/lib/crypto").decryptTokens;
let session: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, JWT_SECRET: "test-secret-at-least-32-characters-long",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000001",
    APP_URL: "http://localhost:3000", CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
    LINKEDIN_CLIENT_ID: "li-id", LINKEDIN_CLIENT_SECRET: "li-secret",
  });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ decryptTokens } = await import("@/lib/crypto"));
  app = (await import("../../app")).buildApp();
  session = `session=${await (await import("@/lib/auth")).signSession(USER, WS)}`;
  await (await import("@/lib/license/__fixtures__/license-instance")).licenseInstance("pro");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "LP", slug: `lp-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  stubLinkedIn();
});

afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function stubLinkedIn(acl: Response | null = null) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth/v2/accessToken")) return Response.json({ access_token: "ORG-AT", refresh_token: "ORG-RT", expires_in: 5184000 });
    if (url.endsWith("/v2/userinfo")) return Response.json({ sub: "member-1", name: "Member One" });
    if (url.includes("/organizationAcls")) return acl ?? Response.json(pages.organizationAcls.body);
    const org = /\/organizations\/(\d+)$/.exec(url)?.[1] as keyof typeof pages.organizations | undefined;
    if (org) return Response.json(pages.organizations[org].body);
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
}

const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))!.split(";")[0]!;

/** Run start + callback; returns the cookie header carrying session + the parked pick token. */
async function authorizePages(): Promise<string> {
  const start = await app.request("/api/oauth/connect/linkedin?pages=1", { headers: { cookie: session } });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.searchParams.get("scope")).toBe("openid profile w_member_social w_organization_social r_organization_admin");
  const cb = await app.request(`/api/oauth/connect/linkedin/callback?code=C&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie: `${session}; ${cookieOf(start, "rs_oauth_state")}` } });
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe("http://localhost:3000/channels/pick/linkedin");
  return `${session}; ${cookieOf(cb, "rs_oauth_pick")}`;
}

const pick = (cookie: string, values: string[]) => app.request("/channels/pick/linkedin", {
  method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values.map((v) => ["account", v])).toString(),
});

const linkedinChannels = () => db.query.channels.findMany({ where: and(eq(s.channels.workspace_id, WS), eq(s.channels.platform, "linkedin")) });

describe("LinkedIn Company Pages picker (real Postgres)", () => {
  it("lists the profile and the pages, then connects only the ticked page as its own channel", async () => {
    if (!TEST_DB) return;
    const [person] = await db.insert(s.channels).values({ workspace_id: WS, platform: "linkedin", platform_id: "member-1", display_name: "Member One",
      token_encrypted: "kept", webhook_secret: "w", status: "active", connection_mode: "oauth" }).returning();
    const cookie = await authorizePages();

    const page = await app.request("/channels/pick/linkedin", { headers: { cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect([...body.matchAll(/name="account" value="([^"]+)"/g)].map((m) => m[1])).toEqual(["person", "page:90000001", "page:90000002"]);
    expect(body).toContain("Example Academy");
    expect(body).toContain("Example Foundation");

    const res = await pick(cookie, ["page:90000002", "page:424242"]); // an id the token cannot post to is ignored
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/channels?connected=linkedin&count=1");
    expect(res.headers.get("set-cookie")).toMatch(/^rs_oauth_pick=; .*Max-Age=0/);

    const rows = await linkedinChannels();
    expect(rows).toHaveLength(2);
    const org = rows.find((r) => r.platform_id === "90000002")!;
    expect(org).toMatchObject({ display_name: "Example Academy", status: "active", connection_mode: "oauth", metadata: { subKind: "organization", vanityName: "example-academy" } });
    expect(decryptTokens(org.token_encrypted)).toMatchObject({ access_token: "ORG-AT", refresh_token: "ORG-RT" });
    // regression: the existing profile channel is untouched
    expect(rows.find((r) => r.id === person!.id)).toMatchObject({ token_encrypted: "kept", metadata: {} });
  });

  it("connects the profile from the picker without a page marker", async () => {
    if (!TEST_DB) return;
    const res = await pick(await authorizePages(), ["person"]);
    expect(res.headers.get("location")).toBe("/channels?connected=linkedin&count=1");
    const [row] = await linkedinChannels();
    expect(row).toMatchObject({ platform_id: "member-1", display_name: "Member One", metadata: {} });
  });

  it("reconnecting a page restores it and merges its metadata", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({ workspace_id: WS, platform: "linkedin", platform_id: "90000002", display_name: "Old", token_encrypted: "x",
      webhook_secret: "w", status: "needs_reauth", needs_reauth_reason: "token_expired", connection_mode: "oauth", metadata: { subKind: "organization", note: "keep" } });
    await pick(await authorizePages(), ["page:90000002"]);
    const [row] = await linkedinChannels();
    expect(row).toMatchObject({ status: "active", needs_reauth_reason: null, display_name: "Example Academy", metadata: { subKind: "organization", note: "keep", vanityName: "example-academy" } });
  });

  it("refuses the picker without the parked token, for another session, and with nothing ticked", async () => {
    if (!TEST_DB) return;
    const none = await app.request("/channels/pick/linkedin", { headers: { cookie: session } });
    expect(none.headers.get("location")).toBe("/channels?error=invalid_state");
    const cookie = await authorizePages();
    const other = `session=${await (await import("@/lib/auth")).signSession(USER, WS)}; ${cookie.split("; ")[1]}`;
    expect((await pick(other, ["page:90000002"])).headers.get("location")).toBe("/channels?error=invalid_state");
    const empty = await pick(cookie, []);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Tick at least one account");
    expect(await linkedinChannels()).toHaveLength(0);
  });

  it("explains missing page access on the picker and maps an unauthorized scope on the callback", async () => {
    if (!TEST_DB) return;
    const cookie = await authorizePages();
    stubLinkedIn(Response.json(pages.aclDenied.body, { status: 403 }));
    const body = await (await app.request("/channels/pick/linkedin", { headers: { cookie } })).text();
    expect(body).toContain("Community Management API");
    expect(body).not.toContain('name="account"');
    const denied = await app.request("/api/oauth/connect/linkedin/callback?error=unauthorized_scope_error&state=x", { headers: { cookie: session } });
    expect(denied.headers.get("location")).toBe("http://localhost:3000/channels?error=scope_unavailable");
  });

  it("a plain LinkedIn state never opens the picker (profile connect unchanged)", async () => {
    if (!TEST_DB) return;
    const start = await app.request("/api/oauth/connect/linkedin", { headers: { cookie: session } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = await app.request(`/api/oauth/connect/linkedin/callback?code=C&state=${state}`, { headers: { cookie: `${session}; ${cookieOf(start, "rs_oauth_state")}` } });
    expect(cb.headers.get("location")).toBe("http://localhost:3000/channels?connected=linkedin&count=1");
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("rs_oauth_pick="))).toBe(false);
    const [row] = await linkedinChannels();
    expect(row).toMatchObject({ platform_id: "member-1", metadata: {} });
  });
});
