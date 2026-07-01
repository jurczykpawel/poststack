import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let resolveConversationHistory: typeof import("./conversation-history").resolveConversationHistory;

const WS = "c0ffee08-0000-4000-8000-000000000e01";
const CH = "c0ffee08-0000-4000-8000-000000000e02";
const CONTACT = "c0ffee08-0000-4000-8000-000000000e03";
const CONV_DM = "c0ffee08-0000-4000-8000-000000000e04";
const CONV_CMT = "c0ffee08-0000-4000-8000-000000000e05";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ resolveConversationHistory } = await import("./conversation-history"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await seedWorkspace(db, s, { id: WS, slug: `hist-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-HIST", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values([
    { id: CONV_DM, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "dm" },
    { id: CONV_CMT, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", thread_type: "comment" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

async function seedMessages(rows: Array<{ direction: "inbound" | "outbound"; text: string; offsetMs: number }>) {
  for (const r of rows) {
    await db.insert(s.messages).values({ conversation_id: CONV_DM, direction: r.direction, text: r.text, created_at: new Date(Date.now() + r.offsetMs) });
  }
}

async function seedComments(rows: Array<{ comment_text: string; reply_text?: string; reply_sent?: boolean; offsetMs: number }>) {
  for (const [i, r] of rows.entries()) {
    await db.insert(s.commentLogs).values({
      channel_id: CH, workspace_id: WS, conversation_id: CONV_CMT,
      platform_comment_id: `cmt-${i}`, comment_text: r.comment_text,
      reply_text: r.reply_text ?? null, reply_sent: r.reply_sent ?? false,
      author_id: "A", author_name: "Author",
      created_at: new Date(Date.now() + r.offsetMs),
    });
  }
}

describe.skipIf(!TEST_DB)("resolveConversationHistory — DM", () => {
  it("returns undefined when there is only the triggering message (fresh thread)", async () => {
    await seedMessages([{ direction: "inbound", text: "Hi there", offsetMs: 0 }]);
    expect(await resolveConversationHistory(CONV_DM, false)).toBeUndefined();
  });

  it("formats prior turns oldest-first, excluding the newest (triggering) message", async () => {
    await seedMessages([
      { direction: "inbound", text: "Do you ship to Poland?", offsetMs: 0 },
      { direction: "outbound", text: "Yes, we do!", offsetMs: 1000 },
      { direction: "inbound", text: "Great, and the price?", offsetMs: 2000 }, // the "current" trigger — excluded
    ]);
    const history = await resolveConversationHistory(CONV_DM, false);
    expect(history).toBe("Recent conversation:\nCustomer: Do you ship to Poland?\nYou: Yes, we do!");
  });

  it("caps the number of turns returned", async () => {
    await seedMessages(Array.from({ length: 8 }, (_, i) => ({ direction: "inbound" as const, text: `msg ${i}`, offsetMs: i * 1000 })));
    const history = await resolveConversationHistory(CONV_DM, false, 2);
    expect(history).toBe("Recent conversation:\nCustomer: msg 5\nCustomer: msg 6");
  });

  it("caps a single turn's length", async () => {
    await seedMessages([
      { direction: "inbound", text: "a".repeat(500), offsetMs: 0 },
      { direction: "inbound", text: "trigger", offsetMs: 1000 },
    ]);
    const history = await resolveConversationHistory(CONV_DM, false);
    expect(history!.length).toBeLessThan(350);
    expect(history).toContain("…");
  });
});

describe.skipIf(!TEST_DB)("resolveConversationHistory — comment thread", () => {
  it("returns undefined when there is only the triggering comment", async () => {
    await seedComments([{ comment_text: "First comment ever", offsetMs: 0 }]);
    expect(await resolveConversationHistory(CONV_CMT, true)).toBeUndefined();
  });

  it("expands one prior row into two turns (the comment AND the sent reply)", async () => {
    await seedComments([
      { comment_text: "Congrats on the launch!", reply_text: "Thank you so much!", reply_sent: true, offsetMs: 0 },
      { comment_text: "What features does it have?", offsetMs: 1000 }, // trigger — excluded
    ]);
    const history = await resolveConversationHistory(CONV_CMT, true);
    expect(history).toBe("Recent conversation:\nCustomer: Congrats on the launch!\nYou: Thank you so much!");
  });

  it("omits the reply turn when the prior comment was never answered", async () => {
    await seedComments([
      { comment_text: "Unanswered comment", reply_sent: false, offsetMs: 0 },
      { comment_text: "trigger", offsetMs: 1000 },
    ]);
    const history = await resolveConversationHistory(CONV_CMT, true);
    expect(history).toBe("Recent conversation:\nCustomer: Unanswered comment");
  });
});
