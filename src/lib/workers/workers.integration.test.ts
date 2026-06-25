import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Mock the network/crypto boundary; the DB is real.
const provider = {
  requiresTokenRefresh: vi.fn(() => false),
  refreshBufferSeconds: vi.fn(() => 0),
  sendMessage: vi.fn(async () => ({ platformMessageId: "PMID-1" })),
  sendComment: vi.fn(async () => ({ platformMessageId: "CMT-PMID" })),
  commentOnPost: vi.fn(async () => ({ platformMessageId: "FIRST-PMID" })),
  sendPrivateReply: vi.fn(async () => ({ platformMessageId: "PR-PMID" })),
  checkFollowsBusiness: vi.fn(async () => true),
  getPostUrl: vi.fn(async (_t: unknown, postId: string) => `https://www.instagram.com/reel/${postId}/`),
  getUserProfile: vi.fn(async () => ({ name: "Jan Testowy", profilePicture: "https://x/a.jpg" })),
  refreshToken: vi.fn(async (t: unknown) => t),
};
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));
// decryptTokens is a vi.fn so a test can make it throw (a corrupt token / rotated key); the
// channel-token wrapper that the workers use is NOT mocked, so it maps that throw to a re-auth.
const decryptTokens = vi.fn(() => ({ access_token: "x" }));
vi.mock("@/lib/crypto", () => ({ decryptTokens, encryptTokens: () => "enc", encryptString: () => "enc", decryptString: (s: string) => s }));
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
  processOutgoingFirstComment: typeof import("./outgoing-first-comment-worker").processOutgoingFirstComment;
  processOutgoingPrivateReply: typeof import("./outgoing-private-reply-worker").processOutgoingPrivateReply;
  processFollowGate: typeof import("./follow-gate-worker").processFollowGate;
  processSequenceStep: typeof import("./sequence-step-worker").processSequenceStep;
  processTokenRefresh: typeof import("./token-refresh-worker").processTokenRefresh;
  processIncomingEcho: typeof import("./incoming-echo-worker").processIncomingEcho;
  processIncomingReceipt: typeof import("./incoming-receipt-worker").processIncomingReceipt;
};
let TokenInvalidError: typeof import("@/lib/platforms/errors").TokenInvalidError;
let MessagingPolicyError: typeof import("@/lib/platforms/errors").MessagingPolicyError;
let RateLimitError: typeof import("@/lib/platforms/errors").RateLimitError;
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
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
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
    processOutgoingFirstComment: (await import("./outgoing-first-comment-worker")).processOutgoingFirstComment,
    processOutgoingPrivateReply: (await import("./outgoing-private-reply-worker")).processOutgoingPrivateReply,
    processFollowGate: (await import("./follow-gate-worker")).processFollowGate,
    processSequenceStep: (await import("./sequence-step-worker")).processSequenceStep,
    processTokenRefresh: (await import("./token-refresh-worker")).processTokenRefresh,
    processIncomingEcho: (await import("./incoming-echo-worker")).processIncomingEcho,
    processIncomingReceipt: (await import("./incoming-receipt-worker")).processIncomingReceipt,
  };
  ({ TokenInvalidError, MessagingPolicyError, RateLimitError } = await import("@/lib/platforms/errors"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  decryptTokens.mockReturnValue({ access_token: "x" });
  provider.requiresTokenRefresh.mockReturnValue(false);
  provider.sendMessage.mockResolvedValue({ platformMessageId: "PMID-1" });
  provider.refreshToken.mockImplementation(async (t: unknown) => t);
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  // The webhook_events log is a shared store (channel_id is SET NULL, not cascade); clear it so
  // event keys / dedup claims don't survive into a re-run of this suite. (Outbound delivery rows
  // are cleared by the workspace cascade below.)
  await db.delete(s.webhookEvents);
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
    const job = { platform: "facebook", pageId: PAGE, senderId: "NEW-PSID", recipientId: PAGE, mid: "mid-w1", text: "hi", timestamp: ts() };
    await w.processIncomingMessage(job, helpers);
    await w.processIncomingMessage(job, helpers); // dedup
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "mid-w1"));
    expect(msgs.length).toBe(1);
    expect(msgs[0].direction).toBe("inbound");
  });

  // a new inbound message's counters (unread_count, last_inbound_at, status:open) now commit
  // ATOMICALLY with the message insert, so a crash between can't permanently skip them. Here we verify
  // they're applied for a new DM (last_inbound_at is the drain's 24h-window anchor) and that a
  // redelivery doesn't double-count (preserved — the insert conflicts inside the tx).
  it("applies unread_count + last_inbound_at atomically for a new DM; a redelivery doesn't double them", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "t167-SENDER", recipientId: PAGE, mid: "mid-167", text: "hi", timestamp: ts() };
    await w.processIncomingMessage(job, helpers);
    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "t167-SENDER")),
      columns: { contact_id: true },
    });
    const conv = () => db.query.conversations.findFirst({
      where: and(eq(s.conversations.channel_id, CH), eq(s.conversations.contact_id, cc!.contact_id)),
      columns: { unread_count: true, last_inbound_at: true, status: true },
    });
    const c1 = await conv();
    expect(c1?.unread_count).toBe(1);
    expect(c1?.last_inbound_at).not.toBeNull(); // drain 24h-window anchor — must not be skipped
    expect(c1?.status).toBe("open");
    await w.processIncomingMessage(job, helpers); // redelivery
    expect((await conv())?.unread_count).toBe(1);
  });

  it("resolves a new contact's Meta profile name/avatar (inbox shows a nick, not the PSID)", async () => {
    if (!TEST_DB) return;
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "profile-SENDER", recipientId: PAGE, mid: "mid-prof", text: "hi", timestamp: ts() }, helpers);
    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "profile-SENDER")),
      columns: { contact_id: true },
    });
    const contact = await db.query.contacts.findFirst({ where: eq(s.contacts.id, cc!.contact_id), columns: { display_name: true, avatar_url: true } });
    expect(provider.getUserProfile).toHaveBeenCalled();
    expect(contact?.display_name).toBe("Jan Testowy");
    expect(contact?.avatar_url).toBe("https://x/a.jpg");
  });

  it("deduplicates per conversation, not globally — the same id in two conversations is stored once each", async () => {
    if (!TEST_DB) return;
    // Two different senders on the same page resolve to two different
    // conversations. A message id only deduplicates within its own conversation,
    // so a shared id must not let one conversation suppress another's message.
    const SHARED = "shared-message-id";
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "SENDER-A", recipientId: PAGE, mid: SHARED, text: "a", timestamp: ts() }, helpers);
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "SENDER-B", recipientId: PAGE, mid: SHARED, text: "b", timestamp: ts() }, helpers);
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, SHARED));
    expect(msgs.length).toBe(2);
  });

  it("skips when no channel matches the page", async () => {
    if (!TEST_DB) return;
    await expect(
      w.processIncomingMessage({ platform: "facebook", pageId: "NOPE", senderId: "x", recipientId: "y", mid: "m", text: "t", timestamp: ts() }, helpers),
    ).resolves.toBeUndefined();
  });

  // the DM path's contact find-or-create must be race-hardened like the shared resolver
  //: two parallel first DMs from a NEW sender converge on ONE contact, with neither job
  // failing on a 23505 (which previously dead-lettered the loser + forced a retry).
  it("two concurrent first DMs from a new sender create exactly one contact, no failure", async () => {
    if (!TEST_DB) return;
    const SENDER = "DM-RACE-SENDER";
    await Promise.all([
      w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: SENDER, recipientId: PAGE, mid: "dm-race-1", text: "hi", timestamp: ts() }, helpers),
      w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: SENDER, recipientId: PAGE, mid: "dm-race-2", text: "yo", timestamp: ts() }, helpers),
    ]);
    const links = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, SENDER)));
    expect(links.length).toBe(1);
    // Both messages still landed (different mids), proving neither job aborted on the race.
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "dm-race-1"));
    const msgs2 = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "dm-race-2"));
    expect(msgs.length).toBe(1);
    expect(msgs2.length).toBe(1);
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
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-RETRY", recipientId: PAGE, mid: "mid-dmretry", text: "hello", timestamp: ts() };
      // First delivery: message is stored, then the reply enqueue fails. The worker must
      // surface the error (retry) instead of swallowing it behind the committed message.
      await expect(w.processIncomingMessage(job, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the message is already stored (deduped), but the rule must still fire once.
      await w.processIncomingMessage(job, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      // Redelivery after success: no duplicate reply.
      await w.processIncomingMessage(job, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  // a permanently-lost DM auto-reply must surface to the operator.
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
    // Fail the reply enqueue, but stay transparent to the contact.created fan-out (WHOUT1: emitting
    // an event now enqueues event-dispatch via addJobTx — that must not be the failure under test).
    const spy = vi.spyOn(qc, "addJobTx").mockImplementation(async (_tx, task) => {
      if (task !== "event-dispatch") throw new Error("permanent");
    });
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-LAST", recipientId: PAGE, mid: "mid-last", text: "hello", timestamp: ts() };
      await expect(w.processIncomingMessage(job, helpersJob(3, 3))).rejects.toThrow();
      expect(await convFlag("DM-LAST")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not flag the conversation on a non-final failed attempt (still retrying)", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockImplementation(async (_tx, task) => {
      if (task !== "event-dispatch") throw new Error("transient"); // transparent to the contact.created fan-out
    });
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-MID", recipientId: PAGE, mid: "mid-mid", text: "hello", timestamp: ts() };
      await expect(w.processIncomingMessage(job, helpersJob(1, 3))).rejects.toThrow();
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
      const job = { platform: "facebook", pageId: PAGE, senderId: "DM-OK", recipientId: PAGE, mid: "mid-ok", text: "hello", timestamp: ts() };
      await expect(w.processIncomingMessage(job, helpersJob(1, 3))).rejects.toThrow(); // attempt 1 fails
      await w.processIncomingMessage(job, helpersJob(2, 3)); // attempt 2 succeeds
      expect(await jobCount("outgoing-message")).toBe(1);
      expect(await convFlag("DM-OK")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // a no-match / paused event is terminally claimed, so a later redelivery
  // (after a rule is added or after unpause) does not produce a late reply to an old event.
  it("a no-match DM is terminally claimed — adding a rule then redelivering does not reply late", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "t17-NM", recipientId: PAGE, mid: "mid-nm", text: "hello", timestamp: ts() };
    await w.processIncomingMessage(job, helpers); // no rule yet → no-match, claimed
    expect(await jobCount("outgoing-message")).toBe(0);
    await seedDefaultDmRule(); // operator adds a matching rule
    await w.processIncomingMessage(job, helpers); // redelivery of the SAME event
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  it("a paused DM is terminally claimed — unpausing then redelivering does not reply late", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_P = "eeeeeeee-0000-0000-0000-0000000aa001";
    await db.insert(s.contacts).values({ id: CONTACT_P, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_P, channel_id: CH, platform_sender_id: "t17-PAUSE" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_P, platform: "facebook", is_automation_paused: true });
    const job = { platform: "facebook", pageId: PAGE, senderId: "t17-PAUSE", recipientId: PAGE, mid: "mid-pause", text: "hello", timestamp: ts() };
    await w.processIncomingMessage(job, helpers); // paused → claim + skip
    expect(await jobCount("outgoing-message")).toBe(0);
    await db.update(s.conversations).set({ is_automation_paused: false }).where(eq(s.conversations.contact_id, CONTACT_P));
    await w.processIncomingMessage(job, helpers); // redelivery after unpause
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  // two parallel deliveries of the same new DM: the worker that loses the claim
  // race must read "already handled" (not no-match) and not flag a conversation the winner
  // just auto-replied to.
  it("two parallel deliveries of the same DM → exactly one reply and needs_manual_reply stays false", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_R = "eeeeeeee-0000-0000-0000-0000000aa002";
    // Pre-seed identity so both deliveries race only on the message/claim, not contact creation.
    await db.insert(s.contacts).values({ id: CONTACT_R, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_R, channel_id: CH, platform_sender_id: "t18-RACE" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_R, platform: "facebook" });
    const job = { platform: "facebook", pageId: PAGE, senderId: "t18-RACE", recipientId: PAGE, mid: "mid-race", text: "hello", timestamp: ts() };
    await Promise.all([
      w.processIncomingMessage(job, helpers),
      w.processIncomingMessage(job, helpers),
    ]);
    expect(await jobCount("outgoing-message")).toBe(1);
    expect(await convFlag("t18-RACE")).toBe(false);
  });

  // a stale final-failure of an old message must not re-raise the flag on a
  // conversation a newer message already resolved.
  it("an old DM's final-failure does not overwrite a conversation a newer message resolved", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const SENDER = "t19";
    const OLD_TS = 1_770_000_900;
    const NEW_TS = 1_770_001_000;
    const qc = await import("@/lib/queue/client");
    // Script applies to the REAL (reply) enqueues only; the contact.created fan-out (event-dispatch)
    // is transparent so it doesn't consume a step (WHOUT1: emit now enqueues event-dispatch).
    const spy = vi.spyOn(qc, "addJobTx");
    const script = [
      () => { throw new Error("transient"); }, // old msg, attempt 1: fails (non-final)
      () => undefined, // newer msg: auto-reply succeeds, resolves the conversation
    ];
    let step = 0;
    spy.mockImplementation(async (_tx, task) => {
      if (task === "event-dispatch") return;
      const fn = script[step] ?? (() => { throw new Error("permanent"); }); // old msg, final attempt: fails for good
      step++;
      return fn();
    });
    try {
      const oldJob = { platform: "facebook", pageId: PAGE, senderId: SENDER, recipientId: PAGE, mid: "mid-old", text: "hello", timestamp: OLD_TS };
      await expect(w.processIncomingMessage(oldJob, helpersJob(1, 3))).rejects.toThrow();
      const newJob = { ...oldJob, mid: "mid-new", timestamp: NEW_TS };
      await w.processIncomingMessage(newJob, helpers); // newer message resolves it → flag false
      expect(await convFlag(SENDER)).toBe(false);
      await expect(w.processIncomingMessage(oldJob, helpersJob(3, 3))).rejects.toThrow(); // old final fail
      expect(await convFlag(SENDER)).toBe(false); // not re-raised by the stale retry
    } finally {
      spy.mockRestore();
    }
  });

  // the durable event claim (in webhook_events) must outlive the ephemeral TTL prune (cooldowns,
  // rate-limit windows, the token denylist), so an old webhook redelivery can't fire a
  // second/late reply after maintenance runs. The webhook_events log is NOT auto-pruned (its
  // retention is owner-driven via the prune endpoint), so a maintenance run leaves the claim — and
  // thus dedup — intact while clearing the short-lived stores.
  it("a processed event stays deduped after the operational TTL stores are pruned", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const { pruneExpired } = await import("@/lib/maintenance");
    const job = { platform: "facebook", pageId: PAGE, senderId: "t22", recipientId: PAGE, mid: "mid-22", text: "hello", timestamp: ts() };
    await w.processIncomingMessage(job, helpers); // fires + durably records the event
    expect(await jobCount("outgoing-message")).toBe(1);
    // Maintenance prunes the ephemeral TTL stores (seconds-to-hours lived); two days out is
    // well past them but the webhook_events log is untouched by maintenance.
    await pruneExpired(new Date(Date.now() + 2 * 86_400_000));
    expect((await db.select().from(s.webhookEvents)).length).toBeGreaterThan(0); // event claim survives
    // Redelivery after the prune must not reply again.
    await w.processIncomingMessage(job, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  // an out-of-order older message must not move conversation activity backwards.
  it("an out-of-order older message does not move conversation activity backwards", async () => {
    if (!TEST_DB) return;
    const T2 = ts();
    const T1 = T2 - 3600; // an hour older, but ingested second
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "t23", recipientId: PAGE, mid: "m-t2", text: "newer", timestamp: T2 }, helpers);
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "t23", recipientId: PAGE, mid: "m-t1", text: "older", timestamp: T1 }, helpers);
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "t23"));
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.last_message_at?.getTime()).toBe(T2 * 1000);
    expect(conv.last_inbound_at?.getTime()).toBe(T2 * 1000);
    expect(conv.last_message_preview).toBe("newer");
  });

  // a duplicate DM must dedup before mutating lifecycle (no reopen / no reorder).
  it("a duplicate DM does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, senderId: "t24-DM", recipientId: PAGE, mid: "m-dup", text: "hi", timestamp: ts() };
    await w.processIncomingMessage(job, helpers); // creates conversation
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "t24-DM"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    await w.processIncomingMessage(job, helpers); // redelivery of the SAME message
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.status).toBe("closed");
    expect(conv.last_message_at?.getTime()).toBe(past.getTime());
  });

  // a new DM that arrives while automation is paused must surface for a human.
  it("a new DM on a paused conversation flags it for manual attention", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    const CONTACT_P = "eeeeeeee-0000-0000-0000-0000000aa026";
    await db.insert(s.contacts).values({ id: CONTACT_P, workspace_id: WS });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT_P, channel_id: CH, platform_sender_id: "t26" });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT_P, platform: "facebook", is_automation_paused: true });
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "t26", recipientId: PAGE, mid: "m-26", text: "hello", timestamp: ts() }, helpers);
    expect(await jobCount("outgoing-message")).toBe(0); // paused → no auto-reply
    expect(await convFlag("t26")).toBe(true); // but surfaced for a human
  });

  // a manually paused CHANNEL ingests to the inbox but runs no automation.
  it("a manually paused channel ingests a DM but runs no automation", async () => {
    if (!TEST_DB) return;
    await seedDefaultDmRule();
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "t40", recipientId: PAGE, mid: "m-40", text: "hello", timestamp: ts() }, helpers);
    const msgs = await db.select().from(s.messages).where(eq(s.messages.platform_message_id, "m-40"));
    expect(msgs.length).toBe(1); // still ingested to the inbox
    expect(await jobCount("outgoing-message")).toBe(0); // but no auto-reply
    expect(await convFlag("t40")).toBe(true); // surfaced for a human
  });
});

