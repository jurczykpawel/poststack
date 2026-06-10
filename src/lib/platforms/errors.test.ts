import { describe, it, expect } from "vitest";
import { TokenInvalidError, MessagingPolicyError, RateLimitError, isMetaTokenError, isMetaWindowError, isMetaRateLimitError, isMetaPrivateReplyPolicyError, isMetaUnreachableRecipientError, isMetaCommentPolicyError, parseRetryAfterMs, assertMetaOk } from "./errors";

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

// out-of-window rejections are a policy block (retry can't fix), not a token error.
describe("isMetaWindowError", () => {
  it("is true for error_subcode 2018278 (outside allowed window)", () => {
    expect(isMetaWindowError('{"error":{"code":10,"error_subcode":2018278,"message":"This message is sent outside of allowed window."}}')).toBe(true);
  });

  it("falls back to the documented message text", () => {
    expect(isMetaWindowError("(#10) This message is sent outside of allowed window.")).toBe(true);
  });

  // other terminal messaging-policy subcodes (tag-related, policy family) must also be
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

// a 429 / throttle code is retryable, but only after the provider's Retry-After window.
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

// private-reply rejections (comment too old / already replied / ineligible) surface as
// application/permission/parameter error codes outside the 24h-window subcode allowlist; they're
// terminal, so they must drop (not dead-letter). Transient codes (1/2) and unparseable bodies stay
// retryable.
describe("isMetaPrivateReplyPolicyError", () => {
  it("is true for terminal application/permission/parameter codes (10 / 100 / 200)", () => {
    expect(isMetaPrivateReplyPolicyError('{"error":{"code":10,"message":"(#10) Application does not have permission for this action"}}')).toBe(true);
    expect(isMetaPrivateReplyPolicyError('{"error":{"code":100,"message":"(#100) Invalid parameter"}}')).toBe(true);
    expect(isMetaPrivateReplyPolicyError('{"error":{"code":200,"message":"Permissions error"}}')).toBe(true);
  });
  it("is false for transient codes (1 unknown / 2 service unavailable) — those stay retryable", () => {
    expect(isMetaPrivateReplyPolicyError('{"error":{"code":1,"message":"An unknown error occurred"}}')).toBe(false);
    expect(isMetaPrivateReplyPolicyError('{"error":{"code":2,"message":"Service temporarily unavailable"}}')).toBe(false);
  });
  it("is false for an unparseable body (e.g. a 5xx HTML page)", () => {
    expect(isMetaPrivateReplyPolicyError("upstream connect error or disconnect")).toBe(false);
  });
});

// a stale/unreachable recipient (subcode 2018001) is permanent; drop, never retry.
// Subcode-keyed so it's safe in any send context (unlike a bare overloaded code).
describe("isMetaUnreachableRecipientError", () => {
  it("is true for subcode 2018001 (no matching user / dead recipient)", () => {
    expect(isMetaUnreachableRecipientError('{"error":{"code":100,"error_subcode":2018001,"message":"No matching user found"}}')).toBe(true);
  });
  it("is false for a bare code-100 with no subcode (overloaded → transient)", () => {
    expect(isMetaUnreachableRecipientError('{"error":{"code":100,"message":"(#100) Invalid parameter"}}')).toBe(false);
  });
  it("is false for an unknown subcode and for an unparseable body", () => {
    expect(isMetaUnreachableRecipientError('{"error":{"error_subcode":9999999}}')).toBe(false);
    expect(isMetaUnreachableRecipientError("upstream connect error")).toBe(false);
  });
});

// code 10 on a sendComment = commenting disabled / post blocked = terminal. Only
// code 10 (bare-100 overloaded, 200 channel-wide → both stay transient here).
describe("isMetaCommentPolicyError", () => {
  it("is true for code 10 (action not allowed on this comment/post)", () => {
    expect(isMetaCommentPolicyError('{"error":{"code":10,"message":"(#10) commenting disabled"}}')).toBe(true);
  });
  it("is false for code 100 / 200 (overloaded / channel-wide) and unparseable bodies", () => {
    expect(isMetaCommentPolicyError('{"error":{"code":100}}')).toBe(false);
    expect(isMetaCommentPolicyError('{"error":{"code":200}}')).toBe(false);
    expect(isMetaCommentPolicyError("not json")).toBe(false);
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

  // a private-reply policy rejection (terminal code outside the window subcode set) drops,
  // but ONLY for a private-reply context, and only for terminal codes.
  it("throws MessagingPolicyError for a private-reply policy rejection (code 10) on a private-reply context", async () => {
    const res = new Response('{"error":{"code":10,"message":"(#10) cannot privately reply to this comment"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook private reply")).rejects.toBeInstanceOf(MessagingPolicyError);
    await expect(assertMetaOk(new Response('{"error":{"code":100}}', { status: 400 }), "Instagram private reply")).rejects.toBeInstanceOf(MessagingPolicyError);
  });

  it("does NOT widen terminal classification for a normal send — the same code-10 body stays a retryable generic Error", async () => {
    const res = new Response('{"error":{"code":10,"message":"(#10) policy"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toThrow(/failed/);
    await expect(assertMetaOk(new Response('{"error":{"code":10}}', { status: 400 }), "Facebook send message")).rejects.not.toBeInstanceOf(MessagingPolicyError);
  });

  it("keeps a transient error retryable even on a private-reply context (code 2 → generic Error, not dropped)", async () => {
    const res = new Response('{"error":{"code":2,"message":"Service temporarily unavailable"}}', { status: 500 });
    await expect(assertMetaOk(res, "Facebook private reply")).rejects.toThrow(/failed/);
    await expect(assertMetaOk(new Response('{"error":{"code":2}}', { status: 500 }), "Facebook private reply")).rejects.not.toBeInstanceOf(MessagingPolicyError);
  });

  // a 2018001 (dead recipient) drops in ANY send context (subcode-keyed).
  it("throws MessagingPolicyError for an unreachable-recipient subcode (2018001) on a normal send", async () => {
    const res = new Response('{"error":{"code":100,"error_subcode":2018001,"message":"No matching user found"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toBeInstanceOf(MessagingPolicyError);
    await expect(assertMetaOk(new Response('{"error":{"code":100,"error_subcode":2018001}}', { status: 400 }), "Instagram send message")).rejects.toBeInstanceOf(MessagingPolicyError);
  });

  // code 10 drops on a comment send, but a bare code-100 on the same context, and
  // a code-10 on a normal DM, both stay retryable (anti-regression).
  it("throws MessagingPolicyError for code 10 on a send-comment context", async () => {
    await expect(assertMetaOk(new Response('{"error":{"code":10,"message":"commenting disabled"}}', { status: 400 }), "Facebook send comment")).rejects.toBeInstanceOf(MessagingPolicyError);
  });
  it("keeps code 10 on a send-message context, and bare code-100 on a comment context, retryable", async () => {
    await expect(assertMetaOk(new Response('{"error":{"code":10}}', { status: 400 }), "Facebook send message")).rejects.not.toBeInstanceOf(MessagingPolicyError);
    await expect(assertMetaOk(new Response('{"error":{"code":100}}', { status: 400 }), "Facebook send comment")).rejects.toThrow(/failed/);
  });
});
