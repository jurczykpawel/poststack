// The PRO feature registry and the tier -> features map. This is the *mechanism*,
// not the pricing policy: which existing features become PRO is decided later
// (sub-project C). B ships the gate plus a single seed feature.
//
// tier comes from the Sellf token (claims.tier); ReplyStack maps it to a feature
// set here, so adding a tier (e.g. a free-registration "registered" tier between
// free and pro) is a one-line change with zero gate refactor.

/** Gateable licensed features. Extend the union as features are introduced. */
export type Feature =
  | "personalization"
  | "ai_rephrase"
  | "sequences"
  | "interactive_messages"
  | "follow_gate"
  | "multi_channel"
  | "non_meta_channels"
  | "multi_workspace";

export type TierId = string;

// Per-tier feature sets, composed so higher tiers are supersets of lower ones.
// Free is deliberately minimal (the anti-ManyChat pitch): one FB + one IG channel,
// keyword auto-reply, and unlimited messages/contacts. Almost everything else is PRO.
// `multi_workspace` (multitenancy) lives ONLY in `business` — owner-only until a Sellf
// business variant exists. `pro` is what is sold today.
const PRO: readonly Feature[] = [
  "personalization",
  "ai_rephrase",
  "sequences",
  "interactive_messages",
  "follow_gate",
  "multi_channel", // a 2nd+ channel of the same platform (e.g. another FB page / IG account)
  "non_meta_channels", // any channel that isn't Facebook/Instagram (Telegram, future Gmail, …)
];
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

const FEATURE_LABEL: Record<Feature, string> = {
  personalization: "Personalization placeholders ({imie}/{name})",
  ai_rephrase: "AI rephrasing",
  sequences: "Drip sequences",
  interactive_messages: "Buttons and quick replies",
  follow_gate: "Follow-gate",
  multi_channel: "More than one channel per platform",
  non_meta_channels: "Channels other than Facebook/Instagram",
  multi_workspace: "Multiple workspaces",
};

/** A one-line, user-facing reason for a 402 on a given feature. */
export function proMessage(feature: Feature): string {
  return `${FEATURE_LABEL[feature]} requires a PRO license.`;
}