describe("incoming-comment worker", () => {
  it("logs a comment and dedups by (channel, comment id)", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-w1", postId: "post-1", senderId: PSID, senderName: "A", text: "hello", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    await w.processIncomingComment(job, helpers);
    const logs = await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-w1"));
    expect(logs.length).toBe(1);
  });

  it("resolves and stores the post permalink, reusing it for later comments on the same post", async () => {
    if (!TEST_DB) return;
    provider.getPostUrl.mockClear();
    const IG_CH = "eeeeeeee-0000-0000-0000-0000000000fd";
    const IG_PAGE = "IG-PURL";
    await db.insert(s.channels).values({ id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: IG_PAGE, token_encrypted: "x", webhook_secret: "spurl", status: "active" });
    const post = "media-purl";
    await w.processIncomingComment({ platform: "instagram", pageId: IG_PAGE, commentId: "cmt-purl-1", postId: post, senderId: "PURL-A", senderName: "A", text: "hi", timestamp: ts() }, helpers);
    await w.processIncomingComment({ platform: "instagram", pageId: IG_PAGE, commentId: "cmt-purl-2", postId: post, senderId: "PURL-B", senderName: "B", text: "hi", timestamp: ts() }, helpers);
    const logs = await db.select().from(s.commentLogs).where(eq(s.commentLogs.post_id, post));
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.post_url === `https://www.instagram.com/reel/${post}/`)).toBe(true);
    // Second comment on the same post reuses the stored permalink instead of calling the API again.
    expect(provider.getPostUrl).toHaveBeenCalledTimes(1);
  });

  // a comment on a fresh conversation is unread work for the operator; the inbox badge
  // must reflect it. A redelivery of the same comment must not double-count.
  it("increments unread_count for a new comment, not on redelivery", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-unread", postId: "p1", senderId: "UNREAD-COMMENTER", senderName: "U", text: "hello", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "UNREAD-COMMENTER")),
      columns: { contact_id: true },
    });
    const unread = async () =>
      (await db.query.conversations.findFirst({
        where: and(eq(s.conversations.channel_id, CH), eq(s.conversations.contact_id, cc!.contact_id)),
        columns: { unread_count: true },
      }))?.unread_count;
    expect(await unread()).toBe(1);
    await w.processIncomingComment(job, helpers); // redelivery
    expect(await unread()).toBe(1);
  });

  it("routes to the channel matching the event platform, not a same-id channel on another platform", async () => {
    if (!TEST_DB) return;
    const IG_CH = "eeeeeeee-0000-0000-0000-0000000000fc";
    await db.insert(s.channels).values({ id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s2", status: "active" });
    const job = { platform: "instagram", pageId: PAGE, commentId: "cmt-ig", postId: "m1", senderId: "IG-COMMENTER", senderName: "Iga", text: "hi", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
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
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-new", postId: "p1", senderId: "NEW-COMMENTER", senderName: "Jane", text: "info please", timestamp: ts() };
    await w.processIncomingComment(job, helpers);

    const cc = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "NEW-COMMENTER")));
    expect(cc.length).toBe(1);
    expect(await jobCount("outgoing-comment")).toBe(1);
    expect(await jobCount("outgoing-private-reply")).toBe(1);
  });

  it("reply_mode comment → public reply only, no private reply", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "comment", comment_reply_text: "public!" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-pub", postId: "p1", senderId: "C2", senderName: "B", text: "info", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    expect(await jobCount("outgoing-comment")).toBe(1);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
  });

  it("reply_mode dm → private reply only, no public reply", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "dm only", reply_mode: "dm" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-dm", postId: "p1", senderId: "C3", senderName: "B", text: "info", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    expect(await jobCount("outgoing-comment")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(1);
  });

  // an unmatched comment is unhandled work: raise the attention badge, mirroring the DM worker.
  it("flags needs_manual_reply on a comment that matches no rule", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-nomatch", postId: "p1", senderId: "NOMATCH-C", senderName: "Z", text: "totally unrelated", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "NOMATCH-C")),
      columns: { contact_id: true },
    });
    const conv = await db.query.conversations.findFirst({ where: eq(s.conversations.contact_id, cc!.contact_id) });
    expect(conv?.needs_manual_reply).toBe(true);
  });

  // two concurrent first events from the same new sender converge on ONE contact without a
  // unique-violation failing a job (the loser's link insert is a no-op, not a thrown 23505).
  it("two concurrent first events from a new sender create exactly one contact, no failure", async () => {
    if (!TEST_DB) return;
    const { resolveContactConversation } = await import("./resolve-contact");
    const ch = { id: CH, workspace_id: WS, platform: "facebook" as const };
    const [a, b] = await Promise.all([
      resolveContactConversation(ch, "RACE-SENDER", "A", "hi"),
      resolveContactConversation(ch, "RACE-SENDER", "A", "hi"),
    ]);
    expect(a.contactId).toBe(b.contactId);
    const links = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "RACE-SENDER")));
    expect(links.length).toBe(1);
  });

  // the new-comment log must not contain the commenter's raw platform author-id (PSID-class
  // PII that sits outside the GDPR erasure boundary); it logs the internal comment-log id instead.
  it("does not log the raw commenter author-id", async () => {
    if (!TEST_DB) return;
    const lines: string[] = [];
    const spyHelpers = { logger: { info: (m: string) => lines.push(m) }, job: { id: "job-test" } } as never;
    const SENDER = "PSID-142";
    await w.processIncomingComment(
      { platform: "facebook", pageId: PAGE, commentId: "cmt-pii", postId: "p1", senderId: SENDER, senderName: "Z", text: "hi", timestamp: ts() },
      spyHelpers,
    );
    const loggedLine = lines.find((m) => m.includes("Logged comment="));
    expect(loggedLine).toBeDefined();
    expect(loggedLine).not.toContain(SENDER);
  });

  it("retries a comment rule whose first reply enqueue failed — not lost to the comment-log dedup", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "DM!", reply_mode: "dm" });
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("enqueue down"));
    try {
      const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-retry", postId: "p1", senderId: "CMT-RETRY", senderName: "Bob", text: "info please", timestamp: ts() };
      // First delivery: the comment is logged, then the reply enqueue fails → surface it.
      await expect(w.processIncomingComment(job, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-private-reply")).toBe(0);
      // Retry: the comment is already logged (deduped), but the rule must still fire once.
      await w.processIncomingComment(job, helpers);
      expect(await jobCount("outgoing-private-reply")).toBe(1);
      // Redelivery after success: no duplicate reply.
      await w.processIncomingComment(job, helpers);
      expect(await jobCount("outgoing-private-reply")).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reply when no rule matches (but still logs)", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "both", comment_reply_text: "y" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-nomatch", postId: "p1", senderId: "C4", senderName: "B", text: "unrelated chatter", timestamp: ts() };
    await w.processIncomingComment(job, helpers);
    expect(await jobCount("outgoing-comment")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
  });

  // the page's OWN public reply is redelivered by Meta as a fresh comment with
  // from.id === page id. Without a from-is-page guard it re-logs, re-matches a post_id-only rule
  // (which matches every comment on the post), and posts yet another reply → unbounded self-loop.
  // It must be dropped: zero log, zero match, zero reply enqueue. A real fan's comment on the same
  // post is still processed.
  it("drops a comment authored by the page itself (self-loop guard), but still processes a fan's", async () => {
    if (!TEST_DB) return;
    // The unconditional-loop config: a rule scoped to the post with NO keywords matches EVERY comment.
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "PostLoop", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { post_id: "p-loop" },
      response_type: "text", response_config: { text: "x", reply_mode: "comment", comment_reply_text: "auto!" },
    });
    // The page's own reply, redelivered as a fresh comment (senderId === channel.platform_id === PAGE).
    const selfJob = { platform: "facebook", pageId: PAGE, commentId: "cmt-self", postId: "p-loop", senderId: PAGE, senderName: "Our Page", text: "auto!", timestamp: ts() };
    await w.processIncomingComment(selfJob, helpers);
    expect((await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-self"))).length).toBe(0);
    expect(await jobCount("outgoing-comment")).toBe(0);
    // A genuine fan's comment on the same post IS processed: logged + public reply enqueued.
    const fanJob = { platform: "facebook", pageId: PAGE, commentId: "cmt-fan", postId: "p-loop", senderId: "FAN-1", senderName: "Fan", text: "anything", timestamp: ts() };
    await w.processIncomingComment(fanJob, helpers);
    expect((await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-fan"))).length).toBe(1);
    expect(await jobCount("outgoing-comment")).toBe(1);
  });

  // a redelivered comment resolves identity but must not bump activity/status.
  it("a redelivered comment does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    await seedCommentRule({ text: "x", reply_mode: "dm" });
    const job = { platform: "facebook", pageId: PAGE, commentId: "cmt-reopen", postId: "p1", senderId: "CMT-REOPEN", senderName: "Z", text: "info", timestamp: ts() };
    await w.processIncomingComment(job, helpers); // first delivery: logs + fires DM
    expect(await jobCount("outgoing-private-reply")).toBe(1);
    // Operator closes the conversation; record an old last_message_at.
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "CMT-REOPEN"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    // Redelivery of the SAME comment: identity resolves, but status/order are untouched.
    await w.processIncomingComment(job, helpers);
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
    await w.processIncomingReaction({ platform: "instagram", pageId: PAGE, senderId: "IG-REACTOR", reactedMid: "m-ig", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    const onIg = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, IG_CH), eq(s.contactChannels.platform_sender_id, "IG-REACTOR")));
    expect(onIg.length).toBe(1);
    const onFb = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "IG-REACTOR")));
    expect(onFb.length).toBe(0);
  });

  it("fires a reaction rule and DMs the reactor (new contact materialised)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-1", reactedMid: "m-1", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    const cc = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "REACTOR-1")));
    expect(cc.length).toBe(1);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("records the reaction for the thread even with no rule, upserting on re-react", async () => {
    if (!TEST_DB) return;
    // No reaction rule seeded: the reaction is still recorded for visibility.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-VIS", reactedMid: "m-vis", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    const mine = () => db.select().from(s.messageReactions).where(eq(s.messageReactions.reacted_mid, "m-vis"));
    let rows = await mine();
    expect(rows.length).toBe(1);
    expect(rows[0].reaction_type).toBe("love");
    expect(rows[0].emoji).toBe("❤️");
    // A changed reaction (new timestamp) updates the same row instead of duplicating.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-VIS", reactedMid: "m-vis", reactionType: "angry", emoji: "😠", timestamp: ts() + 1 }, helpers);
    rows = await mine();
    expect(rows.length).toBe(1);
    expect(rows[0].reaction_type).toBe("angry");
  });

  // a reaction whose sender is the page itself (senderId === channel.platform_id) must be
  // dropped: it would otherwise materialise the page as a self-contact (before rule eval, so
  // unconditionally) and fire a doomed self-DM. The reaction-path analog of the comment self-guard
  // / the DM is_echo skip.
  it("drops a reaction authored by the page itself (no self-contact, no self-DM)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: PAGE, reactedMid: "m-self", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    const self = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, PAGE)));
    expect(self.length).toBe(0);
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  // a reaction is a low-signal event; it must NOT resurface a conversation the operator
  // deliberately closed (which would return it to the inbox with no unread/attention signal).
  it("does not reopen a closed conversation on a reaction", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    const SENDER = "REACTOR-CLOSED";
    const [c] = await db.insert(s.contacts).values({ workspace_id: WS }).returning({ id: s.contacts.id });
    await db.insert(s.contactChannels).values({ contact_id: c.id, channel_id: CH, platform_sender_id: SENDER });
    await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: c.id, platform: "facebook", status: "closed" });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: SENDER, reactedMid: "m-closed", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    const conv = await db.query.conversations.findFirst({
      where: and(eq(s.conversations.channel_id, CH), eq(s.conversations.contact_id, c.id)),
      columns: { status: true },
    });
    expect(conv?.status).toBe("closed");
  });

  it("respects a reactions filter (only the listed type fires)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ trigger_config: { reactions: ["love"] } });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-2", reactedMid: "m-2", reactionType: "angry", emoji: "😠", timestamp: ts() }, helpers);
    expect(await jobCount("outgoing-message")).toBe(0);
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-2", reactedMid: "m-2", reactionType: "love", emoji: "❤️", timestamp: ts() }, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("deduplicates a redelivered reaction so the rule fires (and replies) only once", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    // Same reaction identity (sender + reacted message + timestamp) delivered twice,
    // as happens when the webhook batch is retried. The rule must fire only once.
    const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-DUP", reactedMid: "m-dup", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_111 };
    await w.processIncomingReaction(evt, helpers);
    await w.processIncomingReaction(evt, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
  });

  it("retries a reaction whose first fire-tx failed, replying exactly once (no permanent drop)", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    // Inject the failure at the enqueue boundary (consistent with the DM/comment retry tests) so
    // the REAL executor runs and the claim is genuinely taken inside the fire-tx — then rolled
    // back when the enqueue throws. Mocking evaluateRules itself would skip the claim path.
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockRejectedValueOnce(new Error("transient enqueue failure"));
    try {
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-RETRY", reactedMid: "m-retry", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_222 };

      // First delivery: the claim is taken in the fire-tx, then the enqueue throws → the whole tx
      // rolls back (claim released) and the worker surfaces the error so the job is retried — not
      // swallowed, which would drop the reply for good.
      await expect(w.processIncomingReaction(evt, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);

      // Retry of the same reaction (graphile reschedule): the released claim lets it run, and the
      // rule fires exactly once.
      await w.processIncomingReaction(evt, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);

      // A still-later duplicate is deduped by the now-committed claim.
      await w.processIncomingReaction(evt, helpers);
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
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-CD", reactedMid: "m-cd", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_333 };
      await expect(w.processIncomingReaction(evt, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the cooldown was rolled back with the failed reply, so the rule fires.
      await w.processIncomingReaction(evt, helpers);
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
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-CAP", reactedMid: "m-cap", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_444 };
      await expect(w.processIncomingReaction(evt, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // Retry: the lifetime counter was not spent on the failed reply.
      await w.processIncomingReaction(evt, helpers);
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
      const evt = { platform: "facebook", pageId: PAGE, senderId: "REACTOR-ENQ", reactedMid: "m-enq", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_555 };
      await expect(w.processIncomingReaction(evt, helpers)).rejects.toThrow();
      expect(await jobCount("outgoing-message")).toBe(0);
      // The claim is taken in the same transaction as the enqueue, so a failed enqueue
      // leaves no terminal claim behind — otherwise the retry would hit it and skip silently.
      expect((await db.select().from(s.webhookEvents)).filter((e) => e.handling_status !== "received").length).toBe(0);
      // Retry: enqueue works, the event fires exactly once and is now claimed.
      await w.processIncomingReaction(evt, helpers);
      expect(await jobCount("outgoing-message")).toBe(1);
      expect((await db.select().from(s.webhookEvents)).filter((e) => e.handling_status === "fired").length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a higher-priority rule on cooldown does not claim the event and starve a lower-priority rule", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ name: "A", priority: 10, cooldown_seconds: 3600 });
    await seedReactionRule({ name: "B", priority: 5, cooldown_seconds: 0 });
    // First reaction: A (higher priority) fires and goes on cooldown for this contact.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-MULTI", reactedMid: "m-A", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_661 }, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    // A different reaction from the same contact: A is cooling down, so B must fire. A's
    // skip must roll back its event claim, or B would see the event as already handled.
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "REACTOR-MULTI", reactedMid: "m-B", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_662 }, helpers);
    expect(await jobCount("outgoing-message")).toBe(2);
  });

  // eligibility precheck must gate the (paid/slow) AI before planning a reply.
  it("does not call the AI for a redelivered, already-handled reaction", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ response_config: { text: "thanks!", ai_rephrase: true } });
    const evt = { platform: "facebook", pageId: PAGE, senderId: "R-AI-DUP", reactedMid: "m-aidup", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_771 };
    await w.processIncomingReaction(evt, helpers); // first: fires + claims (AI ran)
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction(evt, helpers); // redelivery: already claimed
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
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CD-AI", reactedMid: "m-cd1", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_772 }, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CD-AI", reactedMid: "m-cd2", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_773 }, helpers);
      expect(spy).not.toHaveBeenCalled(); // high rule cooling down → no AI; low rule has none
      expect(await jobCount("outgoing-message")).toBe(2); // low rule fired
    } finally {
      spy.mockRestore();
    }
  });

  it("a rule at its send cap does not call the AI", async () => {
    if (!TEST_DB) return;
    await seedReactionRule({ max_sends_per_contact: 1, response_config: { text: "x", ai_rephrase: true } });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CAP-AI", reactedMid: "m-cap1", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_774 }, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    const ai = await import("@/lib/ai/rephrase");
    const spy = vi.spyOn(ai, "rephrase");
    try {
      await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: "R-CAP-AI", reactedMid: "m-cap2", reactionType: "love", emoji: "❤️", timestamp: 1_770_000_775 }, helpers);
      expect(spy).not.toHaveBeenCalled();
      expect(await jobCount("outgoing-message")).toBe(1); // capped → no second send
    } finally {
      spy.mockRestore();
    }
  });

  // a redelivered reaction is deduped BEFORE resolving/mutating the conversation.
  it("a duplicate reaction does not reopen or reorder a closed conversation", async () => {
    if (!TEST_DB) return;
    await seedReactionRule();
    const evt = { platform: "facebook", pageId: PAGE, senderId: "t24-RX", reactedMid: "m-rx", reactionType: "love", emoji: "❤️", timestamp: 1_770_002_001 };
    await w.processIncomingReaction(evt, helpers); // fires + claims, materialises conversation
    expect(await jobCount("outgoing-message")).toBe(1);
    const [cc] = await db.select().from(s.contactChannels).where(eq(s.contactChannels.platform_sender_id, "t24-RX"));
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ status: "closed", last_message_at: past }).where(eq(s.conversations.contact_id, cc.contact_id));
    await w.processIncomingReaction(evt, helpers); // redelivery
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.contact_id, cc.contact_id));
    expect(conv.status).toBe("closed");
    expect(conv.last_message_at?.getTime()).toBe(past.getTime());
    expect(await jobCount("outgoing-message")).toBe(1);
  });
});

