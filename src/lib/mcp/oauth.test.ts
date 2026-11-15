import { createHash } from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@/lib/net/safe-fetch", () => ({ safeFetch: (...args: unknown[]) => fetchMock(...args) }));

let m: typeof import("./oauth");

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
  process.env.ENCRYPTION_KEY ??= "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "https://ps.example.com/";
  m = await import("./oauth");
});

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

describe("PKCE S256", () => {
  // RFC 7636 Appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  it("accepts the RFC 7636 example and rejects anything else", () => {
    expect(challengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(m.pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(m.pkceMatches(`${verifier.slice(0, -1)}A`, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
    expect(m.pkceMatches(verifier, verifier)).toBe(false); // "plain" is not accepted
  });
  it("rejects verifiers outside the RFC length/charset", () => {
    const short = "a".repeat(42);
    expect(m.pkceMatches(short, challengeOf(short))).toBe(false);
    const spaced = `${"a".repeat(42)} `;
    expect(m.pkceMatches(spaced, challengeOf(spaced))).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("allows https and loopback http only, never fragments or credentials", () => {
    expect(m.isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(m.isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(m.isAllowedRedirectUri("http://localhost/callback")).toBe(true);
    expect(m.isAllowedRedirectUri("http://[::1]:9000/cb")).toBe(true);
    expect(m.isAllowedRedirectUri("http://example.com/cb")).toBe(false);
    expect(m.isAllowedRedirectUri("https://claude.ai/cb#x")).toBe(false);
    expect(m.isAllowedRedirectUri("https://user:pw@claude.ai/cb")).toBe(false);
    expect(m.isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(m.isAllowedRedirectUri("not a url")).toBe(false);
  });
  it("matches exactly, except that a loopback redirect may change its port", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1/callback"];
    expect(m.redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(m.redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(m.redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(m.redirectUriMatches(registered, "https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(m.redirectUriMatches(registered, "http://127.0.0.1:51234/callback")).toBe(true);
    expect(m.redirectUriMatches(registered, "http://127.0.0.1:51234/other")).toBe(false);
    expect(m.redirectUriMatches(registered, "http://localhost:51234/callback")).toBe(false);
    expect(m.redirectUriMatches(["https://claude.ai:443/cb"], "https://claude.ai:8443/cb")).toBe(false);
  });
});

describe("resource indicator and response", () => {
  it("only accepts this instance's MCP endpoint or the instance itself", () => {
    expect(m.mcpResource()).toBe("https://ps.example.com/mcp");
    expect(m.resourceAllowed(undefined)).toBe(true);
    expect(m.resourceAllowed("https://ps.example.com/mcp")).toBe(true);
    expect(m.resourceAllowed("https://ps.example.com")).toBe(true);
    expect(m.resourceAllowed("https://other.example.com/mcp")).toBe(false);
    expect(m.resourceAllowed("https://ps.example.com/api/v1")).toBe(false);
  });
  it("adds iss (RFC 9207) and keeps the client's own query", () => {
    const url = new URL(m.redirectWith("https://chatgpt.com/connector_platform_oauth_redirect?a=1", { code: "c", state: "s&t", error: undefined }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ a: "1", code: "c", state: "s&t", iss: "https://ps.example.com" });
  });
});

describe("consent scopes", () => {
  it("read is read-only, write is everything except operator scopes", () => {
    expect(m.OAUTH_ACCESS.read.every((s) => s.endsWith(":read"))).toBe(true);
    expect(m.OAUTH_ACCESS.write).toContain("posts:write");
    expect([...m.OAUTH_ACCESS.read, ...m.OAUTH_ACCESS.write].some((s) => s.startsWith("instance_"))).toBe(false);
  });
  it("narrows to what the client requested, never adds to it", () => {
    expect(m.grantScopes("read", [])).toEqual([...m.OAUTH_ACCESS.read]);
    expect(m.grantScopes("write", ["posts:read", "posts:write"])).toEqual(["posts:read", "posts:write"]);
    expect(m.grantScopes("read", ["posts:read", "posts:write"])).toEqual(["posts:read"]);
    expect(m.grantScopes("read", ["posts:write"])).toEqual([]);
  });
});

describe("authorization request validation", () => {
  const doc = { client_id: "https://claude.ai/oauth/client.json", client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
  const base = { client_id: doc.client_id, redirect_uri: doc.redirect_uris[0], response_type: "code", code_challenge_method: "S256", code_challenge: challengeOf("v".repeat(43)), state: "st" };

  it("reads a Client ID Metadata Document and caches it", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json(doc));
    const parsed = await m.parseAuthorizeRequest({ ...base, scope: "posts:read offline_access" });
    expect("ok" in parsed && parsed.ok.client).toEqual({ id: doc.client_id, name: "Claude", redirect_uris: doc.redirect_uris });
    expect("ok" in parsed && parsed.ok.requestedScopes).toEqual(["posts:read"]);
    await m.parseAuthorizeRequest(base);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a metadata document whose client_id differs from its URL", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json({ ...doc, client_id: "https://evil.example/client.json" }));
    expect(await m.parseAuthorizeRequest({ ...base, client_id: "https://evil.example/other.json" })).toEqual({ fatal: expect.any(String) });
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json(doc));
    expect(await m.parseAuthorizeRequest({ ...base, redirect_uri: "https://evil.example/cb" })).toEqual({ fatal: expect.any(String) });
  });

  it("returns protocol errors to the registered redirect with state and iss", async () => {
    fetchMock.mockReset().mockResolvedValue(Response.json(doc));
    for (const [patch, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ] as const) {
      const parsed = await m.parseAuthorizeRequest({ ...base, ...patch });
      expect("redirect" in parsed).toBe(true);
      const url = new URL((parsed as { redirect: string }).redirect);
      expect(`${url.origin}${url.pathname}`).toBe(doc.redirect_uris[0]);
      expect(url.searchParams.get("error")).toBe(error);
      expect(url.searchParams.get("state")).toBe("st");
      expect(url.searchParams.get("iss")).toBe("https://ps.example.com");
    }
  });
});
