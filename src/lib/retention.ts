import { prisma } from "@/lib/prisma";

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
      prisma.message.findMany({
        where: {
          created_at: { lt: cutoff },
          status: { in: [...PRUNABLE_STATUSES] },
          conversation: { workspace_id: workspaceId },
        },
        select: { id: true },
        take: BATCH_SIZE,
      }),
    (ids) => prisma.message.deleteMany({ where: { id: { in: ids } } }),
  );

  const deletedComments = await deleteInBatches(
    () =>
      prisma.commentLog.findMany({
        where: { created_at: { lt: cutoff }, workspace_id: workspaceId },
        select: { id: true },
        take: BATCH_SIZE,
      }),
    (ids) => prisma.commentLog.deleteMany({ where: { id: { in: ids } } }),
  );

  // Conversations whose messages were all pruned are stale husks — remove them.
  const emptied = await prisma.conversation.deleteMany({
    where: { workspace_id: workspaceId, last_message_at: { lt: cutoff }, messages: { none: {} } },
  });

  return { deletedMessages, deletedComments, deletedConversations: emptied.count };
}

/**
 * Delete messages (and comment logs) older than each workspace's configured
 * retention window, then remove conversations left empty. Workspaces with no
 * policy (message_retention_days = null) are skipped — retention is opt-in.
 */
export async function pruneOldMessages(now: Date = new Date()): Promise<RetentionResult> {
  const workspaces = await prisma.workspace.findMany({
    where: { message_retention_days: { not: null } },
    select: { id: true, message_retention_days: true },
  });

  const result: RetentionResult = {
    workspaces: workspaces.length,
    deletedMessages: 0,
    deletedComments: 0,
    deletedConversations: 0,
  };

  for (const ws of workspaces) {
    const ws_result = await pruneWorkspaceMessages(ws.id, ws.message_retention_days as number, now);
    result.deletedMessages += ws_result.deletedMessages;
    result.deletedComments += ws_result.deletedComments;
    result.deletedConversations += ws_result.deletedConversations;
  }

  return result;
}

async function deleteInBatches(
  fetchIds: () => Promise<Array<{ id: string }>>,
  del: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await fetchIds();
    if (rows.length === 0) break;
    const res = await del(rows.map((r) => r.id));
    total += res.count;
    if (rows.length < BATCH_SIZE) break;
  }
  return total;
}
