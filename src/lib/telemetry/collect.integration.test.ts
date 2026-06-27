import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { inArray, sql } from "drizzle-orm";

// Real Postgres: buildEnvelope() aggregates instance-wide counts, unions live∪rolled-up webhook
// counts, populates the instance-wide response times, carries a stable hashed identity, and NEVER
// leaks a raw domain, license order id, or any secret env value.

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_URL = "https://secret-real-domain.example.org";

let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let buildEnvelope: typeof import("./collect").buildEnvelope;
let collectMetrics: typeof import("./collect").collectMetrics;

let WS = "", CH_IG = "", CH_FB = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "jwt-secret-value-at-least-32-characters-long-xyz";
  process.env.APP_URL = APP_URL;
  process.env.CRON_SECRET = "cron-secret-value-at-least-32-characters-long-xyz";
  // Secrets that MUST NOT appear anywhere in the serialized envelope.
  process.env.META_APP_SECRET = "meta-app-secret-VALUE-leak-canary-1";
  process.env.AI_API_KEY = "sk-ai-VALUE-leak-canary-2";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret-VALUE-leak-canary-3";
  process.env.STORAGE_SECRET_ACCESS_KEY = "storage-secret-VALUE-leak-canary-4";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ buildEnvelope, collectMetrics } = await import("./collect"));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS].filter(Boolean)));
  await db.delete(schema.telemetryState);
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS]));
  await db.delete(schema.telemetryState);
  WS = await seedWorkspace(db, schema, { slug: `tel-${Math.random().toString(36).slice(2)}` });

  const mk = (platform: "instagram" | "facebook", status: "active" | "needs_reauth") =>
    db.insert(schema.channels).values({
      workspace_id: WS, platform, platform_id: `${platform}-${Math.random()}`,
      connection_mode: "oauth", status,
      token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });

  const [ig] = await mk("instagram", "active");
  const [fb] = await mk("facebook", "needs_reauth");
  CH_IG = ig!.id;
  CH_FB = fb!.id;
});

/** Seed the full surface buildEnvelope counts: contacts, rules, sequences, metrics, webhooks, sends. */
async function seedActivity() {
  await db.insert(schema.contacts).values([
    { workspace_id: WS, display_name: "Person One" },
    { workspace_id: WS, display_name: "Person Two" },
  ]);
  await db.insert(schema.autoReplyRules).values({
    workspace_id: WS, channel_id: CH_IG, name: "rule", trigger_type: "keyword",
  });
  await db.insert(schema.sequences).values({ workspace_id: WS, name: "seq" });

  // Two recent live response_metrics + one rolled-up stats row (older days, already compacted).
  const received = sql`now() - interval '1 day'`;
  await db.insert(schema.responseMetrics).values([
    { workspace_id: WS, channel_id: CH_IG, platform: "instagram", thread_type: "dm", received_at: received, handled_at: received, handling_ms: 1_000, first_response_ms: 2_000, outcome: "answered" },
    { workspace_id: WS, channel_id: CH_IG, platform: "instagram", thread_type: "comment", received_at: received, handled_at: received, handling_ms: 1_500, first_response_ms: null, outcome: "no_match" },
  ]);
  await db.insert(schema.responseMetricStats).values({
    workspace_id: WS, day: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
    platform: "instagram", thread_type: "dm",
    answered_count: 3, total_count: 3, sum_handling_ms: 3_000, count_handling: 3,
    sum_first_response_ms: 9_000, count_first_response: 3, bucket_lt_1m: 3,
  });

  // Live webhook events + rolled-up webhook_event_stats rows → the union total is live + stats.
  // Spread across both platforms so the per-platform breakdown is exercised: instagram 1 live + 5
  // stats = 6, facebook 1 live + 1 stats = 2.
  await db.insert(schema.webhookEvents).values([
    { event_key: `k-${Math.random()}`, event_type: "messages", channel_id: CH_IG, platform: "instagram", handling_status: "fired", raw: { a: 1 }, received_at: sql`now() - interval '2 hours'` },
    { event_key: `k-${Math.random()}`, event_type: "messages", channel_id: CH_FB, platform: "facebook", handling_status: "no_match", raw: { a: 2 }, received_at: sql`now() - interval '2 hours'` },
  ]);
  await db.insert(schema.webhookEventStats).values([
    { channel_id: CH_IG, day: new Date(Date.now() - 80 * 86_400_000).toISOString().slice(0, 10), platform: "instagram", event_type: "messages", handling_status: "fired", count: 5 },
    { channel_id: CH_FB, day: new Date(Date.now() - 80 * 86_400_000).toISOString().slice(0, 10), platform: "facebook", event_type: "messages", handling_status: "fired", count: 1 },
  ]);

  // Outbound deliveries: instagram 2 sent + 1 failed, facebook 1 sent. Only sent count toward
  // messages_sent.total (+3) and the per-platform breakdown (instagram 2, facebook 1).
  await db.insert(schema.outboundDeliveries).values([
    { workspace_id: WS, channel_id: CH_IG, delivery_key: `d-${Math.random()}`, task_name: "outgoing-message", status: "sent", payload: {} },
    { workspace_id: WS, channel_id: CH_IG, delivery_key: `d-${Math.random()}`, task_name: "outgoing-message", status: "sent", payload: {} },
    { workspace_id: WS, channel_id: CH_IG, delivery_key: `d-${Math.random()}`, task_name: "outgoing-message", status: "failed", payload: {} },
    { workspace_id: WS, channel_id: CH_FB, delivery_key: `d-${Math.random()}`, task_name: "outgoing-message", status: "sent", payload: {} },
  ]);

  // Comment logs: facebook 2 with a public reply sent + 1 without, instagram 1 with a reply sent.
  // comments_replied.total (+3); per-platform breakdown facebook 2, instagram 1.
  await db.insert(schema.commentLogs).values([
    { workspace_id: WS, channel_id: CH_FB, platform_comment_id: `c-${Math.random()}`, comment_text: "hi", reply_sent: true },
    { workspace_id: WS, channel_id: CH_FB, platform_comment_id: `c-${Math.random()}`, comment_text: "yo", reply_sent: true },
    { workspace_id: WS, channel_id: CH_FB, platform_comment_id: `c-${Math.random()}`, comment_text: "no reply", reply_sent: false },
    { workspace_id: WS, channel_id: CH_IG, platform_comment_id: `c-${Math.random()}`, comment_text: "hey", reply_sent: true },
  ]);
}

