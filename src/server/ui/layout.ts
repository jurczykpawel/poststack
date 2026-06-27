import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { env } from "@/lib/env";
import { BRAND } from "@/lib/brand";
import type { Feature } from "@/lib/license/features";
import type { Area } from "@/lib/license/areas";
import { AREAS } from "@/lib/license/areas";
import { resolveTheme, themeBootScript } from "./shell/theme";
import { NAV_SECTIONS, SETTINGS_ITEM, isActive, navItemVisible, allNavItems } from "./shell/nav";
import { iconSprite, icon } from "./components/icons";
import { toastRegion, confirmDialog, uiBehaviorScript } from "./components/toast";
import { commandPalette, paletteTrigger, paletteScript } from "./shell/command-palette";
import { assetUrl } from "./assets";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const ALPINE = assetUrl("vendor/alpine-3.14.9.min.js");
const HTMX = assetUrl("vendor/htmx-2.0.4.min.js");
const HTMX_SSE = assetUrl("vendor/htmx-ext-sse-2.2.2.js");
// json-enc: forms across the app (auth, channels, sources, dashboard) use hx-ext="json-enc" to POST
// JSON; without this extension htmx falls back to form-encoding and the JSON-only handlers reject it.
const HTMX_JSON_ENC = assetUrl("vendor/htmx-ext-json-enc-2.0.3.js");

// The first glyph of the brand name powers the sidebar brand mark (single source: BRAND.name).
function brandGlyph(): string {
  return (BRAND.name.trim()[0] ?? "P").toUpperCase();
}

export interface PageOpts {
  title: string;
  /** Active nav key OR the active item's href (reply routes pass a path like "/inbox"). */
  nav: string;
  body: Html;
  primaryAction?: Html;
  breadcrumb?: string;
  themeCookie?: string;
  /** Entitled features (lock-gating). Defaults to empty = fail-closed (gated items locked). */
  features?: Set<Feature>;
  /** Entitled areas (visibility-gating). Defaults to all areas = every wing visible. */
  products?: Set<Area>;
}

/** Resolve the active nav KEY from either a key or an href path. */
function resolveActiveKey(nav: string): string {
  if (allNavItems().some((i) => i.key === nav)) return nav;
  const byHref = allNavItems().find((i) => isActive(i.key, nav));
  return byHref?.key ?? nav;
}

function sidebar(activeKey: string, features: Set<Feature>, products: Set<Area>): Html {
  const sections = NAV_SECTIONS.map((sec) => {
    const visible = sec.items.filter((it) => navItemVisible(it, products));
    if (visible.length === 0) return html``;
    return html`<div class="nav-sec">${sec.section}</div>
      ${visible.map((it) => {
        const locked = it.feature && !features.has(it.feature);
        if (locked) {
          return html`<a class="nav-item nav-locked" href="${env.LICENSE_UPGRADE_URL}" target="_blank" rel="noopener" title="Requires a PRO license">${icon(it.icon, "ico", 16)}<span>${it.label}</span><span class="nav-soon">PRO</span></a>`;
        }
        const active = it.key === activeKey;
        const cls = active ? "nav-item is-active" : "nav-item";
        const aria = active ? raw(' aria-current="page"') : raw("");
        return html`<a class="${cls}" href="${it.href}"${aria}>${icon(it.icon, "ico", 16)}<span>${it.label}</span></a>`;
      })}`;
  });
  const footActive = activeKey === "settings";
  const footCls = footActive ? "sidebar-foot is-active" : "sidebar-foot";
  const footAria = footActive ? raw(' aria-current="page"') : raw("");
  return html`<aside class="sidebar">
    <div class="brand"><span class="brand-glyph">${brandGlyph()}</span>${BRAND.name}</div>
    <nav aria-label="Primary">${sections}</nav>
    <a class="${footCls}" href="${SETTINGS_ITEM.href}"${footAria}>${icon("settings", "ico", 16)}<span>Settings</span></a>
  </aside>`;
}

