import recorded from "../../../tests/fixtures/mqa-delivery-approval.json";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import { runOnce, type JobHelpers } from "graphile-worker";
import { and, eq, sql } from "drizzle-orm";
import type { OutgoingCommentJob, OutgoingMessageJob, OutgoingPrivateReplyJob } from "@/lib/queue/types";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const send = vi.fn();
let token: string;

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

const WS = "ffffffff-0000-0000-0000-0000000000a1";
const USER = "ffffffff-0000-0000-0000-0000000000a2";
const CH = "ffffffff-0000-0000-0000-0000000000a3";
const CONTACT = "ffffffff-0000-0000-0000-0000000000a4";
const CONV_DM = "ffffffff-0000-0000-0000-0000000000a5";
const CONV_COMMENT = "ffffffff-0000-0000-0000-0000000000a6";
const FOREIGN_WS = "ffffffff-0000-0000-0000-0000000000b1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  const { FacebookProvider } = await import("@/lib/platforms/facebook");
  vi.spyOn(FacebookProvider.prototype, "sendMessage").mockImplementation(send);
  vi.spyOn(FacebookProvider.prototype, "sendComment").mockImplementation(send);
  vi.spyOn(FacebookProvider.prototype, "sendPrivateReply").mockImplementation(send);
  const { encryptTokens } = await import("@/lib/crypto");
  token = encryptTokens({ access_token: "test" });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  send.mockReset();
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(s.webhookEvents);
  for (const ws of [WS, FOREIGN_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaces).values({ id: FOREIGN_WS, name: "F", slug: `f-${FOREIGN_WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-F", token_encrypted: token, webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-F" });
  await db.insert(s.conversations).values({ id: CONV_DM, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "dm", last_inbound_at: new Date() });
  await db.insert(s.messages).values({ conversation_id: CONV_DM, direction: "inbound", text: "Where is my order?", platform_message_id: "MID-F1" });
  await db.insert(s.conversations).values({ id: CONV_COMMENT, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "comment", thread_ref: "POST-1" });
  await db.insert(s.messages).values({ conversation_id: CONV_COMMENT, direction: "inbound", text: "Nice post!", platform_message_id: "CMT-F9" });
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, FOREIGN_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

async function seedApproval(over: Record<string, unknown> = {}, proposed: unknown = { content: { text: "Proposed reply" } }) {
  const [a] = await db
    .insert(s.pendingApprovals)
    .values({
      workspace_id: WS, source: "ai_auto", conversation_id: CONV_DM, contact_id: CONTACT, channel_id: CH,
      recipient_platform_id: "PSID-F", proposed_content: proposed, ...over,
    })
    .returning({ id: s.pendingApprovals.id });
  return a.id;
}

function get(path: string) {
  return app.request(path, { headers: { cookie, "hx-request": "true" } });
}
function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "hx-request": "true" },
    body: JSON.stringify(body ?? {}),
  });
}
function statusOf(id: string) {
  return db.query.pendingApprovals.findFirst({ where: eq(s.pendingApprovals.id, id), columns: { status: true, proposed_content: true } });
}

describe("inbox thread — pending approval drafts", () => {
  it("keeps each approval quote tied to the inbound that created it", async () => {
    const { processIncomingMessage } = await import("@/lib/workers/incoming-message-worker");
    const [rule] = await db.insert(s.autoReplyRules).values({ workspace_id: WS, name: "Review", trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "Mqa9", match_type: "contains" }] }, response_type: "text",
      response_config: { text: "Review reply" }, requires_approval: true, cooldown_seconds: 0 }).returning();
    const inboundIds: string[] = [];
    for (const message of recorded.messages) {
      await db.update(s.conversations).set({ last_message_preview: message.text }).where(eq(s.conversations.id, CONV_DM));
      await processIncomingMessage({ platform: "facebook", channelId: CH, pageId: "PG-F", recipientId: "PG-F", senderId: "PSID-F",
        mid: message.platform_message_id, text: message.text, timestamp: Date.parse(message.created_at) / 1000 },
        { logger: { info() {}, error() {} } } as unknown as import("graphile-worker").JobHelpers);
      const inbound = await db.query.messages.findFirst({ where: eq(s.messages.platform_message_id, message.platform_message_id) });
      inboundIds.push(inbound!.id);
    }
    const response = await get("/approvals");
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const message of recorded.messages) expect(body).toContain(`<blockquote class="appr-trigger">${message.text}</blockquote>`);
    const api = await app.request("/api/v1/approvals", { headers: { cookie } });
    const { data } = await api.json();
    expect(data.filter((a: { rule_id: string }) => a.rule_id === rule.id).map((a: { inboundMessageId: string }) => a.inboundMessageId).sort())
      .toEqual(inboundIds.sort());
  });

  it("omits the quote for an older approval with no source instead of showing newer activity", async () => {
    await seedApproval();
    await db.update(s.conversations).set({ last_message_preview: "Later unrelated message" }).where(eq(s.conversations.id, CONV_DM));
    expect(await (await get("/approvals")).text()).not.toContain('class="appr-trigger"');
  });

  it("quotes the originating comment and retains the approval after the source is removed", async () => {
    const [comment] = await db.insert(s.commentLogs).values({ workspace_id: WS, channel_id: CH, conversation_id: CONV_COMMENT,
      platform_comment_id: "origin-comment", comment_text: "Original comment" }).returning();
    await seedApproval({ conversation_id: CONV_COMMENT, inbound_comment_id: comment.id });
    const body = await (await get("/approvals")).text();
    expect(body).toContain('<blockquote class="appr-trigger">Original comment</blockquote>');
    await db.delete(s.commentLogs).where(eq(s.commentLogs.id, comment.id));
    const api = await app.request("/api/v1/approvals", { headers: { cookie } });
    const { data } = await api.json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ inboundMessageId: null, inboundCommentId: null });
  });

  it("renders a pending approval as a draft bubble in the thread", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const res = await get(`/inbox/${CONV_DM}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proposed reply");
    expect(html).toContain("awaiting approval");
    expect(html).toContain(`/inbox/approval/${id}/approve`);
    expect(html).toContain(`/inbox/approval/${id}/edit`);
    expect(html).toContain(`/inbox/approval/${id}/reject`);
  });

  it("a conversation with no pending approvals renders no draft bubble", async () => {
    if (!TEST_DB) return;
    const res = await get(`/inbox/${CONV_DM}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/inbox/approval/");
    expect(html).not.toContain("awaiting approval");
  });

  it("Edit updates proposed_content text (workspace-scoped) and re-renders the draft", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const res = await post(`/inbox/approval/${id}/edit`, { text: "Edited reply" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Edited reply");
    const row = await statusOf(id);
    expect(row?.status).toBe("pending");
    expect((row?.proposed_content as { content?: { text?: string } }).content?.text).toBe("Edited reply");
  });

  it("Edit on a public-comment draft updates comment.text", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval(
      { conversation_id: CONV_COMMENT, proposed_content: { comment: { text: "old", commentId: "CMT-F9" } } },
    );
    const res = await post(`/inbox/approval/${id}/edit`, { text: "new public reply" });
    expect(res.status).toBe(200);
    const row = await statusOf(id);
    const pc = row?.proposed_content as { comment?: { text?: string; commentId?: string } };
    expect(pc.comment?.text).toBe("new public reply");
    expect(pc.comment?.commentId).toBe("CMT-F9");
  });

  it("Edit on a foreign-workspace approval → 404, no change", async () => {
    if (!TEST_DB) return;
    const [foreign] = await db
      .insert(s.pendingApprovals)
      .values({
        workspace_id: FOREIGN_WS, source: "rule", conversation_id: CONV_DM, contact_id: CONTACT, channel_id: CH,
        recipient_platform_id: "PSID-F", proposed_content: { content: { text: "keep me" } },
      })
      .returning({ id: s.pendingApprovals.id });
    // conversation_id belongs to WS but the approval row's workspace is FOREIGN_WS → not the caller's.
    const res = await post(`/inbox/approval/${foreign.id}/edit`, { text: "hacked" });
    expect(res.status).toBe(404);
    const row = await statusOf(foreign.id);
    expect((row?.proposed_content as { content?: { text?: string } }).content?.text).toBe("keep me");
  });

  it("Accept reaches the existing approve handler — the draft leaves the pending set", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const res = await post(`/inbox/approval/${id}/approve`);
    expect(res.status).toBe(200);
    expect((await statusOf(id))?.status).toBe("approved");
  });

  it("Reject reaches the existing reject handler — the draft leaves the pending set", async () => {
    if (!TEST_DB) return;
    const id = await seedApproval();
    const res = await post(`/inbox/approval/${id}/reject`);
    expect(res.status).toBe(200);
    expect((await statusOf(id))?.status).toBe("rejected");
  });
});

it("reports whitespace approval edits next to the field without changing the draft", async () => {
  const id = await seedApproval();
  const before = await statusOf(id);
  const res = await post(`/approvals/${id}/edit`, { text: "   " });
  expect(res.status).toBe(422);
  expect(await res.text()).toContain("Reply text is required");
  expect(await statusOf(id)).toEqual(before);
});
it.each([
  ["/approvals", "/approvals"],
  ["/inbox/approval", `/inbox/${CONV_DM}`],
])("limits edits through %s to 2000 characters", async (prefix, screen) => {
  const id = await seedApproval();
  expect(await (await get(screen)).text()).toContain('maxlength="2000"');
  const before = await statusOf(id);
  const res = await post(`${prefix}/${id}/edit`, { text: "x".repeat(2001) });
  expect(res.status).toBe(422);
  expect(await res.text()).toContain("Reply text must be at most 2000 characters");
  expect(await statusOf(id)).toEqual(before);
  expect((await post(`${prefix}/${id}/edit`, { text: "x".repeat(2000) })).status).toBe(200);
});

const attempt = (attempts: number) => ({
  logger: { info() {} }, job: { id: "123", attempts, max_attempts: 3 },
}) as unknown as JobHelpers;

async function approvalJob<T = OutgoingMessageJob>(key: string) {
  const { rows } = await db.execute<{ payload: T }>(
    sql`select payload from graphile_worker._private_jobs where key = ${key}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0].payload;
}

it.each([
  new DOMException("Send timed out", "TimeoutError"),
  new DOMException("Send aborted", "AbortError"),
  new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }),
  Object.assign(new Error("socket closed unexpectedly"), { code: "ECONNRESET" }),
])("stops sending an approval after an ambiguous provider response (%s)", async (error) => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  const payload = await approvalJob(`approval-${id}`);
  send.mockRejectedValue(error);
  await processOutgoingMessage(payload, attempt(1));
  await processOutgoingMessage(payload, attempt(2));
  expect(send).toHaveBeenCalledTimes(1);
  const history = await (await get("/approvals")).text();
  expect(history).toContain(">Delivery unknown</span>");
  expect(history).not.toContain(`hx-post="/approvals/${id}/retry"`);
  expect((await post(`/approvals/${id}/retry`)).headers.get("HX-Trigger")).toBeNull();
});

