import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundIdempotency } from "@/db/schema";

// Mirrors the former Redis idempotency TTL. Expired claims are ignored and
// may be pruned (see DATA1).
const TTL_MS = 86_400_000; // 24h

/** Has this outbound send already been claimed (and not yet expired)? */
export async function isClaimed(key: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.query.outboundIdempotency.findFirst({
    where: eq(outboundIdempotency.key, key),
  });
  return row != null && row.expires_at > now;
}

/** Claim a key AFTER a successful send so retries become no-ops. */
export async function claim(key: string, now: Date = new Date()): Promise<void> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  await db
    .insert(outboundIdempotency)
    .values({ key, expires_at })
    .onConflictDoUpdate({ target: outboundIdempotency.key, set: { expires_at } });
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
    .insert(outboundIdempotency)
    .values({ key, expires_at })
    .onConflictDoNothing({ target: outboundIdempotency.key })
    .returning({ key: outboundIdempotency.key });
  return row != null;
}
