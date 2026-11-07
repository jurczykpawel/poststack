import { afterEach, it, expect, vi } from "vitest";
import { xPlatformPost } from "./x";
afterEach(() => vi.unstubAllGlobals());
it("reads the matching X post", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: "123", text: "test" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await xPlatformPost({ accessToken: "fixture" }, "123", "GET")).toEqual({ exists: true, providerStatus: 200, platformPostId: "123" });
});
it("accepts documented deleted response and a subsequent 404", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: { deleted: true } })).mockResolvedValueOnce(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await xPlatformPost({ accessToken: "fixture" }, "123", "DELETE")).toEqual({ deleted: true });
  expect(await xPlatformPost({ accessToken: "fixture" }, "123", "GET")).toMatchObject({ exists: false, providerStatus: 404 });
  expect(fetcher.mock.calls[0]).toMatchObject(["https://api.twitter.com/2/tweets/123", { method: "DELETE", redirect: "error" }]);
});
it.each([402, 429, 500])("rejects provider HTTP %i", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
  await expect(xPlatformPost({ accessToken: "fixture" }, "123", "DELETE")).rejects.toThrow();
});
it("requires explicit deletion acknowledgement", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: {} })));
  await expect(xPlatformPost({ accessToken: "fixture" }, "123", "DELETE")).rejects.toThrow();
});
it("returns the public URL needed by a sent editorial post", async () => {
  const { xProvider } = await import("./x");
  const { default: docs } = await import("../../../tests/fixtures/provider-docs/publish-responses.json");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(docs.x.createPost.body)));
  const result = await xProvider.publish({ tokens: { accessToken: "fixture" }, accountId: "account", request: { format: "text", media: [], caption: "test" }, mediaUrls: [] });
  expect(result.url).toBe(`https://x.com/i/web/status/${docs.x.createPost.body.data.id}`);
});
