import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_approvals_key_abcdef0123456789";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let approvals: typeof import("./approvals/route");
let approve: typeof import("./approvals/[approvalId]/approve/route");
let reject: typeof import("./approvals/[approvalId]/reject/route");
let rules: typeof import("./rules/route");
let ruleById: typeof import("./rules/[ruleId]/route");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-4000-8000-0000000000e1";
const WS2 = "eeeeeeee-0000-4000-8000-0000000000e2";
const CH = "eeeeeeee-0000-4000-8000-0000000000e3";
const CONTACT = "eeeeeeee-0000-4000-8000-0000000000e4";
const CONV = "eeeeeeee-0000-4000-8000-0000000000e5";
let RULE = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  approvals = await import("./approvals/route");
  approve = await import("./approvals/[approvalId]/approve/route");
  reject = await import("./approvals/[approvalId]/reject/route");
  rules = await import("./rules/route");
  ruleById = await import("./rules/[ruleId]/route");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
  for (const ws of [WS, WS2]) {
    await db.insert(s.workspaces).values({ id: ws, name: "A", slug: `a-${ws}` });
  }
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-A", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open" });
  const [r] = await db.insert(s.autoReplyRules).values({
    workspace_id: WS, name: "Gated", trigger_type: "keyword", is_active: true, cooldown_seconds: 0,
    trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
    response_type: "text", response_config: { text: "hello" }, requires_approval: true,
  }).returning({ id: s.autoReplyRules.id });
  RULE = r.id;
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "sk_live_ap" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
  if (closeQueue) await closeQueue();
});

const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (qs = "") => new Request(`http://x${qs}`, { headers: { authorization: `Bearer ${KEY}` } });
const ctx = (id: string) => ({ params: Promise.resolve({ approvalId: id }) });

async function seedApproval(over: Record<string, unknown> = {}, content: unknown = { text: "Proposed reply" }) {
  const [a] = await db.insert(s.pendingApprovals).values({
    workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT, channel_id: CH,
    recipient_platform_id: "PSID-A", proposed_content: { content }, ...over,
  }).returning({ id: s.pendingApprovals.id });
  return a.id;
}
async function outgoingCount() {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'`);
  return Number((r.rows[0] as { n: number }).n);
}

