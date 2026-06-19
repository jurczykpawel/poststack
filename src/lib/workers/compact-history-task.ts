import { env } from "@/lib/env";
import { compactHistory } from "@/lib/history/compaction";
import { AuditAction } from "@/lib/audit";

/** Cron entry: run a compaction pass with the configured window, then log the counts.
 *  No-op when HISTORY_RETENTION_DAYS=0.
 *
 *  This is an instance-level maintenance run with no workspace, so it is NOT recorded
 *  in audit_logs: that table's workspace_id is a NOT NULL uuid with a foreign key to
 *  workspaces, so there is no valid "system" workspace to attribute the row to. The
 *  counts are logged instead — the audit was always best-effort, never the point. */
export async function runCompactHistory(): Promise<void> {
  const retentionDays = env.HISTORY_RETENTION_DAYS;
  if (retentionDays <= 0) return;
  const res = await compactHistory({ now: new Date(), retentionDays, batchSize: 1000 });
  console.log(`[compact-history] ${AuditAction.HistoryCompacted}`, {
    webhookEventsCompacted: res.webhookEvents.compacted,
    orphansDeleted: res.webhookEvents.orphansDeleted,
    postReactionsCompacted: res.postReactions.compacted,
    responseMetricsCompacted: res.responseMetrics.compacted,
    retentionDays,
  });
}
