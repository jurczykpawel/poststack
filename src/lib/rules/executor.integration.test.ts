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
    expect(fired).toBe(id);
    expect(await outgoingJobCount()).toBe(1);
  });

  it("returns null and enqueues nothing when no rule matches", async () => {
    if (!TEST_DB) return;
    await seedRule();
    const fired = await evaluateRules({ ...baseInput, text: "unrelated" });
    expect(fired).toBeNull();
    expect(await outgoingJobCount()).toBe(0);
  });

  it("respects the cooldown: a second identical event does not re-fire", async () => {
    if (!TEST_DB) return;
    await seedRule({ cooldown_seconds: 3600 });
    expect(await evaluateRules(baseInput)).not.toBeNull();
    expect(await evaluateRules(baseInput)).toBeNull();
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
    expect(fired).not.toBeNull();
    expect(await outgoingJobCount()).toBe(0);
    const pr = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-private-reply'`);
    expect(Number((pr.rows[0] as { n: number }).n)).toBe(1);
  });

  it("fires a story_reply rule only when the message is a story reply", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Story", trigger_type: "story_reply", is_active: true, cooldown_seconds: 0,
      trigger_config: {}, response_type: "text", response_config: { text: "thanks for the story reply!" },
    });
    expect(await evaluateRules({ ...baseInput, text: "love it" })).toBeNull(); // plain DM
    expect(await evaluateRules({ ...baseInput, text: "love it", isStoryReply: true })).not.toBeNull();
    expect(await outgoingJobCount()).toBe(1);
  });

  it("queues a pending approval (no send) when the rule requires approval", async () => {
    if (!TEST_DB) return;
    const id = await seedRule({ requires_approval: true });
    const fired = await evaluateRules(baseInput);
    expect(fired).toBe(id);
    expect(await outgoingJobCount()).toBe(0);
    const approvals = await db.select().from(s.pendingApprovals).where(eq(s.pendingApprovals.workspace_id, WS));
    expect(approvals.length).toBe(1);
    expect(approvals[0].status).toBe("pending");
  });
});
