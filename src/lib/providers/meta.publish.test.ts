import { describe, it, expect, afterEach, vi } from "vitest";
// Cover/media fetches now route through the SSRF guard (safeFetch → DNS resolve). Stub DNS to a
// public IP so these unit tests don't hit the network for fake hostnames.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));

// Media fetches now connect over the net core's node:http(s) pinned connector (NOT global fetch).
// Keep the REAL public-only SSRF policy (assertSafeUrl: DNS resolve + classify + pin) and route only
// the transport to the global fetch stub these tests already install — mock transport, keep policy.
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/net/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string, init: RequestInit, opts: Parameters<typeof actual.safeFetch>[2]) => {
      await actual.assertSafeUrl(url, opts); // real policy: refuse non-public BEFORE any transport
      return fetch(url, { ...init, redirect: "error" }); // transport via the test's global fetch stub
    },
  };
});

import { metaProvider } from "./meta";
import { PermanentError } from "./errors";
import { GRAPH_API_BASE, IG_GRAPH_BASE } from "@/lib/platforms/constants";

afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "T" };

describe("meta.publish", () => {
  it("IG feed image sends image_url (not a bare url) to the media container", async () => {
    let createBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/media_publish"))
          return new Response(JSON.stringify({ id: "ig_post_1" }), { status: 200 });
        if (url.includes("?fields=status_code"))
          return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        createBody = String(init?.body ?? ""); // container-create POST
        return new Response(JSON.stringify({ id: "container_img" }), { status: 200 });
      }),
    );
    await metaProvider.publish({
      tokens,
      accountId: "IGACCT",
      request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/photo.png"],
    });
    const params = new URLSearchParams(createBody);
    expect(params.get("image_url")).toBe("https://cdn/photo.png");
    expect(params.has("url")).toBe(false); // regression: bare `url` → Meta #100 image_url required
    expect(params.has("media_type")).toBe(false); // images are not REELS
  });

  it("publishes a reel: container -> status FINISHED -> publish", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/media_publish"))
          return new Response(JSON.stringify({ id: "post_123" }), { status: 200 });
        if (url.includes("?fields=status_code"))
          return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_1" }), { status: 200 });
      }),
    );
    const handle = await metaProvider.publish({
      tokens,
      accountId: "ACCT",
      request: { format: "reel", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(handle.providerHandle).toBe("post_123");
    expect(calls.some((u) => u.includes("/ACCT/media"))).toBe(true);
  });

  it("passes cover_url to the reel container when options.coverUrl is set", async () => {
    let createBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/media_publish"))
          return new Response(JSON.stringify({ id: "post_9" }), { status: 200 });
        if (url.includes("?fields=status_code"))
          return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        createBody = String(init?.body ?? ""); // the container-create POST
        return new Response(JSON.stringify({ id: "container_9" }), { status: 200 });
      }),
    );
    await metaProvider.publish({
      tokens,
      accountId: "ACCT",
      request: {
        format: "reel",
        media: [{ mediaId: "m" }],
        caption: "hi",
        options: { coverUrl: "https://cdn/cover.png" },
      },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(createBody).toContain("cover_url=");
    expect(decodeURIComponent(createBody)).toContain("https://cdn/cover.png");
  });

  it("Facebook page video: posts to /{page}/videos via file_url + published flag (METAPUB1)", async () => {
    let url = "";
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: "fbvid_1" }), { status: 200 });
      }),
    );
    const h = await metaProvider.publish({
      tokens,
      accountId: "PAGE123",
      request: {
        format: "feed_post",
        media: [{ mediaId: "m" }],
        caption: "hello fb",
        options: { target: "facebook", published: false },
      },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(h.providerHandle).toBe("fbvid_1");
    expect(url).toContain("/PAGE123/videos");
    const decoded = decodeURIComponent(body);
    expect(decoded).toContain("file_url=https://cdn/x.mp4");
    expect(decoded).toContain("published=false");
    expect(body).toContain("description=hello+fb"); // URLSearchParams encodes space as +
  });

  it("FB Reel: 3-step video_reels (start -> file_url upload -> finish) routed by subKind", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        calls.push(u);
        if (u.includes("/video_reels") && u.includes("upload_phase=start"))
          return new Response(JSON.stringify({ video_id: "r1", upload_url: "https://rupload.facebook.com/r1" }), { status: 200 });
        if (u === "https://rupload.facebook.com/r1") return new Response(JSON.stringify({ success: true }), { status: 200 });
        if (u.includes("/video_reels") && u.includes("upload_phase=finish"))
          return new Response(JSON.stringify({ success: true, post_id: "r1" }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await metaProvider.publish({
      tokens,
      accountId: "PAGE",
      request: { format: "reel", media: [{ mediaId: "m" }], caption: "c" },
      mediaUrls: ["https://cdn/x.mp4"],
      channelMetadata: { subKind: "facebook_page" },
    });
    expect(h.providerHandle).toBe("r1");
    expect(calls.some((u) => u.includes("upload_phase=start"))).toBe(true);
    expect(calls.some((u) => u.includes("upload_phase=finish"))).toBe(true);
  });

  it("refuses to send the token to an upload_url on a non-Meta host [PSA50]", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        calls.push(u);
        if (u.includes("/video_reels") && u.includes("upload_phase=start"))
          return new Response(JSON.stringify({ video_id: "r1", upload_url: "http://169.254.169.254/exfil" }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    await expect(
      metaProvider.publish({
        tokens,
        accountId: "PAGE",
        request: { format: "reel", media: [{ mediaId: "m" }], caption: "c" },
        mediaUrls: ["https://cdn/x.mp4"],
        channelMetadata: { subKind: "facebook_page" },
      }),
    ).rejects.toThrow();
    expect(calls.some((u) => u.includes("169.254.169.254"))).toBe(false); // the token was never sent there
  });

  it("FB photo: feed_post + mediaKind=image posts to /{page}/photos", async () => {
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        url = String(input);
        return new Response(JSON.stringify({ post_id: "ph1" }), { status: 200 });
      }),
    );
    const h = await metaProvider.publish({
      tokens,
      accountId: "PAGE",
      request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "c", options: { mediaKind: "image" } },
      mediaUrls: ["https://cdn/x.jpg"],
      channelMetadata: { subKind: "facebook_page" },
    });
    expect(h.providerHandle).toBe("ph1");
    expect(url).toContain("/PAGE/photos");
  });

  it("FB video sets a custom thumbnail when options.coverUrl is set", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        calls.push(u);
        if (u.includes("/PAGE/videos")) return new Response(JSON.stringify({ id: "v1" }), { status: 200 });
        if (u === "https://cdn/cover.png") return new Response(new Uint8Array([1]), { status: 200 });
        if (u.includes("/v1/thumbnails")) return new Response(JSON.stringify({ success: true }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await metaProvider.publish({
      tokens,
      accountId: "PAGE",
      request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "c", options: { target: "facebook", coverUrl: "https://cdn/cover.png" } },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(h.providerHandle).toBe("v1");
    expect(calls.some((u) => u.includes("/v1/thumbnails"))).toBe(true);
  });

  it("subKind=instagram routes to the IG container flow (not Facebook)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        calls.push(u);
        if (u.includes("/media_publish")) return new Response(JSON.stringify({ id: "ig1" }), { status: 200 });
        if (u.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "cont1" }), { status: 200 });
      }),
    );
    const h = await metaProvider.publish({
      tokens,
      accountId: "IGID",
      request: { format: "reel", media: [{ mediaId: "m" }], caption: "c" },
      mediaUrls: ["https://cdn/x.mp4"],
      channelMetadata: { subKind: "instagram" },
    });
    expect(h.providerHandle).toBe("ig1");
    expect(calls.some((u) => u.includes("/IGID/media") || u.includes("/media_publish"))).toBe(true);
    expect(calls.every((u) => !u.includes("/video_reels"))).toBe(true);
  });

  it("throws PermanentError for an unsupported format", async () => {
    await expect(
      metaProvider.publish({
        tokens,
        accountId: "A",
        request: { format: "carousel", media: [] },
        mediaUrls: [],
      }),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("meta.publishStory (STORY1)", () => {
  it("IG: STORIES container -> status FINISHED -> media_publish", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/media_publish")) return new Response(JSON.stringify({ id: "story_ig_1" }), { status: 200 });
        if (url.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_s1" }), { status: 200 });
      }),
    );
    const h = await metaProvider.publishStory!({
      tokens,
      accountId: "IGID",
      mediaUrl: "https://cdn/card.jpg",
      channelMetadata: { subKind: "instagram" },
    });
    expect(h.providerHandle).toBe("story_ig_1");
    const create = calls.find((c) => c.url.includes("/IGID/media") && !c.url.includes("media_publish"));
    expect(create?.body).toContain("media_type=STORIES");
    expect(create?.body).toContain("image_url=");
    expect(calls.every((c) => !c.url.includes("/photo_stories"))).toBe(true);
  });

  it("FB: unpublished photo -> photo_stories", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/photo_stories")) return new Response(JSON.stringify({ success: true, post_id: "fb_story_9" }), { status: 200 });
        return new Response(JSON.stringify({ id: "photo_77" }), { status: 200 });
      }),
    );
    const h = await metaProvider.publishStory!({
      tokens,
      accountId: "PAGE",
      mediaUrl: "https://cdn/card.jpg",
      channelMetadata: { subKind: "facebook_page" },
    });
    expect(h.providerHandle).toBe("fb_story_9");
    const photo = calls.find((c) => c.url.includes("/PAGE/photos"));
    expect(photo?.body).toContain("published=false");
    const story = calls.find((c) => c.url.includes("/photo_stories"));
    expect(story?.body).toContain("photo_id=photo_77");
  });

  it("IG: surfaces a container ERROR as a permanent failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "ERROR" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_err" }), { status: 200 });
      }),
    );
    await expect(
      metaProvider.publishStory!({ tokens, accountId: "IGID", mediaUrl: "https://cdn/card.jpg", channelMetadata: { subKind: "instagram" } }),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});

