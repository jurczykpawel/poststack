import type { MiddlewareHandler } from "hono";

// Two Content-Security-Policies:
//   • the APP policy (tight) governs the dashboard, the API and everything else — connect-src 'self',
//     no third-party scripts beyond the altcha CDN, no data: fonts;
//   • the LANDING policy (slightly wider) governs ONLY the marketing landing's HTML documents, which
//     load a few cross-origin extras: the public telemetry stats endpoint (Live fleet section),
//     Umami + Google Tag Manager analytics (when configured), and inlined @fontsource data: webfonts.
// The landing is served by this app (built Astro in landing/dist), but only its documents need the
// extra allowances — so we scope the relaxation to those paths instead of loosening the whole app.

/** Public telemetry stats endpoint the landing's Live fleet section reads (hardcoded in the landing). */
const TELEMETRY_ORIGIN = "https://telemetry.techskills.academy";
/** Default Umami host (overridable per deploy via LANDING_UMAMI_SRC). */
const UMAMI_DEFAULT_ORIGIN = "https://stats.techskills.academy";
/** GTM bootstrap (gtm.js) host. */
const GTM_SCRIPT_ORIGIN = "https://www.googletagmanager.com";
/** Hosts GTM/GA4 may POST measurement to — Google's endpoints plus our server-side GTM container. */
const GTM_COLLECT_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://t.poststack.techskills.academy",
];

export interface LandingAnalyticsEnv {
  umamiWebsiteId?: string;
  umamiSrc?: string;
  gtmId?: string;
}

export interface CspOptions {
  /** When true, widen script/connect/font for the marketing landing's analytics, telemetry + webfonts. */
  landing?: boolean;
  /** Analytics config (read from env) — only consulted when `landing` is true. */
  analytics?: LandingAnalyticsEnv;
}

const present = (v: string | undefined): boolean => !!v && v.trim().length > 0;
const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Resolve the origin of a URL string; null when empty/invalid. */
function originOf(url: string | undefined): string | null {
  if (!present(url)) return null;
  try {
    return new URL(url!.trim()).origin;
  } catch {
    return null;
  }
}

/** Build a Content-Security-Policy. The base is tight; `landing: true` adds only what the marketing
 *  documents need (and only for the analytics that are actually configured). Pure → unit-testable. */
export function buildContentSecurityPolicy(opts: CspOptions = {}): string {
  // cdn.jsdelivr.net stays in the base: the app loads the altcha widget from it on its own forms.
  const scriptSrc = ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"];
  const connectSrc = ["'self'"];
  const fontSrc = ["'self'"];

  if (opts.landing) {
    connectSrc.push(TELEMETRY_ORIGIN); // Live fleet section reads the public stats endpoint
    fontSrc.push("data:"); // the landing inlines its webfonts as base64 data: URIs (@fontsource)

    const a = opts.analytics ?? {};
    if (present(a.umamiWebsiteId)) {
      const umami = originOf(a.umamiSrc) ?? UMAMI_DEFAULT_ORIGIN;
      scriptSrc.push(umami);
      connectSrc.push(umami);
    }
    if (present(a.gtmId)) {
      scriptSrc.push(GTM_SCRIPT_ORIGIN);
      connectSrc.push(...GTM_COLLECT_ORIGINS);
    }
  }

  return [
    "default-src 'self'",
    `script-src ${dedupe(scriptSrc).join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src ${dedupe(connectSrc).join(" ")}`,
    `font-src ${dedupe(fontSrc).join(" ")}`,
    // The captcha widget runs its proof-of-work in a blob: worker on both the app and landing forms.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const STATIC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-DNS-Prefetch-Control": "on",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

// Precompute both policies once. Only the landing's HTML documents get the relaxed one; assets
// (_astro/*, og.png, …) don't need it — a document's own CSP governs what it may load, not the CSP
// on the sub-resource responses.
const APP_CSP = buildContentSecurityPolicy({ landing: false });
const LANDING_CSP = buildContentSecurityPolicy({
  landing: true,
  analytics: {
    umamiWebsiteId: process.env.LANDING_UMAMI_WEBSITE_ID,
    umamiSrc: process.env.LANDING_UMAMI_SRC,
    gtmId: process.env.LANDING_GTM_ID,
  },
});

/** The landing's HTML documents (see src/server/routes/landing.ts). These — and only these — get the
 *  wider CSP; the dashboard, API and static assets keep the tight app CSP. */
export const LANDING_DOCUMENT_PATHS = new Set(["/", "/privacy", "/privacy/"]);

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(STATIC_HEADERS)) {
      c.res.headers.set(key, value);
    }
    const csp = LANDING_DOCUMENT_PATHS.has(c.req.path) ? LANDING_CSP : APP_CSP;
    c.res.headers.set("Content-Security-Policy", csp);
    if (c.req.path.startsWith("/api/")) {
      c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    }
  };
}
