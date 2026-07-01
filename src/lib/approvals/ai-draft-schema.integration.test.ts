import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");

const WS = "ffffffff-0000-0000-0000-0000000000a1";
const CH = "ffffffff-0000-0000-0000-0000000000a2";
const CONTACT = "ffffffff-0000-0000-0000-0000000000a3";
const CONV = "ffffffff-0000-0000-0000-0000000000a4";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "T", slug: `t-${WS}` });
  await db.insert(s.channels).values({
    id: CH,
    workspace_id: WS,
    platform: "instagram",
    platform_id: "IG-AIDRAFT",
    token_encrypted: "x",
    webhook_secret: "s",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "C" });
  await db.insert(s.conversations).values({
    id: CONV,
    workspace_id: WS,
    channel_id: CH,
    contact_id: CONTACT,
    platform: "instagram",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  // Cascade from workspace removes channel/contact/conversation/pending_approvals.
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

// AI-draft auto-reply: a pending_approvals row can be created with NO originating rule
// (rule_id null) and an explicit `source` discriminator, so an AI-generated draft (not tied
// to a keyword rule) can sit in the approval queue exactly like a rule-generated one.
describe("AI-draft schema additions", () => {
  it("inserts a pending_approvals row with rule_id null + source=ai_auto and reads it back", async () => {
    if (!TEST_DB) return;
    const ID = "ffffffff-0000-0000-0000-0000000000a5";
    await db.insert(s.pendingApprovals).values({
      id: ID,
      workspace_id: WS,
      rule_id: null,
      source: "ai_auto",
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_id: CH,
      recipient_platform_id: "PSID-1",
      proposed_content: { type: "text", text: "hi" },
    });
    const [row] = await db.select().from(s.pendingApprovals).where(eq(s.pendingApprovals.id, ID));
    expect(row.rule_id).toBeNull();
    expect(row.source).toBe("ai_auto");
    expect(row.status).toBe("pending");
  });

  it("defaults pending_approvals.source to 'rule' when omitted", async () => {
    if (!TEST_DB) return;
    const ID = "ffffffff-0000-0000-0000-0000000000a6";
    await db.insert(s.pendingApprovals).values({
      id: ID,
      workspace_id: WS,
      rule_id: null,
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_id: CH,
      recipient_platform_id: "PSID-2",
      proposed_content: { type: "text", text: "yo" },
    });
    const [row] = await db.select().from(s.pendingApprovals).where(eq(s.pendingApprovals.id, ID));
    expect(row.source).toBe("rule");
  });

  it("a freshly inserted channel defaults ai_draft_enabled=false and ai_draft_target='dm'", async () => {
    if (!TEST_DB) return;
    const [row] = await db.select().from(s.channels).where(eq(s.channels.id, CH));
    expect(row.ai_draft_enabled).toBe(false);
    expect(row.ai_draft_target).toBe("dm");
    expect(row.ai_draft_autosend_dm).toBe(false);
    expect(row.ai_draft_autosend_public).toBe(false);
  });

  // ADPROMPT2: the single ai_draft_prompt override was split into an independent DM one and public
  // comment one — both default to null (inherit the workspace default).
  it("a freshly inserted channel defaults ai_draft_prompt_dm and ai_draft_prompt_public to null", async () => {
    if (!TEST_DB) return;
    const [row] = await db.select().from(s.channels).where(eq(s.channels.id, CH));
    expect(row.ai_draft_prompt_dm).toBeNull();
    expect(row.ai_draft_prompt_public).toBeNull();
  });

  it("workspaces.ai_draft_prompt_dm and ai_draft_prompt_public default to null", async () => {
    if (!TEST_DB) return;
    const [row] = await db.select().from(s.workspaces).where(eq(s.workspaces.id, WS));
    expect(row.ai_draft_prompt_dm).toBeNull();
    expect(row.ai_draft_prompt_public).toBeNull();
  });
});