describe("collectMetrics (real Postgres)", () => {
  it("counts the seeded workspace's channels by platform + needs_reauth", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const m = await collectMetrics(db);
    expect(m.workspaces).toBeGreaterThanOrEqual(1);
    expect(m.channels.total).toBeGreaterThanOrEqual(2);
    expect(m.channels.by_platform.instagram).toBeGreaterThanOrEqual(1);
    expect(m.channels.by_platform.facebook).toBeGreaterThanOrEqual(1);
    expect(m.channels.needs_reauth).toBeGreaterThanOrEqual(1);
  });

  it("messages_sent counts only sent deliveries; comments_replied only reply_sent", async () => {
    if (!TEST_DB) return;
    const before = await collectMetrics(db);
    await seedActivity();
    const after = await collectMetrics(db);
    expect(after.messages_sent.total - before.messages_sent.total).toBe(3);
    expect(after.messages_sent.last_24h - before.messages_sent.last_24h).toBe(3);
    expect(after.comments_replied.total - before.comments_replied.total).toBe(3);
  });

  it("messages_sent.by_platform groups sent deliveries by channel platform, summing to total", async () => {
    if (!TEST_DB) return;
    const before = await collectMetrics(db);
    await seedActivity();
    const after = await collectMetrics(db);
    const ig = (after.messages_sent.by_platform.instagram ?? 0) - (before.messages_sent.by_platform.instagram ?? 0);
    const fb = (after.messages_sent.by_platform.facebook ?? 0) - (before.messages_sent.by_platform.facebook ?? 0);
    expect(ig).toBe(2);
    expect(fb).toBe(1);
    // The breakdown sums to the total (no sent delivery is unattributed).
    const sum = Object.values(after.messages_sent.by_platform).reduce((a, n) => a + n, 0);
    expect(sum).toBe(after.messages_sent.total);
  });

  it("comments_replied.by_platform groups replies by channel platform, summing to total", async () => {
    if (!TEST_DB) return;
    const before = await collectMetrics(db);
    await seedActivity();
    const after = await collectMetrics(db);
    const fb = (after.comments_replied.by_platform.facebook ?? 0) - (before.comments_replied.by_platform.facebook ?? 0);
    const ig = (after.comments_replied.by_platform.instagram ?? 0) - (before.comments_replied.by_platform.instagram ?? 0);
    expect(fb).toBe(2);
    expect(ig).toBe(1);
    const sum = Object.values(after.comments_replied.by_platform).reduce((a, n) => a + n, 0);
    expect(sum).toBe(after.comments_replied.total);
  });

  it("webhooks_processed.total reflects the live∪stats union", async () => {
    if (!TEST_DB) return;
    const before = await collectMetrics(db);
    await seedActivity();
    const after = await collectMetrics(db);
    // 2 live events + 6 across the rolled-up stats rows = +8 all-time.
    expect(after.webhooks_processed.total - before.webhooks_processed.total).toBe(8);
    // last_24h counts only the live rows in the window (+2).
    expect(after.webhooks_processed.last_24h - before.webhooks_processed.last_24h).toBe(2);
    expect((after.webhooks_processed.by_status.fired ?? 0) - (before.webhooks_processed.by_status.fired ?? 0)).toBe(7); // ig: 1 live + 5 stats; fb: 1 stats
  });

  it("webhooks_processed.by_platform unions live∪stats per platform, summing to total", async () => {
    if (!TEST_DB) return;
    const before = await collectMetrics(db);
    await seedActivity();
    const after = await collectMetrics(db);
    // instagram: 1 live + 5 stats = +6; facebook: 1 live + 1 stats = +2.
    const ig = (after.webhooks_processed.by_platform.instagram ?? 0) - (before.webhooks_processed.by_platform.instagram ?? 0);
    const fb = (after.webhooks_processed.by_platform.facebook ?? 0) - (before.webhooks_processed.by_platform.facebook ?? 0);
    expect(ig).toBe(6);
    expect(fb).toBe(2);
    // The breakdown sums to ≤ total: an old event whose page→channel was never resolved has a null
    // platform and is unattributed (dropped from the breakdown), so the breakdown can trail the total.
    const sum = Object.values(after.webhooks_processed.by_platform).reduce((a, n) => a + n, 0);
    expect(sum).toBeLessThanOrEqual(after.webhooks_processed.total);
    // The seeded delta, however, is fully attributed: +6 ig +2 fb = +8, matching the total delta.
    expect(sum - Object.values(before.webhooks_processed.by_platform).reduce((a, n) => a + n, 0)).toBe(8);
  });

  it("response_times are populated and instance-wide", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const m = await collectMetrics(db);
    expect(m.response_times.window_days).toBe(30);
    expect(m.response_times.answer_rate_pct).toBeGreaterThan(0);
    expect(typeof m.response_times.by_thread_type).toBe("object");
    expect(m.response_times.by_thread_type.dm).toBeDefined();
  });
});

