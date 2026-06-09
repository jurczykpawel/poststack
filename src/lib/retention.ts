import { and, eq, lt, inArray, isNotNull, notExists } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, commentLogs, conversations, workspaces, pendingApprovals, flowSessions } from "@/db/schema";

const BATCH_SIZE = 1000;
const DAY_MS = 86_400_000;

/** Terminal message states that are safe to prune. Never held (waiting on the
 * breaker, REL5) or pending (in flight). */
const PRUNABLE_STATUSES = ["sent", "delivered", "failed", "expired"] as const;

export interface RetentionResult {
  workspaces: number;
  deletedMessages: number;
  deletedComments: number;
  deletedConversations: number;
}

export interface WorkspacePruneResult {
  deletedMessages: number;
  deletedComments: number;
  deletedConversations: number;
}

/**
 * Prune one workspace's terminal messages + comment logs older than
 * `retentionDays`, then drop conversations left empty. Workspace-scoped and
 * batched. Shared by the scheduled retention job and the manual prune API.
 */
export async function pruneWorkspaceMessages(
  workspaceId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<WorkspacePruneResult> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const deletedMessages = await deleteInBatches(
    () =>
      db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
        .where(
          and(
            lt(messages.created_at, cutoff),
            inArray(messages.status, [...PRUNABLE_STATUSES]),
            eq(conversations.workspace_id, workspaceId),
          ),
        )
        .limit(BATCH_SIZE),
    async (ids) => (await db.delete(messages).where(inArray(messages.id, ids))).rowCount ?? 0,
  );

  const deletedComments = await deleteInBatches(
    () =>
      db
        .select({ id: commentLogs.id })
        .from(commentLogs)
        .where(and(lt(commentLogs.created_at, cutoff), eq(commentLogs.workspace_id, workspaceId)))
        .limit(BATCH_SIZE),
    async (ids) => (await db.delete(commentLogs).where(inArray(commentLogs.id, ids))).rowCount ?? 0,
  );

  // Conversations whose messages were all pruned are stale husks — remove them. But message
  // retention must not destroy LIVE workflow state: pending_approvals / flow_sessions cascade
  // ON DELETE, so a conversation with a still-pending approval or an active flow session is
  // not a husk and must be kept. Closed/terminal dependents don't block the prune.
  const emptied = await db.delete(conversations).where(
    and(
      eq(conversations.workspace_id, workspaceId),
      lt(conversations.last_message_at, cutoff),
      notExists(db.select().from(messages).where(eq(messages.conversation_id, conversations.id))),
      notExists(
        db.select().from(pendingApprovals).where(
          and(eq(pendingApprovals.conversation_id, conversations.id), eq(pendingApprovals.status, "pending")),
        ),
      ),
      notExists(
        db.select().from(flowSessions).where(
          and(eq(flowSessions.conversation_id, conversations.id), eq(flowSessions.status, "active")),
        ),
      ),
    ),
  );

  return { deletedMessages, deletedComments, deletedConversations: emptied.rowCount ?? 0 };
}

/**
 * Delete messages (and comment logs) older than each workspace's configured
 * retention window, then remove conversations left empty. Workspaces with no
 * policy (message_retention_days = null) are skipped — retention is opt-in.
 */
export async function pruneOldMessages(now: Date = new Date()): Promise<RetentionResult> {
  const wss = await db
    .select({ id: workspaces.id, message_retention_days: workspaces.message_retention_days })
    .from(workspaces)
    .where(isNotNull(workspaces.message_retention_days));

  const result: RetentionResult = {
    workspaces: wss.length,
    deletedMessages: 0,
    deletedComments: 0,
    deletedConversations: 0,
  };

  for (const ws of wss) {
    const ws_result = await pruneWorkspaceMessages(ws.id, ws.message_retention_days as number, now);
    result.deletedMessages += ws_result.deletedMessages;
    result.deletedComments += ws_result.deletedComments;
    result.deletedConversations += ws_result.deletedConversations;
  }

  return result;
}

async function deleteInBatches(
  fetchIds: () => Promise<Array<{ id: string }>>,
  del: (ids: string[]) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await fetchIds();
    if (rows.length === 0) break;
    total += await del(rows.map((r) => r.id));
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}
