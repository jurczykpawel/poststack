import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Mock the network/crypto boundary; the DB is real.
const provider = {
  requiresTokenRefresh: vi.fn(() => false),
  refreshBufferSeconds: vi.fn(() => 0),
  sendMessage: vi.fn(async () => ({ platformMessageId: "PMID-1" })),
  sendComment: vi.fn(async () => ({})),
  sendPrivateReply: vi.fn(async () => {}),
  checkFollowsBusiness: vi.fn(async () => true),
  refreshToken: vi.fn(async (t: unknown) => t),
};
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));
vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }), encryptTokens: () => "enc" }));
const health = { markChannelNeedsReauth: vi.fn(async () => {}), markChannelHealthy: vi.fn(async () => {}) };
vi.mock("@/lib/channels/health", () => health);

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let w: {
  processIncomingMessage: typeof import("./incoming-message-worker").processIncomingMessage;
  processIncomingComment: typeof import("./incoming-comment-worker").processIncomingComment;
  processIncomingReaction: typeof import("./incoming-reaction-worker").processIncomingReaction;
  processOutgoingMessage: typeof import("./outgoing-message-worker").processOutgoingMessage;
  processOutgoingComment: typeof import("./outgoing-comment-worker").processOutgoingComment;
  processOutgoingPrivateReply: typeof import("./outgoing-private-reply-worker").processOutgoingPrivateReply;
  processFollowGate: typeof import("./follow-gate-worker").processFollowGate;
  processSequenceStep: typeof import("./sequence-step-worker").processSequenceStep;
  processTokenRefresh: typeof import("./token-refresh-worker").processTokenRefresh;
};
let TokenInvalidError: typeof import("@/lib/platforms/errors").TokenInvalidError;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000f1";
const CH = "eeeeeeee-0000-0000-0000-0000000000f2";
const CONTACT = "eeeeeeee-0000-0000-0000-0000000000f3";
const CONV = "eeeeeeee-0000-0000-0000-0000000000f4";
const PAGE = "PAGE-W";
const PSID = "PSID-W";
const helpers = { logger: { info: () => {} }, job: { id: "job-test" } } as never;

