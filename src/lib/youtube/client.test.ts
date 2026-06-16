import { describe, it, expect, vi } from "vitest";
import { pollCommentThreads, insertCommentReply, insertCommentThread, refreshGoogleAccessToken, getMyChannel, YouTubeApiError, googleAuthUrl, YOUTUBE_OAUTH_SCOPE } from "./client";

describe("googleAuthUrl — YouTube-only consent", () => {
  const url = googleAuthUrl({ clientId: "cid", redirectUri: "https://app/cb", state: "st" });
  const params = new URL(url).searchParams;

  it("requests exactly the YouTube scope — never Gmail/Drive/Photos", () => {
    expect(params.get("scope")).toBe(YOUTUBE_OAUTH_SCOPE);
    expect(url).not.toContain("gmail");
    expect(url).not.toContain("drive");
    expect(url).not.toContain("photoslibrary");
  });

  it("does not set include_granted_scopes — that would union in every scope already granted to a shared client", () => {
    expect(params.has("include_granted_scopes")).toBe(false);
  });

  it("still forces a refresh token", () => {
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });
});

function thread(id: string, publishedAt: string, over: Record<string, unknown> = {}) {
  return {
    id: `t-${id}`,
    snippet: {
      videoId: "VID1",
      topLevelComment: {
        id: id,
        snippet: { authorDisplayName: `author-${id}`, authorChannelId: { value: `UC-${id}` }, textOriginal: `text ${id}`, publishedAt, updatedAt: publishedAt, ...over },
      },
    },
  };
}
function jsonRes(body: unknown, status = 200, etag?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (etag) headers.etag = etag;
  return new Response(JSON.stringify(body), { status, headers });
}

describe("pollCommentThreads — quota-conscious polling", () => {
  it("returns notModified + zero quota on a 304 (idle channel)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", etag: 'W/"abc"', sincePublishedAt: "2026-01-01T00:00:00Z", fetchImpl });
    expect(r.notModified).toBe(true);
    expect(r.quotaSpent).toBe(0);
    expect(r.comments).toEqual([]);
  });

  it("sends If-None-Match when an etag is supplied", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    await pollCommentThreads({ channelId: "UCx", accessToken: "t", etag: 'W/"abc"', sincePublishedAt: "2026-01-01T00:00:00Z", fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
  });

  it("maps new comments and returns the page etag", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ etag: 'W/"new"', items: [thread("c2", "2026-06-02T00:00:00Z"), thread("c1", "2026-06-01T00:00:00Z")] }),
    ) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: "2026-05-01T00:00:00Z", fetchImpl });
    expect(r.notModified).toBe(false);
    expect(r.etag).toBe('W/"new"');
    expect(r.quotaSpent).toBe(1);
    expect(r.comments.map((c) => c.commentId)).toEqual(["c2", "c1"]);
    expect(r.comments[0]).toMatchObject({ videoId: "VID1", authorName: "author-c2", text: "text c2", commentId: "c2", threadId: "t-c2" });
  });

  it("stops at the cursor: excludes comments at/older than sincePublishedAt", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ items: [thread("c3", "2026-06-03T00:00:00Z"), thread("old", "2026-05-01T00:00:00Z"), thread("older", "2026-04-01T00:00:00Z")], nextPageToken: "p2" }),
    ) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: "2026-05-01T00:00:00Z", fetchImpl });
    expect(r.comments.map((c) => c.commentId)).toEqual(["c3"]); // 'old' (== cursor) and beyond excluded
    expect(fetchImpl).toHaveBeenCalledTimes(1); // stopped paginating once cursor reached
  });

  it("paginates until the cursor across pages", async () => {
    const pages = [
      jsonRes({ items: [thread("c5", "2026-06-05T00:00:00Z")], nextPageToken: "p2" }),
      jsonRes({ items: [thread("c4", "2026-06-04T00:00:00Z"), thread("seen", "2026-05-01T00:00:00Z")], nextPageToken: "p3" }),
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => pages[i++]) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: "2026-05-01T00:00:00Z", fetchImpl });
    expect(r.comments.map((c) => c.commentId)).toEqual(["c5", "c4"]);
    expect(r.quotaSpent).toBe(2);
  });

  it("caps pages to bound quota (maxPages)", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ items: [thread(`c${Math.random()}`, "2026-06-09T00:00:00Z")], nextPageToken: "more" })) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: "2026-05-01T00:00:00Z", maxPages: 3, fetchImpl });
    expect(r.quotaSpent).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("first poll (no cursor) fetches exactly one page — no backlog blowout", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ items: [thread("c1", "2026-06-01T00:00:00Z")], nextPageToken: "more" })) as unknown as typeof fetch;
    const r = await pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: null, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.comments).toHaveLength(1);
  });

  it("throws YouTubeApiError with the HTTP status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota", { status: 403 })) as unknown as typeof fetch;
    await expect(pollCommentThreads({ channelId: "UCx", accessToken: "t", sincePublishedAt: "2026-01-01T00:00:00Z", fetchImpl }))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("insertCommentReply", () => {
  it("posts the reply and returns the new id", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ id: "reply-1" }, 200)) as unknown as typeof fetch;
    const r = await insertCommentReply({ parentId: "c1", text: "thanks!", accessToken: "t", fetchImpl });
    expect(r.id).toBe("reply-1");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/comments?part=snippet");
    expect(JSON.parse(init.body as string)).toEqual({ snippet: { parentId: "c1", textOriginal: "thanks!" } });
  });
  it("throws YouTubeApiError on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(insertCommentReply({ parentId: "c1", text: "x", accessToken: "t", fetchImpl })).rejects.toBeInstanceOf(YouTubeApiError);
  });
});

describe("insertCommentThread — top-level comment on a video", () => {
  it("posts a NEW top-level comment on the video (NOT a reply) and returns the id", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ id: "thread-1" }, 200)) as unknown as typeof fetch;
    const r = await insertCommentThread({ videoId: "vid123", text: "link in bio 👇", accessToken: "t", fetchImpl });
    expect(r.id).toBe("thread-1");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/commentThreads?part=snippet");
    expect(JSON.parse(init.body as string)).toEqual({
      snippet: { videoId: "vid123", topLevelComment: { snippet: { textOriginal: "link in bio 👇" } } },
    });
  });
  it("throws YouTubeApiError on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(insertCommentThread({ videoId: "v", text: "x", accessToken: "t", fetchImpl })).rejects.toBeInstanceOf(YouTubeApiError);
  });
});

describe("refreshGoogleAccessToken", () => {
  it("exchanges a refresh token for a fresh access token + expiry", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ access_token: "fresh", expires_in: 3600 })) as unknown as typeof fetch;
    const r = await refreshGoogleAccessToken({ refreshToken: "rt", clientId: "cid", clientSecret: "sec", fetchImpl });
    expect(r.accessToken).toBe("fresh");
    expect(r.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe("getMyChannel", () => {
  it("resolves the authenticated channel", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ items: [{ id: "UCabc", snippet: { title: "My Channel", thumbnails: { default: { url: "u" } } } }] })) as unknown as typeof fetch;
    const r = await getMyChannel({ accessToken: "t", fetchImpl });
    expect(r).toEqual({ id: "UCabc", title: "My Channel", thumbnail: "u" });
  });
});
