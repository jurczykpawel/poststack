import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { workspaces, channels, contacts, conversations, messages, autoReplyRules, pendingApprovals, sequences, sequenceEnrollments } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

let db: typeof import("@/lib/db").db;
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
  ({ db } = await import("@/lib/db"));
  ({ pruneWorkspaceMessages, pruneOldMessages } = await import("./retention"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  // sequence_enrollments.channel_id is RESTRICT, so the workspace cascade can't drop the
  // channel while an enrollment lingers — clear those first.
  await db.delete(sequenceEnrollments).where(eq(sequenceEnrollments.channel_id, CH));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Retention", slug: `ret-${WS}`, message_retention_days: 30 });
  await db.insert(channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-R", token_encrypted: "e", webhook_secret: "s" });
  await db.insert(contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(contacts).values({ id: CONTACT2, workspace_id: WS });
  await db.insert(conversations).values({ id: CONV_KEEP, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram", last_message_at: recent });
  // Second conversation (different contact, same channel) — all its messages are old.
  await db.insert(conversations).values({ id: CONV_EMPTY, workspace_id: WS, channel_id: CH, contact_id: CONTACT2, platform: "facebook", last_message_at: old });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(sequenceEnrollments).where(eq(sequenceEnrollments.channel_id, CH));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.$client.end();
});

async function seedMessage(conversationId: string, status: "sent" | "held", createdAt: Date) {
  const [m] = await db.insert(messages)
    .values({ conversation_id: conversationId, direction: "outbound", text: "x", status, created_at: createdAt })
    .returning({ id: messages.id });
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

    expect(await db.query.messages.findFirst({ where: eq(messages.id, oldSent) })).toBeUndefined();
    expect(await db.query.messages.findFirst({ where: eq(messages.id, oldOnly) })).toBeUndefined();
    expect(await db.query.messages.findFirst({ where: eq(messages.id, heldOld) })).toBeDefined(); // held survives
    expect(await db.query.messages.findFirst({ where: eq(messages.id, recentSent) })).toBeDefined(); // recent survives
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, CONV_KEEP) })).toBeDefined();
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, CONV_EMPTY) })).toBeUndefined();
  });

  //  — message retention must not destroy live workflow state. A conversation whose
  // only message is prunable but which still has a PENDING approval is not a husk.
  it("does not prune a conversation with a still-pending approval", async () => {
    if (!TEST_DB) return;
    const CONTACT3 = "cccccccc-0000-0000-0000-000000000007";
    const CONV_APPR = "cccccccc-0000-0000-0000-000000000008";
    await db.insert(contacts).values({ id: CONTACT3, workspace_id: WS });
    await db.insert(conversations).values({ id: CONV_APPR, workspace_id: WS, channel_id: CH, contact_id: CONTACT3, platform: "facebook", last_message_at: old });
    const [rule] = await db.insert(autoReplyRules)
      .values({ workspace_id: WS, name: "ApprRule", trigger_type: "keyword", trigger_config: {}, response_type: "text", response_config: { text: "x" } })
      .returning({ id: autoReplyRules.id });
    await db.insert(pendingApprovals).values({
      workspace_id: WS, rule_id: rule.id, conversation_id: CONV_APPR, contact_id: CONTACT3, channel_id: CH,
      recipient_platform_id: "PSID-X", proposed_content: { content: { text: "hi" } },
    });
    await seedMessage(CONV_APPR, "sent", old); // its only message is prunable

    await pruneWorkspaceMessages(WS, 30, now);

    // The old message is pruned, but the conversation + pending approval survive (not a husk).
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, CONV_APPR) })).toBeDefined();
    expect((await db.select().from(pendingApprovals).where(eq(pendingApprovals.conversation_id, CONV_APPR))).length).toBe(1);
  });

  //  — a contact in an ACTIVE sequence enrollment whose conversation went quiet past the
  // cutoff must keep its conversation: the worker locates it by (contact_id, channel_id), so
  // pruning it would silently strand the drip. Once the enrollment is no longer active, the
  // conversation prunes normally.
  it("does not prune a conversation backing an active sequence enrollment, but prunes it once inactive", async () => {
    if (!TEST_DB) return;
    const [seq] = await db.insert(sequences)
      .values({ workspace_id: WS, name: "Drip" })
      .returning({ id: sequences.id });
    // Enrollment is for (CONTACT2, CH) — the same pair as CONV_EMPTY.
    const [enr] = await db.insert(sequenceEnrollments)
      .values({ sequence_id: seq.id, contact_id: CONTACT2, channel_id: CH, status: "active" })
      .returning({ id: sequenceEnrollments.id });
    await seedMessage(CONV_EMPTY, "sent", old); // its only message is prunable

    await pruneWorkspaceMessages(WS, 30, now);
    // Active enrollment → conversation survives even though it's an otherwise-empty husk.
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, CONV_EMPTY) })).toBeDefined();

    // Complete the enrollment → the conversation is now a husk and prunes.
    await db.update(sequenceEnrollments).set({ status: "completed" }).where(eq(sequenceEnrollments.id, enr.id));
    await pruneWorkspaceMessages(WS, 30, now);
    expect(await db.query.conversations.findFirst({ where: eq(conversations.id, CONV_EMPTY) })).toBeUndefined();
  });

  it("pruneOldMessages applies each workspace's own retention policy", async () => {
    if (!TEST_DB) return;
    const oldSent = await seedMessage(CONV_KEEP, "sent", old);

    const result = await pruneOldMessages(now);

    expect(result.workspaces).toBeGreaterThanOrEqual(1);
    expect(await db.query.messages.findFirst({ where: eq(messages.id, oldSent) })).toBeUndefined();
  });
});