// IGFU1: a channel connected ONLY via Instagram Business Login carries an IG-Login token
// (messagingToken) and an EMPTY Facebook page token — publishing must route to graph.instagram.com
// (IG_GRAPH_BASE) with that token. A channel that still has a Facebook page token publishes on
// graph.facebook.com exactly as before (byte-for-byte unchanged).
describe("meta.publish — IG-Login single-login routing (IGFU1)", () => {
  const igTokens = { accessToken: "", messagingToken: "IGQW_pub" };

  function captureFetch() {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/media_publish")) return new Response(JSON.stringify({ id: "ig_post_1" }), { status: 200 });
        if (url.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_1" }), { status: 200 });
      }),
    );
    return calls;
  }

  it("IG-Login-only reel: container + media_publish hit graph.instagram.com with the IG-Login token", async () => {
    const calls = captureFetch();
    const handle = await metaProvider.publish({
      tokens: igTokens,
      accountId: "IGID",
      request: { format: "reel", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(handle.providerHandle).toBe("ig_post_1");
    // every publish-flow edge must be on the IG host (with the configured IG version), never on graph.facebook.com
    expect(calls.every((c) => c.url.startsWith(IG_GRAPH_BASE))).toBe(true);
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media`)).toBe(true);
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media_publish`)).toBe(true);
    expect(calls.some((c) => c.url.includes("graph.facebook.com"))).toBe(false);
    // the IG-Login messaging token (not the empty FB token) carries the calls
    const create = calls.find((c) => c.url === `${IG_GRAPH_BASE}/IGID/media`)!;
    expect(decodeURIComponent(create.body)).toContain("access_token=IGQW_pub");
    const publish = calls.find((c) => c.url === `${IG_GRAPH_BASE}/IGID/media_publish`)!;
    expect(decodeURIComponent(publish.body)).toContain("access_token=IGQW_pub");
  });

  it("IG-Login-only feed_post (image): container on graph.instagram.com with the IG-Login token", async () => {
    const calls = captureFetch();
    await metaProvider.publish({
      tokens: igTokens,
      accountId: "IGID",
      request: { format: "feed_post", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/x.jpg"],
    });
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media`)).toBe(true);
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media_publish`)).toBe(true);
    expect(calls.some((c) => c.url.includes("graph.facebook.com"))).toBe(false);
  });

  it("IG-Login-only story: STORIES container + media_publish hit graph.instagram.com", async () => {
    const calls = captureFetch();
    const h = await metaProvider.publishStory!({
      tokens: igTokens,
      accountId: "IGID",
      mediaUrl: "https://cdn/card.jpg",
      channelMetadata: { subKind: "instagram" },
    });
    expect(h.providerHandle).toBe("ig_post_1");
    expect(calls.every((c) => c.url.startsWith(IG_GRAPH_BASE))).toBe(true);
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media`)).toBe(true);
    expect(calls.some((c) => c.url === `${IG_GRAPH_BASE}/IGID/media_publish`)).toBe(true);
    const create = calls.find((c) => c.url === `${IG_GRAPH_BASE}/IGID/media`)!;
    expect(decodeURIComponent(create.body)).toContain("media_type=STORIES");
    expect(decodeURIComponent(create.body)).toContain("access_token=IGQW_pub");
  });

  it("FB-token IG channel still publishes on graph.facebook.com unchanged (even with a messaging token present)", async () => {
    const calls = captureFetch();
    await metaProvider.publish({
      // a channel that was FB-login-connected AND later augmented with an IG-Login messaging token:
      // the FB page token is present, so publishing MUST stay on graph.facebook.com with it.
      tokens: { accessToken: "FBPAGE", messagingToken: "IGQW_pub" },
      accountId: "IGID",
      request: { format: "reel", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(calls.every((c) => c.url.startsWith(GRAPH_API_BASE))).toBe(true);
    expect(calls.some((c) => c.url.includes("graph.instagram.com"))).toBe(false);
    const create = calls.find((c) => c.url === `${GRAPH_API_BASE}/IGID/media`)!;
    expect(decodeURIComponent(create.body)).toContain("access_token=FBPAGE");
  });
});
