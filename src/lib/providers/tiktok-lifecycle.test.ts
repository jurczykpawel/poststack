import { afterEach, expect, it, vi } from "vitest";
import { tiktokProvider } from "./tiktok";

const info = { creator_nickname: "Creator", creator_avatar_url: "", privacy_level_options: ["SELF_ONLY"], comment_disabled: true, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 };
afterEach(() => { vi.unstubAllGlobals(); });
it("requires confirmation when a selected interaction is no longer available", async () => {
  const http = vi.fn(async () => Response.json({ data: info, error: { code: "ok" } }));
  vi.stubGlobal("fetch", http);
  await expect(tiktokProvider.publish({ tokens: { accessToken: "test" }, accountId: "creator", request: { format: "video", media: [], options: { publishMode: "direct", privacyLevel: "SELF_ONLY", disableComment: false } }, mediaUrls: ["https://example.test/video.mp4"], mediaDurationsSec: [30] })).rejects.toMatchObject({ name: "ConfirmationRequiredError" });
  expect(http).toHaveBeenCalledTimes(1);
});
it.each([ ["PROCESSING_UPLOAD", "accepted"], ["PROCESSING_DOWNLOAD", "accepted"], ["SEND_TO_USER_INBOX", "accepted"], ["PUBLISH_COMPLETE", "published"], ["FAILED", "failed"] ])("maps TikTok %s to %s", async (status, state) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { status, fail_reason: "duration_check_failed" }, error: { code: "ok" } })));
  expect(tiktokProvider.publishStatus).toBeTypeOf("function");
  expect(await tiktokProvider.publishStatus!({ accessToken: "test" }, { providerHandle: "publish-1" })).toMatchObject({ state, ...(state === "failed" ? { error: "duration_check_failed" } : {}) });
});
it("sends the status request with the saved publish id and bearer token", async () => {
  const http = vi.fn(async () => Response.json({ data: { status: "PROCESSING_DOWNLOAD" }, error: { code: "ok" } }));
  vi.stubGlobal("fetch", http);
  await tiktokProvider.publishStatus!({ accessToken: "test-token" }, { providerHandle: "saved-id" });
  expect(http).toHaveBeenCalledWith("https://open.tiktokapis.com/v2/post/publish/status/fetch/", expect.objectContaining({ method: "POST", body: JSON.stringify({ publish_id: "saved-id" }), headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }));
});
it("does not accept an unsuccessful status envelope as publication", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "internal_error" } })));
  await expect(tiktokProvider.publishStatus!({ accessToken: "test" }, { providerHandle: "id" })).rejects.toThrow(/status unavailable/);
});
