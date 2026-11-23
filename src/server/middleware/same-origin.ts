import type { MiddlewareHandler } from "hono";
import { ApiErrors } from "@/lib/api/response";
import { readApiKeyCredential, readSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// One policy for every state-changing browser request (dashboard forms and session-authenticated
// /api/v1 writes). Sec-Fetch-Site must be same-origin (or none: user-initiated, not forgeable by
// another site); a sibling subdomain sends same-site and is refused, because the SameSite=Lax session
// cookie is still attached there. Without Sec-Fetch-Site the full Origin must equal APP_URL's origin.
// A request with neither header (non-browser client carrying a session explicitly) is allowed.
export function isSameOriginRequest(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method)) return true;

  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";

  const origin = headers.get("origin");
  if (origin === null) return true;
  try {
    return origin !== "null" && origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (!isSameOriginRequest(c.req.method, c.req.raw.headers)) return c.text("Forbidden", 403);
  return next();
};

export const requireSameOriginForSessionWrites: MiddlewareHandler = async (c, next) => {
  const request = c.req.raw;
  if (!isSameOriginRequest(request.method, request.headers) &&
      readSessionCookie(request.headers.get("cookie")) && readApiKeyCredential(request) === null) {
    return ApiErrors.forbidden();
  }
  return next();
};
