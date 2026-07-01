import { html } from "hono/html";
import { icon } from "./icons";

type Html = ReturnType<typeof html>;

/**
 * Shared "no AI provider configured" banner. Rendered wherever AI drafts / rephrasing are configured
 * or triggered when no provider key is set — the single source of truth behind the inbox buttons, the
 * Settings prompt forms, the per-rule fields, and the per-channel AI-draft panel (and, as a boolean,
 * the API's `ai_configured`). `what` names the affected feature, e.g. "AI drafts", "rephrasing".
 */
export function aiUnconfiguredBanner(what: string): Html {
  return html`<div class="notice notice-warn" style="font-size:.8rem;display:flex;align-items:center;gap:6px">${icon("sparkles", "ico", 14)}<span>No AI provider configured — ${what} won't run until you add an API key in <a href="/settings">Settings → Credentials (AI rephrasing)</a>.</span></div>`;
}
