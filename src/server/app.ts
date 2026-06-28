import { Hono } from "hono";
import { cors } from "hono/cors";
import { securityHeaders } from "./middleware/security-headers";
import { publicRoutes } from "./routes/public";
import { landingRoutes } from "./routes/landing";
import { special } from "./routes/special";
import { v1 } from "./routes/v1";
import { pages } from "./routes/pages";
import { integrationsRoutes } from "./routes/integrations";
import { ApiErrors, ApiError, apiErrorResponse } from "@/lib/api/response";
import { errorPage } from "./ui/error-page";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { ProRequiredError, LimitExceededError } from "@/lib/license/gate";
import { env } from "@/lib/env";

const corsMiddleware = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Idempotency-Key lets a client safely retry a manual reply without double-sending.
  allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
});

export function buildApp(): Hono {
  const app = new Hono();

  app.use("*", securityHeaders());
  app.use("/api/v1", corsMiddleware);
  app.use("/api/v1/*", corsMiddleware);

  // Any uncaught error from an API handler (DB/queue/runtime) must still honour the
  // { data, error } contract — not leak Hono's plain-text 500 — and never expose internals
  //. HTML page routes keep the framework default.
  app.onError((e, c) => {
    if (c.req.path.startsWith("/api/")) {
      // A feature gated behind a PRO license surfaces as 402, not a 500.
      if (e instanceof ProRequiredError) {
        return ApiErrors.proRequired(e.feature, env.LICENSE_UPGRADE_URL, e.message);
      }
      // A tier count-limit (e.g. too many API keys on free) is also a 402.
      if (e instanceof LimitExceededError) {
        return ApiErrors.proRequired(e.kind, env.LICENSE_UPGRADE_URL, e.message);
      }
      // A service-layer ApiError (ported publishing code) carries its own code/status/details.
      if (e instanceof ApiError) {
        return apiErrorResponse(e);
      }
      console.error(`Unhandled API error on ${c.req.method} ${sanitizeForLog(c.req.path)}: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
      return ApiErrors.internal();
    }
    console.error(`Unhandled error: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
    return c.html(errorPage(500), 500);
  });

  // Unmatched routes: branded HTML 404 for pages; JSON contract for the API.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) return ApiErrors.notFound();
    return c.html(errorPage(404), 404);
  });

  app.route("/", publicRoutes);
  // LANDING1: marketing homepage at `/` (+ its assets). Mounted before `pages` so it owns `/`
  // (which `pages` previously redirected to /overview). Logged-in visitors are redirected onward.
  app.route("/", landingRoutes);
  app.route("/", special);
  // Inbound integration webhooks (HMAC-authenticated, NOT Bearer-auth) — mounted outside /api/v1 so
  // the API-key middleware does NOT apply. Off by default (requires REELSTACK_WEBHOOK_SECRET +
  // REELSTACK_WEBHOOK_WORKSPACE_ID). Has its own onError (app-level onError only covers /api/).
  app.route("/", integrationsRoutes());
  app.route("/api/v1", v1);
  app.route("/", pages);

  return app;
}
