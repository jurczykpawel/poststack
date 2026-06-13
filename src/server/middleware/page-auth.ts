import { jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { env } from "@/lib/env";
import { BRAND } from "@/lib/brand";
import { readSessionCookie, sessionCookie } from "@/lib/auth";

const secret = new TextEncoder().encode(env.JWT_SECRET);

// Gate dashboard pages on a valid session cookie. Mirrors the former Next
// middleware: the JWT denylist is enforced by API handlers, not here.
export const requireSession: MiddlewareHandler = async (c, next) => {
  const token = readSessionCookie(c.req.header("cookie") ?? null);
  if (!token) return c.redirect("/login");
  try {
    // Pin the verify algorithm to HS256 (what signSession uses) — defense-in-depth against a future
    // asymmetric-key refactor re-opening alg-confusion.
    await jwtVerify(token, secret, { issuer: BRAND.jwtIssuer, audience: BRAND.jwtIssuer, algorithms: ["HS256"] });
    return next();
  } catch {
    c.header("set-cookie", sessionCookie("", 0));
    return c.redirect("/login");
  }
};
