import { afterEach, expect, it, vi } from "vitest";
import { metaProvider } from "./meta";
import { linkedinProvider } from "./linkedin";
import fixture from "../../../tests/fixtures/provider-docs/article-story.json";

vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
afterEach(() => vi.unstubAllGlobals());

it.each(["facebook", "instagram", "instagram-login"])("publishes ordinary %s image/video stories on the Story surface", async (platform) => {
  for (const kind of ["image", "video"] as const) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (url.includes("upload_phase=start")) return Response.json(fixture.storyStart);
      if (url.includes("rupload.") || url.includes("upload_phase=finish")) return Response.json(fixture.success);
      if (url.includes("fields=status_code")) return Response.json(fixture.finished);
      if (url.includes("fields=status")) return Response.json(fixture.uploadStatus);
      return Response.json(fixture.published);
    }));
    const facebook = platform === "facebook";
    const host = platform === "instagram-login" ? "graph.instagram.com" : "graph.facebook.com";
    const tokens = platform === "instagram-login" ? { accessToken: "", messagingToken: "IG" } : { accessToken: "T" };
    await metaProvider.publish({ tokens, accountId: "account", channelMetadata: { subKind: facebook ? "facebook_page" : "instagram" },
      request: { format: "story", media: [{ mediaId: "m" }] }, mediaUrls: ["https://example.com/media"], mediaKinds: [kind],
    });
    expect(calls.every(c => c.url.includes(host) || c.url.includes("rupload.facebook.com"))).toBe(true);
    expect(calls.some(c => c.url.includes(facebook ? kind === "image" ? "/photo_stories" : "/video_stories" : "/media_publish"))).toBe(true);
    if (!facebook) {
      const body = calls[0]!.init!.body as URLSearchParams;
      expect(body.get("media_type")).toBe("STORIES");
      expect(body.get(kind === "image" ? "image_url" : "video_url")).toBe("https://example.com/media");
      expect(body.get("access_token")).toBe(platform === "instagram-login" ? "IG" : "T");
    }
    expect(calls.some(c => /\/videos(?:\?|$)|\/video_reels/.test(c.url))).toBe(false);
  }
});

it.each([false, true])("publishes LinkedIn article with thumbnail=%s", async (thumbnail) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("initializeUpload")) return Response.json(fixture.imageUpload);
    if (url.includes("dms-uploads")) return new Response(null, { status: 201 });
    if (url.includes("/rest/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": fixture.postId } });
    return new Response(new Uint8Array([1, 2, 3]));
  }));
  const result = await linkedinProvider.publish({ tokens: { accessToken: "T" }, accountId: "member", mediaUrls: thumbnail ? ["https://example.com/image.png"] : [],
    request: { format: "article", title: fixture.article.title, caption: fixture.article.description, media: thumbnail ? [{ mediaId: "m" }] : [], options: { articleUrl: fixture.article.source } },
  });
  expect(result.providerHandle).toBe(fixture.postId);
  const post = calls.find(c => c.url.endsWith("/rest/posts"))!;
  expect(JSON.parse(String(post.init!.body))).toMatchObject({ author: "urn:li:person:member", content: { article: {
    source: fixture.article.source, title: fixture.article.title, description: fixture.article.description,
    ...(thumbnail ? { thumbnail: fixture.imageUpload.value.image } : {}),
  } } });
  expect(new Headers(post.init!.headers).get("LinkedIn-Version")).toBe("202610");
  expect(calls.some(c => c.url.includes("/rest/images?action=initializeUpload"))).toBe(thumbnail);
});

for (const [provider, platform] of [[linkedinProvider, "linkedin"], [metaProvider, "facebook"], [metaProvider, "instagram"]] as const) {
  for (const capability of provider.capabilities(platform)) {
    it(`${platform} ${capability.format} reaches its publishing transport`, async () => {
      const reachedTransport = new Error("transport reached");
      const transport = vi.fn(async () => { throw reachedTransport; });
      vi.stubGlobal("fetch", transport);
      await expect(provider.publish({ tokens: { accessToken: "T" }, accountId: "member", channelMetadata: { subKind: platform === "facebook" ? "facebook_page" : "instagram" },
        request: { format: capability.format, title: fixture.article.title, caption: "caption", media: Array.from({ length: capability.media.min }, () => ({ mediaId: "m" })), options: { articleUrl: fixture.article.source, mediaKind: capability.media.kinds[0] } },
        mediaUrls: Array.from({ length: capability.media.min }, () => "https://example.com/media"), mediaKinds: Array.from({ length: capability.media.min }, () => capability.media.kinds[0]!),
      })).rejects.not.toThrow(/not implemented|unsupported format|does not support/);
      expect(transport).toHaveBeenCalled();
    });
  }
}
