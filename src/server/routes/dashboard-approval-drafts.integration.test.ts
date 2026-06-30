import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

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
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  for (const ws of [WS, FOREIGN_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaces).values({ id: FOREIGN_WS, name: "F", slug: `f-${FOREIGN_WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-F", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-F" });
  await db.insert(s.conversations).values({ id: CONV_DM, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "dm" });
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
