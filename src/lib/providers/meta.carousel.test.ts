import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/meta-carousel.json";
import { replayFetch, type RecordedExchange } from "./__fixtures__/recorded/replay";
import { metaProvider } from "./meta";
import { validate } from "./validate";
import { PermanentError } from "./errors";
import { postUrlFor } from "@/lib/posts/post-url";

const igAccount = "60596468270350638";
const fbAccount = "125730403827906";
const args = (facebook = false): Parameters<typeof metaProvider.publish>[0] => ({
  tokens: { accessToken: "PAGE_TOKEN" }, accountId: facebook ? fbAccount : igAccount,
  request: { format: "carousel", media: [{ mediaId: "a" }, { mediaId: "b" }], caption: "Two slides", options: { aiDisclosed: true } },
  mediaUrls: ["https://cdn.example/a.jpg", "https://cdn.example/b.mp4"],
  mediaKinds: ["image", facebook ? "image" : "video"],
  channelMetadata: { subKind: facebook ? "facebook_page" : "instagram" },
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function replay(exchanges: RecordedExchange[] = fixture.instagram) {
  vi.stubEnv("META_PUBLISH_POLL_DELAY_MS", "0");
  return replayFetch(exchanges);
}

describe("Meta carousel replay", () => {
  it.each([false, true])("publishes ordered IG children and parent, IG Login=%s", async (login) => {
    const exchanges = fixture.instagram.map(e => ({ ...e, url: login ? e.url.replace("graph.facebook.com", "graph.instagram.com") : e.url }));
    const { calls, unused } = replay(exchanges);
    const input = args();
    if (login) input.tokens = { accessToken: "", messagingToken: "IG_LOGIN_TOKEN" };
    const result = await metaProvider.publish(input);
    expect(result).toMatchObject({ providerHandle: "17895695668004550", url: "https://www.instagram.com/p/ABC123/" });
    const creates = calls.filter(c => c.method === "POST" && c.url.endsWith("/media")).map(c => new URLSearchParams(c.body));
    expect(creates).toHaveLength(3);
    expect(creates[0].get("image_url")).toBe(input.mediaUrls[0]);
    expect(creates[1].get("video_url")).toBe(input.mediaUrls[1]);
    expect(creates[1].get("media_type")).toBe("VIDEO");
    for (const child of creates.slice(0, 2)) {
      expect(child.get("is_carousel_item")).toBe("true");
      expect(child.has("is_ai_generated")).toBe(false);
      expect(child.has("caption")).toBe(false);
    }
    const parentIndex = calls.findIndex(c => new URLSearchParams(c.body).get("media_type") === "CAROUSEL");
    const videoPolls = calls.map((c, index) => ({ c, index })).filter(({ c }) => c.method === "GET" && c.url.includes("22647568134938113"));
    expect(videoPolls.length).toBeGreaterThan(1);
    expect(videoPolls.every(({ index }) => index < parentIndex)).toBe(true);
    expect(creates[2].get("media_type")).toBe("CAROUSEL");
    expect(creates[2].get("children")).toBe("68221501448095333,22647568134938113");
    expect(creates[2].get("caption")).toBe("Two slides");
    expect(creates[2].get("is_ai_generated")).toBe("true");
    expect(new URLSearchParams(calls.find(c => c.url.endsWith("/media_publish"))!.body).get("creation_id")).toBe("57368691656400039");
    expect(calls.every(c => c.url.includes(login ? "graph.instagram.com" : "graph.facebook.com"))).toBe(true);
    expect(creates.every(c => c.get("access_token") === (login ? "IG_LOGIN_TOKEN" : "PAGE_TOKEN"))).toBe(true);
    expect(unused()).toEqual([]);
  });

  it("uploads unpublished FB photos and commits one feed post in order", async () => {
    const { calls, unused } = replay(fixture.facebook);
    const result = await metaProvider.publish(args(true));
    const uploads = calls.filter(c => c.url.endsWith("/photos"));
    expect(uploads).toHaveLength(2);
    expect(uploads.every(c => new URLSearchParams(c.body).get("published") === "false")).toBe(true);
    const feed = new URLSearchParams(calls.find(c => c.url.endsWith("/feed"))!.body);
    expect(JSON.parse(feed.get("attached_media")!)).toEqual([{ media_fbid: "554158337282822679" }, { media_fbid: "1002088840149" }]);
    expect(feed.get("message")).toBe("Two slides");
    expect(feed.has("is_ai_generated")).toBe(false);
    expect(postUrlFor("facebook", result.providerHandle)).toBe("https://www.facebook.com/125730403827906/posts/1002088850000");
    expect(unused()).toEqual([]);
  });

  it("refuses video in a FB carousel before any upload", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const input = args(true); input.mediaKinds![1] = "video";
    await expect(metaProvider.publish(input)).rejects.toThrow(/Video in Facebook carousels requires a verified Meta app/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies child upload failure as pre_commit and deletes prior FB photos", async () => {
    const { calls } = replay([
      fixture.facebook[0], { ...fixture.facebook[1], status: 503, body: {} },
      { method: "DELETE", url: "https://graph.facebook.com/v26.0/554158337282822679", status: 200, body: { success: true } },
    ]);
    await expect(metaProvider.publish(args(true))).rejects.toMatchObject({ phase: "pre_commit" });
    expect(calls.map(c => c.method)).toEqual(["POST", "POST", "DELETE"]);
  });

  it("keeps FB photos when the final commit outcome is uncertain", async () => {
    const { calls } = replay(fixture.facebook.map(e => e.url.endsWith("/feed") ? { ...e, status: 503, body: {} } : e));
    await expect(metaProvider.publish(args(true))).rejects.toMatchObject({ phase: "commit_uncertain" });
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("retries an IG child network failure before publication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection closed")));
    await expect(metaProvider.publish(args())).rejects.toMatchObject({ phase: "pre_commit" });
  });

  it.each(["ERROR", "EXPIRED"])("stops on child status %s without publishing a partial carousel", async status => {
    const { calls } = replay([fixture.instagram[0], { ...fixture.instagram[1], body: { status_code: status } }]);
    await expect(metaProvider.publish(args())).rejects.toBeInstanceOf(PermanentError);
    expect(calls.some(c => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("does not publish before video processing finishes", async () => {
    vi.stubEnv("META_PUBLISH_POLL_ATTEMPTS", "1");
    const { calls } = replay(fixture.instagram);
    await expect(metaProvider.publish(args())).rejects.toMatchObject({ phase: "pre_commit" });
    expect(calls.some(c => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("returns the accepted IG handle even if permalink lookup fails", async () => {
    replay(fixture.instagram.map(e => e.url.includes("fields=permalink") ? { ...e, status: 503, body: {} } : e));
    expect(await metaProvider.publish(args())).toMatchObject({ providerHandle: "17895695668004550" });
  });

  it("declares image-only Facebook carousels and mixed Instagram carousels", () => {
    const request = args().request;
    expect(validate(metaProvider, request, { platform: "facebook", mediaKinds: ["image", "video"] }).ok).toBe(false);
    expect(validate(metaProvider, request, { platform: "instagram", mediaKinds: ["image", "video"] }).ok).toBe(true);
    expect(metaProvider.capabilities("facebook").find(cap => cap.format === "carousel")!.media.kinds).toEqual(["image"]);
  });

  it("treats an accepted final response without an id as uncertain", async () => {
    replay(fixture.facebook.map(e => e.url.endsWith("/feed") ? { ...e, body: {} } : e));
    await expect(metaProvider.publish(args(true))).rejects.toMatchObject({ phase: "commit_uncertain" });
  });

  it("cleans uploaded photos after a definite final rejection", async () => {
    const { calls } = replay([
      ...fixture.facebook.map(e => e.url.endsWith("/feed") ? { ...e, status: 400, body: { error: { code: 100, message: "Invalid parameter" } } } : e),
      ...fixture.facebook.slice(0, 2).map(e => ({ method: "DELETE", url: `https://graph.facebook.com/v26.0/${e.body.id}`, status: 200, body: { success: true } })),
    ]);
    await expect(metaProvider.publish(args(true))).rejects.toBeInstanceOf(PermanentError);
    expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
  });

  it.each([0, 1, 11])("refuses %s items before any upload", async n => {
    const input = args(); input.mediaUrls = Array.from({ length: n }, () => "https://cdn.example/a.jpg");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(metaProvider.publish(input)).rejects.toBeInstanceOf(PermanentError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("keeps the accepted IG publication when permalink lookup times out", async () => {
  replay();
  const recordedFetch = globalThis.fetch;
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("fields=permalink")) return recordedFetch(input, init);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("lookup timeout")), { once: true });
      queueMicrotask(() => controller.abort());
    });
  }));
  expect(await metaProvider.publish(args())).toMatchObject({ providerHandle: "17895695668004550" });
  expect(timeout).toHaveBeenCalledWith(10_000);
});

it("enables video only for a confirmed Facebook channel", () => {
  const request = args().request;
  for (const state of [undefined, "unknown", "unavailable", "available"]) {
    const result = validate(metaProvider, request, { platform: "facebook", channel: { video_carousel: state }, mediaKinds: ["image", "video"] });
    expect(result.ok).toBe(state === "available");
    if (!result.ok) expect(result.errors).toContain("Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.");
  }
});

it("uploads an unpublished video, waits until ready and commits one ordered carousel", async () => {
  const video = (await import("./__fixtures__/facebook-video-carousel.json")).default;
  const { calls, unused } = replay([fixture.facebook[0], ...video.videoReady, fixture.facebook[2]]);
  const input = args(true); input.mediaKinds![1] = "video"; input.channelMetadata!.video_carousel = "available";
  await expect(metaProvider.publish(input)).resolves.toHaveProperty("providerHandle");
  const upload = new URLSearchParams(calls.find(c => c.url.endsWith("/videos"))!.body);
  expect(upload.get("file_url")).toBe(input.mediaUrls[1]);
  expect(upload.get("published")).toBe("false");
  const feed = calls.filter(c => c.url.endsWith("/feed"));
  expect(feed).toHaveLength(1);
  expect(JSON.parse(new URLSearchParams(feed[0].body).get("attached_media")!)).toEqual([{ media_fbid: "554158337282822679" }, { media_fbid: "2002088840149" }]);
  expect(unused()).toEqual([]);
});

it("handles the recorded 403/code200 upload rejection and cleans the prior photo", async () => {
  const video = (await import("./__fixtures__/facebook-video-carousel.json")).default;
  const { calls } = replay([fixture.facebook[0], video.uploadDenied, { method: "DELETE", url: "https://graph.facebook.com/v26.0/554158337282822679", status: 200, body: { success: true } }]);
  const input = args(true); input.mediaKinds![1] = "video"; input.channelMetadata!.video_carousel = "available";
  await expect(metaProvider.publish(input)).rejects.toBeInstanceOf(PermanentError);
  expect(calls.map(c => c.method)).toEqual(["POST", "POST", "DELETE"]);
});

it.each(["processing", "error"])("cleans the video and photo on processing state %s", async status => {
  const video = (await import("./__fixtures__/facebook-video-carousel.json")).default;
  vi.stubEnv("META_PUBLISH_POLL_ATTEMPTS", "1");
  const { calls } = replay([fixture.facebook[0], video.videoReady[0], { ...video.videoReady[1], body: { status: { video_status: status } } }, ...["554158337282822679", "2002088840149"].map(id => ({ method: "DELETE", url: `https://graph.facebook.com/v26.0/${id}`, status: 200, body: { success: true } }))]);
  const input = args(true); input.mediaKinds![1] = "video"; input.channelMetadata!.video_carousel = "available";
  await expect(metaProvider.publish(input)).rejects.toThrow();
  expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
  expect(calls.some(c => c.url.endsWith("/feed"))).toBe(false);
});
