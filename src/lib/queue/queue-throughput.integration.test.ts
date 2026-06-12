import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { run, makeWorkerUtils, runMigrations, type Runner, type WorkerUtils } from "graphile-worker";

// Mock the network/crypto boundary; the queue + DB are real.
const provider = {
  requiresTokenRefresh: vi.fn(() => false),
  refreshBufferSeconds: vi.fn(() => 0),
  sendMessage: vi.fn(async () => ({ platformMessageId: "PMID" })),
  sendComment: vi.fn(async () => ({})),
  sendPrivateReply: vi.fn(async () => {}),
  refreshToken: vi.fn(async (t: unknown) => t),
};
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));
vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }), encryptTokens: () => "enc", encryptString: () => "enc", decryptString: (s: string) => s }));

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let createTaskList: typeof import("./tasks").createTaskList;
let utils: WorkerUtils;
let closeQueue: typeof import("./client").closeQueue;
const runners: Runner[] = [];

const WS = "eeeeeeee-0000-0000-0000-0000000000c1";
const CH = "eeeeeeee-0000-0000-0000-0000000000c2";
const CONTACT = "eeeeeeee-0000-0000-0000-0000000000c3";
const CONV = "eeeeeeee-0000-0000-0000-0000000000c4";
const PAGE = "PAGE-Q";

async function pendingJobs(): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs`);
  return Number((r.rows[0] as { n: number }).n);
}

async function jobCount(task: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = ${task}`);
  return Number((r.rows[0] as { n: number }).n);
}

/** Start a runner and register it for teardown. */
async function startRunner(taskList: Record<string, (p: unknown, h: unknown) => unknown>, concurrency = 10): Promise<Runner> {
  const runner = await run({ connectionString: TEST_DB!, concurrency, pollInterval: 100, taskList: taskList as never });
  runners.push(runner);
  return runner;
}

