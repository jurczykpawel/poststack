import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let health: typeof import("./health");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000e1";
const CH = "eeeeeeee-0000-0000-0000-0000000000e2";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  health = await import("./health");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "H", slug: `h-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-H",
    display_name: "My IG", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "s", status: "active",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

async function status(): Promise<{ status: string; last_error: string | null } | undefined> {
  return db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { status: true, last_error: true } });
}

describe("channel health (real Postgres)", () => {
  it("flags needs_reauth with the error, truncated to 500 chars", async () => {
    if (!TEST_DB) return;
    await health.markChannelNeedsReauth(CH, "x".repeat(1000));
    const c = await status();
    expect(c?.status).toBe("needs_reauth");
    expect(c?.last_error?.length).toBe(500);
  });

  it("emits a channel.needs_reauth event once, only on the healthy→down transition", async () => {
    if (!TEST_DB) return;
    await health.markChannelNeedsReauth(CH, "token dead");
    await health.markChannelNeedsReauth(CH, "still dead"); // already down → no second event
    const evts = await db.query.events.findMany({ where: eq(s.events.subject_id, CH) });
    expect(evts.map((e) => e.type)).toEqual(["channel.needs_reauth"]);
  });

  it("is a no-op for a missing channel", async () => {
    if (!TEST_DB) return;
    await expect(health.markChannelNeedsReauth("eeeeeeee-0000-0000-0000-0000000000ef", "x")).resolves.toBeUndefined();
  });

  // PSA13: a secret embedded in an upstream error string must be stripped before it lands in the
  // persisted last_error / needs_reauth_reason (both named redaction targets).
  it("redacts a token-like secret in the reason before persisting", async () => {
    if (!TEST_DB) return;
    await health.markChannelNeedsReauth(CH, "refresh failed: access_token=EAABSUPERSECRET123 -> 400");
    const c = await db.query.channels.findFirst({
      where: eq(s.channels.id, CH),
      columns: { last_error: true, needs_reauth_reason: true },
    });
    expect(c?.last_error).toContain("access_token=[REDACTED]");
    expect(c?.last_error).not.toContain("EAABSUPERSECRET123");
    expect(c?.needs_reauth_reason).toContain("access_token=[REDACTED]");
    expect(c?.needs_reauth_reason).not.toContain("EAABSUPERSECRET123");
  });

  // PSA13: the redaction must also reach the DISPATCHED alert `detail` — not only the persisted
  // columns. A secret echoed into the alert body would leak to whatever the operator's webhook routes
  // to (Slack/email/n8n). Intercept the outbound POST and assert the detail is redacted.
  it("redacts a token-like secret in the DISPATCHED alert detail, not just the DB columns", async () => {
    if (!TEST_DB) return;
    // The alert throttle is a real, persisted per-(type,channel) bucket; clear ours so this assertion
    // doesn't depend on whether a prior run/test already consumed the window for this channel.
    await db.execute(sql`delete from rate_limit_counters where key = ${"alert:channel_reauth:" + CH}`);
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://example.com/alert-hook";
    const realFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await health.markChannelNeedsReauth(CH, "refresh failed: access_token=EAABSUPERSECRET123 -> 400");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
    }
    const alert = bodies.find((b) => b.channel_id === CH);
    expect(alert).toBeDefined();
    expect(String(alert!.detail)).toContain("access_token=[REDACTED]");
    expect(String(alert!.detail)).not.toContain("EAABSUPERSECRET123");
  });

  it("recovering from needs_reauth sets active and enqueues a drain", async () => {
    if (!TEST_DB) return;
    await health.markChannelNeedsReauth(CH, "dead");
    await health.markChannelHealthy(CH);
    const c = await status();
    expect(c?.status).toBe("active");
    expect(c?.last_error).toBeNull();
    const jobs = await db.execute(sql`select task_identifier from graphile_worker.jobs where task_identifier = 'drain-channel'`);
    expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT enqueue a drain when the channel was already active", async () => {
    if (!TEST_DB) return;
    await health.markChannelHealthy(CH);
    const jobs = await db.execute(sql`select 1 from graphile_worker.jobs where task_identifier = 'drain-channel'`);
    expect(jobs.rows.length).toBe(0);
  });

  // a successful health check / refresh must not undo a manual pause.
  it("does not un-pause a manually paused channel", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await health.markChannelHealthy(CH);
    expect((await status())?.status).toBe("paused");
  });
});
