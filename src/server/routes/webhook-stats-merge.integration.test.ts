import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let compaction: typeof import("@/lib/history/compaction");
let loadWebhookStats: typeof import("./dashboard").loadWebhookStats;
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
  ({ loadWebhookStats } = await import("./dashboard"));
});
afterAll(async () => { if (TEST_DB) { await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS)); await db.$client.end(); } });
beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.delete(schema.webhookEvents).where(sql`channel_id IS NULL`);
  WS = await seedWorkspace(db, schema, { slug: `whs-${Math.random().toString(36).slice(2)}` });
  const [c] = await db.insert(schema.channels).values({
    workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
    connection_mode: "oauth", status: "active",
    token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
  }).returning({ id: schema.channels.id });
  CH = c!.id;
});
async function ev(opts: { status: string; daysAgo: number }) {
  await db.insert(schema.webhookEvents).values({
    event_key: `k-${Math.random()}`, event_type: "comments", raw: {}, channel_id: CH, platform: "instagram",
    handling_status: opts.status as typeof schema.webhookEvents.$inferInsert.handling_status,
    received_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
  });
}

describe("loadWebhookStats live ∪ stats", () => {
  it("all-time total + byStatus are unchanged by compaction", async () => {
    if (!TEST_DB) return;
    await ev({ status: "fired", daysAgo: 90 });
    await ev({ status: "recorded", daysAgo: 80 });
    await ev({ status: "fired", daysAgo: 2 });
    const before = await loadWebhookStats([CH]);
    await compaction.compactHistory({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });
    const after = await loadWebhookStats([CH]);
    expect(after.total).toBe(before.total);              // 3
    expect(after.byStatus.fired).toBe(before.byStatus.fired);       // 2
    expect(after.byStatus.recorded).toBe(before.byStatus.recorded); // 1
  });

  it("last24h counts only recent raw and is unaffected by compaction", async () => {
    if (!TEST_DB) return;
    await ev({ status: "fired", daysAgo: 90 });
    await ev({ status: "fired", daysAgo: 0 });
    const before = await loadWebhookStats([CH]);
    expect(before.last24h).toBe(1);
    await compaction.compactHistory({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });
    const after = await loadWebhookStats([CH]);
    expect(after.last24h).toBe(1);
  });
});
