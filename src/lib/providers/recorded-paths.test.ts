// PROVFIX1: every publish path replayed from responses recorded on the live platforms (see
// __fixtures__/recorded/README.md). Each test checks what a consumer of the stored handle needs —
// the first-comment worker (commentOnPost), the auto-reply matcher (webhook comment post_id), and the
// post card link — not merely what the provider returns.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { replayFetch, pageOf, type RecordedExchange } from "./__fixtures__/recorded/replay";
import photoPub from "./__fixtures__/recorded/facebook-photo-published.json";
import photoUnpub from "./__fixtures__/recorded/facebook-photo-unpublished.json";
import videoPub from "./__fixtures__/recorded/facebook-video-published.json";
import videoPostHandle from "./__fixtures__/recorded/facebook-video-post-handle.json";
import videoDenied from "./__fixtures__/recorded/facebook-video-unpublished-denied.json";
import reelPub from "./__fixtures__/recorded/facebook-reel-published.json";
import reelDraft from "./__fixtures__/recorded/facebook-reel-draft.json";
import fbStory from "./__fixtures__/recorded/facebook-story.json";
import igContainers from "./__fixtures__/recorded/instagram-containers.json";
import prod from "./__fixtures__/recorded/prod-stored-handles.json";
import ytPrivate from "./__fixtures__/recorded/youtube-upload-private.json";
import ytUnlisted from "./__fixtures__/recorded/youtube-upload-unlisted.json";
import ttInbox from "./__fixtures__/recorded/tiktok-inbox.json";
import ttDirect from "./__fixtures__/recorded/tiktok-direct-self-only.json";
import { metaProvider } from "./meta";
import { youtubeProvider } from "./youtube";
import { tiktokProvider } from "./tiktok";
import { PermanentError, TokenInvalidError } from "./errors";
import { postUrlFor } from "@/lib/posts/post-url";

vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (url: string, init?: RequestInit) => fetch(url, init) }));

let FacebookProvider: typeof import("@/lib/platforms/facebook").FacebookProvider;
let InstagramProvider: typeof import("@/lib/platforms/instagram").InstagramProvider;
let YouTubeProvider: typeof import("@/lib/platforms/youtube").YouTubeProvider;
beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/x";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.ENCRYPTION_KEY ??= "0000000000000000000000000000000000000000000000000000000000000001";
  ({ FacebookProvider } = await import("@/lib/platforms/facebook"));
  ({ InstagramProvider } = await import("@/lib/platforms/instagram"));
  ({ YouTubeProvider } = await import("@/lib/platforms/youtube"));
});
afterEach(() => vi.unstubAllGlobals());

const SOURCE = "https://cdn.example/g44.mp4";
const SIZE = 5_064_218; // the recorded upload (Content-Length of the TEST media file)
/** The media file the platform/provider reads; not part of the recordings. */
function media(url: string, init?: RequestInit): Response | undefined {
  if (url !== SOURCE) {
    if (url.startsWith("https://open-upload-i18n.tiktokapis.com/")) return new Response(null, { status: 201 });
    return undefined;
  }
  if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": String(SIZE) } });
  const range = new Headers(init?.headers).get("range");
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range ?? "bytes=0-0")!;
  return new Response(new Uint8Array(Number(end) - Number(start) + 1), { status: 200, headers: { "content-length": String(Number(end) - Number(start) + 1) } });
}

const ex = (list: unknown) => list as RecordedExchange[];
type Fb = { exchanges: unknown; providerHandle: string; verified: { get: { body: { id: string } }; commentAccepted: boolean; commentRequest: RecordedExchange; postUrlFor: string; linkCheck: { location: string } }; commentWebhook: { value: { post_id: string } } };

async function fbPublish(exchanges: RecordedExchange[], format: string, options: Record<string, unknown>) {
  replayFetch(exchanges, media);
  const { providerHandle } = await metaProvider.publish({
    tokens: { accessToken: "T" }, accountId: pageOf(exchanges[0]!.url), mediaUrls: [SOURCE],
    request: { format, media: [{ mediaId: "m" }], caption: "c", options },
    channelMetadata: { subKind: "facebook_page" },
  });
  return providerHandle;
}

