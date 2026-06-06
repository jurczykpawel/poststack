import { Hono } from "hono";
import { createChallenge } from "altcha-lib";
import { prisma } from "@/lib/prisma";
import { openApiSpec } from "@/lib/api/openapi";

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <title>ReplyStack API Docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/api/v1"
      data-configuration='{"theme":"purple","layout":"modern"}'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export const publicRoutes = new Hono();

publicRoutes.get("/api/health", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    return c.json({ status: "error", message: "Database unreachable" }, 503);
  }
});

publicRoutes.get("/api/docs", (c) =>
  c.html(DOCS_HTML),
);

publicRoutes.get("/api/v1", (c) => c.json(openApiSpec));

publicRoutes.get("/api/captcha/challenge", async (c) => {
  const hmacKey = process.env.ALTCHA_HMAC_KEY;
  if (!hmacKey) {
    return c.json({ error: "Captcha not configured" }, 503);
  }
  try {
    const challenge = await createChallenge({ hmacKey, maxNumber: 100_000 });
    return c.json(challenge);
  } catch (err) {
    console.error("[captcha/challenge] Failed:", err);
    return c.json({ error: "Failed to generate challenge" }, 500);
  }
});
