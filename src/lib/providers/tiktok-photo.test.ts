import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import docs from "../../../tests/fixtures/provider-docs/tiktok.json";
import { tiktokProvider, TIKTOK_PHOTO_DOMAIN_MSG, TIKTOK_URL_UNVERIFIED_MSG } from "./tiktok";
import { validate } from "./validate";
import { ConfirmationRequiredError, PermanentError, PermissionError, RateLimitedError, TokenInvalidError } from "./errors";

// Shapes from developers.tiktok.com/doc/content-posting-api-reference-photo-post (read 2026-11-11).
const PREFIX = "https://media.example.com/bucket/";
const photos = [`${PREFIX}a.jpg`, `${PREFIX}b.webp`];
const creator = {
  creator_nickname: "Creator", creator_avatar_url: "https://example.com/a", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
  comment_disabled: false, duet_disabled: true, stitch_disabled: true,
};
const photoInit = { status: 200, body: { data: { publish_id: "p_pub_url~v2.123456789" }, error: { code: "ok", message: "", log_id: "x" } } };

let calls: { url: string; body: Record<string, unknown> }[] = [];
function server(init: { status: number; body: unknown } = photoInit, info: unknown = creator) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, req?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(req?.body ?? "{}")) });
    if (url.endsWith("/creator_info/query/")) return Response.json({ data: info, error: { code: "ok" } });
    if (url.endsWith("/post/publish/content/init/")) return Response.json(init.body, { status: init.status });
    throw new Error(`unexpected ${url}`);
  }));
}
const publish = (options: Record<string, unknown> = {}, mediaUrls = photos, mediaKinds = mediaUrls.map(() => "image")) => tiktokProvider.publish({
  tokens: { accessToken: "AT" }, accountId: "creator", mediaUrls, mediaKinds,
  request: { format: mediaUrls.length > 1 ? "carousel" : "image", media: mediaUrls.map(() => ({ mediaId: "m" })), caption: "Photo caption", options },
});
const initCall = () => calls.find(c => c.url.endsWith("/content/init/"));

beforeEach(() => { vi.stubEnv("TIKTOK_PULL_URL_PREFIX", PREFIX); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("TikTok photo posts", () => {
  it("declares 1 image or a 2–35 image carousel, keeping video", () => {
    const caps = tiktokProvider.capabilities();
    expect(caps.map(c => c.format)).toEqual(["video", "image", "carousel"]);
    const req = (n: number) => ({ format: "carousel", media: Array.from({ length: n }, () => ({ mediaId: "m" })) });
    expect(validate(tiktokProvider, req(35)).ok).toBe(true);
    expect(validate(tiktokProvider, req(36))).toMatchObject({ ok: false, errors: ["format 'carousel' allows <= 35 media"] });
    expect(validate(tiktokProvider, req(2), { mediaKinds: ["image", "video"] }).ok).toBe(false);
  });

  it("inbox mode sends MEDIA_UPLOAD with PULL_FROM_URL images and no Direct Post fields", async () => {
    server();
    const handle = await publish();
    expect(handle).toEqual({ providerHandle: "p_pub_url~v2.123456789", processing: true });
    expect(calls.map(c => c.url)).toEqual(["https://open.tiktokapis.com/v2/post/publish/content/init/"]);
    expect(initCall()!.body).toEqual({
      media_type: "PHOTO", post_mode: "MEDIA_UPLOAD", post_info: { description: "Photo caption" },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: photos },
    });
  });

  it("Direct Post applies creator-checked privacy, comments, disclosure and AI label without video-only fields", async () => {
    server();
    await publish({ publishMode: "direct", privacyLevel: "SELF_ONLY", disableComment: false, brandOrganicToggle: true, aiDisclosed: true });
    const body = initCall()!.body;
    expect(body).toMatchObject({ post_mode: "DIRECT_POST", is_aigc: true });
    expect(body.post_info).toEqual({ description: "Photo caption", privacy_level: "SELF_ONLY", disable_comment: false, brand_content_toggle: false, brand_organic_toggle: true });
  });

  it.each([
    ["privacy not offered by the creator", { privacyLevel: "FOLLOWER_OF_CREATOR" }, creator],
    ["comments the creator disabled", { privacyLevel: "SELF_ONLY", disableComment: false }, { ...creator, comment_disabled: true }],
  ])("Direct Post asks for confirmation on %s before init", async (_name, options, info) => {
    server(photoInit, info);
    await expect(publish({ publishMode: "direct", ...options })).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(initCall()).toBeUndefined();
  });

  it.each([
    ["no prefix configured", "", photos],
    ["a URL outside the prefix", PREFIX, [photos[0]!, "https://other.example.com/b.jpg"]],
    ["a look-alike host", PREFIX, ["https://media.example.com.evil/bucket/a.jpg"]],
  ])("rejects %s before calling TikTok", async (_name, prefix, urls) => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", prefix);
    server();
    await expect(publish({}, urls)).rejects.toThrow(TIKTOK_PHOTO_DOMAIN_MSG);
    expect(calls).toHaveLength(0);
  });

  it("rejects video media in a photo post", async () => {
    server();
    await expect(publish({}, photos, ["image", "video"])).rejects.toThrow("photo posts accept images only");
    expect(calls).toHaveLength(0);
  });

  it("url_ownership_unverified explains the verified prefix instead of asking to reconnect", async () => {
    server(docs.init.urlOwnershipUnverified);
    const err = await publish().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).not.toBeInstanceOf(TokenInvalidError);
    expect((err as Error).message).toBe(TIKTOK_URL_UNVERIFIED_MSG);
  });

  it("maps documented scope, rate limit and token errors", async () => {
    server({ status: 401, body: { error: { code: "scope_not_authorized", message: "The user did not authorize the scope.", log_id: "x" } } });
    await expect(publish()).rejects.toBeInstanceOf(PermissionError);
    server(docs.init.rateLimited);
    await expect(publish()).rejects.toMatchObject({ phase: "pre_commit" });
    await expect(publish()).rejects.toBeInstanceOf(RateLimitedError);
    server(docs.init.tokenInvalid);
    await expect(publish()).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("status FAILED for a photo pull reports TikTok's reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { status: "FAILED", fail_reason: "photo_pull_failed" }, error: { code: "ok" } })));
    await expect(tiktokProvider.publishStatus!({ accessToken: "AT" }, { providerHandle: "p_pub_url~v2.1" })).resolves.toEqual({ state: "failed", error: "photo_pull_failed" });
  });
});
