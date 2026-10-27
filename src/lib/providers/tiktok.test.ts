import { describe, it, expect, afterEach, vi } from "vitest";
// Media download fetches now route through the SSRF guard (safeFetch → DNS resolve). Stub DNS to a
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

import { tiktokProvider } from "./tiktok";
import { isProvider } from "./index";
import { TokenInvalidError } from "./errors";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const creatorInfo = {
  creator_nickname: "Creator", creator_avatar_url: "https://example.com/avatar", privacy_level_options: ["SELF_ONLY"],
  comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 300,
};
const tokens = { accessToken: "AT", refreshToken: "RT" };

describe("tiktok provider", () => {
  it("is registered + refreshable + video capability", () => {
    expect(isProvider("tiktok")).toBe(true);
    expect(tiktokProvider.requiresTokenRefresh()).toBe(true);
    expect(tiktokProvider.capabilities().map((c) => c.format)).toContain("video");
  });

  it("refreshToken returns rotated tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "n", refresh_token: "n2", expires_in: 86400 }), { status: 200 })),
    );
    const t = await tiktokProvider.refreshToken(tokens);
    expect(t.accessToken).toBe("n");
    expect(t.refreshToken).toBe("n2");
  });

  it("healthCheck returns open_id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { user: { open_id: "ttuser" } } }), { status: 200 })));
    expect((await tiktokProvider.healthCheck(tokens)).accountId).toBe("ttuser");
  });

  it("healthCheck 403 -> TokenInvalidError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "x" } }), { status: 403 })));
    await expect(tiktokProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("publish (default) uploads to INBOX via FILE_UPLOAD — downloads bytes, PUTs the chunk, no post_info", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url === "https://cdn/x.mp4") {
          return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 }); // the video bytes
        }
        if (url.includes("/inbox/video/init/")) {
          calls[calls.length - 1]!.body = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({ data: { publish_id: "pub_1", upload_url: "https://upload.tiktok/u1" }, error: { code: "ok" } }),
            { status: 200 },
          );
        }
        if (url === "https://upload.tiktok/u1") {
          calls[calls.length - 1]!.body = init?.headers; // capture the PUT headers
          return new Response("", { status: 201 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: { format: "video", media: [{ mediaId: "m" }], caption: "hi" },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect(h.providerHandle).toBe("pub_1");
    const init = calls.find((c) => c.url.includes("/inbox/video/init/"))!;
    expect((init.body as { source_info: Record<string, unknown> }).source_info).toMatchObject({
      source: "FILE_UPLOAD",
      video_size: 5,
      total_chunk_count: 1,
    });
    expect((init.body as { post_info?: unknown }).post_info).toBeUndefined();
    const put = calls.find((c) => c.url === "https://upload.tiktok/u1")!;
    expect(put.method).toBe("PUT");
  });

  it("publish with a verified prefix uses PULL_FROM_URL (no download/PUT)", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn/");
    let initBody: Record<string, unknown> = {};
    let putCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "PUT") putCalled = true;
        if (url.includes("/inbox/video/init/")) {
          initBody = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify({ data: { publish_id: "pub_p" }, error: { code: "ok" } }), {
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: { format: "video", media: [{ mediaId: "m" }], options: { ingestion: "pull_url" } },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect(h.providerHandle).toBe("pub_p");
    expect(initBody.source_info).toMatchObject({ source: "PULL_FROM_URL", video_url: "https://cdn/x.mp4" });
    expect(putCalled).toBe(false);
  });

  it("publish direct mode sets post_info (title + SELF_ONLY + frame cover)", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn/");
    let url = "";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("creator_info/query/")) return Response.json({ data: creatorInfo, error: { code: "ok" } });
        url = String(input);
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ data: { publish_id: "pub_2" }, error: { code: "ok" } }), {
          status: 200,
        });
      }),
    );
    await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: {
        format: "video",
        media: [{ mediaId: "m" }],
        caption: "my title",
        options: { publishMode: "direct", privacyLevel: "SELF_ONLY", ingestion: "pull_url", coverTimestampMs: 1500 },
      },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect(url).toContain("/post/publish/video/init/");
    expect(body.post_info).toMatchObject({
      title: "my title",
      privacy_level: "SELF_ONLY",
      video_cover_timestamp_ms: 1500,
    });
  });

  it("direct mode sets post_info.is_aigc when options.aiDisclosed is a boolean [AIDISC1]", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn/");
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("creator_info/query/")) return Response.json({ data: creatorInfo, error: { code: "ok" } });
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ data: { publish_id: "pub_ai" }, error: { code: "ok" } }), {
          status: 200,
        });
      }),
    );
    await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: {
        format: "video",
        media: [{ mediaId: "m" }],
        caption: "c",
        options: { publishMode: "direct", privacyLevel: "SELF_ONLY", ingestion: "pull_url", aiDisclosed: true },
      },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect((body.post_info as { is_aigc?: boolean }).is_aigc).toBe(true);
  });

  it("direct mode omits is_aigc when options.aiDisclosed is not a boolean", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn/");
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("creator_info/query/")) return Response.json({ data: creatorInfo, error: { code: "ok" } });
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ data: { publish_id: "pub_noai" }, error: { code: "ok" } }), {
          status: 200,
        });
      }),
    );
    await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: {
        format: "video",
        media: [{ mediaId: "m" }],
        options: { publishMode: "direct", privacyLevel: "SELF_ONLY", ingestion: "pull_url" },
      },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect("is_aigc" in (body.post_info as object)).toBe(false);
  });

  it("inbox mode (no post_info at all) never carries is_aigc even when aiDisclosed is set", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://cdn/x.mp4") return new Response(new Uint8Array([1, 2]), { status: 200 });
        if (url.includes("/inbox/video/init/")) {
          body = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({ data: { publish_id: "pub_inbox", upload_url: "https://upload.tiktok/u2" }, error: { code: "ok" } }),
            { status: 200 },
          );
        }
        if (url === "https://upload.tiktok/u2") return new Response("", { status: 201 });
        return new Response("{}", { status: 200 });
      }),
    );
    await tiktokProvider.publish({
      tokens,
      accountId: "ttuser",
      request: { format: "video", media: [{ mediaId: "m" }], options: { aiDisclosed: true } },
      mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
    });
    expect(body.post_info).toBeUndefined();
  });

  it("surfaces a TikTok 200-with-error (e.g. url_ownership_unverified)", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "url_ownership_unverified", message: "verify domain" } }), {
          status: 200,
        }),
      ),
    );
    await expect(
      tiktokProvider.publish({
        tokens,
        accountId: "ttuser",
        request: { format: "video", media: [{ mediaId: "m" }], options: { ingestion: "pull_url" } },
        mediaUrls: ["https://cdn/x.mp4"],
      mediaDurationsSec: [30],
      }),
    ).rejects.toThrow();
  });
});


