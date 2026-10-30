import { describe, it, expect, afterEach, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));
vi.mock("@/lib/net/safe-fetch", async (original) => {
  const actual = await original<typeof import("@/lib/net/safe-fetch")>();
  return { ...actual, safeFetch: async (url: string, init: RequestInit, opts: Parameters<typeof actual.safeFetch>[2]) => {
    await actual.assertSafeUrl(url, opts);
    return fetch(url, init);
  } };
});
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

  // LIPUB1 (Fix B): media publishing via the Assets API — registerUpload → upload bytes → ugcPost.
  type Call = { url: string; method: string; body: string };
  function stubMediaFetch(): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
        if (u.includes("registerUpload")) {
          return new Response(
            JSON.stringify({
              value: {
                asset: "urn:li:digitalmediaAsset:AST1",
                uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://www.linkedin.com/dms-uploads/AST1" } },
              },
            }),
            { status: 200 },
          );
        }
        if (u.startsWith("https://cdn/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); // media bytes
        if (u.startsWith("https://www.linkedin.com/dms-uploads/")) return new Response(null, { status: 201 }); // upload accepted
        if (u.endsWith("/ugcPosts")) return new Response(JSON.stringify({ id: "urn:li:share:MEDIA" }), { status: 200 });
        return new Response("{}", { status: 404 });
      }),
    );
    return calls;
  }

  it("publish an image: registerUpload (image recipe) → upload bytes → IMAGE share with the asset", async () => {
    const calls = stubMediaFetch();
    const h = await linkedinProvider.publish({
      tokens,
      accountId: "li_1",
      request: { format: "image", media: [{ mediaId: "m" }], caption: "pic!" },
      mediaUrls: ["https://cdn/pic.jpg"],
    });
    expect(h.providerHandle).toBe("urn:li:share:MEDIA");

    const reg = calls.find((c) => c.url.includes("registerUpload"))!;
    expect(reg.body).toContain("feedshare-image");
    expect(calls.some((c) => c.url === "https://www.linkedin.com/dms-uploads/AST1")).toBe(true); // bytes uploaded
    const ugc = calls.find((c) => c.url.endsWith("/ugcPosts"))!;
    const share = JSON.parse(ugc.body).specificContent["com.linkedin.ugc.ShareContent"];
    expect(share.shareMediaCategory).toBe("IMAGE");
    expect(share.media[0].media).toBe("urn:li:digitalmediaAsset:AST1");
    expect(share.media[0].status).toBe("READY");
  });

  it("a media format with no mediaUrls is a permanent error (nothing to upload)", async () => {
    stubMediaFetch();
    await expect(
      linkedinProvider.publish({ tokens, accountId: "li_1", request: { format: "image", media: [], caption: "x" }, mediaUrls: [] }),
    ).rejects.toThrow(/needs media/);
  });

  it("a registerUpload failure surfaces as an error (no share created)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        if (String(url).includes("registerUpload")) return new Response(JSON.stringify({ message: "nope" }), { status: 500 });
        return new Response("{}", { status: 200 });
      }),
    );
    await expect(
      linkedinProvider.publish({ tokens, accountId: "li_1", request: { format: "image", media: [{ mediaId: "m" }], caption: "x" }, mediaUrls: ["https://cdn/pic.jpg"] }),
    ).rejects.toThrow();
    expect(calls.some((u) => u.endsWith("/ugcPosts"))).toBe(false); // never reached the share step
  });
});
