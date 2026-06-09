import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { ruleCooldowns, revokedTokens, rateLimitCounters, processedEvents } from "@/db/schema";

/** Event-dedup rows are kept well past any platform's redelivery window, then dropped. Meta
 *  and Telegram retry webhooks for hours, not weeks — 60 days is a wide safety margin. */
const PROCESSED_EVENT_TTL_MS = 60 * 86_400_000;

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
}