describe("outgoing-private-reply worker", () => {
  // contactId is required on the job — supplying it (no `as never`) keeps the GDPR-cascade column
  // exercised: runDelivery stamps it on the ledger so an erasure reaches private replies.
  it("sends a private reply and records a sent outbound message", async () => {
    if (!TEST_DB) return;
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, contactId: CONTACT, commentId: "cmt-pr", text: "hi via DM" }, helpers);
    expect(provider.sendPrivateReply).toHaveBeenCalled();
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("hi via DM");
    // Must store the provider message id so the inbound echo of this DM dedups against it (no dup row).
    expect(sent[0].platform_message_id).toBe("PR-PMID");
  });

  // A comment-triggered DM must land in the contact's DM thread, NOT the comment thread it was
  // passed — so the inbox keeps comment and DM as two separate threads.
  it("routes a comment-triggered DM to the contact's DM thread, not the comment thread", async () => {
    if (!TEST_DB) return;
    const [commentConv] = await db
      .insert(s.conversations)
      .values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "comment", thread_ref: "POST-Z" })
      .returning({ id: s.conversations.id });
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: commentConv.id, contactId: CONTACT, commentId: "cmt-split", text: "DM not in comment thread" }, helpers);

    // nothing landed in the comment thread …
    const inComment = await db.select().from(s.messages).where(eq(s.messages.conversation_id, commentConv.id));
    expect(inComment.length).toBe(0);
    // … it went to the contact's DM thread (the default-seeded CONV is that dm thread)
    const inDm = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.text, "DM not in comment thread")));
    expect(inDm.length).toBe(1);
  });

  // a comment→DM flips the comment-log's dm_sent (mirrors the public worker's reply_sent),
  // scoped by (commentId, channelId), so "did this comment get a DM?" is queryable.
  it("flips comment_logs.dm_sent for the (comment, channel) once the private reply is sent", async () => {
    if (!TEST_DB) return;
    await db.insert(s.commentLogs).values({
      channel_id: CH, workspace_id: WS, post_id: "p-dm", platform_comment_id: "cmt-dmsent",
      author_id: "FAN-DM", comment_text: "info",
    });
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, contactId: CONTACT, commentId: "cmt-dmsent", text: "hi via DM" }, helpers);
    const [log] = await db.select().from(s.commentLogs).where(and(eq(s.commentLogs.channel_id, CH), eq(s.commentLogs.platform_comment_id, "cmt-dmsent")));
    expect(log.dm_sent).toBe(true);
  });

  it("holds (not fails) when the channel breaker is open", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, contactId: CONTACT, commentId: "cmt-pr2", text: "x" }, helpers);
    expect(provider.sendPrivateReply).not.toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });

  it("holds + flags needs_reauth when the token is invalid", async () => {
    if (!TEST_DB) return;
    provider.sendPrivateReply.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: CONV, contactId: CONTACT, commentId: "cmt-pr3", text: "x" }, helpers);
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
  });

  // a private reply stamps contact_id on the delivery ledger, so erasing the
  // contact cascades the row away (PII in the parked payload can't outlive the contact).
  it("stamps contact_id so a contact erasure cascades to its private-reply deliveries", async () => {
    if (!TEST_DB) return;
    const [c] = await db.insert(s.contacts).values({ workspace_id: WS }).returning({ id: s.contacts.id });
    const [conv] = await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: c.id, platform: "facebook" }).returning({ id: s.conversations.id });
    await w.processOutgoingPrivateReply({ channelId: CH, conversationId: conv.id, contactId: c.id, commentId: "cmt-cascade", text: "hi" }, helpers);
    const before = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.contact_id, c.id));
    expect(before.length).toBe(1);
    await db.delete(s.contacts).where(eq(s.contacts.id, c.id));
    const after = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.contact_id, c.id));
    expect(after.length).toBe(0);
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

  // Meta 24h messaging window → HUMAN_AGENT tag for human replies sent past it.
  it("manual reply WITHIN the 24h window → no HUMAN_AGENT tag (standard RESPONSE)", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ last_inbound_at: new Date() }).where(eq(s.conversations.id, CONV));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-win-in", isManual: true }) as never, helpers);
    expect(provider.sendMessage).toHaveBeenCalled();
    expect((provider.sendMessage.mock.calls[0] as unknown[])[3]).toBeUndefined();
  });

  it("manual reply PAST the 24h window → sends with the HUMAN_AGENT tag", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ last_inbound_at: new Date(Date.now() - 48 * 60 * 60 * 1000) }).where(eq(s.conversations.id, CONV));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-win-out", isManual: true }) as never, helpers);
    expect((provider.sendMessage.mock.calls[0] as unknown[])[3]).toEqual({ messagingTag: "HUMAN_AGENT" });
  });

  it("automated reply past the window does NOT use the HUMAN_AGENT tag (bots stay RESPONSE)", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ last_inbound_at: new Date(Date.now() - 48 * 60 * 60 * 1000) }).where(eq(s.conversations.id, CONV));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-win-auto" }) as never, helpers);
    expect((provider.sendMessage.mock.calls[0] as unknown[])[3]).toBeUndefined();
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

  // an undecryptable stored token (corrupt token / rotated ENCRYPTION_KEY) must
  // degrade exactly like a dead token: hold + needs_reauth + alert, NOT crash-loop to dead-letter
  // with no operator signal. The send callback never even reaches the provider.
  it("holds + flags needs_reauth when the stored token cannot be decrypted", async () => {
    if (!TEST_DB) return;
    decryptTokens.mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    await w.processOutgoingMessage(job({ idempotencyKey: "d-decfail" }) as never, helpers);
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(health.markChannelNeedsReauth).toHaveBeenCalled();
    const held = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "held")));
    expect(held.length).toBe(1);
    const row = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "d-decfail") });
    expect(row?.status).toBe("held"); // parked, not failed/dead-lettered
  });

  // a messaging-policy rejection (e.g. outside the 24h window) is terminal: the delivery
  // is dropped (expired) and NOT rethrown, so a stale step can't grind every retry to dead-letter.
  it("drops (expired, no rethrow) on a messaging-policy rejection", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValueOnce(new MessagingPolicyError("outside the allowed messaging window"));
    await expect(
      w.processOutgoingMessage(job({ idempotencyKey: "d-policy" }) as never, helpers),
    ).resolves.toBeUndefined(); // does not throw → graphile will not retry
    const row = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "d-policy") });
    expect(row?.status).toBe("expired");
    expect(health.markChannelNeedsReauth).not.toHaveBeenCalled();
  });

  // a platform rate-limit (429) is retryable, but only after its Retry-After window. The
  // delivery is recorded `failed` (reattemptable) and re-enqueued at that delay under a deterministic
  // per-delivery key, instead of being rethrown to burn graphile's short backoff budget and dead-letter.
  it("re-enqueues at Retry-After (without rethrow) on a rate-limit rejection", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValueOnce(new RateLimitError("rate limited", 120_000));
    await expect(
      w.processOutgoingMessage(job({ idempotencyKey: "d-rl" }) as never, helpers),
    ).resolves.toBeUndefined(); // not rethrown → graphile does not also retry the current job
    const row = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "d-rl") });
    expect(row?.status).toBe("failed");
    const jobs = await db.execute(
      sql`select key, run_at > now() as future from graphile_worker.jobs where task_identifier = 'outgoing-message'`,
    );
    expect(jobs.rows.length).toBe(1);
    expect((jobs.rows[0] as { key: string }).key).toBe("ratelimit:d-rl");
    expect((jobs.rows[0] as { future: boolean }).future).toBe(true);
  });

  // the rate-limit retry adds a random spread on top of Retry-After, so a throttled burst
  // that all got the same value doesn't re-collide the instant the window opens. With a stubbed RNG
  // the delay is Retry-After + floor(rng * min(Retry-After, 30s)) = 10s + 5s = ~15s, not the bare 10s.
  it("adds jitter on top of Retry-After when re-enqueueing a rate-limited delivery", async () => {
    if (!TEST_DB) return;
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      provider.sendMessage.mockRejectedValueOnce(new RateLimitError("rate limited", 10_000));
      await w.processOutgoingMessage(job({ idempotencyKey: "d-jit" }) as never, helpers);
      const r = await db.execute(sql`select extract(epoch from (run_at - now())) as secs from graphile_worker.jobs where key = 'ratelimit:d-jit'`);
      const secs = Number((r.rows[0] as { secs: number }).secs);
      expect(secs).toBeGreaterThan(12); // jittered well past the bare 10s
      expect(secs).toBeLessThan(17);
    } finally {
      rng.mockRestore();
    }
  });

  // a Retry-After of exactly 0 still gets non-zero jitter (no re-collision at delay 0).
  it("still jitters a rate-limit retry when Retry-After is 0", async () => {
    if (!TEST_DB) return;
    const rng = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      provider.sendMessage.mockRejectedValueOnce(new RateLimitError("rate limited", 0));
      await w.processOutgoingMessage(job({ idempotencyKey: "d-jit0" }) as never, helpers);
      const r = await db.execute(sql`select extract(epoch from (run_at - now())) as secs from graphile_worker.jobs where key = 'ratelimit:d-jit0'`);
      expect(Number((r.rows[0] as { secs: number }).secs)).toBeGreaterThan(0); // floored window → non-zero delay
    } finally {
      rng.mockRestore();
    }
  });

  // an automated send re-checks consent at delivery time: a contact who unsubscribed in the
  // window between enqueue and send is not messaged.
  it("skips an automated outgoing message to a contact unsubscribed after enqueue", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-unsub" }) as never, helpers);
    expect(provider.sendMessage).not.toHaveBeenCalled();
    const sent = await db.select().from(s.messages).where(and(eq(s.messages.conversation_id, CONV), eq(s.messages.status, "sent")));
    expect(sent.length).toBe(0);
  });

  // A human's OWN manual reply (sentByUserId) is exempt — unsubscribe governs automation, not a
  // human agent answering a live conversation.
  it("still sends a human's manual reply to an unsubscribed contact", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-manual", sentByUserId: "operator-1" }) as never, helpers);
    expect(provider.sendMessage).toHaveBeenCalled();
  });

  // an API-key manual reply nulls sentByUserId (it's a users.id FK), so the human-agent
  // exemption must key on the explicit isManual flag, not sentByUserId. Both the consent re-check
  // and the send-while-paused exemption must honour it.
  it("sends an isManual reply (no sentByUserId) to an unsubscribed contact", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-manual-api", isManual: true }) as never, helpers);
    expect(provider.sendMessage).toHaveBeenCalled();
  });

  it("sends an isManual reply while the channel is paused", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-manual-paused", isManual: true }) as never, helpers);
    expect(provider.sendMessage).toHaveBeenCalled();
  });

  it("an automated send (no isManual, no sentByUserId) to an unsubscribed contact is still dropped", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    await w.processOutgoingMessage(job({ idempotencyKey: "d-auto" }) as never, helpers);
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });
});

