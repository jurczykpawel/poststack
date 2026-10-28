import { currentBrand } from "@/lib/brand";
import { html, raw } from "hono/html";

export type Theme = "dark" | "light";

/** Resolve the server-side data-theme from the ps_theme cookie. "system" can't be detected on the
 *  server, so it falls back to the instance theme; the boot script then corrects it
 *  client-side before first paint via prefers-color-scheme. */
export function resolveTheme(cookie: string | undefined): Theme {
  return cookie === "light" || cookie === "dark" ? cookie : currentBrand().theme;
}

/** Set the saved preference or instance theme before first paint. */
export function themeBootScript() {
  const js = `(function(){try{var m=document.cookie.match(/(?:^|; )ps_theme=([^;]+)/);var t=m?decodeURIComponent(m[1]):'${currentBrand().theme}';if(t==='system'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
  return html`<script>${raw(js)}</script>`;
}
