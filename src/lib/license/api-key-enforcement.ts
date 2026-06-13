import { gt, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/db/schema";
import { hasFeature } from "@/lib/license/gate";

/**
 * Enforce that API access is a PRO feature on the EXISTING keys (creation is gated separately at the
 * route). When the instance is not licensed for `api_access` — e.g. after a refund/expiry downgrade —
 * every still-valid key has its expiry set to now, so it immediately stops authenticating (auth
 * already rejects an expired key). Re-upgrading does NOT resurrect old keys; the user mints fresh ones.
 *
 * Run after each license refresh. Instance-wide (one license per instance → one verdict for all keys).
 *
 * NOTE (self-host caveat): a self-hoster could clear `expires_at` directly in their own DB to revive a
 * key. That's accepted — an operator with DB access can bypass any in-process check (or edit the AGPL
 * source); it isn't a meaningful vector for license enforcement, which targets honest downgrades.
 */
export async function enforceApiKeyLicense(now: Date = new Date()): Promise<{ expired: number }> {
  if (await hasFeature("api_access")) return { expired: 0 };

  const rows = await db
    .update(apiKeys)
    .set({ expires_at: now })
    .where(or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, now)))
    .returning({ id: apiKeys.id });

  return { expired: rows.length };
}