async function jobCount(task: string) {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = ${task}`);
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  w = {
    processIncomingMessage: (await import("./incoming-message-worker")).processIncomingMessage,
    processIncomingComment: (await import("./incoming-comment-worker")).processIncomingComment,
    processIncomingReaction: (await import("./incoming-reaction-worker")).processIncomingReaction,
    processOutgoingMessage: (await import("./outgoing-message-worker")).processOutgoingMessage,
    processOutgoingComment: (await import("./outgoing-comment-worker")).processOutgoingComment,
    processOutgoingPrivateReply: (await import("./outgoing-private-reply-worker")).processOutgoingPrivateReply,
    processFollowGate: (await import("./follow-gate-worker")).processFollowGate,
    processSequenceStep: (await import("./sequence-step-worker")).processSequenceStep,
    processTokenRefresh: (await import("./token-refresh-worker")).processTokenRefresh,
  };
  ({ TokenInvalidError } = await import("@/lib/platforms/errors"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  provider.requiresTokenRefresh.mockReturnValue(false);
  provider.sendMessage.mockResolvedValue({ platformMessageId: "PMID-1" });
  provider.refreshToken.mockImplementation(async (t: unknown) => t);
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  // Idempotency/event claims are shared, un-workspace-scoped stores; clear both so
  // reaction-dedup / event keys don't survive into a re-run of this suite.
  await db.delete(s.idempotencyKeys);
  await db.delete(s.processedEvents);
  // sequence_enrollments.channel_id has no cascade — remove before the workspace.
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "W", slug: `w-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s", status: "active",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: PSID });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

const ts = () => Math.floor(Date.now() / 1000);

describe("incoming-message worker (real Postgres)", () => {
  it("stores an inbound message for a new sender and dedups by mid", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "NEW-PSID", recipientId: PAGE, mid: "mid-w1", text: "hi", timestamp: ts(), raw: {} };
    await w.processIncomingMessage(job as never, helpers);
    await w.processIncomingMessage(job as never, helpers); // dedup
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "mid-w1"));
    expect(msgs.length).toBe(1);
    expect(msgs[0].direction).toBe("inbound");
  });

  it("deduplicates per conversation, not globally — the same id in two conversations is stored once each", async () => {
    if (!TEST_DB) return;
    // Two different senders on the same page resolve to two different
    // conversations. A message id only deduplicates within its own conversation,
    // so a shared id must not let one conversation suppress another's message.
    const SHARED = "shared-message-id";
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "SENDER-A", recipientId: PAGE, mid: SHARED, text: "a", timestamp: ts(), raw: {} } as never, helpers);
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "SENDER-B", recipientId: PAGE, mid: SHARED, text: "b", timestamp: ts(), raw: {} } as never, helpers);
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, SHARED));
    expect(msgs.length).toBe(2);
  });

  it("skips when no channel matches the page", async () => {
    if (!TEST_DB) return;
    await expect(
      w.processIncomingMessage({ platform: "facebook", pageId: "NOPE", senderId: "x", recipientId: "y", mid: "m", text: "t", timestamp: ts(), raw: {} } as never, helpers),
    ).resolves.toBeUndefined();
  });

  it("retries a DM rule whose first reply enqueue failed — not lost to the message dedup", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "DM", trigger_type: "default", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "hi back" },
    });
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("enqueue down"));
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-RETRY", recipientId: PAGE, mid: "mid-dmretry", text: "hello", timestamp: ts(), raw: {} };
      // First delivery: message is stored, then the reply enqueue fails. The worker must
      // surface the error (retry) instead of swallowing it behind the committed message.
      await expect(w.processIncomingMessage(job as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the message is already stored (deduped), but the rule must still fire once.
      await w.processIncomingMessage(job as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      // Redelivery after success: no duplicate reply.
      await w.processIncomingMessage(job as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  //  — a permanently-lost DM auto-reply must surface to the operator.
  const helpersJob = (attempts: number, max_attempts: number) =>
    ({ logger: { info: () => {} }, job: { attempts, max_attempts } } as never);
  async function convFlag(sender: string) {
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, sender));
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    return conv.needs_manual_reply;
  }
  async function seedDefaultDmRule() {
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "DM", trigger_type: "default", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "hi" },
    });
  }

  it("flags the conversation for manual reply when a DM auto-reply fails on its final attempt", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValue(new Error("permanent"));
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-LAST", recipientId: PAGE, mid: "mid-last", text: "hello", timestamp: ts(), raw: {} };
      await expect(w.processIncomingMessage(job as never, helpersJob(3, 3))).rejects.toThrow();
      expect(await convFlag("DM-LAST")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not flag the conversation on a non-final failed attempt (still retrying)", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValue(new Error("transient"));
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-MID", recipientId: PAGE, mid: "mid-mid", text: "hello", timestamp: ts(), raw: {} };
      await expect(w.processIncomingMessage(job as never, helpersJob(1, 3))).rejects.toThrow();
      expect(await convFlag("DM-MID")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves the manual-reply flag false when a transient DM failure then succeeds on retry", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("transient"));
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-OK", recipientId: PAGE, mid: "mid-ok", text: "hello", timestamp: ts(), raw: {} };
      await expect(w.processIncomingMessage(job as never, helpersJob(1, 3))).rejects.toThrow(); // attempt 1 fails
      await w.processIncomingMessage(job as never, helpersJob(2, 3)); // attempt 2 succeeds
      expect(await jobCount("outgoing-message")).toBe(1);
      expect(await convFlag("DM-OK")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  //  — a no-match / paused event is terminally claimed, so a later redelivery
  // (after a rule is added or after unpause) does not produce a late reply to an old event.
  it("a no-match DM is terminally claimed — adding a rule then redelivering does not reply late", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "-NM", recipientId: PAGE, mid: "mid-nm", text: "hello", timestamp: ts(), raw: {} };
    await w.processIncomingMessage(job as never, helpers); // no rule yet → no-match, claimed
    expect(await jobCount("outgoing-message")).toBe(0);
    await seedDefaultDmRule(); // operator adds a matching rule
    await w.processIncomingMessage(job as never, helpers); // redelivery of the SAME event
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  it("a paused DM is terminally claimed — unpausing then redelivering does not reply late", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_P = "eeeeeeee-0000-0000-0000-0000000aa001";
    await db.insert(s.contacts).values({ id: CONTACT_P, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_P, channel_id: CH, platform_sender_id: "-PAUSE" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_P, platform: "facebook", is_automation_paused: true });
    const job = { platform: "facebook", pageId: PAGE, senderId: "-PAUSE", recipientId: PAGE, mid: "mid-pause", text: "hello", timestamp: ts(), raw: {} };
    await w.processIncomingMessage(job as never, helpers); // paused → claim + skip
    expect(await jobCount("outgoing-message")).toBe(0);
    await db.update(s.conversations).set({ is_automation_paused: false }).where(eq(s.conversations.contact_id, CONTACT_P));
    await w.processIncomingMessage(job as never, helpers); // redelivery after unpause
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  //  — two parallel deliveries of the same new DM: the worker that loses the claim
  // race must read "already handled" (not no-match) and not flag a conversation the winner
  // just auto-replied to.
  it("two parallel deliveries of the same DM → exactly one reply and needs_manual_reply stays false", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_R = "eeeeeeee-0000-0000-0000-0000000aa002";
    // Pre-seed identity so both deliveries race only on the message/claim, not contact creation.
    await db.insert(s.contacts).values({ id: CONTACT_R, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_R, channel_id: CH, platform_sender_id: "-RACE" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_R, platform: "facebook" });
    const job = { platform: "facebook", pageId: PAGE, senderId: "-RACE", recipientId: PAGE, mid: "mid-race", text: "hello", timestamp: ts(), raw: {} };
    await Promise.all([
      w.processIncomingMessage(job as never, helpers),
      w.processIncomingMessage(job as never, helpers),
    ]);
    expect(await jobCount("outgoing-message")).toBe(1);
    expect(await convFlag("-RACE")).toBe(false);
  });

  //  — a stale final-failure of an old message must not re-raise the flag on a
  // conversation a newer message already resolved.
  it("an old DM's final-failure does not overwrite a conversation a newer message resolved", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const SENDER = "";
    const OLD_TS = 1_770_000_900;
    const NEW_TS = 1_770_001_000;
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx");
    spy.mockRejectedValueOnce(new Error("transient")); // old msg, attempt 1: fails (non-final)
    spy.mockResolvedValueOnce(undefined); // newer msg: auto-reply succeeds, resolves the conversation
    spy.mockRejectedValue(new Error("permanent")); // old msg, final attempt: fails for good
    try {
      const oldJob = { platform: "facebook", pageId: PAGE, senderId: SENDER, recipientId: PAGE, mid: "mid-old", text: "hello", timestamp: OLD_TS, raw: {} };
      await expect(w.processIncomingMessage(oldJob as never, helpersJob(1, 3))).rejects.toThrow();
      const newJob = { ...oldJob, mid: "mid-new", timestamp: NEW_TS };
      await w.processIncomingMessage(newJob as never, helpers); // newer message resolves it → flag false
      expect(await convFlag(SENDER)).toBe(false);
      await expect(w.processIncomingMessage(oldJob as never, helpersJob(3, 3))).rejects.toThrow(); // old final fail
      expect(await convFlag(SENDER)).toBe(false); // not re-raised by the stale retry
    } finally {
      spy.mockRestore();
    }
  });

  //  — the durable event claim must outlive the ephemeral idempotency-keys prune,
  // so an old webhook redelivery can't fire a second/late reply after maintenance runs.
  it("a processed event stays deduped after the operational TTL store is pruned", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const { pruneExpired } = await import("@/lib/maintenance");
    const job = { platform: "facebook", pageId: PAGE, senderId: "", recipientId: PAGE, mid: "mid-22", text: "hello", timestamp: ts(), raw: {} };
    await w.processIncomingMessage(job as never, helpers); // fires + durably records the event
    expect(await jobCount("outgoing-message")).toBe(1);
    // Maintenance prunes the ephemeral idempotency_keys store (and any TTL'd row).
    await pruneExpired(new Date(Date.now() + 100 * 86_400_000));
    expect((await db.select().from(s.idempotencyKeys)).length).toBe(0);
    expect((await db.select().from(s.processedEvents)).length).toBeGreaterThan(0); // event claim survives
    // Redelivery after the prune must not reply again.
    await w.processIncomingMessage(job as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  //  — an out-of-order older message must not move conversation activity backwards.
  it("an out-of-order older message does not move conversation activity backwards", async () => {
    if (!TEST_DB) return;
    const T2 = ts();
    const T1 = T2 - 3600; // an hour older, but ingested second
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "", recipientId: PAGE, mid: "m-t2", text: "newer", timestamp: T2, raw: {} } as never, helpers);
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "", recipientId: PAGE, mid: "m-t1", text: "older", timestamp: T1, raw: {} } as never, helpers);
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, ""));
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.last_message_at?.getTime()).toBe(T2 * 1000);
    expect(conv.last_inbound_at?.getTime()).toBe(T2 * 1000);
    expect(conv.last_message_preview).toBe("newer");
  });

  //  — a duplicate DM must dedup before mutating lifecycle (no reopen / no reorder).
  it("a duplicate DM does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "-DM", recipientId: PAGE, mid: "m-dup", text: "hi", timestamp: ts(), raw: {} };
    await w.processIncomingMessage(job as never, helpers); // creates conversation
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "-DM"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    await w.processIncomingMessage(job as never, helpers); // redelivery of the SAME message
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.status).toBe("closed");
    expect(conv.last_message_at?.getTime()).toBe(past.getTime());
  });

  //  — a new DM that arrives while automation is paused must surface for a human.
  it("a new DM on a paused conversation flags it for manual attention", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_P = "eeeeeeee-0000-0000-0000-0000000aa026";
    await db.insert(s.contacts).values({ id: CONTACT_P, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_P, channel_id: CH, platform_sender_id: "" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_P, platform: "facebook", is_automation_paused: true });
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "", recipientId: PAGE, mid: "m-26", text: "hello", timestamp: ts(), raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(0); // paused → no auto-reply
    expect(await convFlag("")).toBe(true); // but surfaced for a human
  });

  //  — a manually paused CHANNEL ingests to the inbox but runs no automation.
  it("a manually paused channel ingests a DM but runs no automation", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "", recipientId: PAGE, mid: "m-40", text: "hello", timestamp: ts(), raw: {} } as never, helpers);
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "m-40"));
    expect(msgs.length).toBe(1); // still ingested to the inbox
    expect(await jobCount("outgoing-message")).toBe(0); // but no auto-reply
    expect(await convFlag("")).toBe(true); // surfaced for a human
  });
});

