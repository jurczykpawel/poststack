import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyKeys, processedEvents } from "@/db/schema";

/** A Drizzle db or an open transaction — anything that can run `.insert`. */
type Executor = Pick<typeof db, "insert">;

// Outbound-send claims live for a fixed TTL; expired claims are ignored and pruned (DATA1).
const TTL_MS = 86_400_000; // 24h

/** Has this outbound-send key already been claimed (and not yet expired)? */
export async function isClaimed(key: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key),
  });
  return row != null && row.expires_at > now;
}

/** Claim an outbound-send key AFTER a successful send so retries become no-ops. */
export async function claim(key: string, now: Date = new Date()): Promise<void> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  await db
    .insert(idempotencyKeys)
    .values({ key, expires_at })
    .onConflictDoUpdate({ target: idempotencyKeys.key, set: { expires_at } });
}

/**
 * Has this inbound event already been terminally processed? Durable (no TTL) — see
 * `processedEvents`. Used to short-circuit a redelivery before any work.
 */
export async function isEventProcessed(key: string): Promise<boolean> {
  const row = await db.query.processedEvents.findFirst({ where: eq(processedEvents.key, key) });
  return row != null;
}

/**
 * Atomically record an inbound event's terminal outcome (fired / no_match / paused) only
 * if it has not been recorded yet. Returns true when this call created the record (the
 * caller owns the work) and false when it already existed (treat as already handled). Used
 * to deduplicate events that have no natural unique row of their own (e.g. reactions, and
 * the per-event fire claim), so an at-least-once redelivery does not process them twice.
 *
 * Stored DURABLY (no expiry, not pruned) so a redelivery after the operational TTL window —
 * or after a rule change / unpause — still can't fire a late reply to an old event.
 *
 * Pass an open transaction as `executor` so the record commits (or rolls back) with the
 * rest of the unit of work — then a failed reply leaves nothing recorded and the event
 * retries cleanly, while a successful one is durably deduped.
 */
export async function claimEventOnce(
  key: string,
  executor: Executor = db,
): Promise<boolean> {
  const [row] = await executor
    .insert(processedEvents)
    .values({ key })
    .onConflictDoNothing({ target: processedEvents.key })
    .returning({ key: processedEvents.key });
  return row != null;
}
