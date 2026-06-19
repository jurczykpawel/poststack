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
async function rx(opts: { post: string; type: string; reactor: string; daysAgo: number }) {
  await db.insert(schema.postReactions).values({
    workspace_id: WS, channel_id: CH, post_id: opts.post,
    reactor_id: opts.reactor, reactor_name: `name-${opts.reactor}`, reaction_type: opts.type,
    created_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
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

describe("compactPostReactions", () => {
  it("folds old reactions into per-(post,type) totals; keeps in-window raw", async () => {
    if (!TEST_DB) return;
    await rx({ post: "p1", type: "like", reactor: "u1", daysAgo: 90 });
    await rx({ post: "p1", type: "like", reactor: "u2", daysAgo: 80 });
    await rx({ post: "p1", type: "love", reactor: "u3", daysAgo: 70 });
    await rx({ post: "p1", type: "like", reactor: "u4", daysAgo: 5 }); // in-window
    const res = await compaction.compactPostReactions({ now, retentionDays: 60, batchSize: 100, executor: db });
    expect(res.compacted).toBe(3);
    expect(await db.$count(schema.postReactions, eq(schema.postReactions.channel_id, CH))).toBe(1);
    const stats = await db.query.postReactionStats.findMany({ where: eq(schema.postReactionStats.channel_id, CH) });
    const like = stats.find((s) => s.reaction_type === "like")!;
    const love = stats.find((s) => s.reaction_type === "love")!;
    expect(like.count).toBe(2);
    expect(love.count).toBe(1);
  });

  it("last_reacted_at is the GREATEST across runs (monotonic)", async () => {
    if (!TEST_DB) return;
    await rx({ post: "p2", type: "like", reactor: "a", daysAgo: 100 });
    await compaction.compactPostReactions({ now, retentionDays: 60, batchSize: 100, executor: db });
    const first = (await db.query.postReactionStats.findFirst({ where: eq(schema.postReactionStats.post_id, "p2") }))!;
    await rx({ post: "p2", type: "like", reactor: "b", daysAgo: 65 });
    await compaction.compactPostReactions({ now, retentionDays: 60, batchSize: 100, executor: db });
    const second = (await db.query.postReactionStats.findFirst({ where: eq(schema.postReactionStats.post_id, "p2") }))!;
    expect(second.count).toBe(2);
    expect(second.last_reacted_at.getTime()).toBeGreaterThan(first.last_reacted_at.getTime());
  });
});

async function rm(opts: {
  platform?: typeof schema.responseMetrics.$inferInsert.platform;
  threadType?: typeof schema.responseMetrics.$inferInsert.thread_type;
  outcome: typeof schema.responseMetrics.$inferInsert.outcome;
  handlingMs: number;
  firstResponseMs: number | null;
  daysAgo: number;
}) {
  const platform = opts.platform ?? "instagram";
  const threadType = opts.threadType ?? "dm";
  await db.insert(schema.responseMetrics).values({
    workspace_id: WS,
    channel_id: CH,
    platform,
    thread_type: threadType,
    received_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
    handled_at: sql`now() - (${opts.daysAgo} || ' days')::interval`,
    handling_ms: opts.handlingMs,
    first_response_ms: opts.firstResponseMs,
    outcome: opts.outcome,
  });
}
// `received_at - N days` lands on distinct calendar days, so a group can span several day-rows in
// response_metric_stats (unique key includes `day`). Fold them back into one shape for assertions:
// counters/sums/buckets add; min/max take the extreme; null when no day-row carried a value.
async function statsFor(tt: "dm" | "comment", platform = "instagram") {
  const rows = await db.query.responseMetricStats.findMany({
    where: sql`workspace_id = ${WS} AND thread_type = ${tt} AND platform = ${platform}`,
  });
  if (rows.length === 0) return undefined;
  const add = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const ext = (k: "min_first_response_ms" | "max_first_response_ms", fn: (...n: number[]) => number) => {
    const vals = rows.map((r) => r[k]).filter((v): v is number => v != null);
    return vals.length === 0 ? null : fn(...vals);
  };
  return {
    answered_count: add("answered_count"), no_match_count: add("no_match_count"),
    paused_count: add("paused_count"), ignored_count: add("ignored_count"), error_count: add("error_count"),
    total_count: add("total_count"),
    sum_handling_ms: add("sum_handling_ms"), count_handling: add("count_handling"),
    sum_first_response_ms: add("sum_first_response_ms"), count_first_response: add("count_first_response"),
    min_first_response_ms: ext("min_first_response_ms", Math.min),
    max_first_response_ms: ext("max_first_response_ms", Math.max),
    bucket_lt_1m: add("bucket_lt_1m"), bucket_lt_5m: add("bucket_lt_5m"), bucket_lt_15m: add("bucket_lt_15m"),
    bucket_lt_1h: add("bucket_lt_1h"), bucket_lt_6h: add("bucket_lt_6h"), bucket_lt_24h: add("bucket_lt_24h"),
    bucket_gte_24h: add("bucket_gte_24h"),
  };
}

describe("compactResponseMetrics", () => {
  it("folds old rows into per-(platform,thread_type,day) stats with full counters/sums/buckets; raw deleted", async () => {
    if (!TEST_DB) return;
    // DM group: mix of outcomes + first_response spanning several buckets + one null.
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 30_000, daysAgo: 90 }); // <1m
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 2000, firstResponseMs: 200_000, daysAgo: 88 }); // <5m
    await rm({ threadType: "dm", outcome: "no_match", handlingMs: 500, firstResponseMs: 600_000, daysAgo: 85 }); // <15m
    await rm({ threadType: "dm", outcome: "error", handlingMs: 3000, firstResponseMs: null, daysAgo: 80 }); // null fr
    // comment group: distinct buckets + paused/ignored counters.
    await rm({ threadType: "comment", outcome: "paused", handlingMs: 100, firstResponseMs: 2_000_000, daysAgo: 75 }); // <1h
    await rm({ threadType: "comment", outcome: "ignored", handlingMs: 200, firstResponseMs: 10_000_000, daysAgo: 70 }); // <6h
    await rm({ threadType: "comment", outcome: "answered", handlingMs: 300, firstResponseMs: 50_000_000, daysAgo: 65 }); // <24h
    await rm({ threadType: "comment", outcome: "answered", handlingMs: 400, firstResponseMs: 100_000_000, daysAgo: 64 }); // >=24h

    const res = await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    expect(res.compacted).toBe(8);
    expect(await db.$count(schema.responseMetrics, eq(schema.responseMetrics.workspace_id, WS))).toBe(0);

    const dm = (await statsFor("dm"))!;
    expect(dm.answered_count).toBe(2);
    expect(dm.no_match_count).toBe(1);
    expect(dm.error_count).toBe(1);
    expect(dm.paused_count).toBe(0);
    expect(dm.ignored_count).toBe(0);
    expect(dm.total_count).toBe(4);
    expect(dm.sum_handling_ms).toBe(1000 + 2000 + 500 + 3000);
    expect(dm.count_handling).toBe(4);
    expect(dm.sum_first_response_ms).toBe(30_000 + 200_000 + 600_000);
    expect(dm.count_first_response).toBe(3);
    expect(dm.min_first_response_ms).toBe(30_000);
    expect(dm.max_first_response_ms).toBe(600_000);
    expect(dm.bucket_lt_1m).toBe(1);
    expect(dm.bucket_lt_5m).toBe(1);
    expect(dm.bucket_lt_15m).toBe(1);
    expect(dm.bucket_lt_1h).toBe(0);
    expect(dm.bucket_lt_6h).toBe(0);
    expect(dm.bucket_lt_24h).toBe(0);
    expect(dm.bucket_gte_24h).toBe(0);

    const cm = (await statsFor("comment"))!;
    expect(cm.paused_count).toBe(1);
    expect(cm.ignored_count).toBe(1);
    expect(cm.answered_count).toBe(2);
    expect(cm.total_count).toBe(4);
    expect(cm.sum_handling_ms).toBe(100 + 200 + 300 + 400);
    expect(cm.count_handling).toBe(4);
    expect(cm.sum_first_response_ms).toBe(2_000_000 + 10_000_000 + 50_000_000 + 100_000_000);
    expect(cm.count_first_response).toBe(4);
    expect(cm.min_first_response_ms).toBe(2_000_000);
    expect(cm.max_first_response_ms).toBe(100_000_000);
    expect(cm.bucket_lt_1m).toBe(0);
    expect(cm.bucket_lt_5m).toBe(0);
    expect(cm.bucket_lt_15m).toBe(0);
    expect(cm.bucket_lt_1h).toBe(1);
    expect(cm.bucket_lt_6h).toBe(1);
    expect(cm.bucket_lt_24h).toBe(1);
    expect(cm.bucket_gte_24h).toBe(1);
  });

  it("leaves in-window rows untouched (not rolled up, not deleted)", async () => {
    if (!TEST_DB) return;
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 30_000, daysAgo: 5 });
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    expect(await db.$count(schema.responseMetrics, eq(schema.responseMetrics.workspace_id, WS))).toBe(1);
    expect(await statsFor("dm")).toBeUndefined();
  });

  it("idempotent: a second run does not double-count", async () => {
    if (!TEST_DB) return;
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 30_000, daysAgo: 90 });
    await rm({ threadType: "dm", outcome: "no_match", handlingMs: 2000, firstResponseMs: 600_000, daysAgo: 80 });
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    const after1 = (await statsFor("dm"))!;
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    const after2 = (await statsFor("dm"))!;
    expect(after2).toEqual(after1);
    expect(await db.$count(schema.responseMetrics, eq(schema.responseMetrics.workspace_id, WS))).toBe(0);
  });

  it("group with all first_response null → fr count/sums 0, min/max null, buckets 0; handling + outcomes still set", async () => {
    if (!TEST_DB) return;
    await rm({ threadType: "dm", outcome: "error", handlingMs: 1000, firstResponseMs: null, daysAgo: 90 });
    await rm({ threadType: "dm", outcome: "paused", handlingMs: 2000, firstResponseMs: null, daysAgo: 85 });
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    const dm = (await statsFor("dm"))!;
    expect(dm.error_count).toBe(1);
    expect(dm.paused_count).toBe(1);
    expect(dm.total_count).toBe(2);
    expect(dm.sum_handling_ms).toBe(3000);
    expect(dm.count_handling).toBe(2);
    expect(dm.count_first_response).toBe(0);
    expect(dm.sum_first_response_ms).toBe(0);
    expect(dm.min_first_response_ms).toBeNull();
    expect(dm.max_first_response_ms).toBeNull();
    expect(dm.bucket_lt_1m).toBe(0);
    expect(dm.bucket_lt_5m).toBe(0);
    expect(dm.bucket_lt_15m).toBe(0);
    expect(dm.bucket_lt_1h).toBe(0);
    expect(dm.bucket_lt_6h).toBe(0);
    expect(dm.bucket_lt_24h).toBe(0);
    expect(dm.bucket_gte_24h).toBe(0);
  });

  it("partial pre-existing rollup: a second compaction pass ADDS to existing day/group correctly (min/max)", async () => {
    if (!TEST_DB) return;
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 200_000, daysAgo: 90 }); // <5m
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    // A later-arriving (still old) row for the SAME (workspace,platform,thread_type) but a new day.
    await rm({ threadType: "dm", outcome: "no_match", handlingMs: 500, firstResponseMs: 30_000, daysAgo: 90 }); // <1m, lower fr
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 700, firstResponseMs: 600_000, daysAgo: 90 }); // <15m, higher fr
    await compaction.compactResponseMetrics({ now, retentionDays: 60, batchSize: 100, executor: db });
    const dm = (await statsFor("dm"))!;
    expect(dm.answered_count).toBe(2);
    expect(dm.no_match_count).toBe(1);
    expect(dm.total_count).toBe(3);
    expect(dm.sum_handling_ms).toBe(1000 + 500 + 700);
    expect(dm.count_handling).toBe(3);
    expect(dm.count_first_response).toBe(3);
    expect(dm.min_first_response_ms).toBe(30_000);
    expect(dm.max_first_response_ms).toBe(600_000);
    expect(dm.bucket_lt_1m).toBe(1);
    expect(dm.bucket_lt_5m).toBe(1);
    expect(dm.bucket_lt_15m).toBe(1);
  });

  it("disabled (retentionDays=0) is a no-op", async () => {
    if (!TEST_DB) return;
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 30_000, daysAgo: 90 });
    await compaction.compactResponseMetrics({ now, retentionDays: 0, batchSize: 100, executor: db });
    expect(await db.$count(schema.responseMetrics, eq(schema.responseMetrics.workspace_id, WS))).toBe(1);
    expect(await statsFor("dm")).toBeUndefined();
  });
});

