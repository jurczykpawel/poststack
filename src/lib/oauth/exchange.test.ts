import { describe, it, expect, afterEach, vi } from "vitest";
import { exchangeCodeForToken } from "./exchange";
import type { OAuthConfig } from "@/lib/providers/types";

const base: OAuthConfig = {
  authorizeUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  scopes: ["read"],
  clientId: "CID",
  clientSecret: "SECRET",
};

afterEach(() => vi.unstubAllGlobals());

function captureFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("exchangeCodeForToken", () => {
  it("posts the authorization_code grant as form-encoded and maps the token response to a TokenSet", async () => {
    const calls = captureFetch({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    const tokens = await exchangeCodeForToken(base, { code: "CODE", redirectUri: "https://app/cb" });
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(typeof tokens.expiresAt).toBe("string");
    expect(new Date(tokens.expiresAt!).getTime()).toBeGreaterThan(Date.now());

    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("redirect_uri")).toBe("https://app/cb");
    expect(body.get("client_id")).toBe("CID");
    expect(body.get("client_secret")).toBe("SECRET");
  });

  it("sends client creds as a Basic auth header (not in the body) when tokenAuthBasic", async () => {
    const calls = captureFetch({ access_token: "AT" });
    await exchangeCodeForToken({ ...base, tokenAuthBasic: true }, { code: "C", redirectUri: "https://app/cb" });
    const auth = new Headers(calls[0]!.init.headers).get("authorization");
    expect(auth).toBe(`Basic ${Buffer.from("CID:SECRET").toString("base64")}`);
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("client_secret")).toBeNull();
  });

  it("includes the PKCE code_verifier when supplied, and honors clientIdParam", async () => {
    const calls = captureFetch({ access_token: "AT" });
    await exchangeCodeForToken({ ...base, clientIdParam: "client_key" }, { code: "C", redirectUri: "https://app/cb", codeVerifier: "VER" });
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("code_verifier")).toBe("VER");
    expect(body.get("client_key")).toBe("CID");
  });

  it("throws on a non-2xx token response", async () => {
    captureFetch({ error: "invalid_grant" }, 400);
    await expect(exchangeCodeForToken(base, { code: "C", redirectUri: "https://app/cb" })).rejects.toThrow();
  });

  it("throws when the response carries no access_token", async () => {
    captureFetch({ token_type: "bearer" });
    await expect(exchangeCodeForToken(base, { code: "C", redirectUri: "https://app/cb" })).rejects.toThrow();
  });
});
