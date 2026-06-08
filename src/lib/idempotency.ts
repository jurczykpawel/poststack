import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyKeys } from "@/db/schema";

/** A Drizzle db or an open transaction — anything that can run `.insert`. */
type Executor = Pick<typeof db, "insert">;

// Claims live for a fixed TTL; expired claims are ignored and may be pruned (see DATA1).
const TTL_MS = 86_400_000; // 24h

/** Has this key already been claimed (and not yet expired)? */
export async function isClaimed(key: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key),
  });
  return row != null && row.expires_at > now;
}

/** Claim a key AFTER a successful send so retries become no-ops. */
export async function claim(key: string, now: Date = new Date()): Promise<void> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  await db
    .insert(idempotencyKeys)
    .values({ key, expires_at })
    .onConflictDoUpdate({ target: idempotencyKeys.key, set: { expires_at } });
}

/**
 * Atomically claim a key only if it is not already claimed. Returns true when this
 * call created the claim (the caller should do the work) and false when it already
 * existed (the caller should treat it as already done). Used to deduplicate, at
 * ingest, events that have no natural unique row of their own (e.g. reactions),
 * so an at-least-once redelivery does not process them twice.
 *
 * Pass an open transaction as `executor` so the claim commits (or rolls back) with the
 * rest of the unit of work — then a failed reply leaves no claim and the event retries
 * cleanly, while a successful one is durably deduped.
 */
export async function claimOnce(
  key: string,
  now: Date = new Date(),
  executor: Executor = db,
): Promise<boolean> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  const [row] = await executor
    .insert(idempotencyKeys)
    .values({ key, expires_at })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });
  return row != null;
}
