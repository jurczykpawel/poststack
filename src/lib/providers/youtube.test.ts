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

import { youtubeProvider } from "./youtube";
import { isProvider } from "./index";
import { TokenInvalidError } from "./errors";

afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "AT", refreshToken: "RT" };

describe("youtube provider", () => {
  it("is registered + refreshable", () => {
    expect(isProvider("youtube")).toBe(true);
    expect(youtubeProvider.requiresTokenRefresh()).toBe(true);
    expect(youtubeProvider.capabilities().map((c) => c.format)).toContain("short");
  });

  it("refreshToken exchanges via Google token endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })),
    );
    const t = await youtubeProvider.refreshToken(tokens);
    expect(t.accessToken).toBe("new");
    expect(t.refreshToken).toBe("RT");
  });

  it("healthCheck returns the channel id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "UC123" }] }), { status: 200 })),
    );
    expect((await youtubeProvider.healthCheck(tokens)).accountId).toBe("UC123");
  });

  it("healthCheck throws TokenInvalidError on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "x" } }), { status: 401 })));
    await expect(youtubeProvider.healthCheck(tokens)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("healthCheck returns the channel avatar from snippet thumbnails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "T", thumbnails: { default: { url: "https://yt.test/a.jpg" } } } }] }), { status: 200 }),
      ),
    );
    expect((await youtubeProvider.healthCheck(tokens)).avatarUrl).toBe("https://yt.test/a.jpg");
  });

  it("healthCheck returns the channel handle from snippet.customUrl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "T", customUrl: "@techskills" } }] }), { status: 200 }),
      ),
    );
    expect((await youtubeProvider.healthCheck(tokens)).handle).toBe("@techskills");
  });

  it("healthCheck gives an actionable error when the Google account has no YouTube channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 401, message: "Unauthorized", errors: [{ reason: "youtubeSignupRequired" }] } }), { status: 401 }),
      ),
    );
    await expect(youtubeProvider.healthCheck(tokens)).rejects.toThrowError(/no YouTube channel/i);
  });

  it("healthCheck authenticates with the Bearer header, not a ?access_token= query param (Google removed it → 401)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "UC1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await youtubeProvider.healthCheck(tokens);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(String(url)).not.toContain("access_token=");
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer AT");
  });

  it("publish does a resumable upload: download bytes -> init (Location) -> PUT -> video id", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url === "https://cdn/x.mp4") {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }); // the video bytes
        }
        if (url.includes("/upload/youtube/v3/videos")) {
          // resumable init → return the session URI in Location
          return new Response("{}", { status: 200, headers: { location: "https://upload.googleapis.com/sess1" } });
        }
        if (url === "https://upload.googleapis.com/sess1") {
          return new Response(JSON.stringify({ id: "vid_1" }), { status: 200 }); // PUT result
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await youtubeProvider.publish({
      tokens,
      accountId: "UC",
      request: { format: "short", media: [{ mediaId: "m" }], title: "T", options: { privacyStatus: "unlisted" } },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(h.providerHandle).toBe("vid_1");
    expect(calls.some((c) => c.url.includes("/upload/youtube/v3/videos") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url === "https://upload.googleapis.com/sess1" && c.method === "PUT")).toBe(true);
  });

  it("refuses to upload to a resumable Location on a non-Google host [PSA50]", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://cdn/x.mp4") return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        if (url.includes("/upload/youtube/v3/videos"))
          return new Response("{}", { status: 200, headers: { location: "http://169.254.169.254/exfil" } });
        return new Response("{}", { status: 200 });
      }),
    );
    await expect(
      youtubeProvider.publish({
        tokens,
        accountId: "UC",
        request: { format: "short", media: [{ mediaId: "m" }], title: "T" },
        mediaUrls: ["https://cdn/x.mp4"],
      }),
    ).rejects.toThrow();
    expect(calls.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("fails cleanly when the video download exceeds the size cap (no full-buffer OOM) [PSA52]", async () => {
    process.env.PROVIDER_DOWNLOAD_MAX_BYTES = "1"; // any real body exceeds it
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://cdn/x.mp4") return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    try {
      await expect(
        youtubeProvider.publish({
          tokens,
          accountId: "UC",
          request: { format: "short", media: [{ mediaId: "m" }], title: "T" },
          mediaUrls: ["https://cdn/x.mp4"],
        }),
      ).rejects.toThrow();
      expect(calls.some((u) => u.includes("/upload/youtube/v3/videos"))).toBe(false); // never reached the upload
    } finally {
      delete process.env.PROVIDER_DOWNLOAD_MAX_BYTES;
    }
  });

  it("sets a custom thumbnail when options.coverUrl is provided", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://cdn/x.mp4") return new Response(new Uint8Array([1, 2]), { status: 200 });
        if (url.includes("/upload/youtube/v3/videos"))
          return new Response("{}", { status: 200, headers: { location: "https://upload.googleapis.com/sess" } });
        if (url === "https://upload.googleapis.com/sess") return new Response(JSON.stringify({ id: "vid_9" }), { status: 200 });
        if (url === "https://cdn/cover.png")
          return new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/png" } });
        if (url.includes("/upload/youtube/v3/thumbnails/set"))
          return new Response(JSON.stringify({ items: [{}] }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );
    const h = await youtubeProvider.publish({
      tokens,
      accountId: "UC",
      request: {
        format: "short",
        media: [{ mediaId: "m" }],
        title: "T",
        options: { coverUrl: "https://cdn/cover.png" },
      },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(h.providerHandle).toBe("vid_9");
    expect(calls.some((u) => u.includes("/upload/youtube/v3/thumbnails/set?videoId=vid_9"))).toBe(true);
  });

  it("publish surfaces an init error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://cdn/x.mp4") return new Response(new Uint8Array([1]), { status: 200 });
        return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 403 });
      }),
    );
    await expect(
      youtubeProvider.publish({
        tokens,
        accountId: "UC",
        request: { format: "short", media: [{ mediaId: "m" }], title: "T" },
        mediaUrls: ["https://cdn/x.mp4"],
      }),
    ).rejects.toBeInstanceOf(TokenInvalidError); // 403 -> token_invalid via classifyHttp
  });
});
