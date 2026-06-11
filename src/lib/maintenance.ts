import { and, eq, lt, ne, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ruleCooldowns, revokedTokens, rateLimitCounters, outboundDeliveries, pendingApprovals, webhookEvents } from "@/db/schema";

/** A JS Date rendered as its UTC wall-clock, for comparing against a genuinely DB-clock
 *  `timestamp without time zone` column (CURRENT_TIMESTAMP / now()) independent of the process
 *  timezone — the same TZ-safety fix as the retention cutoff. Use it ONLY for columns
 *  actually written by the DB clock: `rate_limit_counters.window_start`
 *  here. Predominantly app-clock columns (written by JS `new Date()`, e.g. `outbound_deliveries.updated_at`
 *  via $onUpdate, `revoked_tokens.expires_at`) keep the plain Date — a UTC cutoff would invert the skew
 *  off-pin. NB `rule_cooldowns.expires_at` IS DB-clock (`now() + interval`), but its prune is a
 *  benign bounded cleanup whose authoritative gate is the DB-clock `expires_at < now()` in limits.ts. */
const utcCutoff = (d: Date) => sql`${d.toISOString()}::timestamp`;

/** Terminal delivery-ledger rows and resolved approvals are operator history: keep them long
 *  enough to investigate a send, then drop so these append-only tables stay bounded (the ledger
 *  is the busiest table by row count). Live state — `held` deliveries, `pending` approvals — is
 *  NEVER pruned here, only the terminal/resolved rows. */
const TERMINAL_LEDGER_TTL_MS = 90 * 86_400_000;

/** Delivery states that are done (no further work). `held`/`pending`/`sending` are live. */
const TERMINAL_DELIVERY_STATUSES = ["sent", "failed", "expired", "unknown"] as const;

/** A `sending` row is normally transient — the next job attempt reconciles it to `unknown`. But if
 *  the job both crashed after committing `sending` AND exhausted its retries before the reconcile
 *  ran, the row is stuck `sending` forever. Sweep such rows well past any retry window. */
const STUCK_SENDING_TTL_MS = 7 * 86_400_000;

/** Orphan webhook_events rows (channel_id NULL — an event for an unknown page, or one whose channel
 *  was later deleted: the FK is ON DELETE SET NULL) belong to no workspace, so no owner can prune
 *  them via the per-workspace endpoint, which deliberately skips them. Yet they carry PSIDs + full
 *  raw payloads. Sweep them systemically here on a 60-day TTL — well past any platform redelivery
 *  window (the horizon the old processed_events kept), and a global delete is tenant-safe since
 *  they are ownerless. */
const ORPHAN_WEBHOOK_EVENT_TTL_MS = 60 * 86_400_000;

/**
 * Delete time-expired ephemeral rows so the tables don't grow unbounded.
 * Run periodically (graphile-worker cron `prune-expired`). Covers the tables
 * that replaced Redis TTL keys: rule cooldowns, the revoked-token denylist, and
 * stale rate-limit windows. Lifetime counters (rule_send_counts) are not pruned.
 */
export async function pruneExpired(now: Date = new Date()): Promise<void> {
  await db.delete(ruleCooldowns).where(lt(ruleCooldowns.expires_at, now));
  await db.delete(revokedTokens).where(lt(revokedTokens.expires_at, now));
  // Rate-limit counters age by window_start (DB-clock now()), not expires_at; drop stale windows.
  await db.delete(rateLimitCounters).where(lt(rateLimitCounters.window_start, utcCutoff(new Date(now.getTime() - 3_600_000))));
  // The webhook_events log (which folds in the old event-dedup) is NOT auto-pruned here: its
  // retention is owner-driven via POST /api/v1/webhook-events/prune (manual, bounded), so an
  // operator keeps the inspection history as long as they choose — EXCEPT ownerless orphan rows
  // (channel_id NULL), which no per-workspace prune can reach. received_at is DB-clock (INSERT
  // DEFAULT now()), so compare against the UTC wall-clock to stay correct on a non-UTC host.
  await db.delete(webhookEvents).where(
    and(
      isNull(webhookEvents.channel_id),
      lt(webhookEvents.received_at, utcCutoff(new Date(now.getTime() - ORPHAN_WEBHOOK_EVENT_TTL_MS))),
    ),
  );

  // Terminal delivery-ledger rows older than the window — but never a `held` row, which is still
  // awaiting a drain.
  const ledgerCutoff = new Date(now.getTime() - TERMINAL_LEDGER_TTL_MS);
  // updated_at on a terminal row is app-clock: status transitions go through `.set({status})` →
  // $onUpdate(() => new Date()), and the one path that INSERTs a fresh terminal row (follow-gate)
  // writes updated_at explicitly too, so the DB-clock insert DEFAULT never reaches a terminal
  // row. Use the plain Date (— a UTC cutoff here over-retained off-pin).
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
