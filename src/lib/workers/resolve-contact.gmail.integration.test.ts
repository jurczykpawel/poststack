import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let resolveContact: typeof import("./resolve-contact");
let WS = "";
let channelId = "";
let contactId = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  resolveContact = await import("./resolve-contact");

  WS = randomUUID();
  await db.insert(s.workspaces).values({ id: WS, name: "Gmail Test WS", slug: `gmail-test-${WS.slice(0, 8)}` });

  const [ch] = await db
    .insert(s.channels)
    .values({
      workspace_id: WS,
      platform: "gmail",
      platform_id: `gmail-test-${WS.slice(0, 8)}`,
      token_encrypted: "enc-placeholder",
      webhook_secret: "secret-placeholder",
    })
    .returning({ id: s.channels.id });
  channelId = ch.id;

  const [ct] = await db
    .insert(s.contacts)
    .values({ workspace_id: WS })
    .returning({ id: s.contacts.id });
  contactId = ct.id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

describe("ensureConversation email thread", () => {
  it("creates an email-typed conversation keyed by threadId with subject", async () => {
    if (!TEST_DB) return;
    const channel = { id: channelId, workspace_id: WS, platform: "gmail" as const };
    const conv = await resolveContact.ensureConversation(
      channel,
      contactId,
      { last_message_at: new Date(), last_message_preview: "hi", subject: "Faktura 3/2026" },
      { type: "email", ref: "thread-abc" },
    );
    expect(conv.thread_type).toBe("email");
    expect(conv.thread_ref).toBe("thread-abc");
    expect(conv.subject).toBe("Faktura 3/2026");
  });

  it("a second message in the same thread does NOT overwrite the subject", async () => {
    if (!TEST_DB) return;
    const channel = { id: channelId, workspace_id: WS, platform: "gmail" as const };
    // Call again with a different subject — the conflict path must keep the original.
    const conv2 = await resolveContact.ensureConversation(
      channel,
      contactId,
      { last_message_at: new Date(), last_message_preview: "re: hi", subject: "SHOULD NOT OVERWRITE" },
      { type: "email", ref: "thread-abc" },
    );
    // Subject must still be the original "Faktura 3/2026".
    const row = await db.query.conversations.findFirst({
      where: and(
        eq(s.conversations.channel_id, channelId),
        eq(s.conversations.contact_id, contactId),
        eq(s.conversations.thread_type, "email"),
        eq(s.conversations.thread_ref, "thread-abc"),
      ),
      columns: { id: true, subject: true },
    });
    expect(row!.subject).toBe("Faktura 3/2026");
    expect(conv2.id).toBe(row!.id);
  });
});
