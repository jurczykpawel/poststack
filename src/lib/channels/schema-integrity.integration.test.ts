import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  workspaces, channels, contacts, conversations, autoReplyRules,
  pendingApprovals, broadcasts, broadcastRecipients,
} from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;

const WS = "bbbbbbbb-0000-0000-0000-000000000001";
const CH = "bbbbbbbb-0000-0000-0000-000000000002";
const CONTACT = "bbbbbbbb-0000-0000-0000-000000000003";
const CONV = "bbbbbbbb-0000-0000-0000-000000000004";
const RULE = "bbbbbbbb-0000-0000-0000-000000000005";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Integrity", slug: `integ-${WS}` });
  await db.insert(channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-X", token_encrypted: "e", webhook_secret: "s" });
  await db.insert(contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram" });
  await db.insert(autoReplyRules).values({ id: RULE, workspace_id: WS, name: "R", trigger_type: "keyword" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.$client.end();
});

describe("PendingApproval referential integrity (SCHEMA1)", () => {
  it("is cascade-deleted when its rule is removed", async () => {
    if (!TEST_DB) return;
    const [pa] = await db.insert(pendingApprovals).values({
      workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT,
      channel_id: CH, recipient_platform_id: "psid", proposed_content: {},
    }).returning({ id: pendingApprovals.id });

    await db.delete(autoReplyRules).where(eq(autoReplyRules.id, RULE));

    expect(await db.query.pendingApprovals.findFirst({ where: eq(pendingApprovals.id, pa.id) })).toBeUndefined();
  });
});

describe("BroadcastRecipient referential integrity (SCHEMA1)", () => {
  it("is cascade-deleted when its contact is removed", async () => {
    if (!TEST_DB) return;
    const [broadcast] = await db.insert(broadcasts).values({ workspace_id: WS, name: "B" }).returning({ id: broadcasts.id });
    const [recipient] = await db.insert(broadcastRecipients)
      .values({ broadcast_id: broadcast.id, contact_id: CONTACT, channel_id: CH })
      .returning({ id: broadcastRecipients.id });

    await db.delete(contacts).where(eq(contacts.id, CONTACT));

    expect(await db.query.broadcastRecipients.findFirst({ where: eq(broadcastRecipients.id, recipient.id) })).toBeUndefined();
  });
});
