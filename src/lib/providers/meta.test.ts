import { describe, it, expect, afterEach, vi } from "vitest";
import { metaProvider } from "./meta";
import { TokenInvalidError, TransientError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

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
