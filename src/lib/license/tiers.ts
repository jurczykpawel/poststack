/**
 * The license tier ladder, low → high. Rank-based, so adding a tier is one array entry and everything
 * compares relatively. Reserved (no features assigned yet, can hold some later):
 *   - `registered` — a free Sellf account (a license with no paid tier) → above anonymous `free`.
 *   - `business`   — multi-tenant / agency, above `pro`.
 * A Sellf `tier` claim maps onto this; anonymous self-host (no license) resolves to `free`.
 */
export const TIERS = ["free", "registered", "pro", "business"] as const;
export type Tier = (typeof TIERS)[number];

const RANK: Record<Tier, number> = { free: 0, registered: 1, pro: 2, business: 3 };

/** Rank of any tier string; unknown / empty / null → free (0). Case-insensitive. */
export function tierRank(tier: string | null | undefined): number {
  const t = (tier ?? "").trim().toLowerCase();
  return t in RANK ? RANK[t as Tier] : 0;
}

/** Narrow any string to a known Tier; unknown → "free". */
export function normalizeTier(tier: string | null | undefined): Tier {
  const t = (tier ?? "").trim().toLowerCase();
  return (TIERS as readonly string[]).includes(t) ? (t as Tier) : "free";
}

/** Does `current` meet (>=) the `min` tier? */
export function meetsTier(current: string | null | undefined, min: Tier): boolean {
  return tierRank(current) >= tierRank(min);
}