it("keeps Graphile's existing timeout retries and terminal Inbox failure for manual replies", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const payload = {
    channelId: CH, conversationId: CONV_DM, contactId: CONTACT, recipientPlatformId: "PSID-F",
    content: { text: "Manual reply" }, isManual: true,
  };
  send.mockRejectedValue(new DOMException("Send timed out", "TimeoutError"));
  for (const n of [1, 2, 3]) await expect(processOutgoingMessage(payload, attempt(n))).rejects.toThrow("Send timed out");
  expect(send).toHaveBeenCalledTimes(3);
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Send timed out");
});

it("shows an unknown private reply when only its public counterpart can be retried", async () => {
  const { processOutgoingComment } = await import("@/lib/workers/outgoing-comment-worker");
  const { processOutgoingPrivateReply } = await import("@/lib/workers/outgoing-private-reply-worker");
  const id = await seedApproval({ conversation_id: CONV_COMMENT }, {
    content: { text: "Details by DM" }, comment: { text: "Thanks!", commentId: "CMT-F9" },
  });
  await post(`/approvals/${id}/approve`);
  send.mockRejectedValueOnce(new DOMException("Send timed out", "TimeoutError"));
  await processOutgoingPrivateReply(await approvalJob<OutgoingPrivateReplyJob>(`approval-${id}`), attempt(1));
  send.mockRejectedValueOnce(new Error("Comment unavailable"));
  await expect(processOutgoingComment(await approvalJob<OutgoingCommentJob>(`approval-${id}-comment`), attempt(3))).rejects.toThrow();
  const history = await (await get("/approvals")).text();
  expect(history).toContain(">Delivery unknown</span>");
  expect(history).toContain(">Failed</span>");
  expect((await post(`/approvals/${id}/retry`)).headers.get("HX-Trigger")).toContain("queued for retry");
  await approvalJob(`retry:approval:${id}:comment`);
  const { rows } = await db.execute(sql`select id from graphile_worker._private_jobs where key = ${`retry:approval:${id}`}`);
  expect(rows).toHaveLength(0);
});

