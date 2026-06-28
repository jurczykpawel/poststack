import { describe, it, expect, afterEach, vi } from "vitest";
import { metaProvider, classifyMetaError } from "./meta";
import { TokenInvalidError, TransientError, PermanentError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

describe("classifyMetaError", () => {
  it("treats only token CODES (190/102/467) as TokenInvalidError", () => {
    for (const code of [190, 102, 467]) {
      expect(classifyMetaError(400, { code, message: "x" })).toBeInstanceOf(TokenInvalidError);
    }
  });

  it("does NOT treat a bare 400 request error as a token failure (regression: #100 image_url)", () => {
    // Meta returns 400 #100 for a missing param; this must NOT flip the channel into reauth.
    const e = classifyMetaError(400, { code: 100, message: "The parameter image_url is required" });
    expect(e).toBeInstanceOf(PermanentError);
    expect(e).not.toBeInstanceOf(TokenInvalidError);
  });

  it("treats a bare 401 without a token code as permanent, not token-invalid", () => {
    expect(classifyMetaError(401, { code: 1, message: "nope" })).toBeInstanceOf(PermanentError);
  });

  it("treats 5xx as TransientError", () => {
    expect(classifyMetaError(503, undefined)).toBeInstanceOf(TransientError);
  });
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const tokens = { accessToken: "EAAG-token" };

describe("meta provider", () => {
  it("declares manual_token mode and no refresh", () => {
    expect(metaProvider.connectionModes()).toContain("manual_token");
    expect(metaProvider.requiresTokenRefresh()).toBe(false);
    expect(metaProvider.capabilities().length).toBeGreaterThan(0);
  });

  it("healthCheck returns account info on 200", async () => {
    stubFetch(200, { id: "123", name: "My Page" });
    const info = await metaProvider.healthCheck(tokens);
    expect(info).toEqual({ accountId: "123", displayName: "My Page" });
  });

  it("healthCheck returns the avatar from the picture field", async () => {
    stubFetch(200, { id: "123", name: "My Page", picture: { data: { url: "https://meta.test/p.jpg" } } });
    expect((await metaProvider.healthCheck(tokens)).avatarUrl).toBe("https://meta.test/p.jpg");
  });

  it("healthCheck throws TokenInvalidError on a 190 token error", async () => {
    stubFetch(400, { error: { code: 190, message: "Session expired" } });
    await expect(metaProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("healthCheck throws TransientError on a 500", async () => {
    stubFetch(500, { error: { message: "server" } });
    await expect(metaProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TransientError);
  });
});
