import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { CSS } from "./styles";
import { env } from "@/lib/env";
import { BRAND } from "@/lib/brand";
import type { Feature } from "@/lib/license/features";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const HEAD = html`
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/htmx-ext-json-enc@2.0.1/json-enc.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js"></script>
`;

export function doc(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${raw(CSS)}</style>
${HEAD}
</head>
<body>${body}</body>
</html>`;
}

// Nav items carry an optional `feature`: when the instance license does not grant it,
// the link is shown locked (🔒) and points at the upgrade page instead. Overview is the
// free landing; Inbox/Contacts are the customer-CRM surface, Sequences its own PRO feature.
const NAV: { href: string; label: string; feature?: Feature }[] = [
  { href: "/overview", label: "Overview" },
  { href: "/inbox", label: "Inbox", feature: "contacts_crm" },
  { href: "/approvals", label: "Approvals" },
  { href: "/rules", label: "Rules" },
  { href: "/channels", label: "Channels" },
  { href: "/contacts", label: "Contacts", feature: "contacts_crm" },
  { href: "/engagement", label: "Engagement", feature: "contacts_crm" },
  { href: "/sequences", label: "Sequences", feature: "sequences" },
  { href: "/settings", label: "Settings" },
];

// `features` defaults to empty (fail-closed): a caller that does not resolve the license
// renders gated items locked rather than leaking access.
export function dashboardDoc(title: string, active: string, content: Html, features: Set<Feature> = new Set()): Html {
  return doc(
    title,
    html`<div class="app">
  <aside class="sidebar">
    <div class="brand">${BRAND.name}</div>
    <nav class="nav">
      ${NAV.map((n) =>
        n.feature && !features.has(n.feature)
          ? html`<a class="nav-link locked" href="${env.LICENSE_UPGRADE_URL}" target="_blank" rel="noopener" title="Requires a PRO license">${n.label} 🔒</a>`
          : html`<a class="nav-link ${n.href === active ? "active" : ""}" href="${n.href}">${n.label}</a>`,
      )}
    </nav>
    <form class="signout" hx-post="/logout">
      <button class="btn-ghost" type="submit" style="cursor:pointer">Sign out</button>
    </form>
  </aside>
  <main class="main">${content}</main>
</div>`,
  );
}
