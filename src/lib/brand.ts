// Single source of truth for the product brand and its brand-NEUTRAL machine identifiers.
//
// The display name may be a working brand, so it lives in ONE place and is env-overridable
// (`BRAND_NAME`). The machine identifiers (API-key prefix, session-cookie name, JWT issuer/
// audience) are deliberately brand-neutral: a brand rename must NOT churn issued keys, live
// cookies, or signed tokens — so they never spell out the brand. Everything that needs the
// brand name or these identifiers reads them from here (DRY), never hardcodes them.
export const BRAND = {
  /** Display name. Working-brand-friendly: change it here or via the BRAND_NAME env var. */
  name: process.env.BRAND_NAME?.trim() || "PostStack",
  /** API-key plaintext prefix (`sk_live_<secret>`). Brand-neutral on purpose. */
  idPrefix: "sk_live_",
  /** Session cookie name. Brand-neutral on purpose. */
  cookieName: "session",
  /** JWT issuer + audience for session tokens. Brand-neutral on purpose. */
  jwtIssuer: "stack",
} as const;
