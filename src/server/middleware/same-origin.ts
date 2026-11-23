import type { MiddlewareHandler } from "hono";
import { ApiErrors } from "@/lib/api/response";
import { readApiKeyCredential, readSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Keep the page policy for dashboard forms. API session writes also check the full Origin when sent.
// Clients that carry a session explicitly can omit both browser headers.
export function isSameOriginRequest(method: string, headers: Headers, { strict = false } = {}): boolean {
  if (SAFE_METHODS.has(method)) return true;

  const site = headers.get("sec-fetch-site");
  if (!strict && site) return site !== "cross-site";
  if (strict && site !== null && site !== "same-origin") return false;

  const origin = headers.get("origin");
  if (origin === null || (!strict && origin === "")) return true;
  try {
    const appUrl = new URL(env.APP_URL);
    return strict ? origin !== "null" && origin === appUrl.origin : new URL(origin).host === appUrl.host;
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
  if (!isSameOriginRequest(request.method, request.headers, { strict: true }) &&
      readSessionCookie(request.headers.get("cookie")) && readApiKeyCredential(request) === null) {
    return ApiErrors.forbidden();
  }
  return next();
};
