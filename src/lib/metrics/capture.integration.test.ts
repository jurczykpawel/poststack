import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Mock the network/crypto boundary; the DB is real. Mirrors workers.integration.test.ts.
const provider = {
  requiresTokenRefresh: vi.fn(() => false),
  refreshBufferSeconds: vi.fn(() => 0),
  sendMessage: vi.fn(async () => ({ platformMessageId: "PMID-1" })),
  sendComment: vi.fn(async () => ({ platformMessageId: "CMT-PMID" })),
  sendPrivateReply: vi.fn(async () => ({ platformMessageId: "PR-PMID" })),
  checkFollowsBusiness: vi.fn(async () => true),
  getPostUrl: vi.fn(async (_t: unknown, postId: string) => `https://www.instagram.com/reel/${postId}/`),
  getUserProfile: vi.fn(async () => ({ name: "Jan Testowy", profilePicture: "https://x/a.jpg" })),
  refreshToken: vi.fn(async (t: unknown) => t),
  inboundCapabilities: vi.fn(() => ["dm", "comment", "reaction"]),
};
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));
const decryptTokens = vi.fn(() => ({ access_token: "x" }));
vi.mock("@/lib/crypto", () => ({ decryptTokens, encryptTokens: () => "enc", encryptString: () => "enc", decryptString: (str: string) => str }));
vi.mock("@/lib/channels/health", () => ({ markChannelNeedsReauth: vi.fn(async () => {}), markChannelHealthy: vi.fn(async () => {}) }));
// Sequences are a PRO feature — force it on so the sequence-trigger rule enrolls.
vi.mock("@/lib/license/gate", () => ({ hasFeature: vi.fn(async () => true) }));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let w: {
  processIncomingMessage: typeof import("@/lib/workers/incoming-message-worker").processIncomingMessage;
  processIncomingComment: typeof import("@/lib/workers/incoming-comment-worker").processIncomingComment;
  processOutgoingMessage: typeof import("@/lib/workers/outgoing-message-worker").processOutgoingMessage;
  processSequenceStep: typeof import("@/lib/workers/sequence-step-worker").processSequenceStep;
};
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let recordResponseMetric: typeof import("@/lib/metrics/capture").recordResponseMetric;
let recordFirstResponse: typeof import("@/lib/metrics/capture").recordFirstResponse;

const WS = "dddddddd-0000-0000-0000-0000000000a1";
const CH = "dddddddd-0000-0000-0000-0000000000a2";
const PAGE = "PAGE-M";
const helpers = { logger: { info: () => {} }, job: { id: "job-metrics" } } as never;

const ts = () => Math.floor(Date.now() / 1000);

