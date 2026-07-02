// The single source of truth for what's gated: one registry array, each row tagging a feature with
// its functional AREA (publishing / replies / core), the minimum TIER that unlocks it, a status, and
// user-facing copy. Licensing a NEW feature = add one row here + one requireFeature()/hasFeature() at
// the call-site. The `Feature` union is DERIVED from this array, so call-sites stay type-checked and
// the registry can never drift from the type.
//
// `area` is the second entitlement dimension: a license entitles a set of areas (from the signed
// token), and a feature is granted only when the tier meets minTier AND its area is entitled. `core`
// is always entitled. `status: "live"` is enforced now; `"planned"` is reserved on the roadmap.
import type { Tier } from "./tiers";
import { meetsTier, normalizeTier } from "./tiers";
import type { Area } from "./areas";

export interface FeatureDef {
  key: string;
  area: Area;
  minTier: Tier;
  status: "live" | "planned";
  label: string;
  description: string;
}

export const FEATURES = [
  // ── replies wing (the reply/inbox feature set) ──────────────────────────────────────────────
  { key: "personalization", area: "replies", minTier: "pro", status: "live", label: "Personalization placeholders ({imie}/{name})", description: "Insert the contact's name into auto-replies." },
  { key: "ai_rephrase", area: "replies", minTier: "pro", status: "live", label: "AI rephrasing", description: "Rephrase replies with an LLM for variety." },
  { key: "ai_draft", area: "replies", minTier: "pro", status: "live", label: "AI-drafted replies", description: "Generate an AI draft reply for a conversation (auto, or on demand from the inbox), parked for your approval." },
  { key: "sequences", area: "replies", minTier: "pro", status: "live", label: "Drip sequences", description: "Automated multi-step message sequences." },
  { key: "interactive_messages", area: "replies", minTier: "pro", status: "live", label: "Buttons and quick replies", description: "Send interactive buttons and quick replies." },
  { key: "follow_gate", area: "replies", minTier: "pro", status: "live", label: "Follow-gate", description: "Require a follow before delivering a reply." },
  { key: "multi_channel", area: "replies", minTier: "pro", status: "live", label: "More than one channel per platform", description: "Connect a 2nd+ channel of the same platform (e.g. another FB page / IG account)." },
  { key: "non_meta_channels", area: "replies", minTier: "pro", status: "live", label: "Channels other than Facebook/Instagram", description: "Any channel that isn't Facebook/Instagram (Telegram, future Gmail, …)." },
  { key: "contacts_crm", area: "replies", minTier: "pro", status: "live", label: "The contacts CRM (managing individual people)", description: "The contacts CRM: contacts list, tags, assignment. Reading the inbox is free." },
  { key: "manual_reply", area: "replies", minTier: "pro", status: "live", label: "Replying to conversations by hand (rules still auto-reply for free)", description: "A human typing a reply in the inbox / via the API. Free = rules auto-reply only." },
  { key: "reaction_trigger", area: "replies", minTier: "pro", status: "live", label: "Auto-replies triggered by a message reaction", description: "Rules that fire on a message reaction (free triggers are keyword/comment only)." },

  // ── core (connection / access infra shared by both wings) ───────────────────────────────────
  { key: "managed_connection", area: "core", minTier: "pro", status: "live", label: "Meta managed connection (one token connects all Pages + Instagram)", description: "Connect one master FB/IG token that auto-enumerates Pages and linked Instagram accounts, mints and refreshes their tokens automatically." },
  { key: "api_access", area: "core", minTier: "pro", status: "live", label: "API access (REST API keys)", description: "Programmatic REST access via API keys (the dashboard uses session auth, unaffected)." },
  { key: "webhook_insights", area: "core", minTier: "pro", status: "live", label: "Webhook delivery stats", description: "Aggregate counts of inbound webhook events by outcome (delivered, auto-replied, errors) on the Webhooks page." },
  // multitenancy is owner-only for now: pro (sold today) must NOT unlock it — business only.
  { key: "multi_workspace", area: "core", minTier: "business", status: "live", label: "Multiple workspaces", description: "Run more than one isolated workspace (multi-tenant / agency)." },

  // ── publishing wing (PostStack feature set — placeholders wired up in Phase 1/3) ─────────────
  { key: "multi_brand", area: "publishing", minTier: "pro", status: "live", label: "Multiple brands", description: "Manage more than one brand — run it as an agency or across projects." },
  { key: "webhook_filtering", area: "publishing", minTier: "pro", status: "live", label: "Webhook event filtering", description: "Restrict an outbound webhook to specific event types. An endpoint with no filter receives every event type." },
  { key: "auto_story", area: "publishing", minTier: "pro", status: "live", label: "Auto-Story", description: "Auto-publish a generated Story card about every post published to a channel." },
  { key: "first_comment", area: "publishing", minTier: "pro", status: "live", label: "Automatic first comment", description: "Auto-post a first comment (e.g. “link in the comments”) under every published post." },
  { key: "multi_api_key", area: "core", minTier: "pro", status: "live", label: "Multiple API keys", description: "Issue more than one API key (e.g. one per client/integration)." },
  { key: "outbound_webhooks", area: "core", minTier: "pro", status: "live", label: "Outbound webhooks", description: "Subscribe an external URL to events (contact.created, post.published, …), delivered HMAC-signed with retry. Like API access, this is a programmatic integration capability." },
] as const satisfies readonly FeatureDef[];

/** Gateable feature keys — the union is derived from the registry, so it can never drift. */
export type Feature = (typeof FEATURES)[number]["key"];

/** Open tier identifier (any string from the Sellf token; normalised against the ladder). */
export type TierId = string;

const BY_KEY = new Map<string, FeatureDef>(FEATURES.map((f) => [f.key, f]));

/** The registry row for a key, or undefined for an unknown key. */
export function getFeature(key: string): FeatureDef | undefined {
  return BY_KEY.get(key);
}

/** The functional area of a (known) feature. */
export function featureArea(key: Feature): Area {
  return BY_KEY.get(key)!.area;
}

/**
 * The set of feature keys a tier unlocks (independent of area — area entitlement is applied in the
 * gate). Unknown / null tiers degrade to free, which grants nothing (every feature is minTier >= pro).
 */
export function tierFeatures(tier: string | null): Set<Feature> {
  if (!tier) return new Set();
  const t = normalizeTier(tier);
  return new Set(FEATURES.filter((f) => meetsTier(t, f.minTier)).map((f) => f.key as Feature));
}

/** A one-line, user-facing reason for a 402 on a given feature — names the area (publishing/replies)
 *  when the feature belongs to a wing, so the message reflects WHICH product is needed, not just tier. */
export function proMessage(feature: Feature): string {
  const f = BY_KEY.get(feature);
  const label = f?.label ?? feature;
  const tier = (f?.minTier ?? "pro").toUpperCase();
  if (f?.area === "publishing") return `${label} requires a ${tier} license with the publishing product.`;
  if (f?.area === "replies") return `${label} requires a ${tier} license with the replies product.`;
  return `${label} requires a ${tier} license.`;
}

/** Per-tier numeric limits (Infinity = unlimited). New limit kind = add to each tier. */
export type LimitKind = "brands" | "apiKeys";
export const LIMITS: Record<Tier, Record<LimitKind, number>> = {
  free: { brands: 1, apiKeys: 1 },
  registered: { brands: 1, apiKeys: 1 }, // reserved tier — same as free until options are assigned
  pro: { brands: Infinity, apiKeys: Infinity },
  business: { brands: Infinity, apiKeys: Infinity },
};
