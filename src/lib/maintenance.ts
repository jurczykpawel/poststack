import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { ruleCooldowns, revokedTokens, rateLimitCounters } from "@/db/schema";

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
}
