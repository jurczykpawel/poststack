import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let connect: typeof import("./connect");
let generateOAuthState: typeof import("./state").generateOAuthState;
let pkceCookie: typeof import("./state").pkceCookie;
let createPkcePair: typeof import("./authorize").createPkcePair;
let decryptTokens: typeof import("@/lib/crypto").decryptTokens;
let gate: typeof import("@/lib/license/gate");
let licenseInstance: typeof import("@/lib/license/__fixtures__/license-instance").licenseInstance;

const WS = "eeee0000-0000-0000-0000-00000000ee01";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.TIKTOK_CLIENT_KEY = "tt-key";
  process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
  process.env.X_CLIENT_ID = "x-id";
  process.env.X_CLIENT_SECRET = "x-secret";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  connect = await import("./connect");
  ({ generateOAuthState, pkceCookie } = await import("./state"));
  ({ createPkcePair } = await import("./authorize"));
  ({ decryptTokens } = await import("@/lib/crypto"));
  gate = await import("@/lib/license/gate");
  ({ licenseInstance } = await import("@/lib/license/__fixtures__/license-instance"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "OA", slug: `oa-${WS}` });
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  await db.$client.end();
});

// Stub the TikTok token endpoint + the provider healthCheck (userinfo) network calls.
function mockTikTok(accountId = "tt-account-1") {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/oauth/token")) {
      return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 86400 });
    }
    // TikTok healthCheck → user info
    if (url.includes("/user/info") || url.includes("user.info")) {
      return Response.json({ data: { user: { open_id: accountId, display_name: "My TikTok", avatar_url: "https://x/y.jpg" } } });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("completePublishOAuth (real Postgres)", () => {
  it("verifies state, exchanges the code, resolves the account, and upserts an oauth channel", async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro"); // a non-Meta channel needs non_meta_channels
    mockTikTok("tt-acc-1");
    const { state, setCookie } = generateOAuthState();
    const cookieHeader = setCookie.split(";")[0]!; // "rs_oauth_state=<value>"

    const r = await connect.completePublishOAuth({
      platform: "tiktok",
      code: "AUTHCODE",
      state,
      cookieHeader,
      redirectUri: "https://app/cb",
      workspaceId: WS,
    });

    expect(r.accountId).toBe("tt-acc-1");
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, r.channelId) });
    expect(ch!.workspace_id).toBe(WS);
    expect(ch!.platform).toBe("tiktok");
    expect(ch!.platform_id).toBe("tt-acc-1");
    expect(ch!.connection_mode).toBe("oauth");
    // token was encrypted at rest, and round-trips back to what the exchange returned
    expect(decryptTokens(ch!.token_encrypted!).access_token).toBe("AT");
    // and the cookies to clear are returned
    expect(r.clearCookies.some((c) => c.startsWith("rs_oauth_state="))).toBe(true);
  });

  it("rejects a mismatched state (CSRF) before any token exchange", async () => {
    if (!TEST_DB) return;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      connect.completePublishOAuth({
        platform: "tiktok",
        code: "AUTHCODE",
        state: "GOOD",
        cookieHeader: "rs_oauth_state=DIFFERENT",
        redirectUri: "https://app/cb",
        workspaceId: WS,
      }),
    ).rejects.toThrow(/Invalid OAuth state/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires the PKCE verifier cookie for a PKCE provider (X)", async () => {
    if (!TEST_DB) return;
    const { state, setCookie } = generateOAuthState();
    const stateCookie = setCookie.split(";")[0]!;
    // state present but PKCE cookie missing → reject before exchange
    await expect(
      connect.completePublishOAuth({
        platform: "twitter",
        code: "C",
        state,
        cookieHeader: stateCookie,
        redirectUri: "https://app/cb",
        workspaceId: WS,
      }),
    ).rejects.toThrow(/PKCE/);
  });

  it("sends the PKCE verifier to the token endpoint when present", async () => {
    if (!TEST_DB) return;
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth2/token")) {
        bodies.push(String(init?.body));
        return Response.json({ access_token: "AT", expires_in: 7200 });
      }
      if (url.includes("users/me") || url.includes("/2/users")) {
        return Response.json({ data: { id: "x-acc-1", name: "X User", username: "xuser" } });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await licenseInstance("pro");
    const { state, setCookie } = generateOAuthState();
    const { verifier } = createPkcePair();
    const cookieHeader = `${setCookie.split(";")[0]}; ${pkceCookie(verifier).split(";")[0]}`;

    const r = await connect.completePublishOAuth({
      platform: "twitter",
      code: "C",
      state,
      cookieHeader,
      redirectUri: "https://app/cb",
      workspaceId: WS,
    });
    expect(r.accountId).toBe("x-acc-1");
    expect(new URLSearchParams(bodies[0]!).get("code_verifier")).toBe(verifier);
  });

  // The generic connect URL is keyed by PROVIDER id (/connect/x), but a channel's `platform` column is
  // the RS platform value "twitter" — the enum has no "x". completePublishOAuth must map the connect id
  // to the platform, else the channel upsert fails ("invalid input value for enum platform: 'x'").
  it("connecting via provider id 'x' stores the channel under platform 'twitter'", async () => {
    if (!TEST_DB) return;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth2/token")) return Response.json({ access_token: "AT", expires_in: 7200 });
      if (url.includes("users/me") || url.includes("/2/users")) return Response.json({ data: { id: "x-acc-2", username: "xuser2" } });
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await licenseInstance("pro");
    const { state, setCookie } = generateOAuthState();
    const { verifier } = createPkcePair();
    const cookieHeader = `${setCookie.split(";")[0]}; ${pkceCookie(verifier).split(";")[0]}`;

    const r = await connect.completePublishOAuth({
      platform: "x", // ← the provider id, as the /connect/x URL passes it
      code: "C",
      state,
      cookieHeader,
      redirectUri: "https://app/cb",
      workspaceId: WS,
    });
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, r.channelId) });
    expect(ch!.platform).toBe("twitter"); // stored under the RS platform, not "x"
    expect(ch!.platform_id).toBe("x-acc-2");
  });

  it("gates a non-Meta channel behind PRO on a free instance (ProRequiredError → 402)", async () => {
    if (!TEST_DB) return;
    mockTikTok("tt-acc-free");
    const { state, setCookie } = generateOAuthState();
    const cookieHeader = setCookie.split(";")[0]!;
    await expect(
      connect.completePublishOAuth({
        platform: "tiktok",
        code: "AUTHCODE",
        state,
        cookieHeader,
        redirectUri: "https://app/cb",
        workspaceId: WS,
      }),
    ).rejects.toMatchObject({ feature: "non_meta_channels" });
    // nothing was connected
    const chans = await db.query.channels.findMany({ where: eq(s.channels.workspace_id, WS) });
    expect(chans).toHaveLength(0);
  });
});
