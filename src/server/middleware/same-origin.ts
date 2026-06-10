import type { MiddlewareHandler } from "hono";
import { env } from "@/lib/env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function appHost(): string {
  try {
    return new URL(env.APP_URL).host;
  } catch {
    return "";
  }
}

// Only accept state-changing requests that come from the app's own pages. Modern browsers send
// Sec-Fetch-Site (accept same-origin/same-site/none, refuse cross-site); clients that omit it fall
// back to an Origin host match against APP_URL. A request with neither header — e.g. a non-browser
// client carrying a valid session cookie — is allowed, since the SameSite=Lax session cookie already
// governs browser cross-site requests; this also keeps server-to-server callers working.
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const site = c.req.header("sec-fetch-site");
  if (site) {
    if (site === "cross-site") return c.text("Forbidden", 403);
    return next();
  }

  const origin = c.req.header("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return c.text("Forbidden", 403);
    }
    if (host !== appHost()) return c.text("Forbidden", 403);
  }
  return next();
};
