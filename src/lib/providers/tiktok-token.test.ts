import { afterEach, describe, expect, it, vi } from "vitest";
import docs from "../../../tests/fixtures/provider-docs/tiktok.json";
import { connectTikTokToken, tiktokProvider } from "./tiktok";
import { fromTokenSet, toTokenSet } from "./token-codec";
import { PermanentError, TokenInvalidError, TransientError } from "./errors";

vi.mock("./oauth-credentials", () => ({ oauthCredentials: vi.fn(async () => ({ clientId: "instance-key", clientSecret: "instance-secret" })) }));
const input = { access_token: "pasted-access", refresh_token: "pasted-refresh", client_key: "issuer-key", client_secret: "issuer-secret" };
const issuer = { issuerClientKey: input.client_key, issuerClientSecret: input.client_secret };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TikTok channel credentials", () => {
  it("keeps OAuth first and offers manual tokens", () => {
    expect(tiktokProvider.connectionModes()).toEqual(["oauth", "manual_token"]);
  });
  it.each([true, false])("refreshes with channel credentials when present: %s", async present => {
    const http = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(docs.refresh.ok));
    vi.stubGlobal("fetch", http);
    const refreshed = await tiktokProvider.refreshToken({ accessToken: "old", refreshToken: "refresh", ...(present ? issuer : {}) });
    const body = new URLSearchParams(String(http.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh", client_key: present ? "issuer-key" : "instance-key", client_secret: present ? "issuer-secret" : "instance-secret" });
    expect(body.has("client_id")).toBe(false);
    expect(refreshed.refreshToken).toBe(docs.refresh.ok.refresh_token);
    expect(Date.parse(refreshed.expiresAt!)).toBeGreaterThan(Date.now() + 86300_000);
  });
  it("carries issuer credentials through both token formats", () => {
    expect(fromTokenSet(toTokenSet({ access_token: "access", ...issuer })) ).toMatchObject(issuer);
  });
  it.each([false, true])("validates user info and establishes expiry, expired access: %s", async expired => {
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token/")) return Response.json(docs.refresh.ok);
      const token = new Headers(init?.headers).get("authorization");
      if (expired && token === `Bearer ${input.access_token}`) return Response.json(docs.userInfo.tokenInvalid.body, { status: 401 });
      return Response.json({ ...docs.userInfo.ok.body, data: { user: { ...docs.userInfo.ok.body.data.user, display_name: "Creator" } } });
    });
    vi.stubGlobal("fetch", http);
    const [account] = await connectTikTokToken(input);
    expect(account).toMatchObject({ platformId: docs.userInfo.ok.body.data.user.open_id, displayName: "Creator", tokens: { ...issuer, access_token: docs.refresh.ok.access_token, refresh_token: docs.refresh.ok.refresh_token } });
    expect(account!.tokens.expires_at).toBeGreaterThan(Date.now() / 1000 + 86300);
    expect(http.mock.calls.some(([url, init]) => url.includes("/user/info/") && new Headers(init?.headers).get("authorization") === `Bearer ${docs.refresh.ok.access_token}`)).toBe(true);
  });
  it.each([{}, { data: { user: { open_id: 123 } }, error: { code: "ok" } }, { data: docs.userInfo.ok.body.data, error: { code: "scope_not_authorized" } }])("requires successful user info with a string open_id: %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(connectTikTokToken(input)).rejects.toBeInstanceOf(PermanentError);
  });
  it("requires the refreshed token to identify the same account", async () => {
    let info = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/oauth/token/") ? Response.json(docs.refresh.ok) : Response.json({ data: { user: { open_id: String(++info) } }, error: { code: "ok" } })));
    await expect(connectTikTokToken(input)).rejects.toThrow();
  });
  it("rejects a partial issuer configuration without calling the instance app", async () => {
    const http = vi.fn();
    vi.stubGlobal("fetch", http);
    await expect(tiktokProvider.refreshToken({ accessToken: "access", refreshToken: "refresh", issuerClientKey: "issuer-key" })).rejects.toBeInstanceOf(TokenInvalidError);
    expect(http).not.toHaveBeenCalled();
  });
  it.each(["network", "provider", "rejected"])("uses a fixed refresh error for %s failures", async failure => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error(input.client_secret);
      return Response.json({ error: input.client_secret, error_description: input.refresh_token }, { status: failure === "rejected" ? 400 : 503 });
    }));
    const error = await tiktokProvider.refreshToken({ accessToken: input.access_token, refreshToken: input.refresh_token, ...issuer }).catch(e => e);
    expect(error).toBeInstanceOf(failure === "rejected" ? PermanentError : TransientError);
    expect(error.stack).not.toContain(input.client_secret);
    expect(error.stack).not.toContain(input.refresh_token);
  });
});
