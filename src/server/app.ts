import { Hono } from "hono";
import { cors } from "hono/cors";
import { securityHeaders } from "./middleware/security-headers";
import { publicRoutes } from "./routes/public";
import { special } from "./routes/special";
import { v1 } from "./routes/v1";
import { pages } from "./routes/pages";
import { ApiErrors } from "@/lib/api/response";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { ProRequiredError } from "@/lib/license/gate";
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
        return ApiErrors.proRequired(e.feature, env.LICENSE_UPGRADE_URL);
      }
      console.error(`Unhandled API error on ${c.req.method} ${sanitizeForLog(c.req.path)}: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
      return ApiErrors.internal();
    }
    console.error(`Unhandled error: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
    return c.text("Internal Server Error", 500);
  });

  app.route("/", publicRoutes);
  app.route("/", special);
  app.route("/api/v1", v1);
  app.route("/", pages);

  return app;
}