describe("incoming-comment worker", () => {
  it("logs a comment and dedups by (channel, comment id)", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-w1", postId: "post-1", senderId: PSID, senderName: "A", text: "hello", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);
    await w.processIncomingComment(job as never, helpers);
    const logs = await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-w1"));
    expect(logs.length).toBe(1);
  });

  it("routes to the channel matching the event platform, not a same-id channel on another platform", async () => {
    if (!TEST_DB) return;
    const IG_CH = "eeeeeeee-0000-0000-0000-0000000000fc";
    await db.insert(s.channels).values({ id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s2", status: "active" });
    const job = { platform: "instagram", pageId: PAGE, commentId: "cmt-ig", postId: "m1", senderId: "IG-COMMENTER", senderName: "Iga", text: "hi", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);
    const onIg = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, IG_CH), eq(s.contactChannels.platform_sender_id, "IG-COMMENTER")));
    expect(onIg.length).toBe(1);
    const onFb = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "IG-COMMENTER")));
    expect(onFb.length).toBe(0);
  });

  async function seedCommentRule(responseConfig: Record<string, unknown>) {
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "C", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
      response_type: "text", response_config: responseConfig,
    });
  }

  it("first-touch: a brand-new commenter gets a contact, conversation, public reply + private reply (both)", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "DM!", reply_mode: "both", comment_reply_text: "replied!" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-new", postId: "p1", senderId: "NEW-COMMENTER", senderName: "Jane", text: "info please", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);

    const cc = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "NEW-COMMENTER")));
    expect(cc.length).toBe(1);
    expect(await jobCount("outgoing-comment")).toBe(1);
    expect(await jobCount("outgoing-private-reply")).toBe(1);
  });

  it("reply_mode comment → public reply only, no private reply", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "comment", comment_reply_text: "public!" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-pub", postId: "p1", senderId: "C2", senderName: "B", text: "info", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);
    expect(await jobCount("outgoing-comment")).toBe(1);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
  });

  it("reply_mode dm → private reply only, no public reply", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "dm only", reply_mode: "dm" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-dm", postId: "p1", senderId: "C3", senderName: "B", text: "info", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);
    expect(await jobCount("outgoing-comment")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(1);
  });

  it("retries a comment rule whose first reply enqueue failed — not lost to the comment-log dedup", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "DM!", reply_mode: "dm" });
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("enqueue down"));
    try {
      const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-retry", postId: "p1", senderId: "CMT-RETRY", senderName: "Bob", text: "info please", timestamp: ts(), raw: {} };
      // First delivery: the comment is logged, then the reply enqueue fails → surface it.
      await expect(w.processIncomingComment(job as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-private-reply")).toBe(0);
      // Retry: the comment is already logged (deduped), but the rule must still fire once.
      await w.processIncomingComment(job as never, helpers);
      expect(await jobCount("outgoing-private-reply")).toBe(1);
      // Redelivery after success: no duplicate reply.
      await w.processIncomingComment(job as never, helpers);
      expect(await jobCount("outgoing-private-reply")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reply when no rule matches (but still logs)", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "both", comment_reply_text: "y" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-nomatch", postId: "p1", senderId: "C4", senderName: "B", text: "unrelated chatter", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers);
    expect(await jobCount("outgoing-comment")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
  });

  //  — a redelivered comment resolves identity but must not bump activity/status.
  it("a redelivered comment does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "dm" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-reopen", postId: "p1", senderId: "CMT-REOPEN", senderName: "Z", text: "info", timestamp: ts(), raw: {} };
    await w.processIncomingComment(job as never, helpers); // first delivery: logs + fires DM
    expect(await jobCount("outgoing-private-reply")).toBe(1);
    // Operator closes the conversation; record an old last_message_at.
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "CMT-REOPEN"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    // Redelivery of the SAME comment: identity resolves, but status/order are untouched.
    await w.processIncomingComment(job as never, helpers);
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.status).toBe("closed");
    expect(conv.last_message_at?.getTime()).toBe(past.getTime());
    expect(await jobCount("outgoing-private-reply")).toBe(1); // no duplicate reply
  });
});

