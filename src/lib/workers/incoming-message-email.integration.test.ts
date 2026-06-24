import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Email ingest path needs no live provider — rules evaluation with no rules is a no-op (no_match).
// Mock the registry so a stray provider construction never reaches the network.
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({
    requiresTokenRefresh: () => false,
    sendMessage: vi.fn(async () => ({ platformMessageId: "x" })),
  }),
}));
vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }), encryptTokens: () => "enc", encryptString: () => "enc", decryptString: (s: string) => s }));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let processIncomingMessage: typeof import("./incoming-message-worker").processIncomingMessage;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "33330000-0000-0000-0000-0000000000c1";
const CH = "33330000-0000-0000-0000-0000000000c2";
const INBOX = "support@firma.pl";
const helpers = { logger: { info: () => {} }, job: { id: "job-email" } } as never;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  processIncomingMessage = (await import("./incoming-message-worker")).processIncomingMessage;
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.webhookEvents);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "GM", slug: `gm-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "gmail", platform_id: INBOX, token_encrypted: "x", webhook_secret: "s", status: "active",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

describe("incoming-message worker — email branch (real Postgres)", () => {
  it("creates an email-typed conversation keyed by threadId with the subject and an inbound message", async () => {
    if (!TEST_DB) return;
    await processIncomingMessage(
      {
        platform: "gmail", channelId: CH, pageId: INBOX, recipientId: INBOX,
        senderId: "jan@gmail.com", mid: "<rfc-1@mail>", text: "dzień dobry", timestamp: Math.floor(Date.now() / 1000),
        threadType: "email", threadId: "thread-1", subject: "Faktura 3/2026",
      },
      helpers,
    );

    const conv = await db.query.conversations.findFirst({
      where: and(eq(s.conversations.channel_id, CH), eq(s.conversations.thread_type, "email")),
      columns: { id: true, thread_ref: true, subject: true },
    });
    expect(conv).toBeTruthy();
    expect(conv!.thread_ref).toBe("thread-1");
    expect(conv!.subject).toBe("Faktura 3/2026");

    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "jan@gmail.com")),
      columns: { contact_id: true },
    });
    expect(cc).toBeTruthy(); // contact keyed by the canonicalized address

    const msgs = await db.select().from(s.messages).where(eq(s.messages.conversation_id, conv!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe("inbound");
    expect(msgs[0].platform_message_id).toBe("<rfc-1@mail>");
  });

  it("a second mail in the same thread does not overwrite the subject", async () => {
    if (!TEST_DB) return;
    const base = {
      platform: "gmail", channelId: CH, pageId: INBOX, recipientId: INBOX,
      senderId: "jan@gmail.com", threadType: "email" as const, threadId: "thread-2",
    };
    await processIncomingMessage({ ...base, mid: "<r1@mail>", text: "a", timestamp: Math.floor(Date.now() / 1000), subject: "Original" }, helpers);
    await processIncomingMessage({ ...base, mid: "<r2@mail>", text: "b", timestamp: Math.floor(Date.now() / 1000), subject: "Changed" }, helpers);
    const conv = await db.query.conversations.findFirst({
      where: and(eq(s.conversations.channel_id, CH), eq(s.conversations.thread_type, "email"), eq(s.conversations.thread_ref, "thread-2")),
      columns: { id: true, subject: true },
    });
    expect(conv!.subject).toBe("Original");
    const msgs = await db.select().from(s.messages).where(eq(s.messages.conversation_id, conv!.id));
    expect(msgs).toHaveLength(2);
  });
});
