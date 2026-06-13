import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createChallenge } from "altcha-lib";
import { db } from "@/lib/db";
import { openApiSpec } from "@/lib/api/openapi";
import { t } from "@/lib/i18n";

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <title>${t("apiDocs.title")}</title>
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
    await db.execute(sql`SELECT 1`);
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
    // Expire the challenge in 10 minutes so a solution cannot be redeemed long
    // after issuance (verifySolution rejects an expired salt). This is shorter
    // than the single-use record's lifetime, so there is no reuse window.
    const challenge = await createChallenge({ hmacKey, maxNumber: 100_000, expires: new Date(Date.now() + 10 * 60_000) });
    return c.json(challenge);
  } catch (err) {
    console.error("[captcha/challenge] Failed:", err);
    return c.json({ error: "Failed to generate challenge" }, 500);
  }
});