function mobileNav(activeKey: string, products: Set<Area>): Html {
  // Prefer a stable, area-aware set of bottom-nav targets, capped to keep the bar legible.
  const preferred = ["overview", "inbox", "content", "channels", "queue"];
  const items = preferred
    .map((k) => allNavItems().find((i) => i.key === k))
    .filter((i): i is NonNullable<typeof i> => !!i && navItemVisible(i, products))
    .slice(0, 4);
  return html`<nav class="mobile-nav" aria-label="Primary mobile">
    ${items.map((it) => {
      const active = it.key === activeKey;
      return html`<a href="${it.href}" class="${active ? "is-active" : ""}"${active ? raw(' aria-current="page"') : raw("")}>${icon(it.icon, "ico", 20)}<span>${it.label}</span></a>`;
    })}
    <a href="${SETTINGS_ITEM.href}">${icon("more", "ico", 20)}<span>More</span></a>
  </nav>`;
}

/** The single Tokyo-Night page shell used by every dashboard page (publish + reply wings). */
export function renderPage(o: PageOpts): Html {
  const theme = resolveTheme(o.themeCookie);
  const features = o.features ?? new Set<Feature>();
  const products = o.products ?? new Set<Area>(AREAS);
  const activeKey = resolveActiveKey(o.nav);
  return html`<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- UXPOLISH1: animate htmx swaps with the View Transitions API (no-op where unsupported). -->
    <meta name="htmx-config" content='{"globalViewTransitions":true}' />
    <title>${o.title}</title>
    ${themeBootScript()}
    <link rel="stylesheet" href="${assetUrl("tokens.css")}" />
    <link rel="stylesheet" href="${assetUrl("admin.css")}" />
    ${uiBehaviorScript()}
    ${paletteScript()}
    <script defer src="${ALPINE}"></script>
    <script defer src="${HTMX}"></script>
    <script defer src="${HTMX_SSE}"></script>
    <script defer src="${HTMX_JSON_ENC}"></script>
    <script defer src="${assetUrl("ps-select.js")}"></script>
    <script defer src="${assetUrl("filter-bar.js")}"></script>
  </head>
  <body x-data>
    ${iconSprite()}
    <a class="skip-link" href="#main">Skip to content</a>
    <!-- REALTIME1 · R4: one SSE connection for the whole shell; sections declare live regions with
         hx-trigger="sse:<kind>" + hx-get to re-render through the SAME server fragment renderer (DRY). -->
    <div class="app" hx-ext="sse" sse-connect="/events/stream">
      ${sidebar(activeKey, features, products)}
      <div class="main">
        <header class="topbar">
          <div class="title-wrap"><h1>${o.title}</h1>${o.breadcrumb ? html`<div class="crumb">${o.breadcrumb}</div>` : ""}</div>
          <div class="topbar-actions">${paletteTrigger()}${o.primaryAction ?? ""}<button type="button" x-data class="btn-ic theme-toggle" aria-label="Toggle light or dark theme" title="Toggle theme" @click="const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', next); document.cookie = 'ps_theme=' + next + '; path=/; max-age=31536000; samesite=lax';">${icon("sun", "ico ico-sun")}${icon("moon", "ico ico-moon")}</button><form class="signout-inline" hx-post="/logout" style="display:inline"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form></div>
        </header>
        <main class="content" id="main" tabindex="-1">${o.body}</main>
      </div>
    </div>
    ${mobileNav(activeKey, products)}
    ${commandPalette(products)}
    ${toastRegion()}
    ${confirmDialog()}
  </body>
</html>`;
}

// ── Auth / minimal doc (login + register) — Tokyo Night, no shell chrome ─────────────────────────
const HEAD = html`
  <script defer src="${ALPINE}"></script>
  <script defer src="${HTMX}"></script>
  <script defer src="${HTMX_JSON_ENC}"></script>
`;

export function doc(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
${themeBootScript()}
<link rel="stylesheet" href="${assetUrl("tokens.css")}" />
<link rel="stylesheet" href="${assetUrl("admin.css")}" />
${HEAD}
</head>
<body>${body}</body>
</html>`;
}

/**
 * Back-compat-shaped wrapper the re-mounted reply sections render through: same call surface as the
 * pre-unify dashboard (`title, active path, content, features`) but now drawn on the unified Tokyo
 * Night shell. `products` (entitled areas) hides the other wing's nav; default = all areas shown.
 */
export function dashboardDoc(
  title: string,
  active: string,
  content: Html,
  features: Set<Feature> = new Set(),
  products?: Set<Area>,
): Html {
  return renderPage({ title, nav: active, body: content, features, products });
}
