import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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

  it("is a no-op for a missing channel", async () => {
    if (!TEST_DB) return;
    await expect(health.markChannelNeedsReauth("eeeeeeee-0000-0000-0000-0000000000ef", "x")).resolves.toBeUndefined();
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
