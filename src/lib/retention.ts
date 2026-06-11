import { and, eq, lt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, commentLogs, conversations, workspaces, pendingApprovals, flowSessions, sequenceEnrollments, channels, webhookEvents } from "@/db/schema";

const BATCH_SIZE = 1000;
const DAY_MS = 86_400_000;

/** Upper bound on a retention window (~10 years). Bounds the API-settable retention day-count so a
 *  huge value can't push the cutoff Date out of range and throw on toISOString() in the cron.
 *  Single source of truth — the dashboard and the v1 settings/prune handlers all enforce it. */
export const MAX_RETENTION_DAYS = 3650;

/** Terminal message states that are safe to prune. Never held (waiting on the
 * breaker) or pending (in flight). */
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
  // `created_at` is written by the DB clock (CURRENT_TIMESTAMP) and stored UTC-naive, but a JS Date
  // param is serialized to a `timestamp without time zone` column in the PROCESS timezone — so on a
  // non-UTC host the cutoff lands hours off and silently over-deletes in-window rows (proven
  // on Europe/Warsaw). Compare against the cutoff's UTC wall-clock instead, which matches how the
  // column is stored regardless of process TZ — used ONLY for the genuinely DB-clock created_at
  // columns below. The husk-prune stays on the plain Date `cutoff`: last_message_at is predominantly
  // app-clock (the worker writes it with `new Date()`; only a rare manual reply writes it DB-clock),
  // so the plain Date is its correct domain — a UTC cutoff would invert the skew off-pin.
  // TZ=UTC is pinned in the images, so both domains coincide regardless.
  const cutoffUtc = sql`${cutoff.toISOString()}::timestamp`;

  const deletedMessages = await deleteInBatches(
    () =>
      db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
        .where(
          and(
            lt(messages.created_at, cutoffUtc),
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
        .where(and(lt(commentLogs.created_at, cutoffUtc), eq(commentLogs.workspace_id, workspaceId)))
        .limit(BATCH_SIZE),
    async (ids) => (await db.delete(commentLogs).where(inArray(commentLogs.id, ids))).rowCount ?? 0,
  );

  // Conversations whose messages were all pruned are stale husks — remove them. But message
  // retention must not destroy LIVE workflow state: pending_approvals / flow_sessions cascade
  // ON DELETE, so a conversation with a still-pending approval or an active flow session is
  // not a husk and must be kept. An ACTIVE sequence enrollment is the same hazard:
  // enrollments have no conversation_id (the worker locates the conversation by the contact +
  // channel pair), so deleting the conversation would leave a slow-drip enrollment silently
  // unable to send while it advances to completed. Guard it by the same (contact_id, channel_id)
  // join the worker uses. Closed/terminal dependents don't block the prune.
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
      notExists(
        db.select().from(sequenceEnrollments).where(
          and(
            eq(sequenceEnrollments.contact_id, conversations.contact_id),
            eq(sequenceEnrollments.channel_id, conversations.channel_id),
            eq(sequenceEnrollments.status, "active"),
          ),
        ),
      ),
    ),
  );

  return { deletedMessages, deletedComments, deletedConversations: emptied.rowCount ?? 0 };
}

/**
 * Manually prune this workspace's webhook_events log older than `olderThanDays`. The log has no
 * auto-TTL (unlike the ephemeral stores) — retention is owner-driven via this endpoint. Scoped
 * STRICTLY to the workspace's own channels: orphan rows (channel_id NULL — an event for an unknown
 * page, OR a row whose channel was later deleted, since the FK is ON DELETE SET NULL) are NOT
 * touched, since such a row could have belonged to another tenant's now-deleted channel. So one
 * tenant's prune never reaches another tenant's rows. Returns the count.
 */
export async function pruneWorkspaceWebhookEvents(
  workspaceId: string,
  olderThanDays: number,
  now: Date = new Date(),
): Promise<{ deletedEvents: number }> {
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  // received_at is DB-clock (defaultNow()), so compare against the UTC wall-clock to stay correct
  // on a non-UTC host (same TZ-safety rationale as the message prune's created_at).
  const cutoffUtc = sql`${cutoff.toISOString()}::timestamp`;

  const own = db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.workspace_id, workspaceId));

  const deleted = await deleteInBatches(
    () =>
      db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            lt(webhookEvents.received_at, cutoffUtc),
            inArray(webhookEvents.channel_id, own),
          ),
        )
        .limit(BATCH_SIZE),
    async (ids) => (await db.delete(webhookEvents).where(inArray(webhookEvents.id, ids))).rowCount ?? 0,
  );

  return { deletedEvents: deleted };
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
    // Isolate each workspace: one tenant's prune failing (e.g. a pathological retention value that
    // throws while building the cutoff) must NOT abort the sweep for every other tenant — a
    // cross-tenant cron DoS. Log and continue; the next run retries this workspace.
    try {
      const ws_result = await pruneWorkspaceMessages(ws.id, ws.message_retention_days as number, now);
      result.deletedMessages += ws_result.deletedMessages;
      result.deletedComments += ws_result.deletedComments;
      result.deletedConversations += ws_result.deletedConversations;
    } catch (err) {
      console.error(`[retention] prune failed for workspace ${ws.id}, skipping:`, err);
    }
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
