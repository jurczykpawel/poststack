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

const WS = "eeeeeeee-0000-0000-0000-0000000000a1";
const USER = "eeeeeeee-0000-0000-0000-0000000000a2";
const CH = "eeeeeeee-0000-0000-0000-0000000000a3";
const CONTACT = "eeeeeeee-0000-0000-0000-0000000000a4";
const CONV_DM = "eeeeeeee-0000-0000-0000-0000000000a5";
const CONV_COMMENT = "eeeeeeee-0000-0000-0000-0000000000a6";
const FOREIGN = "eeeeeeee-0000-0000-0000-0000000000a7";

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
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-E", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-E" });
  // DM thread with one inbound message.
  await db.insert(s.conversations).values({ id: CONV_DM, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "dm" });
  await db.insert(s.messages).values({ conversation_id: CONV_DM, direction: "inbound", text: "Where is my order?", platform_message_id: "MID-1" });
  // Comment thread with one inbound comment (platform_message_id = comment id).
  await db.insert(s.conversations).values({ id: CONV_COMMENT, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "comment", thread_ref: "POST-1" });
  await db.insert(s.messages).values({ conversation_id: CONV_COMMENT, direction: "inbound", text: "Nice post!", platform_message_id: "CMT-99" });
  // PRO by default; the free-instance test clears it.
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function aiDraft(convId: string, body: unknown) {
  return app.request(`/inbox/${convId}/ai-draft`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "hx-request": "true" },
    body: JSON.stringify(body),
  });
}

async function aiDraftJobs() {
  const r = await db.execute(
    sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'ai-draft'`,
  );
  return (r.rows as { payload: Record<string, unknown> }[]).map((row) => row.payload);
}

describe("POST /inbox/:id/ai-draft — on-demand Generate reply", () => {
  it("enqueues an ai-draft job (source ai_manual, target dm, workspace ids) for a valid DM conversation", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_DM, { target: "dm" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.source).toBe("ai_manual");
    expect(j.target).toBe("dm");
    expect(j.workspaceId).toBe(WS);
    expect(j.channelId).toBe(CH);
    expect(j.conversationId).toBe(CONV_DM);
    expect(j.contactId).toBe(CONTACT);
    expect(j.recipientPlatformId).toBe("PSID-E");
    expect(j.incomingText).toBe("Where is my order?");
    expect(j.commentId).toBeUndefined();
  });

  it("forwards the commentId for a comment thread's public draft", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_COMMENT, { target: "public" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.target).toBe("public");
    expect(jobs[0]!.commentId).toBe("CMT-99");
    expect(jobs[0]!.source).toBe("ai_manual");
  });

  it("a foreign / missing conversation → 404, no enqueue", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(FOREIGN, { target: "dm" });
    expect(res.status).toBe(404);
    expect(await aiDraftJobs()).toHaveLength(0);
  });

  it("invalid target → 422, no enqueue", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_DM, { target: "carrier-pigeon" });
    expect(res.status).toBe(422);
    expect(await aiDraftJobs()).toHaveLength(0);
  });

  it("public target on a DM thread (no comment context) → 422, no enqueue", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_DM, { target: "public" });
    expect(res.status).toBe(422);
    expect(await aiDraftJobs()).toHaveLength(0);
  });

  it("free instance (no ai_draft feature) → PRO response, no enqueue", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const res = await aiDraft(CONV_DM, { target: "dm" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("PRO");
    expect(await aiDraftJobs()).toHaveLength(0);
  });

  // T6 gate ordering: the PRO gate runs BEFORE the target validation, so a free instance gets the
  // 403 PRO response even on a bad target (the feature, not the payload, is why it's rejected).
  it("free instance + invalid target → 403 (PRO gate before target validation), no enqueue", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const res = await aiDraft(CONV_DM, { target: "carrier-pigeon" });
    expect(res.status).toBe(403);
    expect(await aiDraftJobs()).toHaveLength(0);
  });

  // Recipient robustness: the recipient is resolved by (contact_id + channel_id) — this
  // conversation's channel — not the contact's first contact_channel on any channel. A contact
  // linked to a second channel must not bleed its identity into this channel's draft.
  it("resolves recipientPlatformId from this conversation's channel, not an unrelated contact_channel", async () => {
    if (!TEST_DB) return;
    const OTHER_CH = "eeeeeeee-0000-0000-0000-0000000000a8";
    await db.insert(s.channels).values({ id: OTHER_CH, workspace_id: WS, platform: "facebook", platform_id: "PG-OTHER", token_encrypted: "x", webhook_secret: "s", status: "active" });
    // A contact_channel on a DIFFERENT channel with a different PSID.
    await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: OTHER_CH, platform_sender_id: "PSID-OTHER" });
    const res = await aiDraft(CONV_DM, { target: "dm" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.recipientPlatformId).toBe("PSID-E");
  });
});