async function fbComment(fx: Fb, handle: string) {
  const { calls } = replayFetch([fx.verified.commentRequest]);
  const sent = await new FacebookProvider().commentOnPost({ access_token: "T" }, handle, "first comment");
  return { url: calls[0]!.url, id: sent.platformMessageId };
}

describe("Facebook publish paths (recorded on the live Graph API)", () => {
  it.each([
    ["photo, published", photoPub as unknown as Fb, "feed_post", { mediaKind: "image" }],
    ["reel, published", reelPub as unknown as Fb, "reel", { mediaKind: "video" }],
    ["reel, draft", reelDraft as unknown as Fb, "reel", { mediaKind: "video", published: false }],
  ])("%s: the stored handle is the <page>_<post> that GET, comments, webhooks and the link all use", async (_l, fx, format, options) => {
    const handle = await fbPublish(ex(fx.exchanges), format, options);
    expect(handle).toMatch(/^\d+_\d+$/);
    expect(handle).toBe(fx.verified.get.body.id); // live GET of this handle returned 200
    expect(handle).toBe(fx.commentWebhook.value.post_id); // auto-reply rules match on this exact value
    const comment = await fbComment(fx, handle);
    expect(fx.verified.commentAccepted).toBe(true);
    expect(comment.url).toContain(`/${handle}/comments`);
    expect(comment.id).toBe((fx.verified.commentRequest.body as { id: string }).id);
    expect(postUrlFor("facebook", handle)).toBe(fx.verified.postUrlFor);
    expect(fx.verified.linkCheck.location).toContain(`/posts/${handle.split("_")[1]}`); // live link resolved to the post
  });

  it("video: the handle is the video's page post, so comment webhooks and auto-reply rules match it", async () => {
    const fx = videoPostHandle as unknown as Fb & { postIdLookup: RecordedExchange; derivedHandle: string; linkOg: { og: string } };
    const videoId = (fx.exchanges as RecordedExchange[])[0]!.body as { id: string };
    const handle = await fbPublish([...ex(fx.exchanges), fx.postIdLookup], "feed_post", { mediaKind: "video" });
    expect(handle).toBe(fx.derivedHandle);
    expect(handle).toBe(fx.commentWebhook.value.post_id);
    expect(handle).toBe(fx.verified.get.body.id);
    expect((await fbComment(fx, handle)).url).toContain(`/${handle}/comments`);
    expect(postUrlFor("facebook", handle)).toBe(fx.verified.postUrlFor);
    expect(fx.linkOg.og).toContain(videoId.id); // the live link opened this video
  });

  it("video: the recorded webhook shows the bare video id never matches a comment (the pre-fix handle)", () => {
    const fx = videoPub as unknown as Fb;
    expect(fx.providerHandle).toMatch(/^\d+$/);
    expect(fx.commentWebhook.value.post_id).not.toBe(fx.providerHandle);
    expect(fx.commentWebhook.value.post_id.split("_")[1]).not.toBe(fx.providerHandle);
  });

  it("video: if the post id lookup fails the publish still succeeds with the video id (commentable, linkable)", async () => {
    const fx = videoPub as unknown as Fb;
    const lookupError = { method: "GET", url: `https://graph.facebook.com/v26.0/${fx.providerHandle}`, status: 400, body: (fbStory as unknown as Fb).verified.get.body };
    const handle = await fbPublish([...ex(fx.exchanges), lookupError as RecordedExchange], "feed_post", { mediaKind: "video" });
    expect(handle).toBe(fx.providerHandle);
    expect((await fbComment(fx, handle)).url).toContain(`/${handle}/comments`);
    expect(postUrlFor("facebook", handle)).toBe(fx.verified.postUrlFor);
    expect(fx.verified.linkCheck.location).toContain(`/videos/${handle}`);
  });

  it("photo, published=false: Graph returns only the photo id; the comment endpoint accepts it", async () => {
    const fx = photoUnpub as unknown as Fb;
    const handle = await fbPublish(ex(fx.exchanges), "feed_post", { mediaKind: "image", published: false });
    expect(handle).toBe(fx.providerHandle);
    expect(handle).toMatch(/^\d+$/);
    expect((await fbComment(fx, handle)).url).toContain(`/${handle}/comments`);
  });

  it("video, published=false: the recorded #200 is a permanent failure, not a dead token", async () => {
    const err = await fbPublish(ex(videoDenied.exchanges), "feed_post", { mediaKind: "video", published: false }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).not.toBeInstanceOf(TokenInvalidError);
    expect(String(err.message)).toContain("#200");
  });

  it("Page story: publishStory returns the photo_stories post_id (not addressable through Graph; only the ledger keeps it)", async () => {
    const fx = fbStory as unknown as Fb;
    const exchanges = ex(fx.exchanges);
    replayFetch(exchanges);
    const h = await metaProvider.publishStory!({ tokens: { accessToken: "T" }, accountId: pageOf(exchanges[0]!.url), mediaUrl: "https://cdn.example/story.jpg", channelMetadata: { subKind: "facebook_page" } });
    expect(h.providerHandle).toBe(fx.providerHandle);
    expect(fx.verified.commentAccepted).toBe(false);
  });

  it("legacy bare reel ids (stored before FBREEL1) are unreadable (#12), and the card links them through the page", () => {
    const legacy = prod.handles.find((h) => h.platform === "facebook" && h.format === "reel" && !h.handle.includes("_"))!;
    expect((legacy.body as { error: { code: number } }).error.code).toBe(12);
    const page = prod.legacyReelLinkCheck.pagePosts.url.split("/")[3]!;
    expect(postUrlFor("facebook", legacy.handle, null, { format: "reel", pageId: page })).toBe(prod.legacyReelLinkCheck.pagePosts.url);
    expect(prod.legacyReelLinkCheck.pagePosts.resolvesToPost).toBe(true);
    expect(prod.legacyReelLinkCheck.watch.resolvesToPost).toBe(false);
    // A bare id from /videos stays a watch link (verified: redirects to the video).
    expect(postUrlFor("facebook", videoPub.providerHandle, null, { format: "feed_post", pageId: page })).toBe(videoPub.verified!.postUrlFor);
  });
});

