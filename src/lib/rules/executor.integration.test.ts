import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let evaluateRules: typeof import("./executor").evaluateRules;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000d1";
const CH = "eeeeeeee-0000-0000-0000-0000000000d2";
const CONTACT = "eeeeeeee-0000-0000-0000-0000000000d3";
const CONV = "eeeeeeee-0000-0000-0000-0000000000d4";

const baseInput = {
  workspaceId: WS,
  channelId: CH,
  conversationId: CONV,
  contactId: CONTACT,
  recipientPlatformId: "PSID-EXEC",
  text: "hi there",
  eventType: "message" as const,
};

async function seedRule(over: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(s.autoReplyRules)
    .values({
      workspace_id: WS,
      name: "Greet",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "hello" },
      is_active: true,
      cooldown_seconds: 0,
      ...over,
    })
    .returning({ id: s.autoReplyRules.id });
  return r.id;
}

async function outgoingJobCount() {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'`);
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
  ({ evaluateRules } = await import("./executor"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.ruleCooldowns); // cooldown locks are global by (rule,contact); clear for isolation
  await db.insert(s.workspaces).values({ id: WS, name: "E", slug: `e-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-E", token_encrypted: "x", webhook_secret: "s", status: "active",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values({
    id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

describe("evaluateRules (real Postgres)", () => {
  it("fires the matching rule and enqueues an outgoing message", async () => {
    if (!TEST_DB) return;
    const id = await seedRule();
    const fired = await evaluateRules(baseInput);
    expect(fired.ruleId).toBe(id);
    expect(await outgoingJobCount()).toBe(1);
  });

  // a malformed HIGH-priority rule (e.g. an out-of-band keyword row missing `value`) must
  // not throw and decapitate matching for the whole workspace: it's skipped and a valid lower-priority
  // rule still fires.
  it("skips a malformed high-priority rule and still fires a valid lower-priority one", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Bad", trigger_type: "keyword", priority: 100, is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ match_type: "contains" }] }, // missing `value`
      response_type: "text", response_config: { text: "x" },
    });
    const goodId = await seedRule({ priority: 0 });

    const fired = await evaluateRules(baseInput);

    expect(fired.ruleId).toBe(goodId); // bad rule skipped (no throw), good rule fired
    expect(await outgoingJobCount()).toBe(1);
  });

  it("returns null and enqueues nothing when no rule matches", async () => {
    if (!TEST_DB) return;
    await seedRule();
    const fired = await evaluateRules({ ...baseInput, text: "unrelated" });
    expect(fired.ruleId).toBeNull();
    expect(await outgoingJobCount()).toBe(0);
  });

  // an unsubscribed contact receives no automated reply (and no AI is spent, because
  // the gate returns before any rule is planned). Re-subscribing restores delivery.
  it("does not fire any rule for an unsubscribed contact", async () => {
    if (!TEST_DB) return;
    await seedRule();
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    const res = await evaluateRules(baseInput);
    expect(res.outcome).toBe("no_match");
    expect(res.ruleId).toBeNull();
    expect(await outgoingJobCount()).toBe(0);

    await db.update(s.contacts).set({ is_subscribed: true }).where(eq(s.contacts.id, CONTACT));
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    expect(await outgoingJobCount()).toBe(1);
  });

  // a contactId that no longer resolves (contact erased mid-flight) is treated as
  // "do not send": no rule fires and nothing is enqueued (consistent with the sequence worker).
  it("does not fire when the contactId no longer resolves to a contact", async () => {
    if (!TEST_DB) return;
    await seedRule();
    const res = await evaluateRules({ ...baseInput, contactId: "eeeeeeee-0000-4000-8000-000000000099" });
    expect(res.outcome).toBe("no_match");
    expect(res.ruleId).toBeNull();
    expect(await outgoingJobCount()).toBe(0);
  });

  // the public comment reply carries the contact id so the delivery ledger row (and the
  // queue PII scrub) can reach the personalized reply text on erasure.
  it("stamps contactId on the outgoing-comment job", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "CmtPublic", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
      response_type: "text", response_config: { text: "see your DMs", reply_mode: "comment" },
    });
    const fired = await evaluateRules({ ...baseInput, text: "info here", eventType: "comment", commentId: "CMT-67" });
    expect(fired.ruleId).not.toBeNull();
    const job = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-comment'`);
    expect((job.rows[0] as { payload: { contactId: string } }).payload.contactId).toBe(CONTACT);
  });

  it("respects the cooldown: a second identical event does not re-fire", async () => {
    if (!TEST_DB) return;
    await seedRule({ cooldown_seconds: 3600 });
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    expect((await evaluateRules(baseInput)).ruleId).toBeNull();
    expect(await outgoingJobCount()).toBe(1);
  });

  it("routes a comment-triggered DM through outgoing-private-reply (not outgoing-message)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "CmtDM", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
      response_type: "text", response_config: { text: "DM!", reply_mode: "dm" },
    });
    const fired = await evaluateRules({ ...baseInput, text: "info here", eventType: "comment", commentId: "CMT-1" });
    expect(fired.ruleId).not.toBeNull();
    expect(await outgoingJobCount()).toBe(0);
    const pr = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-private-reply'`);
    expect(Number((pr.rows[0] as { n: number }).n)).toBe(1);
  });

  it("random_text + ai_rephrase: picks one from the pool then sends it (AI is a no-op without a key)", async () => {
    if (!TEST_DB) return;
    const pool = ["Thanks a lot!", "Cheers!", "Appreciate it!"];
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Pool", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "random_text", response_config: { messages: pool, ai_rephrase: true },
    });
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    const job = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const text = (job.rows[0] as { payload: { content: { text: string } } }).payload.content.text;
    expect(pool).toContain(text);
  });

  it("carries quick replies and buttons into the outgoing-message payload", async () => {
    if (!TEST_DB) return;
    const quick_replies = [
      { content_type: "text", title: "Yes", payload: "YES" },
      { content_type: "user_email" },
    ];
    const buttons = [{ title: "Claim", payload: "CLAIM_LM" }];
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Interactive", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text", response_config: { text: "Pick:", quick_replies, buttons },
    });
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    const job = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const content = (job.rows[0] as { payload: { content: { text: string; quick_replies: unknown; buttons: unknown } } }).payload.content;
    expect(content.text).toBe("Pick:");
    expect(content.quick_replies).toEqual(quick_replies);
    expect(content.buttons).toEqual(buttons);
  });

  it("carries a button into a comment-triggered private reply (first-touch)", async () => {
    if (!TEST_DB) return;
    const buttons = [{ title: "Chcę odebrać", payload: "CLAIM_LM" }];
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "CmtBtn", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
      response_type: "text", response_config: { text: "Tap to claim:", reply_mode: "dm", buttons },
    });
    expect((await evaluateRules({ ...baseInput, text: "info please", eventType: "comment", commentId: "CMT-9" })).ruleId).not.toBeNull();
    const job = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-private-reply'`);
    const payload = (job.rows[0] as { payload: { text: string; content: { buttons: unknown } } }).payload;
    expect(payload.text).toBe("Tap to claim:");
    expect(payload.content.buttons).toEqual(buttons);
  });

  it("routes a follow_gate postback rule to a follow-gate job (not a direct send)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Gate", trigger_type: "postback", is_active: true, cooldown_seconds: 0,
      trigger_config: { payload: "CLAIM_LM" },
      response_type: "follow_gate",
      response_config: {
        followed: { text: "Here's your guide!" },
        not_followed: { text: "Follow first 🙏", buttons: [{ title: "Chcę odebrać", payload: "CLAIM_LM" }] },
      },
    });
    const fired = await evaluateRules({ ...baseInput, text: null, postbackPayload: "CLAIM_LM" });
    expect(fired.ruleId).not.toBeNull();
    expect(await outgoingJobCount()).toBe(0); // gated — nothing sent directly
    const fg = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'follow-gate'`);
    const p = (fg.rows[0] as { payload: { followed: { text: string }; notFollowed: { text: string; buttons: Array<{ payload: string }> } } }).payload;
    expect(p.followed.text).toBe("Here's your guide!");
    expect(p.notFollowed.text).toBe("Follow first 🙏");
    expect(p.notFollowed.buttons[0].payload).toBe("CLAIM_LM");
  });

  it("fires a story_reply rule only when the message is a story reply", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Story", trigger_type: "story_reply", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "thanks for the story reply!" },
    });
    expect((await evaluateRules({ ...baseInput, text: "love it" })).ruleId).toBeNull(); // plain DM
    expect((await evaluateRules({ ...baseInput, text: "love it", isStoryReply: true })).ruleId).not.toBeNull();
    expect(await outgoingJobCount()).toBe(1);
  });

  it("queues a pending approval (no send) when the rule requires approval", async () => {
    if (!TEST_DB) return;
    const id = await seedRule({ requires_approval: true });
    const fired = await evaluateRules(baseInput);
    expect(fired.ruleId).toBe(id);
    expect(await outgoingJobCount()).toBe(0);
    const approvals = await db.select().from(s.pendingApprovals).where(eq(s.pendingApprovals.workspace_id, WS));
    expect(approvals.length).toBe(1);
    expect(approvals[0].status).toBe("pending");
    // Parks the resolved, ready-to-send content (approve-what-you-see), not the raw config.
    expect((approvals[0].proposed_content as { content: { text: string } }).content.text).toBe("hello");
  });
});
