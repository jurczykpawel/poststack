// The PRO feature registry and the tier -> features map. This is the *mechanism*,
// not the pricing policy: which existing features become PRO is decided later
// (sub-project C). B ships the gate plus a single seed feature.
//
// tier comes from the Sellf token (claims.tier); ReplyStack maps it to a feature
// set here, so adding a tier (e.g. a free-registration "registered" tier between
// free and pro) is a one-line change with zero gate refactor.

/** Gateable licensed features. Extend the union as features are introduced. */
export type Feature = "personalization" | "multi_workspace";

export type TierId = string;

// Per-tier feature sets, composed so higher tiers are supersets of lower ones.
// `multi_workspace` (multitenancy: 2nd+ workspace on an instance) lives ONLY in
// `business` — multitenancy is intentionally off for everyone until a Sellf
// `business` variant exists (the owner self-issues a business token for their
// own instance). `pro` is what is sold today.
const PRO: readonly Feature[] = ["personalization"];
const BUSINESS: readonly Feature[] = [...PRO, "multi_workspace"];

/**
 * Open map of tier -> granted features. `free` is the implicit tier for no /
 * invalid / expired license. Add tiers here without touching the gate.
 */
export const TIER_FEATURES: Record<TierId, readonly Feature[]> = {
  free: [],
  pro: [...PRO],
  business: [...BUSINESS],
};

/** Resolves the feature set for a tier; unknown or null tiers degrade to free. */
export function tierFeatures(tier: string | null): Set<Feature> {
  if (!tier) return new Set();
  return new Set(TIER_FEATURES[tier] ?? []);
}