describe("Instagram publish paths (containers recorded live; media id shape from PROD)", () => {
  const ig = ex(igContainers.exchanges);
  const posts = ig.filter((e) => e.method === "POST");
  const container = (i: number) => {
    const id = (posts[i]!.body as { id: string }).id;
    return [posts[i]!, ...ig.filter((e) => e.method === "GET" && e.url.includes(`/${id}?`))];
  };
  const account = pageOf(posts[0]!.url);
  const prodIg = (format: string) => prod.handles.find((h) => h.platform === "instagram" && h.format === format)!;
  const publishCall = (id: string): RecordedExchange => ({ method: "POST", url: `https://graph.facebook.com/v26.0/${account}/media_publish`, status: 200, body: { id } });

  it.each([["feed_post", 0], ["reel", 1]] as const)("%s: media_publish id is the handle; comments and permalink use it", async (format, i) => {
    process.env.META_PUBLISH_POLL_DELAY_MS = "0";
    const stored = prodIg(format);
    replayFetch([...container(i), publishCall(stored.handle)]);
    const { providerHandle } = await metaProvider.publish({
      tokens: { accessToken: "T" }, accountId: account, mediaUrls: [SOURCE],
      request: { format, media: [{ mediaId: "m" }], caption: "c" }, channelMetadata: { subKind: "instagram" },
    });
    expect(providerHandle).toBe(stored.handle);
    const { calls } = replayFetch([{ method: "POST", url: `https://graph.facebook.com/v26.0/${stored.handle}/comments`, status: 200, body: { id: "17900000000000001" } }]);
    await new InstagramProvider().commentOnPost({ access_token: "T" }, providerHandle, "first comment");
    expect(calls[0]!.url).toContain(`/${providerHandle}/comments`);
    replayFetch([{ method: "GET", url: `https://graph.facebook.com/v26.0/${stored.handle}`, status: stored.status, body: stored.body }]);
    expect(await new InstagramProvider().getPostUrl({ access_token: "T" }, providerHandle)).toBe((stored.body as { permalink: string }).permalink);
    expect(postUrlFor("instagram", providerHandle)).toBeNull(); // IG ids carry no shortcode
  });

  it("story: STORIES container then media_publish", async () => {
    process.env.META_PUBLISH_POLL_DELAY_MS = "0";
    replayFetch([...container(2), publishCall("17800000000000002")]);
    const h = await metaProvider.publishStory!({ tokens: { accessToken: "T" }, accountId: account, mediaUrl: "https://cdn.example/story.jpg", channelMetadata: { subKind: "instagram" } });
    expect(h.providerHandle).toBe("17800000000000002");
  });
});

