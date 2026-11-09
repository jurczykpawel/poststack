import { afterEach, it, expect, vi } from "vitest";
import { xPlatformPost } from "./x";
import missingPost from "../../../tests/fixtures/provider-docs/x-get-deleted-tweet.json";
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

it.each(["GET", "DELETE"] as const)("recognizes a matching missing tweet in a 200 %s response", async (method) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(missingPost)));
  expect(await xPlatformPost({ accessToken: "fixture" }, missingPost.errors[0].resource_id, method)).toEqual(
    method === "GET" ? { exists: false, providerStatus: 404, platformPostId: missingPost.errors[0].resource_id } : { deleted: true },
  );
});
it.each([
  { type: "https://api.x.com/2/problems/not-authorized-for-resource" },
  { resource_id: "999" },
  { resource_type: "user" },
])("rejects a different problem or resource: %j", async (change) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ errors: [{ ...missingPost.errors[0], ...change }] })));
  await expect(xPlatformPost({ accessToken: "fixture" }, missingPost.errors[0].resource_id, "GET")).rejects.toThrow("Unexpected X post response");
});
it("preserves the provider status on errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
  await expect(xPlatformPost({ accessToken: "fixture" }, "123", "GET")).rejects.toMatchObject({ providerStatus: 429 });
});

it("rejects mixed problems in a 200 response", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ errors: [
    missingPost.errors[0], { ...missingPost.errors[0], type: "https://api.x.com/2/problems/not-authorized-for-resource" },
  ] })));
  await expect(xPlatformPost({ accessToken: "fixture" }, missingPost.errors[0].resource_id, "GET")).rejects.toThrow("Unexpected X post response");
});