describe("buildEnvelope (real Postgres)", () => {
  it("returns the full versioned shape with a stable instance_id", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const e1 = await buildEnvelope(db);
    expect(e1.schema_version).toBe(1);
    expect(e1.project).toBe("poststack");
    expect(e1.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e1.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e1.deployment.runtime).toBe("bun");
    expect(e1.metrics.channels.total).toBeGreaterThanOrEqual(2);
    expect(e1.report_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e1.identity).toEqual({ license_tier: null }); // no license configured in this suite

    // instance_id is persisted once and stays the same on a second build.
    const e2 = await buildEnvelope(db);
    expect(e2.instance_id).toBe(e1.instance_id);
  });

  it("identity is anonymous — no domain/license hash, and the raw APP_URL host never appears", async () => {
    if (!TEST_DB) return;
    const e = await buildEnvelope(db);
    expect(e.identity).not.toHaveProperty("domain_hash");
    expect(e.identity).not.toHaveProperty("license_hash");
    const json = JSON.stringify(e);
    // The real domain/host must NOT be in the payload at all (not even hashed).
    expect(json).not.toContain("secret-real-domain.example.org");
    expect(json).not.toContain("secret-real-domain");
  });

  it("secret-scan: no secret env value or PII appears anywhere in the envelope JSON", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const json = JSON.stringify(await buildEnvelope(db));
    const secrets = [
      process.env.JWT_SECRET!,
      process.env.ENCRYPTION_KEY!,
      process.env.CRON_SECRET!,
      process.env.META_APP_SECRET!,
      process.env.AI_API_KEY!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.STORAGE_SECRET_ACCESS_KEY!,
    ];
    for (const s of secrets) expect(json).not.toContain(s);
    // The leak canaries must be absent regardless of which var carried them.
    for (const canary of ["leak-canary-1", "leak-canary-2", "leak-canary-3", "leak-canary-4"]) {
      expect(json).not.toContain(canary);
    }
    // No seeded PII (contact display names) is counted/emitted — only aggregate numbers.
    expect(json).not.toContain("Person One");
    expect(json).not.toContain("Person Two");
    // No raw token material.
    expect(json.toLowerCase()).not.toContain("access_token");
  });
});