describe("TikTok Direct Post settings", () => {
  const url = "https://cdn.example.com/media/video.mp4?signature=original";
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 17]);
  function mockPublishing(creator = creatorInfo) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      calls.push({ url: target, init });
      if (target.includes("creator_info/query/")) return Response.json({ data: creator, error: { code: "ok" } });
      if (target.includes("/video/init/")) return Response.json({ data: { publish_id: "pub", upload_url: "https://upload.example.com/chunk" }, error: { code: "ok" } });
      if (target === url) return new Response(bytes);
      if (target === "https://upload.example.com/chunk") return new Response(null, { status: 201 });
      throw new Error(`Unexpected request: ${target}`);
    }));
    return calls;
  }
  const publish = (options: Record<string, unknown> = {}, durationSec: number | null = 30) => tiktokProvider.publish({
    tokens, accountId: "creator", mediaUrls: [url], mediaDurationsSec: [durationSec],
    request: { format: "video", media: [{ mediaId: "m" }], caption: "Original caption", options: { publishMode: "direct", ...options } },
  });
  const initBody = (calls: ReturnType<typeof mockPublishing>) => JSON.parse(String(calls.find(c => c.url.includes("/video/init/"))?.init?.body));

  it.each([undefined, "", "PUBLIC_TO_EVERYONE", "invalid"])("requires an explicit privacy allowed by the creator: %s", async privacyLevel => {
    const calls = mockPublishing();
    await expect(publish({ privacyLevel })).rejects.toThrow(/privacy/i);
    expect(calls.every(c => c.url.includes("creator_info/query/"))).toBe(true);
  });
  it("preserves the caption and commercial flags and applies interaction choices", async () => {
    const calls = mockPublishing({ ...creatorInfo, privacy_level_options: ["PUBLIC_TO_EVERYONE"] });
    await publish({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: true, disableStitch: false, brandContentToggle: true, brandOrganicToggle: true, aiDisclosed: false });
    expect(initBody(calls).post_info).toEqual({ title: "Original caption", privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false, disable_duet: true, disable_stitch: false, brand_content_toggle: true, brand_organic_toggle: true, is_aigc: false });
  });
  it("defaults interactions to disabled and commercial flags to off", async () => {
    const calls = mockPublishing();
    await publish({ privacyLevel: "SELF_ONLY" });
    expect(initBody(calls).post_info).toMatchObject({ disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false });
  });
  it("forces disabled creator interactions off even when requested on", async () => {
    const calls = mockPublishing({ ...creatorInfo, comment_disabled: true, duet_disabled: true, stitch_disabled: true });
    await publish({ privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false });
    expect(initBody(calls).post_info).toMatchObject({ disable_comment: true, disable_duet: true, disable_stitch: true });
  });
  it("rejects branded content with private visibility before ingestion", async () => {
    const calls = mockPublishing();
    await expect(publish({ privacyLevel: "SELF_ONLY", brandContentToggle: true })).rejects.toThrow(/private/i);
    expect(calls).toHaveLength(1);
  });
  it("allows own-brand content with private visibility", async () => {
    const calls = mockPublishing();
    await publish({ privacyLevel: "SELF_ONLY", brandOrganicToggle: true });
    expect(initBody(calls).post_info.brand_organic_toggle).toBe(true);
  });
  it.each([301, null, 0, -1, NaN, Infinity])("rejects unavailable or excessive video duration: %s", async duration => {
    const calls = mockPublishing();
    await expect(publish({ privacyLevel: "SELF_ONLY" }, duration)).rejects.toThrow(/duration/i);
    expect(calls).toHaveLength(1);
  });
  it("accepts duration equal to the creator limit", async () => {
    mockPublishing();
    await expect(publish({ privacyLevel: "SELF_ONLY" }, 300)).resolves.toEqual({ providerHandle: "pub" });
  });
  it("keeps the catalog ceiling when the creator allows longer videos", async () => {
    mockPublishing({ ...creatorInfo, max_video_post_duration_sec: 1200 });
    await expect(publish({ privacyLevel: "SELF_ONLY" }, 601)).rejects.toThrow(/600/);
  });
  it("requires creator duration permissions when absent from creator info", async () => {
    const { max_video_post_duration_sec: _limit, ...withoutLimit } = creatorInfo;
    mockPublishing(withoutLimit as typeof creatorInfo);
    await expect(publish({ privacyLevel: "SELF_ONLY" })).rejects.toThrow(/duration/i);
  });
  it("sends the original video bytes unchanged in FILE_UPLOAD", async () => {
    const calls = mockPublishing();
    await publish({ privacyLevel: "SELF_ONLY" });
    expect(calls.find(c => c.init?.method === "PUT")?.init?.body).toEqual(bytes);
    expect(initBody(calls).source_info.video_size).toBe(bytes.length);
  });
  it("automatically pulls the original URL from the configured verified prefix", async () => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", "https://cdn.example.com/media/");
    const calls = mockPublishing();
    await publish({ privacyLevel: "SELF_ONLY" });
    expect(initBody(calls).source_info).toEqual({ source: "PULL_FROM_URL", video_url: url });
    expect(calls).toHaveLength(2);
  });
  it.each(["", "https://other.example.com/media/", "https://cdn.example.com/media/other/", "https://cdn.example.com.evil/media/", "http://cdn.example.com/media/", "invalid", "https://cdn.example.com/media/?x=1"])("uses FILE_UPLOAD outside a verified prefix: %s", async prefix => {
    vi.stubEnv("TIKTOK_PULL_URL_PREFIX", prefix);
    const calls = mockPublishing();
    await publish({ privacyLevel: "SELF_ONLY", ingestion: "pull_url" });
    expect(initBody(calls).source_info.source).toBe("FILE_UPLOAD");
    expect(calls.find(c => c.init?.method === "PUT")?.init?.body).toEqual(bytes);
  });
});
