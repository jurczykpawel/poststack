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
  // Comment thread — a real comment lives in commentLogs (the messages table is the DM store, so a
  // comment thread has ZERO messages rows). This mirrors prod: the on-demand draft must source the
  // comment text/id from commentLogs, not messages.
  await db.insert(s.conversations).values({ id: CONV_COMMENT, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "comment", thread_ref: "POST-1" });
  await db.insert(s.commentLogs).values({ channel_id: CH, workspace_id: WS, conversation_id: CONV_COMMENT, platform_comment_id: "CMT-99", comment_text: "Nice post!", post_id: "POST-1", author_id: "PSID-E", author_name: "Ann" });
  // PRO by default; the free-instance test clears it.
  await licenseInstance();
  gate.invalidateLicenseCache();
  // An AI provider key is present by default so the enqueue tests exercise the real path; the
  // "no AI configured" test clears it.
  process.env.AI_API_KEY = "test-key";
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

  it("forwards the commentId AND comment text for a comment thread's public draft (sourced from commentLogs, not messages)", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_COMMENT, { target: "public" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.target).toBe("public");
    expect(jobs[0]!.commentId).toBe("CMT-99");
    expect(jobs[0]!.incomingText).toBe("Nice post!");
    expect(jobs[0]!.source).toBe("ai_manual");
  });

  // ADCTX1: a comment reply enqueued with no local post record for it (the DM thread's message has
  // none, and the comment thread's post "POST-1" isn't seeded as a `posts` row in beforeEach) carries
  // no context — the LLM would see only the raw comment. Once a matching local post exists, its
  // caption rides along as `job.context` so the model knows what the comment is replying to.
  it("has no context when the comment's post has no local record (published outside PostStack)", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_COMMENT, { target: "public" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs[0]!.context).toBeUndefined();
  });

  it("prepends the parent post's caption as context when the post was published through PostStack", async () => {
    if (!TEST_DB) return;
    const [c] = await db.insert(s.content).values({ workspace_id: WS, title: "Editorial title" }).returning({ id: s.content.id });
    await db.insert(s.posts).values({ workspace_id: WS, content_id: c!.id, platform: "facebook", platform_post_id: "POST-1", description: "We shipped a new feature today!" });
    const res = await aiDraft(CONV_COMMENT, { target: "public" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs[0]!.context).toBe("Post caption: We shipped a new feature today!");
  });

  it("a DM draft (no comment) never carries post context", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_DM, { target: "dm" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs[0]!.context).toBeUndefined();
  });

  it("generates a DM (first-touch) draft for a comment thread — comment text sourced from commentLogs", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_COMMENT, { target: "dm" });
    expect(res.status).toBe(200);
    const jobs = await aiDraftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.target).toBe("dm");
    expect(jobs[0]!.incomingText).toBe("Nice post!");
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

  it("no AI provider configured → warns, disables the buttons, no enqueue (not a silent 'Draft requested')", async () => {
    if (!TEST_DB) return;
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY; // alias — must also be clear so the fallback doesn't resolve it
    try {
      const res = await aiDraft(CONV_DM, { target: "dm" });
      expect(res.status).toBe(200);
      expect(await aiDraftJobs()).toHaveLength(0);
      const html = await res.text();
      expect(html).toContain("No AI provider configured"); // the inbox banner
      expect(html).toContain('type="button" disabled'); // the Generate reply button is disabled
    } finally {
      process.env.AI_API_KEY = "test-key";
    }
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

// Bug: after clicking "Generate reply" the draft only showed up on a manual browser refresh — the
// job runs async (worker), so the enqueue response has no draft yet. Fixed with a self-terminating
// poll: GET /inbox/:id/drafts, hit by the drafts region's own hx-get, re-schedules itself until a
// draft appears (or the attempt cap is hit).
describe("GET /inbox/:id/drafts — self-terminating draft poll", () => {
  function drafts(convId: string, attempt?: number, since?: number) {
    const qs = attempt ? `?attempt=${attempt}&since=${since ?? 0}` : "";
    return app.request(`/inbox/${convId}/drafts${qs}`, { headers: { cookie } });
  }

  async function seedDraft(text: string) {
    await db.insert(s.pendingApprovals).values({
      workspace_id: WS, source: "ai_manual", conversation_id: CONV_DM, contact_id: CONTACT, channel_id: CH,
      recipient_platform_id: "PSID-E", status: "pending", proposed_content: { content: { text } },
    });
  }

  it("the enqueue response (POST .../ai-draft) starts the poll — no draft yet, so it schedules attempt=1&since=0", async () => {
    if (!TEST_DB) return;
    const res = await aiDraft(CONV_DM, { target: "dm" });
    const body = await res.text();
    expect(body).toContain(`hx-get="/inbox/${CONV_DM}/drafts?attempt=1&since=0"`);
    expect(body).toContain('hx-trigger="load delay:3s"');
  });

  it("no draft yet → reschedules itself with attempt+1, same since", async () => {
    if (!TEST_DB) return;
    const res = await drafts(CONV_DM, 3, 0);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`hx-get="/inbox/${CONV_DM}/drafts?attempt=4&since=0"`);
  });

  it("a draft now exists → renders it, with NO further hx-get (polling stops)", async () => {
    if (!TEST_DB) return;
    await seedDraft("Your order ships tomorrow.");
    const res = await drafts(CONV_DM, 2, 0);
    const body = await res.text();
    expect(body).toContain("Your order ships tomorrow.");
    expect(body).not.toMatch(/thread-drafts"[^>]*hx-get/);
  });

  it("hits the attempt cap → gives up polling (no hx-get), rendering whatever exists", async () => {
    if (!TEST_DB) return;
    const res = await drafts(CONV_DM, 20, 0);
    const body = await res.text();
    expect(body).toContain('id="thread-drafts"');
    expect(body).not.toMatch(/thread-drafts"[^>]*hx-get/);
  });

  it("a foreign/missing conversation id → 404, not another workspace's drafts", async () => {
    if (!TEST_DB) return;
    const res = await drafts(FOREIGN, 1, 0);
    expect(res.status).toBe(404);
  });

  // Regression: "generate one reply, it appears; generate a second — it doesn't appear
  // automatically." The poll used to stop the instant ANY draft existed; requesting a second draft
  // while the first (still unapproved) one was already there switched polling off immediately.
  describe("second draft while the first is still unapproved (the reported bug)", () => {
    it("with since=1 (one already existed) and still only 1 row → keeps polling AND shows the first draft", async () => {
      if (!TEST_DB) return;
      await seedDraft("First reply.");
      const res = await drafts(CONV_DM, 1, 1);
      const body = await res.text();
      expect(body).toContain("First reply.");
      expect(body).toContain('class="draft-spinner"');
      expect(body).toContain(`hx-get="/inbox/${CONV_DM}/drafts?attempt=2&since=1"`);
    });

    it("once the second row lands (count > since) → stops polling and shows BOTH drafts", async () => {
      if (!TEST_DB) return;
      await seedDraft("First reply.");
      await seedDraft("Second reply.");
      const res = await drafts(CONV_DM, 2, 1);
      const body = await res.text();
      expect(body).toContain("First reply.");
      expect(body).toContain("Second reply.");
      expect(body).not.toContain("draft-spinner");
      expect(body).not.toMatch(/thread-drafts"[^>]*hx-get/);
    });

    it("the SECOND click's enqueue response carries since=1 (the count from BEFORE this click), not since=0", async () => {
      if (!TEST_DB) return;
      await seedDraft("First reply.");
      const res = await aiDraft(CONV_DM, { target: "dm" });
      const body = await res.text();
      expect(body).toContain("First reply."); // still visible
      expect(body).toContain(`hx-get="/inbox/${CONV_DM}/drafts?attempt=1&since=1"`);
    });
  });
});
