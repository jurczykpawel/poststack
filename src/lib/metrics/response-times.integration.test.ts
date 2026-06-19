import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_response_times_key_abcdef0123";

let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let compaction: typeof import("@/lib/history/compaction");
let getResponseTimeStats: typeof import("./response-times").getResponseTimeStats;
let getInstanceResponseTimeStats: typeof import("./response-times").getInstanceResponseTimeStats;
let app: Hono;

let WS = "", WS_OTHER = "", CH = "";

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
  ({ getResponseTimeStats, getInstanceResponseTimeStats } = await import("./response-times"));
  const { buildApp } = await import("@/server/app");
  app = buildApp();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS, WS_OTHER].filter(Boolean)));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS, WS_OTHER]));
  WS = await seedWorkspace(db, schema, { slug: `rt-${Math.random().toString(36).slice(2)}` });
  WS_OTHER = await seedWorkspace(db, schema, { slug: `rt-other-${Math.random().toString(36).slice(2)}` });
  const [c] = await db.insert(schema.channels).values({
    workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
    connection_mode: "oauth", status: "active",
    token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
  }).returning({ id: schema.channels.id });
  CH = c!.id;
  await db.insert(schema.apiKeys).values({
    workspace_id: WS, name: "rt key",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: "sk_live_resp",
  });
});

/** Insert a live response_metrics row `daysAgo` old. */
async function liveMetric(opts: {
  workspaceId: string; daysAgo: number; threadType?: "dm" | "comment";
  outcome?: "answered" | "no_match"; handlingMs?: number; firstResponseMs?: number | null;
}) {
  const received = sql`now() - (${opts.daysAgo} || ' days')::interval`;
  await db.insert(schema.responseMetrics).values({
    workspace_id: opts.workspaceId, channel_id: opts.workspaceId === WS ? CH : null,
    platform: "instagram", thread_type: opts.threadType ?? "dm",
    received_at: received, handled_at: received,
    handling_ms: opts.handlingMs ?? 1_000,
    first_response_ms: opts.firstResponseMs === undefined ? 2_000 : opts.firstResponseMs,
    outcome: opts.outcome ?? "answered",
  });
}

describe("getResponseTimeStats — live ∪ stats union (real Postgres)", () => {
  it("returns the same numbers whether or not the old rows are compacted", async () => {
    if (!TEST_DB) return;
    // Two recent (kept live) + two old (will roll up under a 60-day window).
    await liveMetric({ workspaceId: WS, daysAgo: 1, firstResponseMs: 30_000 });
    await liveMetric({ workspaceId: WS, daysAgo: 2, firstResponseMs: 90_000 });
    await liveMetric({ workspaceId: WS, daysAgo: 100, firstResponseMs: 1_000 });
    await liveMetric({ workspaceId: WS, daysAgo: 110, firstResponseMs: 5_000 });

    const before = await getResponseTimeStats(db, { workspaceId: WS, windowDays: 365 });
    expect(before.overall.total_count).toBe(4);
    expect(before.overall.count_first_response).toBe(4);
    expect(before.overall.answer_rate_pct).toBe(100);

    await compaction.compactHistory({ now: new Date(), retentionDays: 60, batchSize: 100, executor: db });

    // After compaction the two old rows live only in response_metric_stats; the union must match.
    const after = await getResponseTimeStats(db, { workspaceId: WS, windowDays: 365 });
    expect(after.overall.total_count).toBe(before.overall.total_count);
    expect(after.overall.count_first_response).toBe(before.overall.count_first_response);
    expect(after.overall.avg_first_response_ms).toBe(before.overall.avg_first_response_ms);
    expect(after.overall.p50_bucket).toBe(before.overall.p50_bucket);
    expect(after.overall.p90_bucket).toBe(before.overall.p90_bucket);
    expect(after.overall.answer_rate_pct).toBe(before.overall.answer_rate_pct);
  });

  it("excludes another workspace's rows and splits by thread type", async () => {
    if (!TEST_DB) return;
    await liveMetric({ workspaceId: WS, daysAgo: 1, threadType: "dm", outcome: "answered", firstResponseMs: 1_000 });
    await liveMetric({ workspaceId: WS, daysAgo: 1, threadType: "comment", outcome: "no_match", firstResponseMs: null });
    // Contaminating rows in a different workspace must never be counted.
    await liveMetric({ workspaceId: WS_OTHER, daysAgo: 1, threadType: "dm", firstResponseMs: 999_000 });

    const s = await getResponseTimeStats(db, { workspaceId: WS, windowDays: 30 });
    expect(s.overall.total_count).toBe(2);
    expect(s.overall.answer_rate_pct).toBe(50); // 1 answered of 2
    expect(s.overall.count_first_response).toBe(1);
    expect(s.by_thread_type.dm?.total_count).toBe(1);
    expect(s.by_thread_type.dm?.answer_rate_pct).toBe(100);
    expect(s.by_thread_type.comment?.total_count).toBe(1);
    expect(s.by_thread_type.comment?.count_first_response).toBe(0);
    expect(s.by_thread_type.comment?.avg_first_response_ms).toBeNull();
  });

  it("respects the window — rows older than the window are not counted", async () => {
    if (!TEST_DB) return;
    await liveMetric({ workspaceId: WS, daysAgo: 2 });
    await liveMetric({ workspaceId: WS, daysAgo: 200 });
    const s = await getResponseTimeStats(db, { workspaceId: WS, windowDays: 30 });
    expect(s.overall.total_count).toBe(1);
  });
});