// the durable delivery state machine. The provider call sits between a committed
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

  // if the token-invalid handler's own park bookkeeping fails, the delivery must NOT
  // be left stuck in `sending` (a retry would drop it as an `unknown` crash). It is demoted to
  // `failed` (reattemptable) and the error rethrown so the retry re-sends.
  it("demotes to failed (not stuck sending) when the token-invalid park bookkeeping throws", async () => {
    if (!TEST_DB) return;
    const { runDelivery } = await import("./delivery");
    await expect(
      runDelivery({
        deliveryKey: "d-tokfail",
        channelId: CH,
        taskName: "outgoing-message",
        payload: { contactId: CONTACT },
        helpers,
        send: async () => {
          throw new TokenInvalidError("dead");
        },
        onSent: async () => {},
        onHeld: async () => {
          throw new Error("park failed");
        },
      }),
    ).rejects.toThrow("park failed");
    expect((await delivery("d-tokfail"))?.status).toBe("failed");
  });
});

// every outbound type parks the FULL typed operation on the ledger when the channel
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
  it("posts a reply and marks the comment log reply_sent, persisting the new comment id", async () => {
    if (!TEST_DB) return;
    await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, platform_comment_id: "cmt-out", comment_text: "x" });
    await w.processOutgoingComment({ channelId: CH, commentId: "cmt-out", text: "reply", idempotencyKey: "d-cmt-out" } as never, helpers);
    expect(provider.sendComment).toHaveBeenCalled();
    const log = await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "cmt-out"));
    expect(log[0].reply_sent).toBe(true);
    // the posted comment's id is captured on the delivery ledger (reliably populated).
    const del = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "d-cmt-out") });
    expect(del?.platform_message_id).toBe("CMT-PMID");
  });
});

