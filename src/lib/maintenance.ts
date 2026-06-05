import { prisma } from "@/lib/prisma";

/**
 * Delete time-expired ephemeral rows so the tables don't grow unbounded.
 * Run periodically (graphile-worker cron `prune-expired`). Covers the tables
 * that replaced Redis TTL keys: outbound idempotency, rule cooldowns, and the
 * revoked-token denylist. Lifetime counters (rule_send_counts) are not pruned.
 */
export async function pruneExpired(now: Date = new Date()): Promise<void> {
  const where = { expires_at: { lt: now } };
  await prisma.outboundIdempotency.deleteMany({ where });
  await prisma.ruleCooldown.deleteMany({ where });
  await prisma.revokedToken.deleteMany({ where });
}
