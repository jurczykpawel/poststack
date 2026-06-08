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
const helpers = { logger: { info: () => {} } } as never;

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
  // Idempotency claims are a shared key→TTL store with no workspace scope; clear it
  // so reaction-dedup keys don't survive into a re-run of this suite.
  await db.delete(s.idempotencyKeys);
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
      expect((await db.select().from(s.idempotencyKeys)).length).toBe(0);
      // Retry: enqueue works, the event fires exactly once and is now claimed.
      await w.processIncomingReaction(evt as never, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      expect((await db.select().from(s.idempotencyKeys)).length).toBe(1);
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
});