describe("outgoing-first-comment worker (FIRSTCOMMENT1)", () => {
  it("posts a top-level comment on the published post via commentOnPost and records the delivery", async () => {
    if (!TEST_DB) return;
    await w.processOutgoingFirstComment(
      { channelId: CH, postId: "POST_PUB_1", text: "Link in comments 👇", idempotencyKey: "d-first-1" } as never,
      helpers,
    );
    expect(provider.commentOnPost).toHaveBeenCalledWith({ access_token: "x" }, "POST_PUB_1", "Link in comments 👇");
    const del = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "d-first-1") });
    expect(del?.status).toBe("sent");
    expect(del?.task_name).toBe("outgoing-first-comment");
    expect(del?.platform_message_id).toBe("FIRST-PMID");
  });

  it("is idempotent: re-running the same delivery key does not double-post", async () => {
    if (!TEST_DB) return;
    const job = { channelId: CH, postId: "POST_PUB_2", text: "First!", idempotencyKey: "d-first-2" } as never;
    await w.processOutgoingFirstComment(job, helpers);
    await w.processOutgoingFirstComment(job, helpers);
    expect(provider.commentOnPost).toHaveBeenCalledTimes(1);
  });
});

describe("sequence-step worker", () => {
  const seedEnrollment = async (steps: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => {
    const [seq] = await db.insert(s.sequences).values({
      workspace_id: WS, name: "Seq", status: "active", steps,
    }).returning({ id: s.sequences.id });
    const [enr] = await db.insert(s.sequenceEnrollments).values({
      sequence_id: seq.id, contact_id: CONTACT, channel_id: CH, status: "active", current_step_index: 0,
      steps_snapshot: steps, ...over,
    }).returning({ id: s.sequenceEnrollments.id });
    return { seqId: seq.id, enrId: enr.id };
  };

  it("sends a message step and advances / completes", async () => {
    if (!TEST_DB) return;
    const { enrId } = await seedEnrollment([{ type: "message", content: "hi" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    expect(await jobCount("outgoing-message")).toBe(1);
    const after = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(after?.status).toBe("completed");
  });

  // a re-run of the same step (a retry whose advance didn't stick) must not enqueue a
  // second outbound or a second next-step: the deterministic per-step job keys dedup.
  it("re-running the same step does not double-send (idempotent per step)", async () => {
    if (!TEST_DB) return;
    const { enrId } = await seedEnrollment([{ type: "message", content: "one" }, { type: "message", content: "two" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    expect(await jobCount("sequence-step")).toBe(1);

    // Simulate a retry of step 0 (its advance didn't commit): rewind the cursor and re-run.
    await db.update(s.sequenceEnrollments).set({ current_step_index: 0, status: "active" }).where(eq(s.sequenceEnrollments.id, enrId));
    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    // Still exactly one outbound for step 0 and one next-step job — the job keys deduped.
    expect(await jobCount("outgoing-message")).toBe(1);
    expect(await jobCount("sequence-step")).toBe(1);
  });

  // an enrollment is driven by the steps snapshot it captured, NOT the live sequence.
  it("uses the enrollment's pinned snapshot even after the sequence definition is edited", async () => {
    if (!TEST_DB) return;
    const { seqId, enrId } = await seedEnrollment([{ type: "message", content: "v1 original" }]);
    // The sequence definition is edited AFTER enrollment (steps reordered/rewritten).
    await db.update(s.sequences).set({ steps: [{ type: "message", content: "v2 rewritten" }] }).where(eq(s.sequences.id, seqId));

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    // The worker sent the V1 content from the snapshot, not the edited V2 content.
    const r = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    expect((r.rows[0] as { payload: { content: { text: string } } }).payload.content.text).toBe("v1 original");
  });

  // an unsubscribed contact is not sent a sequence step, but the enrollment still
  // advances (so it resumes naturally if they re-subscribe before a later step).
  it("does not send a sequence step to an unsubscribed contact, but advances", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    const { enrId } = await seedEnrollment([{ type: "message", content: "hi" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    expect(await jobCount("outgoing-message")).toBe(0);
    const after = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(after?.status).toBe("completed"); // advanced past the (skipped) step
  });

  // a conversation with automation paused HOLDS the drip: no send, no cursor advance,
  // and the step is deferred so it resumes from the same place once un-paused.
  it("holds (no send, no advance) a sequence step when the conversation is automation-paused", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ is_automation_paused: true }).where(eq(s.conversations.id, CONV));
    const { enrId } = await seedEnrollment([{ type: "message", content: "hi" }, { type: "message", content: "two" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    // Nothing sent and the cursor stays on step 0 (active) — the drip is held, not skipped.
    expect(await jobCount("outgoing-message")).toBe(0);
    const after = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(after?.current_step_index).toBe(0);
    expect(after?.status).toBe("active");
    // A deferred re-check job was enqueued so it resumes after un-pause.
    expect(await jobCount("sequence-step")).toBe(1);

    // Un-pausing and re-running delivers the step and advances.
    await db.update(s.conversations).set({ is_automation_paused: false }).where(eq(s.conversations.id, CONV));
    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
    const resumed = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });

    expect(resumed?.current_step_index).toBe(1);
  });

  // the pause must freeze a DELAY step too. Previously the is_automation_paused check sat
  // inside the message branch, so a delay step "counted down" during the pause and advanced the
  // cursor. A paused conversation holds every step type, then resumes from the same place.
  it("holds a delay step (no advance) when the conversation is automation-paused", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ is_automation_paused: true }).where(eq(s.conversations.id, CONV));
    const { enrId } = await seedEnrollment([{ type: "delay", delay_minutes: 60 }, { type: "message", content: "after" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    // The cursor stays on the delay step (0), active — it did not count down during the pause.
    const held = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(held?.current_step_index).toBe(0);
    expect(held?.status).toBe("active");
    expect(await jobCount("sequence-step")).toBe(1); // deferred re-check only

    // Un-pausing and re-running advances past the delay to the next step.
    await db.update(s.conversations).set({ is_automation_paused: false }).where(eq(s.conversations.id, CONV));
    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);
    const resumedDelay = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(resumedDelay?.current_step_index).toBe(1);
  });

  // a paused CHANNEL holds the drip just like a paused conversation: no send, no advance,
  // deferred re-check. Otherwise the step's message parks `held` and can expire during a long pause.
  it("holds (no send, no advance) a sequence step when the channel is paused", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    const { enrId } = await seedEnrollment([{ type: "message", content: "hi" }, { type: "message", content: "two" }]);

    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);

    expect(await jobCount("outgoing-message")).toBe(0);
    const after = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(after?.current_step_index).toBe(0);
    expect(after?.status).toBe("active");
    expect(await jobCount("sequence-step")).toBe(1); // deferred re-check only

    // Un-pausing the channel resumes and delivers the step.
    await db.update(s.channels).set({ status: "active" }).where(eq(s.channels.id, CH));
    await w.processSequenceStep({ enrollmentId: enrId } as never, helpers);
    expect(await jobCount("outgoing-message")).toBe(1);
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
    // The token write + health flip now share a transaction, so the flip is called with the tx
    // executor (CH, now, tx) rather than just the id.
    expect(health.markChannelHealthy).toHaveBeenCalledWith(CH, expect.any(Date), expect.anything());
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

  // a per-recipient PERMANENT failure on the live follow-check (e.g. the user
  // deleted their account → MessagingPolicyError) drops the gate terminally: no child enqueued,
  // no channel re-auth, no retry/dead-letter. The ledger records it `expired`.
  it("drops the gate terminally when the follow check hits a permanent policy error", async () => {
    if (!TEST_DB) return;
    provider.checkFollowsBusiness.mockRejectedValueOnce(new MessagingPolicyError("recipient is permanently unreachable"));
    await w.processFollowGate(fgJob({ idempotencyKey: "fg-policy-drop" }) as never, helpers);
    expect(health.markChannelNeedsReauth).not.toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
    const [row] = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.delivery_key, "fg-policy-drop"));
    expect(row.status).toBe("expired");
  });

  // a contact that unsubscribed after the gate was enqueued is not delivered to; the
  // worker re-checks is_subscribed and drops without probing the follow graph (closes the gap).
  it("drops the gate without a follow-check or send when the contact is unsubscribed", async () => {
    if (!TEST_DB) return;
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    await w.processFollowGate(fgJob() as never, helpers);
    expect(provider.checkFollowsBusiness).not.toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  // a contact erased mid-flight (the contactId no longer resolves) is treated the same
  // as unsubscribed: drop without probing the follow graph or enqueuing a child. Matches the
  // sequence worker's `!contact?.is_subscribed` guard.
  it("drops the gate without a follow-check or send when the contact no longer exists", async () => {
    if (!TEST_DB) return;
    await w.processFollowGate(
      fgJob({ contactId: "11111111-0000-4000-8000-000000000099", idempotencyKey: "fg-absent" }) as never,
      helpers,
    );
    expect(provider.checkFollowsBusiness).not.toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  // a paused channel must not even probe the follow graph or pin an outcome; the gate
  // is parked so a drain re-runs the live follow-check from scratch after resume.
  it("parks the gate without a follow-check or send when the channel is paused", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await w.processFollowGate(fgJob() as never, helpers);
    expect(provider.checkFollowsBusiness).not.toHaveBeenCalled();
    expect(await jobCount("outgoing-message")).toBe(0);
    const row = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "idem-fg") });
    expect(row?.status).toBe("held");
    expect(row?.task_name).toBe("follow-gate");
  });

  // the outcome is resolved once and pinned. A retry after the follow status flips
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

describe("webhook_events handling outcome (real Postgres)", () => {
  // Simulate the edge: log the event row first, then run the worker with payload.eventKey so its
  // CAS lands on that exact row — asserting the recorded handling_status + outcome links.
  async function logged(key: string, type: string, extra: Record<string, unknown> = {}) {
    const idem = await import("@/lib/idempotency");
    await idem.logEvent({ event_key: key, event_type: type, raw: {}, channel_id: CH, ...extra });
  }
  async function eventRow(key: string) {
    const [row] = await db.select().from(s.webhookEvents).where(eq(s.webhookEvents.event_key, key));
    return row;
  }
  async function seedDmRule(over: Record<string, unknown> = {}) {
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "DM", trigger_type: "default", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "hi" }, ...over,
    });
  }

  it("a fired DM records handling_status=fired + contact/conversation/message links", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    const key = "msg-evt-fired";
    await logged(key, "message", { sender_id: "EVT-F" });
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "EVT-F", recipientId: PAGE, mid: "evt-fired-mid", eventKey: key, text: "hello", timestamp: ts() }, helpers);
    const row = await eventRow(key);
    expect(row.handling_status).toBe("fired");
    expect(row.handled_at).toBeTruthy();
    expect(row.contact_id).toBeTruthy();
    expect(row.conversation_id).toBeTruthy();
    expect(row.message_id).toBeTruthy();
  });

  it("a no-match DM records handling_status=no_match", async () => {
    if (!TEST_DB) return;
    // no rule seeded → no match
    const key = "msg-evt-nomatch";
    await logged(key, "message", { sender_id: "EVT-NM" });
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "EVT-NM", recipientId: PAGE, mid: "evt-nm-mid", eventKey: key, text: "nothing", timestamp: ts() }, helpers);
    const row = await eventRow(key);
    expect(row.handling_status).toBe("no_match");
  });

  it("a paused-channel DM records handling_status=paused", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    const key = "msg-evt-paused";
    await logged(key, "message", { sender_id: "EVT-P" });
    await w.processIncomingMessage({ platform: "facebook", pageId: PAGE, senderId: "EVT-P", recipientId: PAGE, mid: "evt-p-mid", eventKey: key, text: "hello", timestamp: ts() }, helpers);
    expect((await eventRow(key)).handling_status).toBe("paused");
  });

  it("a self-loop comment records handling_status=ignored, no comment logged", async () => {
    if (!TEST_DB) return;
    const key = "cmt-evt-self-add";
    await logged(key, "comment", { sender_id: PAGE });
    await w.processIncomingComment({ platform: "facebook", pageId: PAGE, commentId: "evt-cmt-self", postId: "p", senderId: PAGE, senderName: "Us", text: "auto", eventKey: key, timestamp: ts() }, helpers);
    expect((await eventRow(key)).handling_status).toBe("ignored");
    expect((await db.select().from(s.commentLogs).where(eq(s.commentLogs.platform_comment_id, "evt-cmt-self"))).length).toBe(0);
  });

  it("a self-guard reaction records handling_status=ignored", async () => {
    if (!TEST_DB) return;
    const key = "reaction-evt-self";
    await logged(key, "reaction", { sender_id: PAGE });
    await w.processIncomingReaction({ platform: "facebook", pageId: PAGE, senderId: PAGE, reactedMid: "m-self-evt", reactionType: "love", emoji: "❤️", eventKey: key, timestamp: ts() }, helpers);
    expect((await eventRow(key)).handling_status).toBe("ignored");
  });

  it("a fired comment links the comment_log row", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "C", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { post_id: "p-evt" }, response_type: "text",
      response_config: { text: "x", reply_mode: "comment", comment_reply_text: "thanks!" },
    });
    const key = "cmt-evt-fired-add";
    await logged(key, "comment", { sender_id: "EVT-CMT-F" });
    await w.processIncomingComment({ platform: "facebook", pageId: PAGE, commentId: "evt-cmt-fired", postId: "p-evt", senderId: "EVT-CMT-F", senderName: "Fan", text: "anything", eventKey: key, timestamp: ts() }, helpers);
    const row = await eventRow(key);
    expect(row.handling_status).toBe("fired");
    expect(row.comment_log_id).toBeTruthy();
  });

  it("a DM whose reply fails on the final attempt records handling_status=error + detail", async () => {
    if (!TEST_DB) return;
    await seedDmRule();
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockImplementation(async (_tx, task) => {
      if (task !== "event-dispatch") throw new Error("permanent enqueue failure"); // transparent to contact.created fan-out
    });
    const key = "msg-evt-error";
    await logged(key, "message", { sender_id: "EVT-E" });
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "EVT-E", recipientId: PAGE, mid: "evt-e-mid", eventKey: key, text: "hello", timestamp: ts() };
      const helpersFinal = { logger: { info: () => {} }, job: { attempts: 3, max_attempts: 3 } } as never;
      await expect(w.processIncomingMessage(job, helpersFinal)).rejects.toThrow();
      const row = await eventRow(key);
      expect(row.handling_status).toBe("error");
      expect(row.error_detail).toContain("permanent enqueue failure");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("alert triggers (real Postgres)", () => {
  // dispatchAlert posts to CHANNEL_ALERT_WEBHOOK_URL; capture the POSTs by stubbing fetch. The
  // throttle uses the real rate_limit_counters — clear the alert keys each test so it doesn't
  // suppress across tests.
  let realFetch: typeof fetch;
  let alerts: Array<{ type: string; channel_id?: string; detail?: string }>;

  beforeEach(async () => {
    if (!TEST_DB) return;
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    await db.execute(sql`delete from rate_limit_counters where key like 'alert:%'`);
    alerts = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      alerts.push(JSON.parse(init!.body as string));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  });

  it("a transient delivery failure raises a delivery_failed alert", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValueOnce(new Error("network blip"));
    await expect(
      w.processOutgoingMessage(
        { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "alert-failed" } as never,
        helpers,
      ),
    ).rejects.toThrow();
    expect(alerts.some((a) => a.type === "delivery_failed" && a.channel_id === CH)).toBe(true);
  });

  it("a held delivery (channel needs_reauth) raises a delivery_held alert", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.id, CH));
    await w.processOutgoingMessage(
      { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: "alert-held" } as never,
      helpers,
    );
    expect(alerts.some((a) => a.type === "delivery_held" && a.channel_id === CH)).toBe(true);
  });

  it("a DM whose reply fails on the final attempt raises an event_error alert", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "DM", trigger_type: "default", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "hi" },
    });
    const qc = await import("@/lib/queue/client");
    const spy = vi.spyOn(qc, "addJobTx").mockImplementation(async (_tx, task) => {
      if (task !== "event-dispatch") throw new Error("permanent"); // transparent to contact.created fan-out
    });
    try {
      const job = { platform: "facebook", pageId: PAGE, senderId: "ALERT-EE", recipientId: PAGE, mid: "alert-ee-mid", text: "hello", timestamp: ts() };
      const helpersFinal = { logger: { info: () => {} }, job: { attempts: 3, max_attempts: 3 } } as never;
      await expect(w.processIncomingMessage(job, helpersFinal)).rejects.toThrow();
      expect(alerts.some((a) => a.type === "event_error" && a.channel_id === CH)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("the throttle collapses repeated same-channel failures into one alert in the window", async () => {
    if (!TEST_DB) return;
    provider.sendMessage.mockRejectedValue(new Error("network blip"));
    for (const key of ["thr-1", "thr-2", "thr-3"]) {
      await expect(
        w.processOutgoingMessage(
          { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: PSID, content: { text: "hi" }, idempotencyKey: key } as never,
          helpers,
        ),
      ).rejects.toThrow();
    }
    expect(alerts.filter((a) => a.type === "delivery_failed" && a.channel_id === CH).length).toBe(1);
  });
});

