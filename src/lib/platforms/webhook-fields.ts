// WEBHOOKSUB1: single source of truth for which Page webhook fields each platform needs subscribed.
// Both the connect-time subscriber (`subscribePageWebhooks`) and the reconcile/status check read from
// here, so a self-hosted PRO instance always auto-configures the COMPLETE set — never the partial set
// that left message_echoes / reactions / receipts undelivered and required a manual re-subscribe.
//
// IMPORTANT: these are `page`-object subscribed_apps fields. `comments` is NOT a valid page field
// (Graph #100 — it belongs to the `instagram` object app-level subscription); including it makes the
// whole subscribed_apps POST fail atomically. IG media-comment webhooks arrive via the app-level
// `instagram` object subscription, not a page field — so it is intentionally absent here.
//
// WHSUBOPTIN1: only subscribe to fields PostStack actually consumes. `messaging_optins` is omitted —
// no handler consumes optin events and Meta won't durably hold that subscription for this app, so
// requiring it produced a permanent false "missing" that re-subscribing could never clear.

/** Page webhook fields PostStack relies on. Ordered for stable display. */
export const FACEBOOK_PAGE_FIELDS = [
  "messages",
  "messaging_postbacks",
  "message_echoes", // a message sent from elsewhere (FB app / Business Suite / n8n) → keep the thread whole
  "message_reactions", // emoji reactions on our DMs (Engagement) — needs pages_messaging Advanced Access to actually deliver
  "message_reads", // read receipts → "Seen" in the thread
  "message_deliveries", // delivery receipts → ✓✓ in the thread
  "feed", // post comments + post reactions/likes
] as const;

/** Instagram messaging is delivered through the linked Page's subscription, so the same page-valid
 *  fields apply. IG comments come via the app-level `instagram` object subscription (not a page field). */
export const INSTAGRAM_PAGE_FIELDS = [
  "messages",
  "messaging_postbacks",
  "message_echoes",
  "message_reactions",
  "message_reads",
  "message_deliveries",
  "feed",
] as const;

/** IG-Login per-account subscribed_apps fields on the `instagram` object (graph.instagram.com). Field
 *  names are the EXACT instagram-object webhook field names from the Meta dashboard (v25.0): `messages`,
 *  `messaging_postbacks`, `message_reactions` (NOT `messaging_reactions` — that name is invalid and would
 *  make the subscribed_apps POST fail atomically, killing all IG-Login inbound), `messaging_seen`, and
 *  `comments`. Only fields PostStack consumes (WHSUBOPTIN1 principle: omit messaging_optins/_referrals —
 *  no handler). `comments` is REQUIRED so an IG-Login-only channel receives comment webhooks for
 *  comment→DM automation. (Verified against the live app's Webhooks field list, 2026-06-29.) */
export const INSTAGRAM_LOGIN_FIELDS = ["messages", "messaging_postbacks", "message_reactions", "messaging_seen", "comments"] as const;
export function instagramLoginFields(): readonly string[] { return INSTAGRAM_LOGIN_FIELDS; }

export type Platform = "facebook" | "instagram";

/** The expected page subscribed_fields for a platform (the auto-config target + reconcile baseline). */
export function expectedPageFields(platform: Platform): readonly string[] {
  return platform === "instagram" ? INSTAGRAM_PAGE_FIELDS : FACEBOOK_PAGE_FIELDS;
}

/** Generic active/missing split of a `current` subscription against an `expected` field set. The shared
 *  primitive behind both the page diff and the IG-Login per-account diff (DRY). */
export function diffFields(
  expected: readonly string[],
  current: readonly string[],
): { active: string[]; missing: string[] } {
  const cur = new Set(current);
  return {
    active: expected.filter((f) => cur.has(f)),
    missing: expected.filter((f) => !cur.has(f)),
  };
}

/** Diff a page's currently-subscribed fields against what the platform expects. */
export function diffSubscribedFields(
  platform: Platform,
  current: readonly string[],
): { active: string[]; missing: string[] } {
  return diffFields(expectedPageFields(platform), current);
}