describe("incoming-reaction worker", () => {
  async function seedReactionRule(over: Record<string, unknown> = {}) {
    const [row] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "React", trigger_type: "reaction", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "thanks for the reaction!" }, ...over,
    }).returning({ id: s.autoReplyRules.id });
    return row.id;
  }

  it("routes to the channel matching the event platform, not a same-id channel on another platform", async () => {
    if (!TEST_DB) return;
    const IG_CH = "eeeeeeee-0000-0000-0000-0000000000fb";
    await db.insert(s.channels).values({ id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s3", status: "active" });
    await seedReactionRule();
    await w.processIncomingReaction({ platform: "instagram", pageId: PAGE, senderId: "IG-REACTOR", reactedMid: "m-ig", reactionType: "love", emoji: "❤️", timestamp: ts(), raw: {} } as never, helpers);
    const onIg = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, IG_CH), eq(s.contactChannels.platform_sender_id, "IG-REACTOR")));
    expect(onIg.length).toBe(1);
    const onFb = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "IG-REACTOR")));
    expect(onFb.length).toBe(0);
  });

  it("fires a reaction rule and DMs the reactor (new contact materialised)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-1", reactedMid: "m-1", reactionType: "love", emoji: "❤️", timestamp: ts(), raw: {} } as never, helpers);
    const cc = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "REACTOR-1")));
    expect(cc.length).toBe(1);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("respects a reactions filter (only the listed type fires)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ trigger_config: { reactions: ["love"] } });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-2", reactedMid: "m-2", reactionType: "angry", emoji: "😠", timestamp: ts(), raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(0);
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-2", reactedMid: "m-2", reactionType: "love", emoji: "❤️", timestamp: ts(), raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("deduplicates a redelivered reaction so the rule fires (and replies) only once", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    // Same reaction identity (sender + reacted message + timestamp) delivered twice,
    // as happens when the webhook batch is retried. The rule must fire only once.
    const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-DUP", reactedMid: "m-dup", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_111, raw: {} };
    await w.processIncomingReaction(evt as never, helpers);
    await w.processIncomingReaction(evt as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("retries a reaction whose first evaluation failed, replying exactly once (no permanent drop)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    const executor = await import("@/lib/rules/executor");
    const spy = vi.spyOn(executor, "evaluateRules").mockRejectedValueOnce(new Error("transient downstream failure"));
    try {
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-RETRY", reactedMid: "m-retry", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_222, raw: {} };

      // First delivery: the claim is taken, then evaluation throws. The worker must
      // surface the error so the job is retried — not swallow it behind the claim,
      // which would drop the reply for good.
      await expect(w.processIncomingReaction(evt as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);

      // Retry of the same reaction (graphile reschedule): the released claim lets it
      // run, and the rule fires exactly once.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);

      // A still-later duplicate is deduped by the now-committed claim.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a cooldown rule whose first reply fails is not blocked by its own cooldown on retry", async () => {
    if (!TEST_DB) return;
    // Cooldown is a durable side effect; it must not be spent on a reply that never
    // went out, or the retry skips the rule and the reply is lost for good.
    await seedReactionRule({ cooldown_seconds: 3600, response_config: { text: "thanks!", ai_rephrase: true } });
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase").mockRejectedValueOnce(new Error("AI down"));
    try {
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-CD", reactedMid: "m-cd", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_333, raw: {} };
      await expect(w.processIncomingReaction(evt as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the cooldown was rolled back with the failed reply, so the rule fires.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a max_sends=1 rule whose first reply fails still sends exactly once on retry (count ends at 1)", async () => {
    if (!TEST_DB) return;
    const ruleId = await seedReactionRule({ max_sends_per_contact: 1, response_config: { text: "thanks!", ai_rephrase: true } });
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase").mockRejectedValueOnce(new Error("AI down"));
    try {
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-CAP", reactedMid: "m-cap", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_444, raw: {} };
      await expect(w.processIncomingReaction(evt as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the lifetime counter was not spent on the failed reply.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      const counts = await db.select().from(s.ruleSendCounts).where(eq(s.ruleSendCounts.rule_id, ruleId));
      expect(counts.length).toBe(1);
      expect(counts[0].count).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("an enqueue failure rolls back the event claim with the reply, so the retry is not silently skipped", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ cooldown_seconds: 3600 });
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("enqueue down"));
    try {
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-ENQ", reactedMid: "m-enq", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_555, raw: {} };
      await expect(w.processIncomingReaction(evt as never, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // The claim is taken in the same transaction as the enqueue, so a failed enqueue
      // leaves no claim behind — otherwise the retry would hit it and skip silently.
      expect((await db.select().from(s.processedEvents)).length).toBe(0);
      // Retry: enqueue works, the event fires exactly once and is now claimed.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      expect((await db.select().from(s.processedEvents)).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a higher-priority rule on cooldown does not claim the event and starve a lower-priority rule", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ name: "A", priority: 10, cooldown_seconds: 3600 });
    await seedReactionRule({ name: "B", priority: 5, cooldown_seconds: 0 });
    // First reaction: A (higher priority) fires and goes on cooldown for this contact.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-MULTI", reactedMid: "m-A", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_661, raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    // A different reaction from the same contact: A is cooling down, so B must fire. A's
    // skip must roll back its event claim, or B would see the event as already handled.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-MULTI", reactedMid: "m-B", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_662, raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(2);
  });

  //  — eligibility precheck must gate the (paid/slow) AI before planning a reply.
  it("does not call the AI for a redelivered, already-handled reaction", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ response_config: { text: "thanks!", ai_rephrase: true } });
    const evt = { platform: "facebook", pageId: PAGE, senderId: "R-AI-DUP", reactedMid: "m-aidup", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_771, raw: {} };
    await w.processIncomingReaction(evt as never, helpers); // first: fires + claims (AI ran)
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction(evt as never, helpers); // redelivery: already claimed
      expect(spy).not.toHaveBeenCalled();
      expect(await jobCount("outgoing-message")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a cooling-down AI rule does not call the AI, and a lower-priority rule still fires", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ name: "Hi", priority: 10, cooldown_seconds: 3600, response_config: { text: "hi", ai_rephrase: true } });
    await seedReactionRule({ name: "Lo", priority: 5, cooldown_seconds: 0, response_config: { text: "lo" } });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CD-AI", reactedMid: "m-cd1", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_772, raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CD-AI", reactedMid: "m-cd2", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_773, raw: {} } as never, helpers);
      expect(spy).not.toHaveBeenCalled(); // high rule cooling down → no AI; low rule has none
      expect(await jobCount("outgoing-message")).toBe(2); // low rule fired
    } finally {
      spy.mockRestore();
    }
  });

  it("a rule at its send cap does not call the AI", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ max_sends_per_contact: 1, response_config: { text: "x", ai_rephrase: true } });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CAP-AI", reactedMid: "m-cap1", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_774, raw: {} } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CAP-AI", reactedMid: "m-cap2", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_775, raw: {} } as never, helpers);
      expect(spy).not.toHaveBeenCalled();
      expect(await jobCount("outgoing-message")).toBe(1); // capped → no second send
    } finally {
      spy.mockRestore();
    }
  });

  //  — a redelivered reaction is deduped BEFORE resolving/mutating the conversation.
  it("a duplicate reaction does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    const evt = { platform: "facebook", pageId: PAGE, senderId: "-RX", reactedMid: "m-rx", reactionType: "love", emoji: "❤️", timestamp: 1_770_002_001, raw: {} };
    await w.processIncomingReaction(evt as never, helpers); // fires + claims, materialises conversation
    expect(await jobCount("outgoing-message")).toBe(1);
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "-RX"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    await w.processIncomingReaction(evt as never, helpers); // redelivery
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.status).toBe("closed");
    expect(conv.last_message_at?.getTime()).toBe(past.getTime());
    expect(await jobCount("outgoing-message")).toBe(1);
  });
});