it("records the last failure when the outgoing task throws before entering delivery", async () => {
  const { createTaskList } = await import("@/lib/queue/tasks");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  const payload = await approvalJob(`approval-${id}`);
  const task = createTaskList()["outgoing-message"]!;
  send.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(task(payload, attempt(1))).rejects.toThrow("Provider unavailable");
  vi.spyOn(db.query.conversations, "findFirst").mockRejectedValueOnce(new Error("Could not load conversation"));
  await expect(task(payload, attempt(3))).rejects.toThrow("Could not load conversation");
  expect(send).toHaveBeenCalledTimes(1);
  expect(await (await get("/approvals")).text()).toContain(`hx-post="/approvals/${id}/retry"`);
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Could not load conversation");
});

it("shows an uncertain result on the existing Inbox message when Retry times out", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  send.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(processOutgoingMessage(await approvalJob(`approval-${id}`), attempt(3))).rejects.toThrow();
  await post(`/approvals/${id}/retry`);
  send.mockRejectedValueOnce(new DOMException("Send timed out", "TimeoutError"));
  await processOutgoingMessage(await approvalJob(`retry:approval:${id}`), attempt(1));
  const thread = await (await get(`/inbox/${CONV_DM}`)).text();
  expect(thread).toContain("Delivery unknown");
  expect(thread).not.toContain("Queued");
});

