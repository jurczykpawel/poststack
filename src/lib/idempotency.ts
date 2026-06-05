import { prisma } from "@/lib/prisma";

// Mirrors the former Redis idempotency TTL. Expired claims are ignored and
// may be pruned (see DATA1).
const TTL_MS = 86_400_000; // 24h

/** Has this outbound send already been claimed (and not yet expired)? */
export async function isClaimed(key: string, now: Date = new Date()): Promise<boolean> {
  const row = await prisma.outboundIdempotency.findUnique({ where: { key } });
  return row !== null && row.expires_at > now;
}

/** Claim a key AFTER a successful send so retries become no-ops. */
export async function claim(key: string, now: Date = new Date()): Promise<void> {
  const expires_at = new Date(now.getTime() + TTL_MS);
  await prisma.outboundIdempotency.upsert({
    where: { key },
    create: { key, expires_at },
    update: { expires_at },
  });
}
