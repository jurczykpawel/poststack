import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";

// AUD48: if flagging the channel throws, the post must already be 'held' (not 'sending').
// The worker imports markChannelNeedsReauth from this module; the mock makes it throw so we prove the
// held-window ordering (setStatus(held) BEFORE the best-effort channel flag).
vi.mock("@/lib/channels/health", async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    markChannelNeedsReauth: vi.fn(async () => {
      throw new Error("transient db blip while flagging channel");
    }),
  };
});

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let processPublish: typeof import("./publish-worker").processPublish;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ processPublish } = await import("./publish-worker"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `aud48-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
});
afterEach(() => vi.unstubAllGlobals());

describe("AUD48 — token-invalid held window", () => {
  it("leaves the post 'held' (reattemptable) even when channel-flag throws", async () => {
    if (!TEST_DB) return;
    const [c] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "instagram",
        platform_id: `ACCT-${Math.random()}`,
        connection_mode: "manual_token",
        status: "active",
        token_encrypted: encryptTokens({ access_token: "T" }),
        webhook_secret: "wh",
      })
      .returning();
    const [m] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
      .returning();
    const [p] = await db
      .insert(schema.deliveries)
      .values({
        workspace_id: WS,
        channel_id: c!.id,
        format: "reel",
        status: "scheduled",
        payload: { format: "reel", media: [{ mediaId: m!.id }] },
        scheduled_at: new Date(),
        run_at: new Date(),
      })
      .returning();

    // Meta returns a dead-token error (code 190) at container-create → TokenInvalidError in the worker.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })),
    );

    // Must NOT throw (channel-flag failure is swallowed) and must NOT leave 'sending'.
    await processPublish({ postId: p!.id }, helpers);
    const row = await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, p!.id) });
    expect(row!.status).toBe("held");
  });
});
