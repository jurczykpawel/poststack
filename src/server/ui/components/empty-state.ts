import { html } from "hono/html";
import { btn } from "./button";

type Html = ReturnType<typeof html>;

export interface EmptyStateOpts {
  title: string;
  body: string;
  /** Optional call-to-action rendered as a secondary button. */
  action?: { label: string; href: string };
}

/** A calm placeholder for an empty panel (e.g. "All healthy ✓" when nothing needs attention). */
export function emptyState(o: EmptyStateOpts): Html {
  return html`<div class="empty">
    <p class="empty-title">${o.title}</p>
    <p class="empty-body">${o.body}</p>
    ${o.action ? btn({ label: o.action.label, href: o.action.href, variant: "secondary", size: "sm" }) : ""}
  </div>`;
}
