import { html, raw } from "hono/html";
import type { IconName } from "./icons";
type Html = ReturnType<typeof html>;
type Variant = "primary" | "secondary" | "danger" | "ghost";
export interface BtnOpts {
  label: string;
  variant?: Variant;
  size?: "sm" | "md";
  href?: string;
  icon?: IconName;
  /** Raw HTML attribute string. MUST be a static literal (e.g. HTMX attrs).
   *  Never pass user/DB input — it is injected unescaped via raw(). */
  attrs?: string;
}

export function btn(o: BtnOpts): Html {
  const cls = `btn btn-${o.variant ?? "secondary"} btn-${o.size ?? "md"}`;
  const inner = html`${o.icon ? raw(`<svg class="btn-ic" width="14" height="14" aria-hidden="true"><use href="#i-${o.icon}"/></svg>`) : ""}${o.label}`;
  return o.href
    ? html`<a class="${cls}" href="${o.href}" ${raw(o.attrs ?? "")}>${inner}</a>`
    : html`<button class="${cls}" ${raw(o.attrs ?? "")}>${inner}</button>`;
}