it.each([null, new Date("2000-01-01")])("explains why a closed DM window blocks Retry (%s)", async (lastInbound) => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  send.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(processOutgoingMessage(await approvalJob(`approval-${id}`), attempt(3))).rejects.toThrow();
  await db.update(s.conversations).set({ last_inbound_at: lastInbound }).where(eq(s.conversations.id, CONV_DM));
  const history = await (await get("/approvals")).text();
  expect(history).not.toContain(`hx-post="/approvals/${id}/retry"`);
  expect(history).toContain("24h reply window closed");
  const retry = await post(`/approvals/${id}/retry`);
  expect(retry.headers.get("HX-Trigger")).toBeNull();
  expect(await retry.text()).toContain("24h reply window closed");
});

it("shows a final approval failure and retries the same reply once", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const { loadOverview } = await import("@/lib/stats/overview");
  const id = await seedApproval({ source: "rule" });
  const approved = await post(`/approvals/${id}/approve`);
  expect(approved.status).toBe(200);
  const payload = await approvalJob(`approval-${id}`);
  expect(await approved.text()).not.toMatch(/>Sent<\/span>/);
  send.mockRejectedValue(new Error("Provider unavailable"));
  const runOutgoing = () => runOnce({
    connectionString: TEST_DB!,
    taskList: { "outgoing-message": (job, helpers) => processOutgoingMessage(job as OutgoingMessageJob, helpers) },
  });
  for (const n of [1, 2]) {
    await runOutgoing();
    const { rows: [job] } = await db.execute<{ attempts: number }>(sql`select attempts from graphile_worker.jobs where key = ${`approval-${id}`}`);
    expect(job.attempts).toBe(n);
    expect(await (await get(`/inbox/${CONV_DM}`)).text()).not.toContain("Not delivered");
    expect(await (await get("/approvals")).text()).not.toContain(">Retry</button>");
    await db.execute(sql`update graphile_worker._private_jobs set run_at = now() where key = ${`approval-${id}`}`);
  }
  await runOutgoing();
  const { rows: [exhausted] } = await db.execute<{ attempts: number; max_attempts: number }>(
    sql`select attempts, max_attempts from graphile_worker.jobs where key = ${`approval-${id}`}`,
  );
  expect(exhausted).toEqual({ attempts: 3, max_attempts: 3 });
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Provider unavailable");
  expect(await loadOverview(WS)).toMatchObject({ failed: 1, sent: 0 });
  const history = await (await get("/approvals")).text();
  expect(history).toMatch(/>Failed<\/span>/);
  expect(history).not.toMatch(/>Sent<\/span>/);
  expect(history).toContain(`hx-post="/approvals/${id}/retry"`);
  await processOutgoingMessage(payload, attempt(3));
  expect(send).toHaveBeenCalledTimes(3);

  const retries = await Promise.all([post(`/approvals/${id}/retry`), post(`/approvals/${id}/retry`)]);
  expect(retries.map(res => res.status)).toEqual([200, 200]);
  expect(retries.filter(res => res.headers.get("HX-Trigger")?.includes("queued for retry"))).toHaveLength(1);
  const retried = await approvalJob(`retry:${payload.idempotencyKey}`);
  expect(retried.idempotencyKey).toBe(payload.idempotencyKey);
  expect(await db.query.messages.findFirst({ where: eq(s.messages.id, retried.heldMessageId!) }))
    .toMatchObject({ status: "pending", failure_reason: null });
  const thread = await (await get(`/inbox/${CONV_DM}`)).text();
  expect(thread).not.toContain("Not delivered");
  expect(thread).toContain("Queued");
  send.mockResolvedValue({ platformMessageId: "retried-approval" });
  await runOutgoing();
  const outbound = await db.query.messages.findMany({ where: and(eq(s.messages.conversation_id, CONV_DM), eq(s.messages.direction, "outbound")) });
  expect(outbound).toMatchObject([
    { text: "Proposed reply", status: "sent", failure_reason: null },
  ]);
  expect(await loadOverview(WS)).toMatchObject({ failed: 0, sent: 1 });
  expect(await (await get("/approvals")).text()).toMatch(/>Sent<\/span>/);
});

