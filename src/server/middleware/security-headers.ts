import type { MiddlewareHandler } from "hono";

// The marketing landing (served by the app at `/`) loads a few cross-origin resources at runtime:
//   • the "Live fleet" section fetches the public telemetry stats endpoint (always);
//   • Umami analytics (script + beacon) when LANDING_UMAMI_WEBSITE_ID is configured;
//   • Google Tag Manager (gtm.js + GA/server-side collection) when LANDING_GTM_ID is configured.
// A bare `connect-src 'self'` (and `script-src` without these hosts) silently blocks them, so the
// fleet numbers never appear and analytics never loads. We build the CSP from the same env the
// landing injection reads, so the policy stays tight when a host is NOT configured (self-hosters
// without analytics get no loosening beyond the public telemetry endpoint the stock landing uses).

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

export interface AnalyticsCspEnv {
  umamiWebsiteId?: string;
  umamiSrc?: string;
  gtmId?: string;
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

/** Build the Content-Security-Policy, widening script/connect only for the analytics that are
 *  actually configured. Pure (env passed in) so it is unit-testable. */
export function buildContentSecurityPolicy(a: AnalyticsCspEnv = {}): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"];
  const connectSrc = ["'self'", TELEMETRY_ORIGIN];

  if (present(a.umamiWebsiteId)) {
    const umami = originOf(a.umamiSrc) ?? UMAMI_DEFAULT_ORIGIN;
    scriptSrc.push(umami);
    connectSrc.push(umami);
  }
  if (present(a.gtmId)) {
    scriptSrc.push(GTM_SCRIPT_ORIGIN);
    connectSrc.push(...GTM_COLLECT_ORIGINS);
  }

  return [
    "default-src 'self'",
    `script-src ${dedupe(scriptSrc).join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src ${dedupe(connectSrc).join(" ")}`,
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-DNS-Prefetch-Control": "on",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": buildContentSecurityPolicy({
    umamiWebsiteId: process.env.LANDING_UMAMI_WEBSITE_ID,
    umamiSrc: process.env.LANDING_UMAMI_SRC,
    gtmId: process.env.LANDING_GTM_ID,
  }),
};

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(key, value);
    }
    if (c.req.path.startsWith("/api/")) {
      c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    }
  };
}
