import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRateState } from "@/db/schema";

export interface RateConfig {
  capacity: number;
  refillPerMinute: number;
}

/**
 * Atomically consume one token from a per-channel bucket. Returns true if allowed.
 * Lazy refill from elapsed time (no cron). Used to gate the publish worker.
 */
export async function tryConsume(channelId: string, cfg: RateConfig): Promise<boolean> {
  await db
    .insert(channelRateState)
    .values({ channel_id: channelId, tokens: cfg.capacity })
    .onConflictDoNothing();

  const res = await db.execute(sql`
    UPDATE channel_rate_state
    SET tokens = LEAST(${cfg.capacity}, tokens + floor(extract(epoch from (now() - updated_at)) / 60 * ${cfg.refillPerMinute})) - 1,
        updated_at = now()
    WHERE channel_id = ${channelId}
      AND LEAST(${cfg.capacity}, tokens + floor(extract(epoch from (now() - updated_at)) / 60 * ${cfg.refillPerMinute})) >= 1
    RETURNING tokens
  `);
  return (res.rows?.length ?? 0) > 0;
}