describe("outgoing-private-reply worker", () => {
  it("sends a private reply and records a sent outbound message", async () => {
    if (!TEST_DB) return;
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, commentId: "cmt-pr", text: "hi via DM" } as never, helpers);
    expect(provider.sendPrivateReply).toHaveBeenCalled();
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("hi via DM");
  });

  it("holds (not fails) when the channel breaker is open", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, commentId: "cmt-pr2", text: "x" } as never, helpers);
    expect(provider.sendPrivateReply).not.toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });

  it("holds + flags needs_reauth when the token is invalid", async () => {
    if (!TEST_DB) return;
    provider.sendPrivateReply.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, commentId: "cmt-pr3", text: "x" } as never, helpers);
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });
});

describe("outgoing-message worker", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, ...over,
  });

  it("sends and records a sent message", async () => {
    if (!TEST_DB) return;
    await w.processOutgoingMessage(job() as never, helpers);
    expect(provider.sendMessage).toHaveBeenCalled();
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(1);
    expect(sent[0].platform_message_id).toBe("PMID-1");
  });

  it("holds (not fails) when the channel breaker is open (needs_reauth)", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingMessage(job() as never, helpers);
    expect(provider.sendMessage).not.toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });

  it("holds + flags needs_reauth when the token is invalid on send", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await w.processOutgoingMessage(job() as never, helpers);
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });
});

