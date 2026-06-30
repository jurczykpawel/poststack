import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/** A Drizzle db or an open transaction — anything that can run `.execute` (mirrors limits.ts). */
type Executor = Pick<typeof db, "execute">;

/**
 * At-least-once redelivery guard for graphile-worker tasks whose effects are NOT a real outbound
 * delivery (so they must NOT leave a row in `outbound_deliveries`, which `stats/overview` +
 * `telemetry/collect` count as a sent message). It rides the generic `rate_limit_counters` KV — the
 * same keyed Postgres store already used for `alert:*` suppression and `altcha:*` replay markers, and
 * one that no stats/telemetry query reads.
 *
 * `claimJobOnce` is written INSIDE the work transaction so the marker commits atomically with the
 * job's effects: a redelivery only short-circuits when the prior run actually committed (a rolled-back
 * run leaves no marker and is correctly retried). `pruneExpired` drops rate-limit rows older than an
 * hour, so the marker is a self-cleaning ~1h idempotency window — comfortably longer than any
 * graphile redelivery, after which the job is exhausted anyway.
 */
export async function claimJobOnce(executor: Executor, key: string): Promise<boolean> {
  const res = await executor.execute(sql`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO NOTHING
    RETURNING key`);
  return res.rows.length > 0;
}

/**
 * Has a prior committed run already claimed this key? A cheap pre-work read so an expensive step
 * (e.g. a paid LLM call) is skipped on redelivery before it runs; the authoritative guard is still
 * `claimJobOnce` inside the tx.
 */
export async function isJobClaimed(key: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT 1 FROM rate_limit_counters WHERE key = ${key} LIMIT 1`);
  return res.rows.length > 0;
}
