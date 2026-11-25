import { panelErrorPage } from "../ui/error-page";
import type { MiddlewareHandler } from "hono";
import { authenticateDashboard, hasBearerCredential, sessionCookie } from "@/lib/auth";

export const requireSession: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const auth = await authenticateDashboard(c.req.raw).catch(() => null);
  if (!auth) {
    if (!hasBearerCredential(c.req.raw)) c.header("set-cookie", sessionCookie("", 0));
    return c.req.header("HX-Request") === "true"
      ? c.body("", 200, { "HX-Redirect": "/login" })
      : c.redirect("/login");
  }
  await next();
  const status = c.res.status;
  if (c.req.method === "GET" && c.req.header("HX-Request") !== "true" &&
      (status === 403 || status === 404) && !c.res.headers.get("Content-Type")?.startsWith("text/html")) {
    const message = status === 403 && c.res.headers.get("Content-Type")?.startsWith("text/plain")
      ? await c.res.text() : undefined;
    c.res = await c.html(await panelErrorPage(status, message), status);
  }
  const noTransform = c.res.headers.get("Cache-Control")?.includes("no-transform");
  c.res.headers.set("Cache-Control", `private, no-store${noTransform ? ", no-transform" : ""}`);
};
