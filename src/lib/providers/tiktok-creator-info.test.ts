import { afterEach, describe, expect, it, vi } from "vitest";
import { queryCreatorInfo } from "./tiktok-creator-info";
import { PermanentError, RateLimitedError, TokenInvalidError, TransientError } from "./errors";

const info = {
  creator_nickname: "Creator", creator_username: "creator", creator_avatar_url: "https://example.com/avatar",
  privacy_level_options: ["SELF_ONLY"], comment_disabled: false, duet_disabled: true,
  stitch_disabled: false, max_video_post_duration_sec: 300,
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function reply(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}
describe("TikTok creator info", () => {
  it("queries and returns the creator profile and permissions", async () => {
    const mock = reply({ data: { ...info, extra: "ignored" }, error: { code: "ok" } });
    expect(await queryCreatorInfo("token")).toEqual({ status: "available", creator_info: info });
    expect(mock).toHaveBeenCalledWith("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", expect.objectContaining({
      method: "POST", body: "{}", redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer token", "Content-Type": "application/json; charset=UTF-8" },
    }));
  });
  it.each(["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"])("returns cannot post now for %s", async (code) => {
    reply({ error: { code, message: "token" } });
    expect(await queryCreatorInfo("token")).toEqual({ status: "cannot_post_now", reason: code, message: "TikTok cannot accept posts right now. Try again later." });
  });
  it.each([200, 401])("classifies token errors with HTTP %s", async (status) => {
    reply({ error: { code: "access_token_invalid", message: "token" } }, status);
    await expect(queryCreatorInfo("token")).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(queryCreatorInfo("token")).rejects.not.toThrow("token");
  });
  it("classifies missing scope separately", async () => {
    reply({ error: { code: "scope_not_authorized" } }, 401);
    await expect(queryCreatorInfo("token")).rejects.toBeInstanceOf(PermanentError);
  });
  it("classifies rate limits", async () => {
    reply({ error: { code: "rate_limit_exceeded" } }, 429);
    await expect(queryCreatorInfo("token")).rejects.toBeInstanceOf(RateLimitedError);
  });
  it("classifies server failures as pre-commit", async () => {
    reply({}, 503);
    await expect(queryCreatorInfo("token")).rejects.toMatchObject({ phase: "pre_commit" });
  });
  it("classifies network errors without forwarding their text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("token")));
    await expect(queryCreatorInfo("token")).rejects.toBeInstanceOf(TransientError);
    await expect(queryCreatorInfo("token")).rejects.not.toThrow("token");
  });
  it.each([{}, { ...info, duet_disabled: "false" }, { ...info, max_video_post_duration_sec: -1 }])("rejects incomplete creator data", async (data) => {
    reply({ data, error: { code: "ok" } });
    await expect(queryCreatorInfo("token")).rejects.toBeInstanceOf(TransientError);
  });
  it("requires an explicit successful API result", async () => {
    reply({ data: info });
    await expect(queryCreatorInfo("token")).rejects.toThrow();
  });
});

describe("TikTok direct publish creator query", () => {
  const publish = async () => {
    const { tiktokProvider } = await import("./tiktok");
    return tiktokProvider.publish({
      tokens: { accessToken: "token" }, accountId: "creator",
      request: { format: "video", media: [{ mediaId: "m" }], options: { publishMode: "direct", privacyLevel: "SELF_ONLY" } },
      mediaUrls: ["https://example.com/video.mp4"], mediaDurationsSec: [30],
    });
  };
  it("queries creator info before every direct publication", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://example.com/");
    const mock = vi.fn(async (url: string) => Response.json({
      data: url.includes("creator_info") ? info : { publish_id: "pub" }, error: { code: "ok" },
    }));
    vi.stubGlobal("fetch", mock);
    await publish(); await publish();
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", "https://open.tiktokapis.com/v2/post/publish/video/init/",
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", "https://open.tiktokapis.com/v2/post/publish/video/init/",
    ]);
  });
  it("stops before publish initialization when the creator cannot post", async () => {
    const mock = reply({ error: { code: "spam_risk_too_many_posts" } });
    await expect(publish()).rejects.toMatchObject({ kind: "rate_limited", phase: "pre_commit" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toContain("creator_info/query/");
  });
});