//  — the durable delivery state machine. The provider call sits between a committed
// `sending` claim and an atomic `sent`+persist, so neither crash window (after the provider
// accepted but before we recorded it; after recording but before local persist) produces a
// silent duplicate or loses local state.
describe("outbound delivery state machine", () => {
  const delivery = (key: string) =>
    db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, key) });
  const seedDelivery = (key: string, task: string, status: string) =>
    db.insert(s.outboundDeliveries).values({
      delivery_key: key, workspace_id: WS, channel_id: CH, task_name: task, payload: {}, status: status as never, attempts: 1,
    });

  it("records sent + platform id and persists the local message in one shot", async () => {
    if (!TEST_DB) return;
    await w.processOutgoingMessage(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "d-ok" } as never,
      helpers,
    );
    const row = await delivery("d-ok");
    expect(row?.status).toBe("sent");
    expect(row?.platform_message_id).toBe("PMID-1");
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(1);
  });

  // A crash after the provider accepted but before we recorded the result leaves a `sending`
  // row. The retry must NOT re-send (that would duplicate to a real recipient) — it records
  // the ambiguity as `unknown` instead.
  it("does not re-send a message whose prior attempt was interrupted mid-send", async () => {
    if (!TEST_DB) return;
    await seedDelivery("d-crash", "outgoing-message", "sending");
    await w.processOutgoingMessage(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "d-crash" } as never,
      helpers,
    );
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect((await delivery("d-crash"))?.status).toBe("unknown");
  });

  it("does not re-send a message whose delivery is already sent (retry after the persist window)", async () => {
    if (!TEST_DB) return;
    await seedDelivery("d-done", "outgoing-message", "sent");
    await w.processOutgoingMessage(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "d-done" } as never,
      helpers,
    );
    expect(provider.sendMessage).not.toHaveBeenCalled();
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(0);
  });

  it("marks failed and rethrows on a transient error, then re-sends on retry", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValueOnce(new Error("network blip"));
    await expect(
      w.processOutgoingMessage(
        { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "d-retry" } as never,
        helpers,
      ),
    ).rejects.toThrow("network blip");
    expect((await delivery("d-retry"))?.status).toBe("failed");

    await w.processOutgoingMessage(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "d-retry" } as never,
      helpers,
    );
    expect((await delivery("d-retry"))?.status).toBe("sent");
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not re-post a comment whose prior attempt was interrupted mid-send", async () => {
    if (!TEST_DB) return;
    await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, platform_comment_id: "cmt-crash", comment_text: "x" });
    await seedDelivery("d-cmt", "outgoing-comment", "sending");
    await w.processOutgoingComment({ channelId: CH, commentId: "cmt-crash", text: "r", idempotencyKey: "d-cmt" } as never, helpers);
    expect(provider.sendComment).not.toHaveBeenCalled();
    expect((await delivery("d-cmt"))?.status).toBe("unknown");
  });

  it("does not re-send a private reply whose prior attempt was interrupted mid-send", async () => {
    if (!TEST_DB) return;
    await seedDelivery("d-pr", "outgoing-private-reply", "sending");
    await w.processOutgoingPrivateReply(
      { channelId: CH, conversationId: CONV, commentId: "cmt-pr-crash", text: "x", idempotencyKey: "d-pr" } as never,
      helpers,
    );
    expect(provider.sendPrivateReply).not.toHaveBeenCalled();
    expect((await delivery("d-pr"))?.status).toBe("unknown");
  });
});