describe("compactHistory orchestrator", () => {
  it("runs all compactors and returns combined counts", async () => {
    if (!TEST_DB) return;
    await ev({ type: "comments", status: "fired", daysAgo: 90 });
    await rx({ post: "p1", type: "like", reactor: "u1", daysAgo: 90 });
    await rm({ threadType: "dm", outcome: "answered", handlingMs: 1000, firstResponseMs: 30_000, daysAgo: 90 });
    const res = await compaction.compactHistory({ now, retentionDays: 60, batchSize: 100, executor: db });
    expect(res.webhookEvents.compacted).toBe(1);
    expect(res.postReactions.compacted).toBe(1);
    expect(res.responseMetrics.compacted).toBe(1);
  });

  it("deleting a compacted webhook_events row does NOT delete linked records", async () => {
    if (!TEST_DB) return;
    const [ct] = await db.insert(schema.contacts).values({ workspace_id: WS, display_name: "C" }).returning({ id: schema.contacts.id });
    await db.insert(schema.webhookEvents).values({
      event_key: `k-${Math.random()}`, event_type: "messages", raw: {}, channel_id: CH, platform: "instagram",
      handling_status: "fired", contact_id: ct!.id, received_at: sql`now() - interval '90 days'`,
    });
    await compaction.compactHistory({ now, retentionDays: 60, batchSize: 100, executor: db });
    const stillThere = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, ct!.id) });
    expect(stillThere).toBeDefined();
  });
});
