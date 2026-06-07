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

  it("skips when no channel matches the page", async () => {
    if (!TEST_DB) return;
    await expect(
      w.processIncomingMessage({ platform: "facebook", pageId: "NOPE", senderId: "x", recipientId: "y", mid: "m", text: "t", timestamp: ts(), raw: {} } as never, helpers),
    ).resolves.toBeUndefined();
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
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "React", trigger_type: "reaction", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "thanks for the reaction!" }, ...over,
    });
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
