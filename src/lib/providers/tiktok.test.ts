import { describe, it, expect, afterEach, vi } from "vitest";
// Media download fetches now route through the SSRF guard (safeFetch → DNS resolve). Stub DNS to a
// public IP so these unit tests don't hit the network for fake hostnames.
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));
import { tiktokProvider } from "./tiktok";
import { isProvider } from "./index";
import { TokenInvalidError } from "./errors";

afterEach(() => vi.unstubAllGlobals());
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

  it("publish with ingestion=pull_url uses PULL_FROM_URL (no download/PUT)", async () => {
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
    });
    expect(h.providerHandle).toBe("pub_p");
    expect(initBody.source_info).toMatchObject({ source: "PULL_FROM_URL", video_url: "https://cdn/x.mp4" });
    expect(putCalled).toBe(false);
  });

  it("publish direct mode sets post_info (title + SELF_ONLY + frame cover)", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        options: { publishMode: "direct", ingestion: "pull_url", coverTimestampMs: 1500 },
      },
      mediaUrls: ["https://cdn/x.mp4"],
    });
    expect(url).toContain("/post/publish/video/init/");
    expect(body.post_info).toMatchObject({
      title: "my title",
      privacy_level: "SELF_ONLY",
      video_cover_timestamp_ms: 1500,
    });
  });

  it("surfaces a TikTok 200-with-error (e.g. url_ownership_unverified)", async () => {
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
      }),
    ).rejects.toThrow();
  });
});
