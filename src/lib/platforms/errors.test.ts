import { describe, it, expect } from "vitest";
import { TokenInvalidError, MessagingPolicyError, RateLimitError, isMetaTokenError, isMetaWindowError, isMetaRateLimitError, parseRetryAfterMs, assertMetaOk } from "./errors";

describe("isMetaTokenError", () => {
  it("is true for Meta code 190 (invalid/expired token)", () => {
    expect(isMetaTokenError('{"error":{"code":190,"type":"OAuthException","message":"Error validating access token: Session has expired"}}')).toBe(true);
  });

  it("is false for non-token OAuth errors like permissions (code 200)", () => {
    expect(isMetaTokenError('{"error":{"code":200,"type":"OAuthException","message":"Permissions error"}}')).toBe(false);
  });

  it("is false for ordinary API errors (e.g. invalid parameter)", () => {
    expect(isMetaTokenError('{"error":{"code":100,"message":"(#100) Invalid parameter"}}')).toBe(false);
  });

  it("falls back to text heuristics for non-JSON bodies", () => {
    expect(isMetaTokenError("Error validating access token")).toBe(true);
    expect(isMetaTokenError("upstream connect error or disconnect")).toBe(false);
  });
});

//  — out-of-window rejections are a policy block (retry can't fix), not a token error.
describe("isMetaWindowError", () => {
  it("is true for error_subcode 2018278 (outside allowed window)", () => {
    expect(isMetaWindowError('{"error":{"code":10,"error_subcode":2018278,"message":"This message is sent outside of allowed window."}}')).toBe(true);
  });

  it("falls back to the documented message text", () => {
    expect(isMetaWindowError("(#10) This message is sent outside of allowed window.")).toBe(true);
  });

  //  — other terminal messaging-policy subcodes (tag-related, policy family) must also be
  // classified terminal, so they drop the delivery instead of grinding retries to dead-letter.
  it("is true for other known terminal policy subcodes (tag / policy family)", () => {
    expect(isMetaWindowError('{"error":{"code":10,"error_subcode":2018109}}')).toBe(true);
    expect(isMetaWindowError('{"error":{"code":10,"error_subcode":2042002}}')).toBe(true);
  });

  it("is false for token errors and ordinary failures", () => {
    expect(isMetaWindowError('{"error":{"code":190}}')).toBe(false);
    expect(isMetaWindowError('{"error":{"code":100,"message":"bad param"}}')).toBe(false);
    // An unknown subcode is NOT assumed terminal — it stays transient (retryable).
    expect(isMetaWindowError('{"error":{"code":10,"error_subcode":1234567}}')).toBe(false);
  });
});

//  — a 429 / throttle code is retryable, but only after the provider's Retry-After window.
describe("isMetaRateLimitError", () => {
  it("is true for Meta throttling codes (4 / 17 / 32 / 613)", () => {
    expect(isMetaRateLimitError('{"error":{"code":4,"message":"Application request limit reached"}}')).toBe(true);
    expect(isMetaRateLimitError('{"error":{"code":613,"message":"Calls to this api have exceeded the rate limit"}}')).toBe(true);
  });
  it("is false for non-throttle errors", () => {
    expect(isMetaRateLimitError('{"error":{"code":190}}')).toBe(false);
    expect(isMetaRateLimitError('{"error":{"code":100}}')).toBe(false);
    expect(isMetaRateLimitError("not json")).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  const headers = (v?: string) => new Headers(v != null ? { "retry-after": v } : {});
  it("reads a delta-seconds value", () => {
    expect(parseRetryAfterMs(headers("30"))).toBe(30_000);
  });
  it("reads an HTTP-date value relative to now", () => {
    const now = Date.now();
    expect(parseRetryAfterMs(headers(new Date(now + 45_000).toUTCString()), now)).toBeGreaterThanOrEqual(44_000);
  });
  it("falls back to a default when absent or unparseable", () => {
    expect(parseRetryAfterMs(headers())).toBe(60_000);
    expect(parseRetryAfterMs(headers("soon"))).toBe(60_000);
  });
  it("clamps an absurd value to the ceiling", () => {
    expect(parseRetryAfterMs(headers("999999"))).toBe(60 * 60_000);
  });
});

describe("assertMetaOk", () => {
  it("does nothing for an ok response", async () => {
    await expect(assertMetaOk(new Response("{}", { status: 200 }), "ctx")).resolves.toBeUndefined();
  });

  it("throws TokenInvalidError for a code-190 body", async () => {
    const res = new Response('{"error":{"code":190,"type":"OAuthException"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws MessagingPolicyError for an outside-window body", async () => {
    const res = new Response('{"error":{"code":10,"error_subcode":2018278,"message":"This message is sent outside of allowed window."}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toBeInstanceOf(MessagingPolicyError);
  });

  it("throws RateLimitError carrying Retry-After for a 429", async () => {
    const res = new Response('{"error":{"code":4}}', { status: 429, headers: { "retry-after": "120" } });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toMatchObject({ name: "RateLimitError", retryAfterMs: 120_000 });
  });

  it("throws RateLimitError for a throttle code even on a non-429 status", async () => {
    const res = new Response('{"error":{"code":613,"message":"rate limit"}}', { status: 400 });
    await expect(assertMetaOk(res, "x")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws a generic Error (not TokenInvalidError) for other failures", async () => {
    const res = new Response('{"error":{"code":100,"message":"bad param"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toThrow(/failed/);
    await expect(assertMetaOk(new Response('{"error":{"code":100}}', { status: 400 }), "x")).rejects.not.toBeInstanceOf(TokenInvalidError);
  });
});
