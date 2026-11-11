import { describe, it, expect, afterEach, vi } from "vitest";
import { threadsProvider } from "./threads";
import { isProvider, listProviders } from "./index";
import { TokenInvalidError } from "./errors";

vi.mock("./oauth-credentials", () => ({ oauthCredentials: async () => ({ clientId: "app", clientSecret: "shh" }) }));
afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "AT" };

describe("threads provider", () => {
  it("is registered + refreshable + text capability", () => {
    expect(isProvider("threads")).toBe(true);
    expect(threadsProvider.requiresTokenRefresh()).toBe(true);
    expect(threadsProvider.capabilities().map((c) => c.format)).toContain("text");
  });

  it("refreshToken refreshes the long-lived token in place (GET)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 5184000 }), { status: 200 })));
    const t = await threadsProvider.refreshToken(tokens);
    expect(t.accessToken).toBe("fresh");
  });

  it("exchangeLongLived swaps a short-lived token via th_exchange_token", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "long", token_type: "bearer", expires_in: 5183944 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const t = await threadsProvider.exchangeLongLived!({ accessToken: "short" });
    expect(t.accessToken).toBe("long");
    expect(Date.parse(t.expiresAt!) - Date.now()).toBeGreaterThan(59 * 86400_000);
    const url = new URL(String((fetcher.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe("https://graph.threads.net/access_token");
    expect(url.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(url.searchParams.get("access_token")).toBe("short");
    expect(url.searchParams.get("client_secret")).toBeTruthy();
  });

  it("exchangeLongLived failure is classified, not swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 190, message: "bad" } }), { status: 400 })));
    await expect(threadsProvider.exchangeLongLived!({ accessToken: "short" })).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("healthCheck returns the user id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "th_1" }), { status: 200 })));
    expect((await threadsProvider.healthCheck(tokens)).accountId).toBe("th_1");
  });

  it("healthCheck expired session (code 190, HTTP 400) -> TokenInvalidError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 190, message: "Session has expired" } }), { status: 400 })));
    await expect(threadsProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("healthCheck 401 -> TokenInvalidError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "x" } }), { status: 401 })));
    await expect(threadsProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("publish persists a workflow before creating a text container", async () => {
    const h = await threadsProvider.publish({ tokens, accountId: "th_1", request: { format: "text", media: [], caption: "hi" }, mediaUrls: [] });
    expect(h.processing).toBe(true);
    expect(JSON.parse(h.providerHandle)).toMatchObject({ accountId: "th_1", format: "text" });
  });

  it("all seven v1 providers are registered", () => {
    expect(listProviders().map((p) => p.id).sort()).toEqual(
      ["linkedin", "meta", "telegram", "threads", "tiktok", "x", "youtube"],
    );
  });
});
