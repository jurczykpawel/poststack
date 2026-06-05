import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;

let prisma: typeof import("@/lib/prisma").prisma;

const WS = "bbbbbbbb-0000-0000-0000-000000000001";
const CH = "bbbbbbbb-0000-0000-0000-000000000002";
const CONTACT = "bbbbbbbb-0000-0000-0000-000000000003";
const CONV = "bbbbbbbb-0000-0000-0000-000000000004";
const RULE = "bbbbbbbb-0000-0000-0000-000000000005";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ prisma } = await import("@/lib/prisma"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: "Integrity", slug: `integ-${WS}` } });
  await prisma.channel.create({
    data: { id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-X", token_encrypted: "e", webhook_secret: "s" },
  });
  await prisma.contact.create({ data: { id: CONTACT, workspace_id: WS } });
  await prisma.conversation.create({
    data: { id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram" },
  });
  await prisma.autoReplyRule.create({
    data: { id: RULE, workspace_id: WS, name: "R", trigger_type: "keyword" },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("PendingApproval referential integrity (SCHEMA1)", () => {
  it("is cascade-deleted when its rule is removed", async () => {
    if (!TEST_DB) return;
    const pa = await prisma.pendingApproval.create({
      data: {
        workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT,
        channel_id: CH, recipient_platform_id: "psid", proposed_content: {},
      },
    });

    await prisma.autoReplyRule.delete({ where: { id: RULE } });

    expect(await prisma.pendingApproval.findUnique({ where: { id: pa.id } })).toBeNull();
  });
});

describe("BroadcastRecipient referential integrity (SCHEMA1)", () => {
  it("is cascade-deleted when its contact is removed", async () => {
    if (!TEST_DB) return;
    const broadcast = await prisma.broadcast.create({ data: { workspace_id: WS, name: "B" } });
    const recipient = await prisma.broadcastRecipient.create({
      data: { broadcast_id: broadcast.id, contact_id: CONTACT, channel_id: CH },
    });

    await prisma.contact.delete({ where: { id: CONTACT } });

    expect(await prisma.broadcastRecipient.findUnique({ where: { id: recipient.id } })).toBeNull();
  });
});
