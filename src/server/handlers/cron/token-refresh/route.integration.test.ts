import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const CRON = "test-cron-secret-at-least-32-characters-long";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let GET: typeof import("./route").GET;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "cccccccc-0000-4000-8000-0000000000c1";
const CH_BAD = "cccccccc-0000-4000-8000-0000000000c2";
const CH_OK = "cccccccc-0000-4000-8000-0000000000c3";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = CRON;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ GET } = await import("./route"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "C", slug: `c-${WS}` });
  // A near-expiry IG token (inside the 10-day refresh buffer) that decrypts fine.
  const soon = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60;
  await db.insert(s.channels).values([
    // Corrupt token_encrypted: decryptTokens throws — must NOT abort the whole scan.
    { id: CH_BAD, workspace_id: WS, platform: "instagram", platform_id: "PG-BAD", connection_mode: "oauth", token_encrypted: "not-valid-ciphertext", webhook_secret: "s", status: "active" },
    { id: CH_OK, workspace_id: WS, platform: "instagram", platform_id: "PG-OK", connection_mode: "oauth", token_encrypted: encryptTokens({ access_token: "t", expires_at: soon }), webhook_secret: "s", status: "active" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

const req = () => new Request("http://x/api/cron/token-refresh", { headers: { "x-cron-secret": CRON } });

describe("cron token-refresh scan isolation", () => {
  it("one channel's undecryptable token does not starve the others of refresh jobs", async () => {
    if (!TEST_DB) return;
    const res = await GET(req());
    expect(res.status).toBe(200);

    const jobs = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'token-refresh'`);
    // Only the healthy channel was enqueued; the corrupt one was skipped (not a 500, not zero).
    expect(jobs.rows.length).toBe(1);
    expect((jobs.rows[0] as { payload: { channelId: string } }).payload.channelId).toBe(CH_OK);
  });
});
