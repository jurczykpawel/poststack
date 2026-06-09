import { and, eq, lt, ne, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { ruleCooldowns, revokedTokens, rateLimitCounters, processedEvents, outboundDeliveries, pendingApprovals } from "@/db/schema";

/** Event-dedup rows are kept well past any platform's redelivery window, then dropped. Meta
 *  and Telegram retry webhooks for hours, not weeks — 60 days is a wide safety margin. */
const PROCESSED_EVENT_TTL_MS = 60 * 86_400_000;

/** Terminal delivery-ledger rows and resolved approvals are operator history: keep them long
 *  enough to investigate a send, then drop so these append-only tables stay bounded (the ledger
 *  is the busiest table by row count). Live state — `held` deliveries, `pending` approvals — is
 *  NEVER pruned here, only the terminal/resolved rows. Same class as the processed_events TTL. */
const TERMINAL_LEDGER_TTL_MS = 90 * 86_400_000;

/** Delivery states that are done (no further work). `held`/`pending`/`sending` are live. */
const TERMINAL_DELIVERY_STATUSES = ["sent", "failed", "expired", "unknown"] as const;

/** A `sending` row is normally transient — the next job attempt reconciles it to `unknown`. But if
 *  the job both crashed after committing `sending` AND exhausted its retries before the reconcile
 *  ran, the row is stuck `sending` forever. Sweep such rows well past any retry window. */
const STUCK_SENDING_TTL_MS = 7 * 86_400_000;

/**
 * Delete time-expired ephemeral rows so the tables don't grow unbounded.
 * Run periodically (graphile-worker cron `prune-expired`). Covers the tables
 * that replaced Redis TTL keys: rule cooldowns, the revoked-token denylist, and
 * stale rate-limit windows. Lifetime counters (rule_send_counts) are not pruned.
 */
export async function pruneExpired(now: Date = new Date()): Promise<void> {
  await db.delete(ruleCooldowns).where(lt(ruleCooldowns.expires_at, now));
  await db.delete(revokedTokens).where(lt(revokedTokens.expires_at, now));
  // Rate-limit counters age by window_start, not expires_at; drop stale windows.
  await db.delete(rateLimitCounters).where(lt(rateLimitCounters.window_start, new Date(now.getTime() - 3_600_000)));
  // Event-dedup keys are durable (no TTL) only within the redelivery window; past it they're
  // dead weight that also outlives a contact erasure (a reaction key embeds the PSID). Prune
  // the old ones so the table stays bounded and PSIDs don't linger forever.
  await db.delete(processedEvents).where(lt(processedEvents.created_at, new Date(now.getTime() - PROCESSED_EVENT_TTL_MS)));

  // Terminal delivery-ledger rows older than the window — but never a `held` row, which is still
  // awaiting a drain.
  const ledgerCutoff = new Date(now.getTime() - TERMINAL_LEDGER_TTL_MS);
  await db.delete(outboundDeliveries).where(
    and(
      inArray(outboundDeliveries.status, [...TERMINAL_DELIVERY_STATUSES]),
      lt(outboundDeliveries.updated_at, ledgerCutoff),
    ),
  );
  // Resolved approvals (approved/rejected) older than the window. A NULL resolved_at never matches
  // `lt`, so an un-resolved (`pending`) row is doubly safe — excluded by status AND by timestamp.
  await db.delete(pendingApprovals).where(
    and(ne(pendingApprovals.status, "pending"), lt(pendingApprovals.resolved_at, ledgerCutoff)),
  );

  // Reap deliveries stuck `sending` (crash + retry-exhaustion before the reconcile) — never a
  // fresh one still inside its retry window.
  await db.delete(outboundDeliveries).where(
    and(
      eq(outboundDeliveries.status, "sending"),
      lt(outboundDeliveries.updated_at, new Date(now.getTime() - STUCK_SENDING_TTL_MS)),
    ),
  );
}