describe("incoming-echo worker (THREADSYNC1)", () => {
  it("records a page-sent echo as an outbound message in the thread, idempotently", async () => {
    if (!TEST_DB) return;
    const job = { platform: "facebook", pageId: PAGE, recipientId: PSID, mid: "echo-1", text: "reply from the FB app", timestamp: ts() };
    await w.processIncomingEcho(job as never, helpers);
    await w.processIncomingEcho(job as never, helpers); // dedup

    const rows = await db.query.messages.findMany({
      where: and(eq(s.messages.conversation_id, CONV), eq(s.messages.platform_message_id, "echo-1")),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe("outbound");
    expect(rows[0]!.text).toBe("reply from the FB app");
    expect(rows[0]!.delivered_at).not.toBeNull(); // an echo means it left Meta → delivered
  });

  it("does not duplicate one of our own already-recorded sends (same mid)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.messages).values({ conversation_id: CONV, direction: "outbound", text: "our send", platform_message_id: "echo-2" });
    await w.processIncomingEcho({ platform: "facebook", pageId: PAGE, recipientId: PSID, mid: "echo-2", text: "our send", timestamp: ts() } as never, helpers);
    const rows = await db.query.messages.findMany({ where: and(eq(s.messages.conversation_id, CONV), eq(s.messages.platform_message_id, "echo-2")) });
    expect(rows).toHaveLength(1);
  });
});

describe("incoming-receipt worker (THREADSYNC1)", () => {
  it("stamps delivered_at, then read_at (read implies delivered), on outbound messages", async () => {
    if (!TEST_DB) return;
    await db.insert(s.messages).values({ conversation_id: CONV, direction: "outbound", text: "hi there", platform_message_id: "out-r1" });
    const future = Date.now() + 60_000;

    await w.processIncomingReceipt({ platform: "facebook", pageId: PAGE, userId: PSID, kind: "delivered", watermark: future } as never, helpers);
    let m = await db.query.messages.findFirst({ where: eq(s.messages.platform_message_id, "out-r1") });
    expect(m!.delivered_at).not.toBeNull();
    expect(m!.read_at).toBeNull();

    await w.processIncomingReceipt({ platform: "facebook", pageId: PAGE, userId: PSID, kind: "read", watermark: future } as never, helpers);
    m = await db.query.messages.findFirst({ where: eq(s.messages.platform_message_id, "out-r1") });
    expect(m!.read_at).not.toBeNull();
    expect(m!.delivered_at).not.toBeNull();
  });

  it("does not stamp inbound messages or messages newer than the watermark", async () => {
    if (!TEST_DB) return;
    await db.insert(s.messages).values({ conversation_id: CONV, direction: "inbound", text: "their msg", platform_message_id: "in-r1" });
    await w.processIncomingReceipt({ platform: "facebook", pageId: PAGE, userId: PSID, kind: "read", watermark: Date.now() - 60_000 } as never, helpers);
    const m = await db.query.messages.findFirst({ where: eq(s.messages.platform_message_id, "in-r1") });
    expect(m!.read_at).toBeNull(); // inbound, and before-watermark guard
  });
});
