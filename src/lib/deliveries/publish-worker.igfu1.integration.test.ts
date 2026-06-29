/**
 * IGFU1 end-to-end: a channel connected ONLY via Instagram Business Login (an IG-Login messaging
 * token in the blob, NO Facebook page token) publishes through the real worker → real MetaProvider,
 * and every Graph edge lands on graph.instagram.com (IG_GRAPH_BASE) carrying the IG-Login token.
 *
 * Runs against a CURRENT-SCHEMA Postgres (TEST_DATABASE_URL). fetch is stubbed so we observe the
 * exact outbound publish edges without touching the network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { IG_GRAPH_BASE } from "@/lib/platforms/constants";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let processPublish: typeof import("./publish-worker").processPublish;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

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
  WS = await seedWorkspace(db, schema, { slug: `igfu1-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.events).where(eq(schema.events.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
});
afterEach(() => vi.unstubAllGlobals());

const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

const status = async (id: string) =>
  (await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, id) }))!.status;

/** Seed an IG-Login-ONLY channel: empty FB page token + an IG-Login messaging token in the blob. */
async function seedIgLoginOnly() {
  const [c] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: "IG_BIZ_1",
      display_name: "IG-Login only",
      connection_mode: "derived",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW_pub" }),
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
      format: "video",
      status: "scheduled",
      payload: { format: "reel", media: [{ mediaId: m!.id }], caption: "hi" },
      scheduled_at: new Date(),
      run_at: new Date(),
    })
    .returning();
  return { channelId: c!.id, postId: p!.id };
}

describe("IGFU1: IG-Login-only channel publishes via graph.instagram.com end-to-end", () => {
  it("routes the reel container + media_publish to graph.instagram.com with the IG-Login token", async () => {
    if (!TEST_DB) return;
    const { postId } = await seedIgLoginOnly();

    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/media_publish")) return new Response(JSON.stringify({ id: "IG_MEDIA_777" }), { status: 200 });
        if (url.includes("?fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
        return new Response(JSON.stringify({ id: "container_1" }), { status: 200 });
      }),
    );

    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("sent");

    // Only Graph publish edges (skip any internal/queue fetches, of which there are none here).
    const graphCalls = calls.filter((c) => c.url.includes("graph."));
    expect(graphCalls.length).toBeGreaterThan(0);
    expect(graphCalls.every((c) => c.url.startsWith(IG_GRAPH_BASE))).toBe(true);
    expect(graphCalls.some((c) => c.url === `${IG_GRAPH_BASE}/IG_BIZ_1/media`)).toBe(true);
    expect(graphCalls.some((c) => c.url === `${IG_GRAPH_BASE}/IG_BIZ_1/media_publish`)).toBe(true);
    expect(graphCalls.some((c) => c.url.includes("graph.facebook.com"))).toBe(false);

    const create = graphCalls.find((c) => c.url === `${IG_GRAPH_BASE}/IG_BIZ_1/media`)!;
    expect(decodeURIComponent(create.body)).toContain("access_token=IGQW_pub");
  });
});
