import { describe, it, expect, afterEach, vi } from "vitest";
import { linkedinProvider } from "./linkedin";
import { isProvider } from "./index";
import { TokenInvalidError } from "./errors";

afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "AT", refreshToken: "RT" };

describe("linkedin provider", () => {
  it("is registered + refreshable + article capability", () => {
    expect(isProvider("linkedin")).toBe(true);
    expect(linkedinProvider.requiresTokenRefresh()).toBe(true);
    expect(linkedinProvider.capabilities().map((c) => c.format)).toContain("article");
  });

  it("refreshToken exchanges via LinkedIn token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "n", expires_in: 5184000 }), { status: 200 })));
    expect((await linkedinProvider.refreshToken(tokens)).accessToken).toBe("n");
  });

  it("healthCheck returns sub", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sub: "li_1", name: "Me" }), { status: 200 })));
    expect((await linkedinProvider.healthCheck(tokens)).accountId).toBe("li_1");
  });

  it("healthCheck 401 -> TokenInvalidError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: 401 })));
    await expect(linkedinProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("publish a text post returns the ugcPost id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "urn:li:share:1" }), { status: 200 })));
    const h = await linkedinProvider.publish({ tokens, accountId: "li_1", request: { format: "text", media: [], caption: "hi" }, mediaUrls: [] });
    expect(h.providerHandle).toBe("urn:li:share:1");
  });
});
