/**
 * Instagram Business Login OAuth helper (IGML5) — pure unit tests with mocked fetch + getConfig.
 *
 * Covers the two pieces the OAuth routes consume:
 *  - buildInstagramLoginAuthUrl: the authorize URL (client_id=INSTAGRAM_APP_ID, the three IG-Login
 *    scopes, response_type=code, redirect_uri, state).
 *  - exchangeInstagramLoginCode: code → short-lived (api.instagram.com) → long-lived
 *    (graph.instagram.com host, ig_exchange_token) → /me (user_id,username). Returns the IGQW
 *    messaging token, its expiry, and the IG business id. Handles both the flat and the newer
 *    `{ data: [ ... ] }` envelope shapes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IG_OAUTH_BASE, IG_OAUTH_TOKEN_BASE, IG_GRAPH_BASE } from "./constants";

vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) =>
    ({ INSTAGRAM_APP_ID: "ig-app-id-123", INSTAGRAM_APP_SECRET: "ig-app-secret-xyz" } as Record<string, string>)[key] ?? "",
}));

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

describe("buildInstagramLoginAuthUrl", () => {
  it("builds instagram.com/oauth/authorize with the IG App ID, the three scopes, and response_type=code", async () => {
    const { buildInstagramLoginAuthUrl } = await import("./instagram-login");
    const url = await buildInstagramLoginAuthUrl("st4te", "https://app.example/api/oauth/instagram-login/callback");
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`${IG_OAUTH_BASE}/oauth/authorize`);
    expect(u.searchParams.get("client_id")).toBe("ig-app-id-123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/api/oauth/instagram-login/callback");
    expect(u.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
    );
  });
});

describe("exchangeInstagramLoginCode", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url.startsWith(`${IG_OAUTH_TOKEN_BASE}/oauth/access_token`)) {
        // newer docs wrap in { data: [...] }
        return Response.json({ data: [{ access_token: "SHORT_TOK", user_id: 17841400000, permissions: "x" }] });
      }
      if (url.includes("/access_token") && url.includes("ig_exchange_token")) {
        return Response.json({ access_token: "IGQW_LONG_TOK", token_type: "bearer", expires_in: 5184000 });
      }
      if (url.includes("/me")) {
        return Response.json({ user_id: "17841400000", username: "acme_biz" });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exchanges code → short-lived (POST api.instagram.com) → long-lived → /me and returns the messaging token", async () => {
    const { exchangeInstagramLoginCode } = await import("./instagram-login");
    const res = await exchangeInstagramLoginCode("auth_code", "https://app.example/cb");

    expect(res.igUserId).toBe("17841400000");
    expect(res.username).toBe("acme_biz");
    expect(res.messagingToken).toBe("IGQW_LONG_TOK");
    expect(res.expiresAt).toBeInstanceOf(Date);
    // ~60 days out
    expect(res.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 3600 * 1000);

    // Short-lived: POST to api.instagram.com with form body carrying the IG creds + auth code
    const shortCall = fetchCalls.find((c) => c.url.startsWith(`${IG_OAUTH_TOKEN_BASE}/oauth/access_token`))!;
    expect(shortCall.init?.method).toBe("POST");
    const body = String(shortCall.init?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_id=ig-app-id-123");
    expect(body).toContain("code=auth_code");

    // Long-lived: graph.instagram.com host with ig_exchange_token + client_secret + short token
    const llCall = fetchCalls.find((c) => c.url.includes("ig_exchange_token"))!;
    expect(llCall.url.startsWith(new URL(IG_GRAPH_BASE).origin)).toBe(true);
    expect(llCall.url).toContain("client_secret=ig-app-secret-xyz");
    expect(llCall.url).toContain("access_token=SHORT_TOK");

    // /me on the versioned IG graph base with the long-lived token
    const meCall = fetchCalls.find((c) => c.url.includes("/me"))!;
    expect(meCall.url.startsWith(`${IG_GRAPH_BASE}/me`)).toBe(true);
    expect(meCall.url).toContain("fields=user_id%2Cusername");
    expect(meCall.url).toContain("access_token=IGQW_LONG_TOK");
  });

  it("throws a clear error when the short-lived exchange fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad code", { status: 400 })) as typeof fetch;
    const { exchangeInstagramLoginCode } = await import("./instagram-login");
    await expect(exchangeInstagramLoginCode("x", "https://app.example/cb")).rejects.toThrow(/Instagram-Login/);
  });
});
