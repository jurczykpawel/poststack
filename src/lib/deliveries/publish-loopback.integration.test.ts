import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";

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
  WS = await seedWorkspace(db, schema, { slug: `loopback-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
});
afterEach(() => vi.unstubAllGlobals());

// A delivery with an editorial post linked back to it (the publish-from-card shape). Instagram is a
// distinct platform in the trunk → routes through the meta provider's IG publish flow.
async function linked() {
  const [c] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: "ACCT",
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
  const [d] = await db
    .insert(schema.deliveries)
    .values({
      workspace_id: WS,
      channel_id: c!.id,
      format: "reel",
      status: "scheduled",
      payload: { format: "reel", media: [{ mediaId: m!.id }], caption: "hi" },
      scheduled_at: new Date(),
      run_at: new Date(),
    })
    .returning();
  const [p] = await db
    .insert(schema.posts)
    .values({ workspace_id: WS, platform: "instagram", status: "scheduled", delivery_id: d!.id })
    .returning();
  return { deliveryId: d!.id, postId: p!.id };
}

const editorial = async (id: string) =>
  (await db.query.posts.findFirst({ where: eq(schema.posts.id, id) }))!;

describe("publish loop-back to editorial post", () => {
  it("delivery sent -> linked editorial post becomes published with published_at", async () => {
    if (!TEST_DB) return;
    const { deliveryId, postId } = await linked();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/media_publish")) return new Response(JSON.stringify({ id: "post_xyz" }), { status: 200 });
        if (url.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_1" }), { status: 200 });
      }),
    );
    await processPublish({ postId: deliveryId }, helpers);
    const p = await editorial(postId);
    expect(p.status).toBe("published");
    expect(p.published_at).toBeInstanceOf(Date);
  });

  it("delivery permanently fails -> linked editorial post becomes failed", async () => {
    if (!TEST_DB) return;
    const { deliveryId, postId } = await linked();
    // 403 → meta classifies as a permanent failure (400/401 would be a token error → held + retry).
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 })));
    await processPublish({ postId: deliveryId }, helpers);
    expect((await editorial(postId)).status).toBe("failed");
  });
});
