// Placeholder personalization for auto-reply text (a PRO feature). Supported tokens:
//   {imie} → the contact's first name (first token of display_name)
//   {name} → the contact's full display_name
//
// Gating contract: when the feature is disabled (no/expired license), placeholders are
// stripped to a safe fallback — a literal "{imie}" must NEVER reach a contact, and no
// personal data is substituted either. When enabled but the name is unknown, the same
// safe fallback applies. Whitespace/punctuation left behind is tidied.

export interface PersonalizeContext {
  displayName: string | null;
  enabled: boolean;
  /** Replacement when a name can't be resolved (or the feature is off). Default "". */
  fallback?: string;
}

const PLACEHOLDER = /\{(imie|name)\}/;
const FIRST_NAME_G = /\{imie\}/g;
const FULL_NAME_G = /\{name\}/g;

export function hasPlaceholders(text: string | null | undefined): boolean {
  return !!text && PLACEHOLDER.test(text);
}

// Collapse the gaps a removed placeholder leaves: spaces before punctuation, doubled
// spaces, and trailing space before a newline — without touching deliberate newlines.
function tidy(s: string): string {
  return s
    .replace(/ +([,.!?:;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function applyPersonalization(text: string, ctx: PersonalizeContext): string {
  const fallback = ctx.fallback ?? "";
  const full = ctx.enabled && ctx.displayName?.trim() ? ctx.displayName.trim() : fallback;
  const first = full ? full.split(/\s+/)[0] : fallback;
  const out = text.replace(FIRST_NAME_G, first).replace(FULL_NAME_G, full);
  return tidy(out);
}

/** True if any text field a rule can send carries a placeholder (for the authoring gate). */
export function responseConfigHasPlaceholders(config: Record<string, unknown>): boolean {
  const texts: Array<string | null | undefined> = [
    config.text as string | undefined,
    config.comment_reply_text as string | undefined,
  ];
  for (const k of ["messages", "comment_reply_texts"] as const) {
    const pool = config[k];
    if (Array.isArray(pool)) for (const t of pool) if (typeof t === "string") texts.push(t);
  }
  for (const k of ["followed", "not_followed"] as const) {
    const branch = config[k] as Record<string, unknown> | undefined;
    if (branch && typeof branch.text === "string") texts.push(branch.text);
  }
  return texts.some((t) => hasPlaceholders(t));
}
