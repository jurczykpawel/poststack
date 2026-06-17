import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let compaction: typeof import("./compaction");
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
  compaction = await import("./compaction");
});
afterAll(async () => { if (TEST_DB) { await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS)); await db.$client.end(); } });

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  // Orphan rows (channel_id NULL) belong to no workspace: the workspace delete above can't reach
  // pre-existing ones, AND it MANUFACTURES new orphans (FK is ON DELETE SET NULL, so a prior test's
  // in-window rows survive channel deletion as NULL). Clear them last so the global orphan-count
  // assertions in this file see only the rows this file creates.
  await db.delete(schema.webhookEvents).where(sql`channel_id IS NULL`);
  WS = await seedWorkspace(db, schema, { slug: `ret-${Math.random().toString(36).slice(2)}` });
  const [c] = await db.insert(schema.channels).values({
    workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
    connection_mode: "oauth", status: "active",
    token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
  }).returning({ id: schema.channels.id });
  CH = c!.id;
});

async function ev(opts: { type: string; status: string; daysAgo: number; channelId?: string | null }) {
  await db.insert(schema.webhookEvents).values({
    event_key: `k-${Math.random()}`,
    event_type: opts.type,
    raw: { hello: "world" },
    channel_id: opts.channelId === undefined ? CH : opts.channelId,
    platform: "instagram",
    handling_status: opts.status as typeof schema.webhookEvents.$inferInsert.handling_status,
    received_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
  });
}
const now = new Date();

describe("compactWebhookEvents", () => {
  it("count conservation: old rows folded into stats, in-window rows stay raw", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 90 });
    await ev({ type: "comments", status: "fired", daysAgo: 80 });
    await ev({ type: "comments", status: "no_match", daysAgo: 70 });
    await ev({ type: "comments", status: "fired", daysAgo: 10 });
    await ev({ type: "comments", status: "fired", daysAgo: 1 });
    await compaction.compactWebhookEvents({ now, retentionDays: 60, batchSize: 100, executor: db });
    const rawCount = await db.$count(schema.webhookEvents, eq(schema.webhookEvents.channel_id, CH));
    expect(rawCount).toBe(2);
    const stats = await db.query.webhookEventStats.findMany({ where: eq(schema.webhookEventStats.channel_id, CH) });
    expect(stats.reduce((a, s) => a + s.count, 0)).toBe(3);
    const firedTotal = stats.filter((s) => s.handling_status === "fired").reduce((a, s) => a + s.count, 0);
    const noMatchTotal = stats.filter((s) => s.handling_status === "no_match").reduce((a, s) => a + s.count, 0);
    expect(firedTotal).toBe(2);
    expect(noMatchTotal).toBe(1);
  });

  it("orphans (channel_id NULL) are deleted and NOT aggregated", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 90, channelId: null });
    await compaction.compactWebhookEvents({ now, retentionDays: 60, batchSize: 100, executor: db });
    expect(await db.$count(schema.webhookEvents, sql`channel_id IS NULL`)).toBe(0);
    expect(await db.$count(schema.webhookEventStats)).toBe(0);
  });

  it("disabled (retentionDays=0) is a no-op", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 90 });
    await compaction.compactWebhookEvents({ now, retentionDays: 0, batchSize: 100, executor: db });
    expect(await db.$count(schema.webhookEvents, eq(schema.webhookEvents.channel_id, CH))).toBe(1);
    expect(await db.$count(schema.webhookEventStats)).toBe(0);
  });

  it("idempotent: a second run changes nothing", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 90 });
    await ev({ type: "comments", status: "fired", daysAgo: 70 });
    await compaction.compactWebhookEvents({ now, retentionDays: 60, batchSize: 100, executor: db });
    const after1 = await db.query.webhookEventStats.findMany();
    const sum1 = after1.reduce((a, s) => a + s.count, 0);
    await compaction.compactWebhookEvents({ now, retentionDays: 60, batchSize: 100, executor: db });
    const after2 = await db.query.webhookEventStats.findMany();
    expect(after2.reduce((a, s) => a + s.count, 0)).toBe(sum1);
    expect(after2.length).toBe(after1.length);
  });

  it("batchSize smaller than the backlog still processes everything", async () => {
    if (!TEST_DB) return;
    for (let i = 0; i < 5; i++) await ev({ type: "comments", status: "fired", daysAgo: 90 });
    await compaction.compactWebhookEvents({ now, retentionDays: 60, batchSize: 2, executor: db });
    expect(await db.$count(schema.webhookEvents, eq(schema.webhookEvents.channel_id, CH))).toBe(0);
    expect((await db.query.webhookEventStats.findMany()).reduce((a, s) => a + s.count, 0)).toBe(5);
  });
});

describe("compactWebhookEvents — cutoff boundary under a non-UTC TZ", () => {
  const prevTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = "America/New_York"; });
  afterAll(() => { process.env.TZ = prevTz; });
  it("compacts < cutoff and keeps >= cutoff exactly", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 61 });
    await ev({ type: "comments", status: "fired", daysAgo: 59 });
    await compaction.compactWebhookEvents({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });
    expect(await db.$count(schema.webhookEvents, eq(schema.webhookEvents.channel_id, CH))).toBe(1);
    expect((await db.query.webhookEventStats.findMany()).reduce((a, s) => a + s.count, 0)).toBe(1);
  });
});