describe("approval workflow (real Postgres)", () => {
  it("a rule can be created with requires_approval via the API", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "NeedsReview", trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "yo", match_type: "contains" }] },
      response_type: "text", response_config: { text: "hi" }, requires_approval: true,
    }));
    expect(res.status).toBe(201);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(s.autoReplyRules.workspace_id, WS), eq(s.autoReplyRules.name, "NeedsReview")) });
    expect(rule?.requires_approval).toBe(true);
  });

  it("rejects requires_approval on a follow_gate rule (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "BadGate", trigger_type: "postback", trigger_config: { payload: "X" },
      response_type: "follow_gate",
      response_config: { followed: { text: "a" }, not_followed: { text: "b", buttons: [{ title: "B", payload: "X" }] } },
      requires_approval: true,
    }));
    expect(res.status).toBe(422);
  });

  it("allows requires_approval on a comment trigger with reply_mode both (comment + DM are both parked)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "GatedBoth", trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text", response_config: { text: "hi", reply_mode: "both", comment_reply_text: "Check DMs" }, requires_approval: true,
    }));
    expect(res.status).toBe(201);
  });

  it("lists pending approvals (and not resolved ones)", async () => {
    if (!TEST_DB) return;
    const pendingId = await seedApproval();
    await seedApproval({ status: "approved" });
    const res = await approvals.GET(get("/approvals?status=pending"));
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.map((a: { id: string }) => a.id)).toEqual([pendingId]);
    expect(data[0].proposed_content.content.text).toBe("Proposed reply");
  });

  it("approve sends the parked reply and marks it approved", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval({}, { text: "Approved msg", buttons: [{ title: "Go", payload: "GO" }] });
    const res = await approve.POST(post({}), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "approved", queued: true });
    expect(await outgoingCount()).toBe(1);
    const job = await db.execute(sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`);
    const payload = (job.rows[0] as { payload: { content: { text: string; buttons: unknown }; recipientPlatformId: string; idempotencyKey: string } }).payload;
    expect(payload.content.text).toBe("Approved msg");
    expect(payload.recipientPlatformId).toBe("PSID-A");
    expect(payload.idempotencyKey).toBe(`approval:${id}`); // deterministic → retry-safe
    const row = await db.query.pendingApprovals.findFirst({ where: eq(s.pendingApprovals.id, id) });
    expect(row?.status).toBe("approved");
    expect(row?.resolved_at).toBeTruthy();
  });

  it("approve of a comment+DM proposal sends BOTH the public comment and the DM (as a private reply)", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval(
      { proposed_content: { content: { text: "Check your DMs 📩" }, comment: { text: "Sent you a DM 🙌", commentId: "CMT-9" } } },
    );
    const res = await approve.POST(post({}), ctx(id));
    expect(res.status).toBe(200);
    const jobs = await db.execute(sql`select j.task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id`);
    const byTask = new Map((jobs.rows as { task_identifier: string; payload: Record<string, unknown> }[]).map((r) => [r.task_identifier, r.payload]));
    // Public comment reply, addressed to the triggering comment.
    expect(byTask.get("outgoing-comment")).toMatchObject({ commentId: "CMT-9", text: "Sent you a DM 🙌" });
    // The DM goes out as a private reply (by comment_id), NOT a PSID-addressed outgoing-message.
    expect(byTask.get("outgoing-private-reply")).toMatchObject({ commentId: "CMT-9", text: "Check your DMs 📩" });
    expect(byTask.has("outgoing-message")).toBe(false);
  });

  it("reject discards the parked reply without sending", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const res = await reject.POST(post({}), ctx(id));
    expect(res.status).toBe(200);
    expect(await outgoingCount()).toBe(0);
    const row = await db.query.pendingApprovals.findFirst({ where: eq(s.pendingApprovals.id, id) });
    expect(row?.status).toBe("rejected");
  });

  it("double-approve sends only once (409 on the second)", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const first = await approve.POST(post({}), ctx(id));
    const second = await approve.POST(post({}), ctx(id));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await outgoingCount()).toBe(1);
  });

  // the lifetime send-count is charged on the actual send (approve), not when the
  // proposal is parked, so a reject costs nothing and approve counts exactly once.
  it("reject consumes no send-count; approve counts the send once", async () => {
    if (!TEST_DB) return;
    await db.update(s.autoReplyRules).set({ max_sends_per_contact: 5 }).where(eq(s.autoReplyRules.id, RULE));
    const sentCount = async () => {
      const rows = await db.select().from(s.ruleSendCounts).where(and(eq(s.ruleSendCounts.rule_id, RULE), eq(s.ruleSendCounts.contact_id, CONTACT)));
      return rows.reduce((n, r) => n + r.count, 0);
    };
    await reject.POST(post({}), ctx(await seedApproval()));
    expect(await sentCount()).toBe(0);
    await approve.POST(post({}), ctx(await seedApproval()));
    expect(await sentCount()).toBe(1);
  });

  it("cannot approve another workspace's approval (404)", async () => {
    if (!TEST_DB) return;
    const [a] = await db.insert(s.pendingApprovals).values({
      workspace_id: WS2, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT, channel_id: CH,
      recipient_platform_id: "PSID-X", proposed_content: { content: { text: "x" } },
    }).returning({ id: s.pendingApprovals.id });
    const res = await approve.POST(post({}), ctx(a.id));
    expect(res.status).toBe(404);
    expect(await outgoingCount()).toBe(0);
  });

  // deleting a rule that still has a `pending` approval would CASCADE-destroy the
  // human-review entry. Block it with a 409 (symmetric with sequence/channel delete guards); once
  // the approval is resolved, the delete goes through.
  it("DELETE a rule with a pending approval is blocked (409); succeeds once resolved", async () => {
    if (!TEST_DB) return;
    const approvalId = await seedApproval();
    const del = () =>
      ruleById.DELETE(new Request("http://x", { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } }), {
        params: Promise.resolve({ ruleId: RULE }),
      });
    expect((await del()).status).toBe(409);
    // The pending approval survived — not silently cascade-destroyed.
    expect(await db.query.pendingApprovals.findFirst({ where: eq(s.pendingApprovals.id, approvalId) })).toBeTruthy();
    // Resolve it, then the rule can be deleted.
    await reject.POST(post({}), ctx(approvalId));
    expect((await del()).status).toBe(204);
  });

  it("approve with empty content resolves without enqueueing", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval({}, null);
    const res = await approve.POST(post({}), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).data.queued).toBe(false);
    expect(await outgoingCount()).toBe(0);
  });

  // a contact can unsubscribe AFTER a reply is parked (the approval can sit for an
  // unbounded time). The approve path must re-check consent like the sequence/follow-gate workers:
  // the human's decision is still recorded (approved), but nothing goes out to an unsubscribed
  // contact, and the rule's limits are not charged for a send that never happened.
  it("does not send on approve when the contact unsubscribed after parking", async () => {
    if (!TEST_DB) return;
    await db.update(s.autoReplyRules).set({ max_sends_per_contact: 5 }).where(eq(s.autoReplyRules.id, RULE));
    const id = await seedApproval();
    await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
    const res = await approve.POST(post({}), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "approved", queued: false });
    expect(await outgoingCount()).toBe(0);
    const row = await db.query.pendingApprovals.findFirst({ where: eq(s.pendingApprovals.id, id) });
    expect(row?.status).toBe("approved"); // human acted; just nothing sent
    const counts = await db.select().from(s.ruleSendCounts).where(and(eq(s.ruleSendCounts.rule_id, RULE), eq(s.ruleSendCounts.contact_id, CONTACT)));
    expect(counts.reduce((n, r) => n + r.count, 0)).toBe(0); // limits not charged
  });
});
