import { html, raw } from "hono/html";

export type Theme = "dark" | "light";

/** Resolve the server-side data-theme from the ps_theme cookie. "system" can't be detected on the
 *  server, so it (and anything unknown/missing) falls back to dark; the boot script then corrects it
 *  client-side before first paint via prefers-color-scheme. */
export function resolveTheme(cookie: string | undefined): Theme {
  return cookie === "light" ? "light" : "dark";
}

/** Inline <script> for <head> — sets data-theme before first paint (no FOUC). Already wired for
 *  light/system; with only dark values defined it resolves to dark (no-op). */
export function themeBootScript() {
  const js = `(function(){try{var m=document.cookie.match(/(?:^|; )ps_theme=([^;]+)/);var t=m?decodeURIComponent(m[1]):'dark';if(t==='system'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
  return html`<script>${raw(js)}</script>`;
}
