import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { CSS } from "./styles";

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

const NAV = [
  { href: "/inbox", label: "Inbox" },
  { href: "/approvals", label: "Approvals" },
  { href: "/rules", label: "Rules" },
  { href: "/channels", label: "Channels" },
  { href: "/contacts", label: "Contacts" },
  { href: "/sequences", label: "Sequences" },
  { href: "/settings", label: "Settings" },
];

export function dashboardDoc(title: string, active: string, content: Html): Html {
  return doc(
    title,
    html`<div class="app">
  <aside class="sidebar">
    <div class="brand">ReplyStack</div>
    <nav class="nav">
      ${NAV.map(
        (n) =>
          html`<a class="nav-link ${n.href === active ? "active" : ""}" href="${n.href}">${n.label}</a>`,
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