//  — every outbound type parks the FULL typed operation on the ledger when the channel
// is down, so a drain can replay the exact operation (right task, addressing, content) once.
describe("typed held parking + replay", () => {
  const heldDelivery = (key: string) =>
    db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, key) });

  it("parks a comment as a typed held delivery when the breaker is open", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingComment({ channelId: CH, commentId: "CMT-H", text: "ty", idempotencyKey: "h-cmt" } as never, helpers);
    expect(provider.sendComment).not.toHaveBeenCalled();
    const row = await heldDelivery("h-cmt");
    expect(row?.status).toBe("held");
    expect(row?.task_name).toBe("outgoing-comment");
    expect((row?.payload as { commentId?: string }).commentId).toBe("CMT-H");
  });

  it("parks a comment as a typed held delivery on an invalid token", async () => {
    if (!TEST_DB) return;
    provider.sendComment.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, platform_comment_id: "CMT-T", comment_text: "x" });
    await w.processOutgoingComment({ channelId: CH, commentId: "CMT-T", text: "ty", idempotencyKey: "t-cmt" } as never, helpers);
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    const row = await heldDelivery("t-cmt");
    expect(row?.status).toBe("held");
    expect(row?.task_name).toBe("outgoing-comment");
  });

  it("parks a private reply (with comment id + linked inbox row) when the breaker is open", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, commentId: "CMT-PR", text: "via DM", idempotencyKey: "h-pr" } as never, helpers);
    expect(provider.sendPrivateReply).not.toHaveBeenCalled();
    const row = await heldDelivery("h-pr");
    expect(row?.status).toBe("held");
    expect(row?.task_name).toBe("outgoing-private-reply");
    const payload = row?.payload as { commentId?: string; heldMessageId?: string };
    expect(payload.commentId).toBe("CMT-PR");
    expect(payload.heldMessageId).toBeTruthy(); // points back at the parked inbox row
  });

  it("parks a follow-gate when the breaker is open", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processFollowGate(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, followed: { text: "guide" }, notFollowed: { text: "follow first" }, idempotencyKey: "h-fg" } as never,
      helpers,
    );
    expect(await jobCount("outgoing-message")).toBe(0); // nothing dispatched while down
    const row = await heldDelivery("h-fg");
    expect(row?.status).toBe("held");
    expect(row?.task_name).toBe("follow-gate");
  });

  it("replays a parked private reply as a private reply (not a flattened DM)", async () => {
    if (!TEST_DB) return;
    // Park it.
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, commentId: "CMT-RP", text: "via DM", idempotencyKey: "r-pr" } as never, helpers);
    const parked = await heldDelivery("r-pr");
    // Channel recovers; drain re-dispatches the SAME stored payload back to the same worker.
    await db.update(s.channels).set({ status: "active" }).where(eq(s.channels.id, CH));
    await w.processOutgoingPrivateReply(parked!.payload as never, helpers);
    expect(provider.sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect((await heldDelivery("r-pr"))?.status).toBe("sent");
    // The parked inbox row was flipped in place — no duplicate sent row.
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(1);
  });

  it("replays a parked comment as a comment, exactly once", async () => {
    if (!TEST_DB) return;
    await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, platform_comment_id: "CMT-RC", comment_text: "x" });
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingComment({ channelId: CH, commentId: "CMT-RC", text: "ty", idempotencyKey: "r-cmt" } as never, helpers);
    const parked = await heldDelivery("r-cmt");
    await db.update(s.channels).set({ status: "active" }).where(eq(s.channels.id, CH));
    await w.processOutgoingComment(parked!.payload as never, helpers);
    expect(provider.sendComment).toHaveBeenCalledTimes(1);
    expect((await heldDelivery("r-cmt"))?.status).toBe("sent");
  });
});

describe("outgoing-comment worker", () => {
  it("posts a reply and marks the comment log reply_sent", async () => {
    if (!TEST_DB) return;
    await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, platform_comment_id: "cmt-out", comment_text: "x" });
    await w.processOutgoingComment({ channelId: CH, commentId: "cmt-out", text: "reply" } as never, helpers);
    expect(provider.sendComment).toHaveBeenCalled();
    const log = await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-out"));
    expect(log[0].reply_sent).toBe(true);
  });
});

