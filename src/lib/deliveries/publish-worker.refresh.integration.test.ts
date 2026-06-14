import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";

// Pre-publish freshness guard (§5C): an oauth channel whose token is about to expire is refreshed
// INLINE before the worker publishes. PostStack proved this with a synthetic provider; the trunk's
// platform column is an enum, so we re-express the invariant against a real refreshable provider
// (tiktok: requiresTokenRefresh() === true), spying its refreshToken + publish.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let decryptTokens: typeof import("@/lib/crypto").decryptTokens;
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
  ({ encryptTokens, decryptTokens } = await import("@/lib/crypto"));
  ({ processPublish } = await import("./publish-worker"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `refresh-${Date.now()}` });
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
afterEach(() => vi.restoreAllMocks());

describe("pre-publish freshness guard", () => {
  it("refreshes an expiring oauth token inline before publishing", async () => {
    if (!TEST_DB) return;
    const [c] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "tiktok",
        platform_id: "A",
        connection_mode: "oauth",
        status: "active",
        token_encrypted: encryptTokens({ access_token: "old", refresh_token: "R" }),
        token_expires_at: new Date(Date.now() + 60_000), // within the 5-minute freshness buffer
        webhook_secret: "wh",
      })
      .returning();
    const [m] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `x${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
      .returning();
    const [p] = await db
      .insert(schema.deliveries)
      .values({
        workspace_id: WS,
        channel_id: c!.id,
        format: "video",
        status: "scheduled",
        payload: { format: "video", media: [{ mediaId: m!.id }] },
        scheduled_at: new Date(),
        run_at: new Date(),
      })
      .returning();

    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    // Precondition (makes the coupling explicit + self-protecting): tiktok stands in for "a real
    // refreshable oauth provider". If it ever stops requiring refresh, fail HERE with a clear reason
    // — switch to another refreshable provider — rather than silently no-op'ing the §5C path below.
    expect(tt.requiresTokenRefresh()).toBe(true);
    const refresh = vi.spyOn(tt, "refreshToken").mockResolvedValue({
      accessToken: "new",
      refreshToken: "R",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const publish = vi.spyOn(tt, "publish").mockResolvedValue({ providerHandle: "ok" });

    await processPublish({ postId: p!.id }, helpers);

    expect(refresh).toHaveBeenCalled();
    // the refreshed token was persisted AND handed to publish (no stale "old" token sent)
    const ch = await db.query.channels.findFirst({ where: eq(schema.channels.id, c!.id) });
    expect(decryptTokens(ch!.token_encrypted).access_token).toBe("new");
    expect(publish.mock.calls[0]![0].tokens.accessToken).toBe("new");
    expect((await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, p!.id) }))!.status).toBe("sent");
  });
});
