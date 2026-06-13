import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let poll: typeof import("./poll");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "11110000-0000-0000-0000-0000000000a1";
const CH = "11110000-0000-0000-0000-0000000000a2";
const YT_CHANNEL_ID = "UCmychannel";
const realFetch = globalThis.fetch;

function ytThread(id: string, publishedAt: string, author = `UCviewer-${id}`) {
  return {
    id: `t-${id}`,
    snippet: {
      videoId: "VIDx",
      topLevelComment: { id, snippet: { authorDisplayName: `viewer ${id}`, authorChannelId: { value: author }, textOriginal: `hello ${id}`, publishedAt, updatedAt: publishedAt } },
    },
  };
}

// commentThreads.list mock with controllable response.
let nextResponse: () => Response;
function setThreads(items: unknown[], etag = 'W/"e1"') {
  nextResponse = () => new Response(JSON.stringify({ etag, items }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsec";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  poll = await import("./poll");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "YT", slug: `yt-${WS}` });
  // A connected YouTube channel with a still-valid access token (no refresh needed).
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "youtube", platform_id: YT_CHANNEL_ID, display_name: "My Channel",
    token_encrypted: encryptTokens({ access_token: "at", refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    webhook_secret: "s", status: "active",
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/commentThreads")) return nextResponse();
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("pollYouTubeChannel (real Postgres)", () => {
  it("ingests new comments into per-video comment threads + logs + persists the cursor", async () => {
    if (!TEST_DB) return;
    mockFetch();
    setThreads([ytThread("c2", "2026-06-02T00:00:00Z"), ytThread("c1", "2026-06-01T00:00:00Z")], 'W/"page2"');
    const r = await poll.pollYouTubeChannel(CH);
    expect(r.ingested).toBe(2);
    expect(r.quotaSpent).toBe(1);

    const logs = await db.query.commentLogs.findMany({ where: eq(s.commentLogs.channel_id, CH) });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.conversation_id !== null && l.post_id === "VIDx")).toBe(true);

    const convs = await db.query.conversations.findMany({ where: eq(s.conversations.workspace_id, WS) });
    expect(convs.every((c) => c.thread_type === "comment" && c.thread_ref === "VIDx")).toBe(true);

    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { last_comment_cursor: true } });
    const cursor = JSON.parse(ch!.last_comment_cursor!);
    expect(cursor.etag).toBe('W/"page2"');
    expect(cursor.sincePublishedAt).toBe("2026-06-02T00:00:00Z"); // newest
  });

  it("dedups on re-poll (unique platform_comment_id) — no duplicate logs", async () => {
    if (!TEST_DB) return;
    mockFetch();
    setThreads([ytThread("c1", "2026-06-01T00:00:00Z")]);
    await poll.pollYouTubeChannel(CH);
    // same comment returned again (e.g. cursor over-fetch)
    setThreads([ytThread("c1", "2026-06-01T00:00:00Z")]);
    const r2 = await poll.pollYouTubeChannel(CH);
    expect(r2.ingested).toBe(0);
    const logs = await db.query.commentLogs.findMany({ where: eq(s.commentLogs.channel_id, CH) });
    expect(logs).toHaveLength(1);
  });

  it("returns notModified (zero quota) on a 304", async () => {
    if (!TEST_DB) return;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 304 })) as typeof fetch;
    const r = await poll.pollYouTubeChannel(CH);
    expect(r.notModified).toBe(true);
    expect(r.ingested).toBe(0);
    expect(r.quotaSpent).toBe(0);
  });

  it("skips the channel's own comments (self-loop guard)", async () => {
    if (!TEST_DB) return;
    mockFetch();
    setThreads([ytThread("own", "2026-06-05T00:00:00Z", YT_CHANNEL_ID), ytThread("viewer", "2026-06-04T00:00:00Z")]);
    const r = await poll.pollYouTubeChannel(CH);
    expect(r.ingested).toBe(1); // only the viewer's comment
    const logs = await db.query.commentLogs.findMany({ where: eq(s.commentLogs.channel_id, CH) });
    expect(logs.map((l) => l.platform_comment_id)).toEqual(["viewer"]);
  });
});

describe("freshYouTubeAccessToken", () => {
  it("refreshes + persists when the stored token is near expiry", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels)
      .set({ token_encrypted: encryptTokens({ access_token: "stale", refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) - 10 }) })
      .where(eq(s.channels.id, CH));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", expires_in: 3600 });
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { id: true, token_encrypted: true } });
    const token = await poll.freshYouTubeAccessToken(ch!);
    expect(token).toBe("fresh");
  });
});
