import { html, raw } from "hono/html";

export type Theme = "dark"; // v1 ships dark only; "light" | "system" land later (spec §11)
const KNOWN: Theme[] = ["dark"];

/** Resolve the active theme from the ps_theme cookie value. Unknown/missing → dark. */
export function resolveTheme(cookie: string | undefined): Theme {
  return KNOWN.includes(cookie as Theme) ? (cookie as Theme) : "dark";
}

/** Inline <script> for <head> — sets data-theme before first paint (no FOUC). Already wired for
 *  light/system; with only dark values defined it resolves to dark (no-op). */
export function themeBootScript() {
  const js = `(function(){try{var m=document.cookie.match(/(?:^|; )ps_theme=([^;]+)/);var t=m?decodeURIComponent(m[1]):'dark';if(t==='system'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
  return html`<script>${raw(js)}</script>`;
}