it("counts an approved AI reply refused by messaging policy", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const { MessagingPolicyError } = await import("@/lib/platforms/errors");
  const { loadOverview } = await import("@/lib/stats/overview");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  send.mockRejectedValue(new MessagingPolicyError("Window closed"));
  await processOutgoingMessage(await approvalJob(`approval-${id}`), attempt(1));
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Window closed");
  expect(await (await get("/approvals")).text()).toMatch(/>Failed<\/span>/);
  expect(await loadOverview(WS)).toMatchObject({ failed: 1, sent: 0 });
  expect((await post(`/approvals/${id}/retry`)).headers.get("HX-Trigger")).toContain("queued for retry");
  await db.update(s.contacts).set({ is_subscribed: false }).where(eq(s.contacts.id, CONTACT));
  await processOutgoingMessage(await approvalJob(`retry:approval:${id}`), attempt(1));
  expect(send).toHaveBeenCalledTimes(1);
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Contact is unsubscribed");
  const history = await (await get("/approvals")).text();
  expect(history).not.toContain(`hx-post="/approvals/${id}/retry"`);
  expect(history).toContain("Contact is unsubscribed");
  expect(await (await post(`/approvals/${id}/retry`)).text()).toContain("Contact is unsubscribed");
  expect(await loadOverview(WS)).toMatchObject({ failed: 1 });
});

it("retries only the failed private reply of a two-part approval", async () => {
  const { processOutgoingComment } = await import("@/lib/workers/outgoing-comment-worker");
  const { processOutgoingPrivateReply } = await import("@/lib/workers/outgoing-private-reply-worker");
  const id = await seedApproval({ conversation_id: CONV_COMMENT }, {
    content: { text: "Details by DM" }, comment: { text: "Thanks!", commentId: "CMT-F9" },
  });
  await post(`/approvals/${id}/approve`);
  send.mockResolvedValueOnce({ platformMessageId: "public-approved" });
  await processOutgoingComment(await approvalJob<OutgoingCommentJob>(`approval-${id}-comment`), attempt(1));
  send.mockRejectedValueOnce(new Error("Private reply unavailable"));
  await expect(processOutgoingPrivateReply(await approvalJob<OutgoingPrivateReplyJob>(`approval-${id}`), attempt(3))).rejects.toThrow();
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered — Private reply unavailable");
  expect((await post(`/approvals/${id}/retry`)).status).toBe(200);
  const retried = await approvalJob<OutgoingPrivateReplyJob>(`retry:approval:${id}`);
  const parked = () => db.query.messages.findFirst({ where: eq(s.messages.id, retried.heldMessageId!) });
  expect(await parked()).toMatchObject({ conversation_id: CONV_DM, status: "pending", failure_reason: null });
  await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
  await processOutgoingPrivateReply(retried, attempt(1));
  expect(await parked()).toMatchObject({ conversation_id: CONV_DM, status: "held", failure_reason: null });
  const thread = await (await get(`/inbox/${CONV_DM}`)).text();
  expect(thread).not.toContain("Not delivered");
  expect(thread).toContain("Held");
  expect(send).toHaveBeenCalledTimes(2);
  const { rows } = await db.execute(sql`select id from graphile_worker._private_jobs where key = ${`retry:approval:${id}:comment`}`);
  expect(rows).toHaveLength(0);
});