/** Wait until the queue has fully drained (all jobs succeeded → removed). */
async function waitForDrain(timeout = 30_000): Promise<void> {
  await vi.waitFor(async () => expect(await pendingJobs()).toBe(0), { timeout, interval: 100 });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ createTaskList } = await import("./tasks"));
  ({ closeQueue } = await import("./client"));
  utils = await makeWorkerUtils({ connectionString: TEST_DB });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  provider.sendMessage.mockResolvedValue({ platformMessageId: "PMID" });
  provider.requiresTokenRefresh.mockReturnValue(false);
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.instanceLicense); // a license row leaked from another file would make the real worker decrypt + flip PRO behavior
  await db.delete(s.webhookEvents); // event log + inbound dedup — clear so re-runs re-process events
  await db.delete(s.outboundDeliveries); // delivery ledger (outbound dedup) — clear so re-runs are deterministic
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "Q", slug: `q-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE, token_encrypted: "enc", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-Q" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open" });
});

afterEach(async () => {
  // Stop any runner started by the test so it stops polling the shared queue.
  while (runners.length) {
    const r = runners.pop()!;
    await r.stop().catch(() => {});
  }
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (utils) await utils.release();
  if (closeQueue) await closeQueue();
});

describe("queue throughput & drain (real Postgres + real graphile runner)", () => {
  it("drains a full batch of 150 jobs exactly once, with nothing left in the queue", async () => {
    if (!TEST_DB) return;
    const N = 150;
    const seen = new Set<number>();
    let processed = 0;
    for (let i = 0; i < N; i++) await utils.addJob("perf-noop", { i }, { maxAttempts: 1 });
    expect(await jobCount("perf-noop")).toBe(N);

    const started = Date.now();
    await startRunner({ "perf-noop": (p) => { seen.add((p as { i: number }).i); processed++; } }, 10);
    await waitForDrain();
    const elapsed = Date.now() - started;

    expect(processed).toBe(N);          // every job ran
    expect(seen.size).toBe(N);          // each exactly once (no double-processing)
    expect(await pendingJobs()).toBe(0); // queue fully drained
    console.log(`[perf] drained ${N} jobs in ${elapsed}ms (~${Math.round((N / elapsed) * 1000)} jobs/s, concurrency 10)`);
  });

  it("loses no jobs when many are enqueued concurrently", async () => {
    if (!TEST_DB) return;
    const N = 80;
    let processed = 0;
    await Promise.all(Array.from({ length: N }, (_, i) => utils.addJob("perf-noop", { i }, { maxAttempts: 1 })));
    expect(await jobCount("perf-noop")).toBe(N);

    await startRunner({ "perf-noop": () => { processed++; } }, 8);
    await waitForDrain();

    expect(processed).toBe(N);
    expect(await pendingJobs()).toBe(0);
  });

  it("retries a transient failure and eventually succeeds (job not lost)", async () => {
    if (!TEST_DB) return;
    let attempts = 0;
    await utils.addJob("perf-flaky", {}, { maxAttempts: 3 });

    await startRunner({
      "perf-flaky": () => {
        attempts++;
        if (attempts < 2) throw new Error("transient");
      },
    }, 1);
    await waitForDrain();

    expect(attempts).toBeGreaterThanOrEqual(2); // failed once, retried, then succeeded
    expect(await pendingJobs()).toBe(0);        // ultimately drained, not stuck
  });

  it("dead-letters a job after exhausting its attempts (retained, not silently dropped)", async () => {
    if (!TEST_DB) return;
    await utils.addJob("perf-poison", {}, { maxAttempts: 1 }); // 1 attempt → no backoff wait
    await utils.addJob("perf-noop", { i: 1 }, { maxAttempts: 1 });
    let goodProcessed = 0;

    await startRunner({
      "perf-poison": () => { throw new Error("always fails"); },
      "perf-noop": () => { goodProcessed++; },
    }, 5);

    // The healthy job drains; the poison job stays as a permanently-failed row.
    await vi.waitFor(async () => {
      const dead = await db.execute(sql`select attempts, max_attempts, last_error from graphile_worker.jobs where task_identifier = 'perf-poison'`);
      expect(dead.rows).toHaveLength(1);
      const row = dead.rows[0] as { attempts: number; max_attempts: number; last_error: string | null };
      expect(row.attempts).toBe(row.max_attempts); // exhausted
      expect(row.last_error).toBeTruthy();          // error preserved for inspection
    }, { timeout: 15_000, interval: 100 });

    expect(goodProcessed).toBe(1); // a poison pill does not block the rest of the queue
    // The exhausted poison row is left for inspection; beforeEach truncates it next run.
  });

  it("idempotency: a re-delivered outgoing-message sends to the provider only once", async () => {
    if (!TEST_DB) return;
    const key = "idem-dup-1";
    // Two separate jobs sharing one idempotency key (a retry / duplicate delivery).
    await utils.addJob("outgoing-message", { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: "PSID-Q", content: { text: "hi" }, idempotencyKey: key }, { maxAttempts: 1 });
    await startRunner(createTaskList() as never, 1);
    await waitForDrain();
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);

    // A second delivery with the same key after the first claimed it → no send.
    provider.sendMessage.mockClear();
    await utils.addJob("outgoing-message", { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: "PSID-Q", content: { text: "hi" }, idempotencyKey: key }, { maxAttempts: 1 });
    await waitForDrain();
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  it("full pipeline drains: incoming-message → rule fires → outgoing-message sent, queue empty", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, channel_id: null, name: "Hi", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hello", match_type: "contains" }] },
      trigger_type: "keyword", response_type: "text", response_config: { text: "auto!" },
    });

    await utils.addJob("incoming-message", {
      platform: "facebook", pageId: PAGE, senderId: "PSID-Q", recipientId: PAGE,
      mid: "mid-pipeline", text: "hello there", timestamp: Math.floor(Date.now() / 1000),
    });

    await startRunner(createTaskList() as never, 10);
    // Both stages must drain: incoming-message enqueues outgoing-message, which then also runs.
    await waitForDrain();

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const sent = await db.select().from(s.messages).where(eq(s.messages.conversation_id, CONV));
    expect(sent.some((m) => m.direction === "outbound" && m.status === "sent")).toBe(true);
    expect(await pendingJobs()).toBe(0);
  });
});