describe("getInstanceResponseTimeStats — across all workspaces (real Postgres)", () => {
  it("counts rows from every workspace (delta over a shared DB)", async () => {
    if (!TEST_DB) return;
    // Delta against whatever else lives in the shared DB: add a known number of rows in TWO
    // workspaces and assert the instance-wide total rises by exactly that many.
    const before = await getInstanceResponseTimeStats(db, { windowDays: 30 });
    await liveMetric({ workspaceId: WS, daysAgo: 1, firstResponseMs: 1_000 });
    await liveMetric({ workspaceId: WS, daysAgo: 1, firstResponseMs: 2_000 });
    await liveMetric({ workspaceId: WS_OTHER, daysAgo: 1, firstResponseMs: 3_000 });
    const after = await getInstanceResponseTimeStats(db, { windowDays: 30 });
    expect(after.overall.total_count - before.overall.total_count).toBe(3);
    expect(after.overall.count_first_response - before.overall.count_first_response).toBe(3);
  });

  it("a single-workspace read is a subset of the instance-wide read", async () => {
    if (!TEST_DB) return;
    await liveMetric({ workspaceId: WS, daysAgo: 1, firstResponseMs: 1_000 });
    await liveMetric({ workspaceId: WS_OTHER, daysAgo: 1, firstResponseMs: 2_000 });
    const ws = await getResponseTimeStats(db, { workspaceId: WS, windowDays: 30 });
    const instance = await getInstanceResponseTimeStats(db, { windowDays: 30 });
    expect(ws.overall.total_count).toBe(1);
    // Instance-wide includes WS, WS_OTHER, and any other workspaces in the shared DB.
    expect(instance.overall.total_count).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /api/v1/stats/response-times", () => {
  it("returns the {data} envelope for the key's workspace", async () => {
    if (!TEST_DB) return;
    await liveMetric({ workspaceId: WS, daysAgo: 1, firstResponseMs: 2_000 });
    const res = await app.request("/api/v1/stats/response-times?window=30", {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.window_days).toBe(30);
    expect(body.data.overall.total_count).toBe(1);
    expect(body.data.overall.answer_rate_pct).toBe(100);
    expect(body.meta.window_days).toBe(30);
  });

  it("clamps an out-of-range window and rejects no auth", async () => {
    if (!TEST_DB) return;
    const unauth = await app.request("/api/v1/stats/response-times");
    expect(unauth.status).toBe(401);

    const res = await app.request("/api/v1/stats/response-times?window=99999", {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    const body = await res.json();
    expect(body.data.window_days).toBe(365);
  });
});
