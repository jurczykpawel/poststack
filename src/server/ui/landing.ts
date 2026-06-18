import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

// The built Astro marketing site (landing/dist). Overridable for tests via LANDING_DIST_DIR so the
// serving logic can be exercised against a fixture without a full Astro build. In the Docker image
// the build stage emits landing/dist next to the app (CWD = /app).
const ROOT = () => process.env.LANDING_DIST_DIR || join(process.cwd(), "landing/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/**
 * Serve a file from the landing build (`landing/dist`). `rel` is the path relative to that root
 * (no leading slash). Path-traversal guarded and extension-allowlisted, mirroring serveAsset.
 * Astro fingerprints `_astro/*` so those are cached immutable; everything else must-revalidate.
 */
/**
 * Runtime analytics config for the landing, read from the app's environment at request time.
 * Self-hosted-friendly: the public image ships with NO tracking IDs baked in; an operator turns
 * analytics on purely via env (so test/prod differ by their compose env, not by the image). When
 * none are set, nothing is injected and the landing loads zero trackers / no consent UI.
 */
function landingAnalyticsConfig(): Record<string, string> {
  const cfg: Record<string, string> = {};
  const gtmId = process.env.LANDING_GTM_ID?.trim();
  const umamiId = process.env.LANDING_UMAMI_WEBSITE_ID?.trim();
  const umamiSrc = process.env.LANDING_UMAMI_SRC?.trim();
  if (gtmId) cfg.gtmId = gtmId;
  if (umamiId) cfg.umamiId = umamiId;
  if (umamiSrc) cfg.umamiSrc = umamiSrc;
  return cfg;
}

// Inject the runtime analytics config as a global, before any of the landing's own head scripts run.
// `<` is escaped so an ID can never break out of the <script> element.
function injectAnalyticsConfig(html: string): string {
  const cfg = landingAnalyticsConfig();
  if (Object.keys(cfg).length === 0) return html;
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const tag = `<script>window.__POSTSTACK_ANALYTICS__=${json}</script>`;
  return html.replace("<head>", `<head>${tag}`);
}

export async function serveLandingFile(c: Context, rel: string): Promise<Response> {
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!/^[\w./-]+$/.test(safe) || safe.includes("..")) return c.notFound();
  const dot = safe.lastIndexOf(".");
  const ext = dot !== -1 ? safe.slice(dot) : "";
  const type = MIME[ext];
  if (!type) return c.notFound();
  try {
    const cache = safe.startsWith("_astro/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate";
    if (ext === ".html") {
      const html = injectAnalyticsConfig(await readFile(join(ROOT(), safe), "utf8"));
      return c.body(html, 200, { "content-type": type, "cache-control": cache });
    }
    const body = await readFile(join(ROOT(), safe));
    return c.body(body, 200, { "content-type": type, "cache-control": cache });
  } catch {
    return c.notFound();
  }
}