describe("YouTube (recorded resumable upload)", () => {
  type Yt = { exchanges: unknown; providerHandle: string; verified: { commentRequest: RecordedExchange; postUrlFor: string } };
  const upload = async (fx: Yt, privacyStatus: string) => {
    replayFetch(ex(fx.exchanges), media);
    return (await youtubeProvider.publish({
      tokens: { accessToken: "T" }, accountId: "UC", mediaUrls: [SOURCE],
      request: { format: "short", media: [{ mediaId: "m" }], title: "t", options: { privacyStatus, notifySubscribers: false } },
    })).providerHandle;
  };
  const comment = (fx: Yt, handle: string) => {
    const { calls } = replayFetch([fx.verified.commentRequest]);
    const run = new YouTubeProvider().commentOnPost({ access_token: "T", refresh_token: "R", expires_at: Math.floor(Date.now() / 1000) + 3600 }, handle, "first comment");
    return { run, calls };
  };

  it("unlisted: the video id takes the first comment and builds the watch link", async () => {
    const fx = ytUnlisted as unknown as Yt;
    const handle = await upload(fx, "unlisted");
    expect(handle).toBe(fx.providerHandle);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const { run, calls } = comment(fx, handle);
    expect((await run).platformMessageId).toBe((fx.verified.commentRequest.body as { id: string }).id);
    expect(JSON.parse(calls[0]!.body).snippet.videoId).toBe(handle);
    expect(postUrlFor("youtube", handle)).toBe(fx.verified.postUrlFor);
  });

  it("private: YouTube refuses a comment on a private video (recorded 403)", async () => {
    const fx = ytPrivate as unknown as Yt;
    const handle = await upload(fx, "private");
    expect(handle).toBe(fx.providerHandle);
    await expect(comment(fx, handle).run).rejects.toThrow(/403/);
  });
});

describe("TikTok (recorded sandbox)", () => {
  type Tt = { exchanges: unknown; providerHandle: string; statusPolls: RecordedExchange[] };
  it.each([
    ["inbox upload", ttInbox as unknown as Tt, {}, "SEND_TO_USER_INBOX"],
    ["direct post, SELF_ONLY", ttDirect as unknown as Tt, { publishMode: "direct", privacyLevel: "SELF_ONLY" }, "PUBLISH_COMPLETE"],
  ])("%s: the handle is the publish_id that status polling takes; it makes no public link", async (_l, fx, options, last) => {
    replayFetch(ex(fx.exchanges), media);
    const h = await tiktokProvider.publish({
      tokens: { accessToken: "T" }, accountId: "open_id", mediaUrls: [SOURCE], mediaDurationsSec: [6],
      request: { format: "video", media: [{ mediaId: "m" }], caption: "c", options },
    });
    expect(h).toEqual({ providerHandle: fx.providerHandle, processing: true });
    replayFetch(fx.statusPolls);
    const states = [];
    for (let i = 0; i < fx.statusPolls.length; i++) states.push((await tiktokProvider.publishStatus!({ accessToken: "T" }, h)).state);
    expect(states.at(-1)).toBe("published");
    expect(states.slice(0, -1).every((s) => s === "accepted")).toBe(true);
    expect((fx.statusPolls.at(-1)!.body as { data: { status: string } }).data.status).toBe(last);
    expect(postUrlFor("tiktok", h.providerHandle, "creator")).toBeNull();
  });
});
