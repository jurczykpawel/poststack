import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

let prisma: typeof import("@/lib/prisma").prisma;
let pruneWorkspaceMessages: typeof import("./retention").pruneWorkspaceMessages;
let pruneOldMessages: typeof import("./retention").pruneOldMessages;

const WS = "cccccccc-0000-0000-0000-000000000001";
const CH = "cccccccc-0000-0000-0000-000000000002";
const CONTACT = "cccccccc-0000-0000-0000-000000000003";
const CONTACT2 = "cccccccc-0000-0000-0000-000000000006";
const CONV_KEEP = "cccccccc-0000-0000-0000-000000000004";
const CONV_EMPTY = "cccccccc-0000-0000-0000-000000000005";

const now = new Date("2026-06-05T12:00:00.000Z");
const old = new Date(now.getTime() - 40 * DAY);
const recent = new Date(now.getTime() - 1 * DAY);

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ prisma } = await import("@/lib/prisma"));
  ({ pruneWorkspaceMessages, pruneOldMessages } = await import("./retention"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: "Retention", slug: `ret-${WS}`, message_retention_days: 30 } });
  await prisma.channel.create({
    data: { id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-R", token_encrypted: "e", webhook_secret: "s" },
  });
  await prisma.contact.create({ data: { id: CONTACT, workspace_id: WS } });
  await prisma.contact.create({ data: { id: CONTACT2, workspace_id: WS } });
  await prisma.conversation.create({
    data: { id: CONV_KEEP, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram", last_message_at: recent },
  });
  // Second conversation (different contact, same channel) — all its messages are old.
  await prisma.conversation.create({
    data: { id: CONV_EMPTY, workspace_id: WS, channel_id: CH, contact_id: CONTACT2, platform: "facebook", last_message_at: old },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

async function seedMessage(conversationId: string, status: "sent" | "held", createdAt: Date) {
  const m = await prisma.message.create({
    data: { conversation_id: conversationId, direction: "outbound", text: "x", status, created_at: createdAt },
  });
  return m.id;
}

describe("pruneWorkspaceMessages (real Postgres)", () => {
  it("removes old terminal messages, keeps held + recent, and deletes emptied conversations", async () => {
    if (!TEST_DB) return;

    const oldSent = await seedMessage(CONV_KEEP, "sent", old);
    const heldOld = await seedMessage(CONV_KEEP, "held", old);
    const recentSent = await seedMessage(CONV_KEEP, "sent", recent);
    const oldOnly = await seedMessage(CONV_EMPTY, "sent", old);

    const result = await pruneWorkspaceMessages(WS, 30, now);

    expect(result.deletedMessages).toBe(2); // oldSent + oldOnly
    expect(result.deletedConversations).toBe(1); // CONV_EMPTY

    expect(await prisma.message.findUnique({ where: { id: oldSent } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: oldOnly } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: heldOld } })).not.toBeNull(); // held survives
    expect(await prisma.message.findUnique({ where: { id: recentSent } })).not.toBeNull(); // recent survives
    expect(await prisma.conversation.findUnique({ where: { id: CONV_KEEP } })).not.toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: CONV_EMPTY } })).toBeNull();
  });

  it("pruneOldMessages applies each workspace's own retention policy", async () => {
    if (!TEST_DB) return;
    const oldSent = await seedMessage(CONV_KEEP, "sent", old);

    const result = await pruneOldMessages(now);

    expect(result.workspaces).toBeGreaterThanOrEqual(1);
    expect(await prisma.message.findUnique({ where: { id: oldSent } })).toBeNull();
  });
});
