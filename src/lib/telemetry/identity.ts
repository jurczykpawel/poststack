// Deterministic identifiers an instance reports with its telemetry. None reveal the actual domain
// or license: domain/order are one-way sha256-hashed over a fixed pepper, and the instance id is a
// random uuid generated once and persisted in the telemetry_state singleton.

import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { telemetryState } from "@/db/schema";
import { hostFromUrl, parseClaims } from "@/lib/license/format";
import { TELEMETRY_HASH_PEPPER } from "./constants";

const SINGLETON = "singleton";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

/** One-way hash of the instance's domain (full lowercased hostname of APP_URL, port stripped). */
export function domainHash(appUrl: string): string {
  const host = (hostFromUrl(appUrl) ?? "").toLowerCase();
  return sha256Hex(TELEMETRY_HASH_PEPPER + host);
}

/** One-way hash of a license order id. */
export function licenseHash(order: string): string {
  return sha256Hex(TELEMETRY_HASH_PEPPER + order);
}

/**
 * The current license's anonymous identity: a one-way hash of its order id plus its tier. Resolves
 * the active token (DB > env), reading the order/tier from its already-verified claims. No license
 * configured (or an unparseable token) → both null.
 */
export async function getLicenseIdentity(): Promise<{ licenseHash: string | null; licenseTier: string | null }> {
  // Lazy import: the license store pulls in the db singleton (which requires DATABASE_URL at load).
  // Keeping it out of the module's static imports lets the pure hashing helpers be used DB-free.
  const { resolveTokenSource } = await import("@/lib/license/store");
  const { token } = await resolveTokenSource();
  if (!token) return { licenseHash: null, licenseTier: null };

  const claims = parseClaims(token);
  if (!claims?.order) return { licenseHash: null, licenseTier: null };

  return { licenseHash: licenseHash(claims.order), licenseTier: claims.tier };
}
