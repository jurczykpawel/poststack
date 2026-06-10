import { jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { env } from "@/lib/env";

const secret = new TextEncoder().encode(env.JWT_SECRET);

function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("rs_session="));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice("rs_session=".length));
  } catch {
    return null;
  }
}

// Gate dashboard pages on a valid session cookie. Mirrors the former Next
// middleware: the JWT denylist is enforced by API handlers, not here.
export const requireSession: MiddlewareHandler = async (c, next) => {
  const token = sessionToken(c.req.header("cookie"));
  if (!token) return c.redirect("/login");
  try {
    // Pin the verify algorithm to HS256 (what signSession uses) — defense-in-depth against a future
    // asymmetric-key refactor re-opening alg-confusion.
    await jwtVerify(token, secret, { issuer: "replystack", audience: "replystack", algorithms: ["HS256"] });
    return next();
  } catch {
    c.header("set-cookie", "rs_session=; Path=/; Max-Age=0");
    return c.redirect("/login");
  }
};
