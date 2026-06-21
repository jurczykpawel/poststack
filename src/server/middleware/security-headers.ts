import type { MiddlewareHandler } from "hono";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-DNS-Prefetch-Control": "on",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    // 'self' for the app's own XHR/fetch; the public telemetry host lets the marketing landing's
    // "Live fleet" section read the aggregate stats endpoint client-side (it is otherwise blocked).
    "connect-src 'self' https://telemetry.techskills.academy",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
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
