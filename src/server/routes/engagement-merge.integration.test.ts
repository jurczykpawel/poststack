import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let compaction: typeof import("@/lib/history/compaction");
let loadEngagement: typeof import("./dashboard").loadEngagement;
let WS = "", CH = "";

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
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  compaction = await import("@/lib/history/compaction");
  ({ loadEngagement } = await import("./dashboard"));
});
afterAll(async () => { if (TEST_DB) { await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS)); await db.$client.end(); } });
beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  WS = await seedWorkspace(db, schema, { slug: `eng-${Math.random().toString(36).slice(2)}` });
  const [c] = await db.insert(schema.channels).values({
    workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
    connection_mode: "oauth", status: "active",
    token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
  }).returning({ id: schema.channels.id });
  CH = c!.id;
});
async function rx(opts: { post: string; type: string; reactor: string; daysAgo: number }) {
  await db.insert(schema.postReactions).values({
    workspace_id: WS, channel_id: CH, post_id: opts.post,
    reactor_id: opts.reactor, reactor_name: `name-${opts.reactor}`, reaction_type: opts.type,
    created_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
  });
}

describe("loadEngagement live ∪ stats", () => {
  it("merges compacted + live reactions per post", async () => {
    if (!TEST_DB) return;
    await rx({ post: "p1", type: "like", reactor: "u1", daysAgo: 90 }); // compacted
    await rx({ post: "p1", type: "like", reactor: "u2", daysAgo: 80 }); // compacted
    await rx({ post: "p1", type: "like", reactor: "u3", daysAgo: 3 });  // live
    await rx({ post: "p1", type: "love", reactor: "u4", daysAgo: 2 });  // live
    await compaction.compactHistory({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });
    const posts = await loadEngagement(WS, [CH]);
    const p1 = posts.find((p) => p.postId === "p1")!;
    expect(p1.total).toBe(4);
    expect(p1.byType.find((t) => t.type === "like")!.n).toBe(3);
    expect(p1.byType.find((t) => t.type === "love")!.n).toBe(1);
  });

  it("a fully-compacted post still appears with correct totals", async () => {
    if (!TEST_DB) return;
    await rx({ post: "p2", type: "like", reactor: "u1", daysAgo: 95 });
    await rx({ post: "p2", type: "like", reactor: "u2", daysAgo: 90 });
    await compaction.compactHistory({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });
    const posts = await loadEngagement(WS, [CH]);
    const p2 = posts.find((p) => p.postId === "p2")!;
    expect(p2.total).toBe(2);
    expect(p2.byType.find((t) => t.type === "like")!.n).toBe(2);
  });
});
