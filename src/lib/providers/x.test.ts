import { describe, it, expect, afterEach, vi } from "vitest";
import { xProvider } from "./x";
import { isProvider } from "./index";
import { TokenInvalidError } from "./errors";

afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "AT", refreshToken: "RT" };

describe("x provider", () => {
  it("is registered + refreshable + text capability", () => {
    expect(isProvider("x")).toBe(true);
    expect(xProvider.requiresTokenRefresh()).toBe(true);
    expect(xProvider.capabilities().map((c) => c.format)).toContain("text");
  });

  it("refreshToken rotates the refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "n", refresh_token: "rot", expires_in: 7200 }), { status: 200 })));
    const t = await xProvider.refreshToken(tokens);
    expect(t.refreshToken).toBe("rot");
  });

  it("healthCheck returns the user id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { id: "u1", username: "me" } }), { status: 200 })));
    const info = await xProvider.healthCheck(tokens);
    expect(info.accountId).toBe("u1");
    expect(info.displayName).toBe("me");
  });

  it("healthCheck 401 -> TokenInvalidError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "x" }), { status: 401 })));
    await expect(xProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("healthCheck rejects a non-string account id [PSA55]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { id: { nested: true } } }), { status: 200 })));
    await expect(xProvider.healthCheck(tokens)).rejects.toThrow(); // not coerced into accountId
  });

  it("publish a text post returns the tweet id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { id: "tw_1" } }), { status: 200 })));
    const h = await xProvider.publish({ tokens, accountId: "u1", request: { format: "text", media: [], caption: "hi" }, mediaUrls: [] });
    expect(h.providerHandle).toBe("tw_1");
  });

  it("rejects a non-string id instead of coercing it into the handle [PSA51]", async () => {
    // A hostile/malformed response with id as an OBJECT used to pass the `!id` guard.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { id: { nested: true } } }), { status: 200 })));
    await expect(
      xProvider.publish({ tokens, accountId: "u1", request: { format: "text", media: [], caption: "hi" }, mediaUrls: [] }),
    ).rejects.toThrow(); // classified error, not "[object Object]" stored as the handle
  });
});
