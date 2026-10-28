import { and, eq, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations } from "@/db/schema";
import { emitEvent } from "@/lib/events";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conversation = typeof conversations.$inferSelect;

function state(row: Conversation) {
  return { status: row.status, is_automation_paused: row.is_automation_paused, assigned_to: row.assigned_to };
}

/** Update a conversation and record any state transition inside the caller's transaction. */
export async function updateConversation(
  tx: DbTx,
  workspaceId: string,
  conversationId: string,
  patch: Partial<typeof conversations.$inferInsert>,
  condition?: SQL,
): Promise<{ before: Conversation; after: Conversation } | undefined> {
  const where = and(eq(conversations.id, conversationId), eq(conversations.workspace_id, workspaceId), condition);
  const [before] = await tx.select().from(conversations).where(where).for("update");
  if (!before) return undefined;
  const [after] = await tx.update(conversations).set({ ...patch, updated_at: new Date() }).where(where).returning();
  if (!after) return undefined;
  if (before.status !== after.status || before.is_automation_paused !== after.is_automation_paused || before.assigned_to !== after.assigned_to) {
    await emitEvent(tx, workspaceId, "conversation.updated", { type: "conversation", id: conversationId }, {
      workspaceId,
      conversationId,
      contactId: after.contact_id,
      channelId: after.channel_id,
      previous: state(before),
      current: state(after),
      updatedAt: after.updated_at.toISOString(),
    });
  }
  return { before, after };
}