it("keeps automatic rule failures in Overview without adding an Inbox message", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const { loadOverview } = await import("@/lib/stats/overview");
  send.mockRejectedValue(new Error("Automatic reply unavailable"));
  await expect(processOutgoingMessage({
    channelId: CH, conversationId: CONV_DM, contactId: CONTACT, recipientPlatformId: "PSID-F",
    content: { text: "Automatic reply" }, idempotencyKey: "rule:auto",
  }, attempt(3))).rejects.toThrow();
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).not.toContain("Not delivered");
  expect(await loadOverview(WS)).toMatchObject({ failed: 1, sent: 0 });
});

it("records a final failure when the channel is disabled before the first claim", async () => {
  const { processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker");
  const { loadOverview } = await import("@/lib/stats/overview");
  const id = await seedApproval();
  await post(`/approvals/${id}/approve`);
  await db.update(s.channels).set({ status: "disabled" }).where(eq(s.channels.id, CH));
  await expect(processOutgoingMessage(await approvalJob(`approval-${id}`), attempt(3))).rejects.toThrow("disabled");
  expect(send).not.toHaveBeenCalled();
  expect(await (await get(`/inbox/${CONV_DM}`)).text()).toContain("Not delivered");
  expect(await loadOverview(WS)).toMatchObject({ failed: 1, sent: 0 });
});

it("sends a failed public reply on retry and updates its Inbox message", async () => {
  const { processOutgoingComment } = await import("@/lib/workers/outgoing-comment-worker");
  const id = await seedApproval({ conversation_id: CONV_COMMENT }, { comment: { text: "Public reply", commentId: "CMT-F9" } });
  await post(`/approvals/${id}/approve`);
  send.mockRejectedValueOnce(new Error("Comment unavailable"));
  await expect(processOutgoingComment(await approvalJob<OutgoingCommentJob>(`approval-${id}-comment`), attempt(3))).rejects.toThrow();
  expect(await (await get(`/inbox/${CONV_COMMENT}`)).text()).toContain("Not delivered — Comment unavailable");
  await post(`/approvals/${id}/retry`);
  send.mockResolvedValueOnce({ platformMessageId: "public-retried" });
  await processOutgoingComment(await approvalJob<OutgoingCommentJob>(`retry:approval:${id}:comment`), attempt(1));
  const thread = await (await get(`/inbox/${CONV_COMMENT}`)).text();
  expect(thread).not.toContain("Not delivered");
  expect(thread).toContain("Public reply");
});
it("gives the approval editor an accessible name and keyboard focus targets", async () => {
  await seedApproval();
  const body = await (await get("/approvals")).text();
  expect(body).toContain('aria-label="Reply text"');
  expect(body).toContain('$nextTick(() => $refs.ta.focus())');
  expect(body).toContain('$refs.edit.focus()');
});
it("explains the reply length limit at the field and preserves the draft", async () => {
  await db.update(s.conversations).set({ last_inbound_at: new Date() }).where(eq(s.conversations.id, CONV_DM));
  const res = await post(`/inbox/${CONV_DM}/reply`, { text: "x".repeat(2001) });
  const body = await res.text();
  expect(body).toContain("at most 2000 characters");
  expect(body).toContain('aria-invalid="true"');
  expect(body).toContain("x".repeat(2001));
});
it.each(["/contacts?open=", "/queue?open=", "/activity?source=events&open=", "/rules/"])("returns 404 for an unavailable panel %s", async (path) => {
  const id = "ffffffff-0000-0000-0000-000000000099";
  expect((await get(path + id + (path === "/rules/" ? "/edit" : ""))).status).toBe(404);
});
it("rejects rule names containing only whitespace", async () => {
  const res = await post("/api/v1/rules", { name: "   ", trigger_type: "keyword", trigger_config: { keywords: [{ value: "never", match_type: "contains" }] }, response_type: "text", response_config: { text: "Hello" } });
  expect(res.status).toBe(422);
});
