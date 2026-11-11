import { describe, it, expect, afterEach, vi } from "vitest";
import { threadsProvider } from "./threads";
import { isProvider, listProviders } from "./index";
import { TokenInvalidError } from "./errors";

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

  it("healthCheck returns the user id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "th_1" }), { status: 200 })));
    expect((await threadsProvider.healthCheck(tokens)).accountId).toBe("th_1");
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
