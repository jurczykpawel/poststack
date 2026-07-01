import { html } from "hono/html";
import { icon } from "./icons";

type Html = ReturnType<typeof html>;

/** A small "🔒 PRO" upgrade link, used wherever a gated feature shows an upsell instead of itself. */
export function proLink(upgradeUrl: string, label = "PRO"): Html {
  return html`<a href="${upgradeUrl}" target="_blank" rel="noopener" class="pro-link" style="color:var(--primary);text-decoration:none;white-space:nowrap">${icon("lock", "ico", 12)} ${label}</a>`;
}
