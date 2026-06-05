import { describe, it, expect } from "vitest";
import { TokenInvalidError, isMetaTokenError, assertMetaOk } from "./errors";

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

describe("assertMetaOk", () => {
  it("does nothing for an ok response", async () => {
    await expect(assertMetaOk(new Response("{}", { status: 200 }), "ctx")).resolves.toBeUndefined();
  });

  it("throws TokenInvalidError for a code-190 body", async () => {
    const res = new Response('{"error":{"code":190,"type":"OAuthException"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws a generic Error (not TokenInvalidError) for other failures", async () => {
    const res = new Response('{"error":{"code":100,"message":"bad param"}}', { status: 400 });
    await expect(assertMetaOk(res, "Facebook send message")).rejects.toThrow(/failed/);
    await expect(assertMetaOk(new Response('{"error":{"code":100}}', { status: 400 }), "x")).rejects.not.toBeInstanceOf(TokenInvalidError);
  });
});
