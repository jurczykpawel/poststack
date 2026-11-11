import { describe, it, expect, afterEach, vi } from "vitest";
import { classifyHttp, oauth2Refresh } from "./http";
import { TokenInvalidError, TransientError, PermanentError, PermissionError, PaymentRequiredError, RateLimitedError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

describe("classifyHttp", () => {
  it("maps status to typed errors", () => {
    expect(classifyHttp(401)).toBeInstanceOf(TokenInvalidError);
    expect(classifyHttp(403)).toBeInstanceOf(PermissionError);
    expect(classifyHttp(500)).toBeInstanceOf(TransientError);
    expect(classifyHttp(400)).toBeInstanceOf(PermanentError);
  });
});

describe("oauth2Refresh", () => {
  it("maps the token response and preserves the refresh token when none returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 })),
    );
    const t = await oauth2Refresh({
      tokenUrl: "https://x/token",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "OLD",
    });
    expect(t.accessToken).toBe("AT");
    expect(t.refreshToken).toBe("OLD"); // preserved (#1383)
    expect(t.expiresAt).toBeTruthy();
  });

  it("throws TokenInvalidError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })),
    );
    await expect(
      oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "OLD" }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("maps 400 invalid_grant to TokenInvalidError (dead refresh token, not retryable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "DEAD" }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
  });
});


describe("OAuth refresh response contract", () => {
  it.each(["invalid_client", "invalid_grant"])("TikTok HTTP 200 %s requires attention", async (error) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error, error_description: "Rejected", log_id: "20261101" })));
    await expect(oauth2Refresh({ tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toBeInstanceOf(TokenInvalidError);
  });
  it("reports rejected application credentials explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" })));
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toThrow(/application credentials rejected/);
  });
  it("does not send an empty refresh token", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "" })).rejects.toBeInstanceOf(TokenInvalidError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps 503 transient even with an OAuth error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" }, { status: 503 })));
    await expect(oauth2Refresh({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", refreshToken: "RT" })).rejects.toBeInstanceOf(TransientError);
  });
});

// Documented envelopes: Google Data API errors, X problem details, TikTok Content Posting errors.
describe("provider error details", () => {
  it.each(["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"])("Google %s is quota, not reconnect", (reason) => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "youtube", body: { error: { errors: [{ reason }] } } })).toBeInstanceOf(RateLimitedError);
  });
  it("LinkedIn permission includes the missing scope", () => {
    const err = classifyHttp(403, "Not enough permissions: w_member_social", "pre_commit", { provider: "linkedin" });
    expect(err).toBeInstanceOf(PermissionError);
    expect(err.message).toContain("w_member_social");
  });
  it("X credits required is a permanent payment reason", () => {
    expect(classifyHttp(402, undefined, "commit_uncertain", { provider: "x" })).toBeInstanceOf(PaymentRequiredError);
  });
  it.each([["access_token_invalid", TokenInvalidError], ["scope_not_authorized", PermissionError], ["rate_limit_exceeded", RateLimitedError]])("TikTok %s", (code, type) => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "tiktok", body: { error: { code } } })).toBeInstanceOf(type);
  });
  it("does not interpret another provider's numeric code as a Meta token", () => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "x", body: { errors: [{ code: 190 }] } })).toBeInstanceOf(PermissionError);
  });
  it.each(["pre_commit", "commit_uncertain"] as const)("keeps %s with Retry-After", (phase) => {
    const err = classifyHttp(429, undefined, phase, { headers: new Headers({ "Retry-After": "125" }) }) as RateLimitedError;
    expect(err.retryAfterSeconds).toBe(125);
    expect(err.phase).toBe(phase);
  });
  it("parses HTTP dates and X reset timestamps", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T12:00:00Z"));
    expect((classifyHttp(503, undefined, "pre_commit", { headers: new Headers({ "Retry-After": "Wed, 11 Nov 2026 12:02:00 GMT" }) }) as RateLimitedError).retryAfterSeconds).toBe(120);
    expect((classifyHttp(429, undefined, "pre_commit", { provider: "x", headers: new Headers({ "x-rate-limit-reset": String(Date.now() / 1000 + 300) }) }) as RateLimitedError).retryAfterSeconds).toBe(300);
    vi.restoreAllMocks();
  });
  it.each([["", 60], ["garbage", 60], ["-1", 60], ["0", 1], ["999999999", 86400]])("bounds delay %s", (value, expected) => {
    expect((classifyHttp(429, undefined, "pre_commit", { headers: new Headers({ "Retry-After": value }) }) as RateLimitedError).retryAfterSeconds).toBe(expected);
  });
});

describe("HTTP classification fallback", () => {
  it("X usage cap is distinct from permissions", () => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "x", body: { type: "https://api.x.com/2/problems/usage-capped" } })).toBeInstanceOf(RateLimitedError);
  });
  it("unknown Google 403 remains a permission failure", () => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "youtube", body: { error: { errors: [{ reason: "forbidden" }] } } })).toBeInstanceOf(PermissionError);
  });
  it.each([null, "upstream unavailable", { error: { errors: {} } }, { type: 123 }])("handles incomplete error envelopes", body => {
    expect(classifyHttp(403, undefined, "pre_commit", { provider: "youtube", body })).toBeInstanceOf(PermissionError);
  });
  it("503 without Retry-After remains transient", () => {
    expect(classifyHttp(503, undefined, "pre_commit")).toMatchObject({ kind: "transient", phase: "pre_commit" });
  });
  it("uses fallback delay for an invalid reset", () => {
    expect((classifyHttp(429, undefined, "pre_commit", { provider: "x", headers: new Headers({ "x-rate-limit-reset": "unknown" }) }) as RateLimitedError).retryAfterSeconds).toBe(60);
  });
  it("TikTok scope denial on HTTP 401 still identifies the missing grant", () => {
    expect(classifyHttp(401, undefined, "pre_commit", { provider: "tiktok", body: { error: { code: "scope_not_authorized" } } })).toBeInstanceOf(PermissionError);
  });
});
