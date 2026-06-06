import { Hono } from "hono";
import { cors } from "hono/cors";
import { securityHeaders } from "./middleware/security-headers";
import { publicRoutes } from "./routes/public";
import { v1 } from "./routes/v1";

const corsMiddleware = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});

export function buildApp(): Hono {
  const app = new Hono();

  app.use("*", securityHeaders());
  app.use("/api/v1", corsMiddleware);
  app.use("/api/v1/*", corsMiddleware);

  app.route("/", publicRoutes);
  app.route("/api/v1", v1);

  return app;
}