describe("sequence-step worker", () => {
  it("sends a message step and advances / completes", async () => {
    if (!TEST_DB) return;
    const [seq] = await db.insert(s.sequences).values({
      workspace_id: WS, name: "Seq", status: "active", steps: [{ type: "message", content: "hi" }],
    }).returning({ id: s.sequences.id });
    const [enr] = await db.insert(s.sequenceEnrollments).values({
      sequence_id: seq.id, contact_id: CONTACT, channel_id: CH, status: "active", current_step_index: 0,
    }).returning({ id: s.sequenceEnrollments.id });

    await w.processSequenceStep({ enrollmentId: enr.id } as never, helpers);

    expect(await jobCount("outgoing-message")).toBe(1);
    const after = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enr.id) });
    expect(after?.status).toBe("completed");
  });
});

describe("token-refresh worker", () => {
  it("skips manual_token channels", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ connection_mode: "manual_token" }).where(eq(s.channels.id, CH));
    await w.processTokenRefresh({ channelId: CH } as never, helpers);
    expect(provider.refreshToken).not.toHaveBeenCalled();
  });

  it("refreshes and stores a new token when due", async () => {
    if (!TEST_DB) return;
    provider.requiresTokenRefresh.mockReturnValue(true);
    provider.refreshToken.mockResolvedValueOnce({ access_token: "new" });
    await w.processTokenRefresh({ channelId: CH } as never, helpers);
    expect(provider.refreshToken).toHaveBeenCalled();
    expect(health.markChannelHealthy).toHaveBeenCalledWith(CH);
  });
});

describe("follow-gate worker", () => {
  const fgJob = (over: Record<string, unknown> = {}) => ({
    channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID,
    followed: { text: "Here is your guide", buttons: [{ title: "Open", url: "https://x" }] },
    notFollowed: { text: "Please follow first, then tap again", buttons: [{ title: "Chcę odebrać", payload: "CLAIM_LM" }] },
    sentByRuleId: undefined, idempotencyKey: "idem-fg",
    ...over,
  });

  async function lastOutgoingContent() {
    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    return (r.rows[0] as { payload: { content: { text: string; buttons?: Array<{ payload?: string }> } } }).payload.content;
  }

  it("delivers the followed content when the user follows", async () => {
    if (!TEST_DB) return;
    provider.checkFollowsBusiness.mockResolvedValueOnce(true);
    await w.processFollowGate(fgJob() as never, helpers);
    expect(provider.checkFollowsBusiness).toHaveBeenCalledWith({ access_token: "x" }, PSID);
    expect(await jobCount("outgoing-message")).toBe(1);
    expect((await lastOutgoingContent()).text).toBe("Here is your guide");
  });

  it("re-prompts (with the claim button) when the user does not follow", async () => {
    if (!TEST_DB) return;
    provider.checkFollowsBusiness.mockResolvedValueOnce(false);
    await w.processFollowGate(fgJob() as never, helpers);
    const content = await lastOutgoingContent();
    expect(content.text).toBe("Please follow first, then tap again");
    expect(content.buttons?.[0].payload).toBe("CLAIM_LM");
  });

  it("leaves the gate open (delivers) when the platform has no follow graph", async () => {
    if (!TEST_DB) return;
    const orig = provider.checkFollowsBusiness;
    (provider as { checkFollowsBusiness?: unknown }).checkFollowsBusiness = undefined;
    try {
      await w.processFollowGate(fgJob() as never, helpers);
    } finally {
      (provider as { checkFollowsBusiness?: unknown }).checkFollowsBusiness = orig;
    }
    expect((await lastOutgoingContent()).text).toBe("Here is your guide");
  });

  it("skips when the channel needs re-auth (cannot check follow status)", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processFollowGate(fgJob() as never, helpers);
    expect(provider.checkFollowsBusiness).not.toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  it("flags needs_reauth when the follow check hits an invalid token", async () => {
    if (!TEST_DB) return;
    provider.checkFollowsBusiness.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await w.processFollowGate(fgJob() as never, helpers);
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  //  — the outcome is resolved once and pinned. A retry after the follow status flips
  // must replay the SAME branch, never enqueue the other one.
  it("pins the gate outcome: a retry after the status flips does not enqueue the other branch", async () => {
    if (!TEST_DB) return;
    // Attempt 1: the user does NOT follow → the re-prompt branch is enqueued and pinned.
    provider.checkFollowsBusiness.mockResolvedValueOnce(false);
    await w.processFollowGate(fgJob() as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    expect((await lastOutgoingContent()).text).toBe("Please follow first, then tap again");

    // The user now follows and the gate job is retried (same delivery key).
    provider.checkFollowsBusiness.mockResolvedValue(true);
    await w.processFollowGate(fgJob() as never, helpers);

    // Still exactly one child, still the originally-resolved branch — and the retry did not
    // even re-check the live follow status.
    expect(await jobCount("outgoing-message")).toBe(1);
    expect((await lastOutgoingContent()).text).toBe("Please follow first, then tap again");
    expect(provider.checkFollowsBusiness).toHaveBeenCalledTimes(1);
  });
});
