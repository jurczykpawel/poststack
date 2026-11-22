import type { MiddlewareHandler } from "hono";
import { authenticateDashboard, sessionCookie } from "@/lib/auth";

export const requireSession: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const auth = await authenticateDashboard(c.req.raw).catch(() => null);
  if (!auth) {
    if (!c.req.raw.headers.has("authorization")) c.header("set-cookie", sessionCookie("", 0));
    return c.req.header("HX-Request") === "true"
      ? c.body("", 200, { "HX-Redirect": "/login" })
      : c.redirect("/login");
  }
  await next();
  const noTransform = c.res.headers.get("Cache-Control")?.includes("no-transform");
  c.res.headers.set("Cache-Control", `private, no-store${noTransform ? ", no-transform" : ""}`);
};