async function jobCount(task: string) {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = ${task}`);
  return Number((r.rows[0] as { n: number }).n);
}

/** Insert a webhook_events row with an explicit received_at in the past, so handling_ms is a
 *  deterministic, positive value. Returns the event_key the worker should claim against. */
async function loggedAt(key: string, type: string, sender: string, receivedAt: Date) {
  await db.insert(s.webhookEvents).values({
    event_key: key, event_type: type, raw: {}, channel_id: CH, sender_id: sender, received_at: receivedAt,
  });
  return key;
}

async function metricFor(key: string) {
  const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, key), columns: { id: true } });
  if (!ev) return undefined;
  return db.query.responseMetrics.findFirst({ where: eq(s.responseMetrics.trigger_event_id, ev.id) });
}

async function metricsFor(key: string) {
  const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, key), columns: { id: true } });
  if (!ev) return [];
  return db.select().from(s.responseMetrics).where(eq(s.responseMetrics.trigger_event_id, ev.id));
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  w = {
    processIncomingMessage: (await import("@/lib/workers/incoming-message-worker")).processIncomingMessage,
    processIncomingComment: (await import("@/lib/workers/incoming-comment-worker")).processIncomingComment,
    processOutgoingMessage: (await import("@/lib/workers/outgoing-message-worker")).processOutgoingMessage,
    processSequenceStep: (await import("@/lib/workers/sequence-step-worker")).processSequenceStep,
  };
  ({ closeQueue } = await import("@/lib/queue/client"));
  ({ recordResponseMetric, recordFirstResponse } = await import("@/lib/metrics/capture"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  decryptTokens.mockReturnValue({ access_token: "x" });
  provider.requiresTokenRefresh.mockReturnValue(false);
  provider.sendMessage.mockResolvedValue({ platformMessageId: "PMID-1" });
  provider.inboundCapabilities.mockReturnValue(["dm", "comment", "reaction"]);
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.responseMetrics);
  await db.delete(s.webhookEvents);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s", status: "active",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.responseMetrics);
  await db.delete(s.webhookEvents);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

async function seedDmRule(over: Record<string, unknown> = {}) {
  await db.insert(s.autoReplyRules).values({
    workspace_id: WS, name: "DM", trigger_type: "default", is_active: true, cooldown_seconds: 0,
    trigger_config: {}, response_type: "text", response_config: { text: "hi back" }, ...over,
  });
}

describe("response_metrics capture (real Postgres)", () => {
  // 1) Direct keyword reply (DM) → one answered row; after delivery `sent`, first_response_ms is set.
  it("a fired DM writes an answered metric, and delivery fills first_response_ms at sent", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    const received = new Date(Date.now() - 5000);
    const key = await loggedAt("m-fired", "message", "MF", received);
    await w.processIncomingMessage(
      { platform: "facebook", pageId: PAGE, senderId: "MF", recipientId: PAGE, mid: "mf-mid", eventKey: key, text: "hello", timestamp: ts() },
      helpers,
    );

    const metric = await metricFor(key);
    expect(metric).toBeDefined();
    expect(metric!.outcome).toBe("answered");
    expect(metric!.thread_type).toBe("dm");
    expect(metric!.platform).toBe("facebook");
    expect(metric!.workspace_id).toBe(WS);
    expect(metric!.channel_id).toBe(CH);
    expect(metric!.handling_ms).toBeGreaterThanOrEqual(0);
    expect(metric!.first_response_ms).toBeNull();
    expect(metric!.first_sent_at).toBeNull();
    expect(metric!.via_sequence).toBe(false);

    // The reply job carries the stamp; running the delivery to `sent` fills first_response_ms.
    expect(await jobCount("outgoing-message")).toBe(1);
    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const payload = (r.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.measurable).toBe(true);
    expect(payload.triggerEventId).toBeTruthy();

    await w.processOutgoingMessage(payload as never, helpers);

    const after = await metricFor(key);
    expect(after!.first_response_ms).not.toBeNull();
    expect(after!.first_response_ms!).toBeGreaterThanOrEqual(0);
    expect(after!.first_sent_at).not.toBeNull();
  });

  // 2) No-match inbound → no_match row, first_response_ms null.
  it("a no-match DM writes a no_match metric with null first_response_ms", async () => {
    if (!TEST_DB) return;
    const received = new Date(Date.now() - 2000);
    const key = await loggedAt("m-nomatch", "message", "MNM", received);
    await w.processIncomingMessage(
      { platform: "facebook", pageId: PAGE, senderId: "MNM", recipientId: PAGE, mid: "mnm-mid", eventKey: key, text: "nothing", timestamp: ts() },
      helpers,
    );
    const metric = await metricFor(key);
    expect(metric).toBeDefined();
    expect(metric!.outcome).toBe("no_match");
    expect(metric!.first_response_ms).toBeNull();
  });

  // 3) Paused channel inbound → paused row.
  it("a paused-channel DM writes a paused metric", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    const received = new Date(Date.now() - 1500);
    const key = await loggedAt("m-paused", "message", "MP", received);
    await w.processIncomingMessage(
      { platform: "facebook", pageId: PAGE, senderId: "MP", recipientId: PAGE, mid: "mp-mid", eventKey: key, text: "hello", timestamp: ts() },
      helpers,
    );
    const metric = await metricFor(key);
    expect(metric).toBeDefined();
    expect(metric!.outcome).toBe("paused");
    expect(metric!.first_response_ms).toBeNull();
  });

  // 4) Sequence whose step 0 is a message → first response measurable.
  it("a sequence starting with a message → metric via_sequence and first_response_ms is set after the first message sends", async () => {
    if (!TEST_DB) return;
    const [seq] = await db.insert(s.sequences).values({
      workspace_id: WS, name: "Seq", status: "active", steps: [{ type: "message", content: "step one" }, { type: "message", content: "step two" }],
    }).returning({ id: s.sequences.id });
    await seedDmRule({ response_type: "sequence", response_config: { sequence_id: seq.id } });
    const received = new Date(Date.now() - 4000);
    const key = await loggedAt("m-seq-msg", "message", "MSQ", received);
    await w.processIncomingMessage(
      { platform: "facebook", pageId: PAGE, senderId: "MSQ", recipientId: PAGE, mid: "msq-mid", eventKey: key, text: "enroll me", timestamp: ts() },
      helpers,
    );

    const metric = await metricFor(key);
    expect(metric).toBeDefined();
    expect(metric!.outcome).toBe("answered");
    expect(metric!.via_sequence).toBe(true);
    expect(metric!.first_response_ms).toBeNull();

    // Run the first sequence step (step 0 = message): it enqueues a measurable outgoing-message.
    // Drive it from the ACTUAL enqueued step-0 job payload (which carries the trigger stamp), not a
    // hand-built one — that's how the live worker runs it.
    const enr = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.sequence_id, seq.id) });
    const stepJob = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = ${`seq-step:${enr!.id}:0`}`);
    const stepPayload = (stepJob.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(stepPayload.triggerEventId).toBeTruthy();
    await w.processSequenceStep(stepPayload as never, helpers);
    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const payload = (r.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.measurable).toBe(true);
    expect(payload.triggerEventId).toBeTruthy();

    await w.processOutgoingMessage(payload as never, helpers);
    const after = await metricFor(key);
    expect(after!.first_response_ms).not.toBeNull();
    expect(after!.first_sent_at).not.toBeNull();
  });

  // 5) Sequence whose step 0 is a delay → first message is NOT measurable; metric stays unset.
  it("a sequence starting with a delay → first message is not measurable, first_response_ms stays null", async () => {
    if (!TEST_DB) return;
    const [seq] = await db.insert(s.sequences).values({
      workspace_id: WS, name: "SeqDelay", status: "active", steps: [{ type: "delay", delay_minutes: 0 }, { type: "message", content: "after delay" }],
    }).returning({ id: s.sequences.id });
    await seedDmRule({ response_type: "sequence", response_config: { sequence_id: seq.id } });
    const received = new Date(Date.now() - 3000);
    const key = await loggedAt("m-seq-delay", "message", "MSD", received);
    await w.processIncomingMessage(
      { platform: "facebook", pageId: PAGE, senderId: "MSD", recipientId: PAGE, mid: "msd-mid", eventKey: key, text: "enroll me", timestamp: ts() },
      helpers,
    );

    const metric = await metricFor(key);
    expect(metric!.outcome).toBe("answered");
    expect(metric!.via_sequence).toBe(true);
    expect(metric!.first_response_ms).toBeNull();

    // Drive each step from its real enqueued job payload (keyed `seq-step:<enr>:<idx>`). The step-0
    // job (a delay) carries the stamp; the step-1 job the worker schedules does NOT.
    const enr = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.sequence_id, seq.id) });
    const stepJobByKey = async (idx: number) => {
      const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = ${`seq-step:${enr!.id}:${idx}`}`);
      return (r.rows[0] as { payload: Record<string, unknown> }).payload;
    };
    const step0 = await stepJobByKey(0);
    expect(step0.triggerEventId).toBeTruthy(); // step 0 (a delay) still carries the stamp
    await w.processSequenceStep(step0 as never, helpers);
    // Step 1 = message: enqueues an outgoing-message — but NOT measurable (the step-1 job has no stamp).
    const step1 = await stepJobByKey(1);
    expect(step1.triggerEventId).toBeUndefined();
    await w.processSequenceStep(step1 as never, helpers);
    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    expect(r.rows.length).toBe(1);
    const payload = (r.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.measurable).not.toBe(true);

    await w.processOutgoingMessage(payload as never, helpers);
    const after = await metricFor(key);
    expect(after!.first_response_ms).toBeNull();
    expect(after!.first_sent_at).toBeNull();
  });

  // 6) Idempotency: redelivery → exactly one row; a second send does not overwrite first_response_ms.
  it("redelivery keeps exactly one metric row and the first send wins first_response_ms", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    const received = new Date(Date.now() - 6000);
    const key = await loggedAt("m-idem", "message", "MID", received);
    const job = { platform: "facebook", pageId: PAGE, senderId: "MID", recipientId: PAGE, mid: "mid-idem", eventKey: key, text: "hello", timestamp: ts() };
    await w.processIncomingMessage(job, helpers);
    await w.processIncomingMessage(job, helpers); // redelivery — must not create a second metric row

    expect((await metricsFor(key)).length).toBe(1);

    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const payload = (r.rows[0] as { payload: Record<string, unknown> }).payload;
    await w.processOutgoingMessage(payload as never, helpers);
    const firstValue = (await metricFor(key))!.first_response_ms;
    const firstSentAt = (await metricFor(key))!.first_sent_at;
    expect(firstValue).not.toBeNull();

    // A second send for the same trigger (later sequence message / a retry) must NOT overwrite the
    // first value — first-write-wins via the `first_response_ms IS NULL` guard. A distinct PMID keeps
    // the outbound message insert unique.
    provider.sendMessage.mockResolvedValueOnce({ platformMessageId: "PMID-2" });
    const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, key), columns: { id: true, received_at: true } });
    await w.processOutgoingMessage(
      {
        channelId: CH, conversationId: payload.conversationId, contactId: payload.contactId, recipientPlatformId: "MID",
        content: { text: "second" }, idempotencyKey: "second-send",
        triggerEventId: ev!.id, triggerReceivedAt: ev!.received_at.toISOString(), measurable: true,
      } as never,
      helpers,
    );
    const afterSecond = await metricFor(key);
    expect(afterSecond!.first_response_ms).toBe(firstValue);
    expect(afterSecond!.first_sent_at!.getTime()).toBe(firstSentAt!.getTime());
  });

  // 7) An event with no conversation context (no eventKey, no thread) is out of scope — no row.
  it("does not write a metric when no conversation/thread context is derivable", async () => {
    if (!TEST_DB) return;
    // A comment with no commenter id resolves no contact/conversation and is only logged.
    const key = await loggedAt("m-nocontext", "comment", "", new Date(Date.now() - 1000));
    await w.processIncomingComment(
      { platform: "facebook", pageId: PAGE, commentId: "cmt-noctx", postId: "p", senderId: undefined, senderName: undefined, text: "hi", eventKey: key, timestamp: ts() },
      helpers,
    );
    expect((await metricsFor(key)).length).toBe(0);
  });

  // A fired comment writes a metric with thread_type=comment.
  it("a fired comment writes an answered metric with thread_type=comment", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "C", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { post_id: "p-cmt" }, response_type: "text",
      response_config: { text: "x", reply_mode: "comment", comment_reply_text: "thanks!" },
    });
    const received = new Date(Date.now() - 2500);
    const key = await loggedAt("m-cmt-fired", "comment", "MCF", received);
    await w.processIncomingComment(
      { platform: "facebook", pageId: PAGE, commentId: "cmt-fired", postId: "p-cmt", senderId: "MCF", senderName: "Fan", text: "anything", eventKey: key, timestamp: ts() },
      helpers,
    );
    const metric = await metricFor(key);
    expect(metric).toBeDefined();
    expect(metric!.outcome).toBe("answered");
    expect(metric!.thread_type).toBe("comment");
  });
});

describe("recordFirstResponse first-write-wins under concurrency (real Postgres)", () => {
  // Two sends for the same trigger land at the same instant: only the first measurable write may set
  // first_response_ms, and once set it must never flip. The `first_response_ms IS NULL` guard has to
  // hold even when both updates run concurrently (Promise.all) against the one metric row.
  it("two concurrent sends with different timestamps leave exactly one non-null first_response_ms that never flips", async () => {
    if (!TEST_DB) return;
    const received = new Date(Date.now() - 10_000);
    const key = await loggedAt("m-race", "message", "MR", received);
    // Seed the metric row exactly as a terminal handling claim would (id/received_at copied off the event).
    const recorded = await recordResponseMetric(db, {
      eventKey: key, workspaceId: WS, channelId: CH, platform: "facebook", threadType: "dm", status: "fired",
    });
    expect(recorded).not.toBeNull();
    expect((await metricFor(key))!.first_response_ms).toBeNull();

    // Two distinct send timestamps → two distinct candidate latencies. Whichever update wins the race
    // sets the value; the other's guard (first_response_ms IS NULL) sees a filled row and is a no-op.
    const early = new Date(received.getTime() + 1_000); // first_response_ms candidate = 1000
    const late = new Date(received.getTime() + 5_000); //  first_response_ms candidate = 5000
    await Promise.all([
      recordFirstResponse(db, { triggerEventId: recorded!.triggerEventId, triggerReceivedAt: received, sentAt: early }),
      recordFirstResponse(db, { triggerEventId: recorded!.triggerEventId, triggerReceivedAt: received, sentAt: late }),
    ]);

    // Exactly one row, with a single non-null latency that is one of the two candidates.
    const rows = await metricsFor(key);
    expect(rows.length).toBe(1);
    const settled = rows[0]!.first_response_ms;
    expect(settled).not.toBeNull();
    expect([1_000, 5_000]).toContain(settled);
    const settledSentAt = rows[0]!.first_sent_at;
    expect(settledSentAt).not.toBeNull();

    // A further send for the same trigger must NOT flip the already-settled value.
    await recordFirstResponse(db, { triggerEventId: recorded!.triggerEventId, triggerReceivedAt: received, sentAt: new Date(received.getTime() + 9_000) });
    const after = await metricFor(key);
    expect(after!.first_response_ms).toBe(settled);
    expect(after!.first_sent_at!.getTime()).toBe(settledSentAt!.getTime());
  });
});
