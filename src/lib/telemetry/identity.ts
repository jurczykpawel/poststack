// The only identity an instance reports with its telemetry is a random uuid (the instance id),
// generated once and persisted in the telemetry_state singleton, plus its license tier (a low-entropy
// enum). No domain or order hash is emitted — those were pseudonymous (brute-forceable over a fixed
// pepper), so the payload now carries nothing linkable back to a person or deployment.

import { eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { telemetryState } from "@/db/schema";
import { parseClaims } from "@/lib/license/format";
import { SEND_WINDOW_MS, RETRY_LEASE_MS } from "./constants";

const SINGLETON = "singleton";

/**
 * The stable, anonymous id for this instance. Read from the telemetry_state singleton; created with
 * a fresh uuid on first call and persisted, so it stays the same across calls and restarts. Race-safe
 * via INSERT … ON CONFLICT DO NOTHING followed by a re-read: concurrent first-calls collapse to one row.
 */
export async function ensureInstanceId(db: typeof Db): Promise<string> {
  await db
    .insert(telemetryState)
    .values({ id: SINGLETON, instance_id: crypto.randomUUID() })
    .onConflictDoNothing({ target: telemetryState.id });

  const row = await db.query.telemetryState.findFirst({ where: eq(telemetryState.id, SINGLETON) });
  if (!row) throw new Error("telemetry_state singleton missing after upsert");
  return row.instance_id;
}

/** The current license's tier only (no order hash). DB > env token; null if unlicensed/unparseable. */
export async function getLicenseTier(): Promise<string | null> {
  // Lazy import: the license store pulls in the db singleton (which requires DATABASE_URL at load).
  const { resolveTokenSource } = await import("@/lib/license/store");
  const { token } = await resolveTokenSource();
  if (!token) return null;
  const claims = parseClaims(token);
  return claims?.tier ?? null;
}

/**
 * Atomically claim the right to send a telemetry report. A single `UPDATE … RETURNING` is the sole
 * debounce gate: it stamps `last_attempt_at` and mints (or reuses) a `report_id`, but only when the
 * row is both (a) past the daily send window since the last success and (b) past the retry lease
 * since the last attempt. Concurrent callers race on the same row — exactly one UPDATE matches, so
 * exactly one claim is returned; the rest get null. The minted `report_id` persists across retries
 * (COALESCE) so the receiver dedups, and is cleared on confirm. Returns null when not due / lease held.
 */
export async function claimSend(
  db: typeof Db,
  windowMs: number = SEND_WINDOW_MS,
  leaseMs: number = RETRY_LEASE_MS,
): Promise<{ instanceId: string; reportId: string } | null> {
  const result = await db.execute(sql`
    UPDATE telemetry_state
       SET last_attempt_at = now(),
           report_id = COALESCE(report_id, gen_random_uuid())
     WHERE id = 'singleton'
       AND (last_sent_at IS NULL OR last_sent_at < now() - make_interval(secs => ${windowMs / 1000}))
       AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => ${leaseMs / 1000}))
     RETURNING instance_id, report_id
  `);
  // node-postgres (the configured driver, see src/lib/db.ts) returns a QueryResult with `.rows`.
  const rows = (result as unknown as { rows: { instance_id: string; report_id: string }[] }).rows;
  const row = rows[0];
  return row ? { instanceId: row.instance_id, reportId: row.report_id } : null;
}

/** Mark the claimed report as delivered: stamp `last_sent_at` and clear `report_id` (so the next
 *  cycle mints a fresh one). Only called after a confirmed 2xx. */
export async function confirmSend(db: typeof Db): Promise<void> {
  await db.execute(
    sql`UPDATE telemetry_state SET last_sent_at = now(), report_id = NULL WHERE id = 'singleton'`,
  );
}
