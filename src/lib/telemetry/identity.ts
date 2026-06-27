// The only identity an instance reports with its telemetry is a random uuid (the instance id),
// generated once and persisted in the telemetry_state singleton, plus its license tier (a low-entropy
// enum). No domain or order hash is emitted — those were pseudonymous (brute-forceable over a fixed
// pepper), so the payload now carries nothing linkable back to a person or deployment.

import { eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { telemetryState } from "@/db/schema";
import { parseClaims } from "@/lib/license/format";

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
