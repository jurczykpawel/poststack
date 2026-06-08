import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { idempotencyKeys } from "@/db/schema";

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
 */
export async function claimOnce(key: string, now: Date = new Date()): Promise<boolean> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  const [row] = await db
    .insert(idempotencyKeys)
    .values({ key, expires_at })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });
  return row != null;
}

/**
 * Drop a claim taken with `claimOnce` so a unit of work that ultimately failed can be
 * retried (and re-claimed). Without this, a claim-before-work pattern would permanently
 * suppress an event whose processing threw after the claim was taken.
 */
export async function release(key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
}
