import { z } from "zod";
import { isSafeAlertWebhookUrl } from "@/lib/notifications/webhook-url";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default("7d"),
  // Open self-registration. Default closed: the first user (empty instance) can
  // always register to bootstrap; after that, set "true" to allow more.
  REGISTRATION_ENABLED: z.string().default("false"),

  // Encryption - must be 32-byte hex (64 chars). The hex regex catches a 64-char NON-hex value
  // at startup; otherwise Buffer.from(key,"hex") yields a 0-byte key and the failure surfaces
  // only on the first encryptTokens (e.g. a channel connect), not at boot.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, "TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 chars). Generate: openssl rand -hex 32")
    .regex(/^[0-9a-f]{64}$/i, "TOKEN_ENCRYPTION_KEY must be hex (0-9a-f). Generate: openssl rand -hex 32"),

  // App
  APP_URL: z.string().url(),

  // Reverse-proxy trust. "" (default) = only trust X-Real-IP / the rightmost
  // X-Forwarded-For hop (the proxy's own value). Set "cloudflare" ONLY when
  // actually behind Cloudflare, to trust CF-Connecting-IP.
  TRUSTED_PROXY: z.string().default(""),

  // Altcha CAPTCHA (optional -- login/register skip verification without key)
  ALTCHA_HMAC_KEY: z.string().default(""),

  // AI rephrase (optional -- rule type "ai_rephrase" falls back to original text without key).
  // Declared here (not read ad-hoc from process.env) so the model + endpoint are a single typed
  // source with defaults, and a malformed base URL fails at boot instead of silently.
  OPENAI_API_KEY: z.string().default(""),
  AI_REPHRASE_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  // Per-workspace LLM-call budget over a rolling 24h window. An ai_rephrase rule on a broad trigger
  // (welcome/default) fires one paid LLM call per inbound across ALL contacts, so an inbound flood
  // would otherwise run up an unbounded OpenAI bill; over this cap rephrase fails soft to the
  // operator's base text. Generous default for normal use; tune down for a tight budget.
  AI_REPHRASE_DAILY_LIMIT: z.coerce.number().int().positive().default(1000),

  // Meta (optional — app starts without them, OAuth won't work until configured)
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),

  // Optional outbound webhook fired when a channel needs re-auth. Validated up front so a
  // private/link-local target (e.g. the cloud metadata endpoint) is rejected at boot rather
  // than fetched at runtime. https anywhere, or http to a hostname / loopback; a
  // private-IP *literal* is refused.
  CHANNEL_ALERT_WEBHOOK_URL: z
    .string()
    .refine(isSafeAlertWebhookUrl, "must be an http(s) URL to a public or loopback host (no private/link-local IP literals)")
    .optional(),

  // Cron
  CRON_SECRET: z.string().min(32),

  // Runtime
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error(
      "Invalid environment variables:\n",
      parsed.error.flatten().fieldErrors
    );
    throw new Error("Invalid environment variables. Check your .env file.");
  }

  // Surface a clear startup signal for security-relevant settings that are silently lax in
  // production: an unset ALTCHA_HMAC_KEY skips CAPTCHA on auth endpoints, and an unset
  // TRUSTED_PROXY collapses per-IP rate limiting to a single bucket. Documented in the README,
  // but a warning means a misconfigured deploy isn't quietly unprotected.
  if (parsed.data.NODE_ENV === "production") {
    if (!parsed.data.ALTCHA_HMAC_KEY) {
      console.warn("[env] ALTCHA_HMAC_KEY is unset in production — CAPTCHA verification on login/register is SKIPPED.");
    }
    if (!parsed.data.TRUSTED_PROXY) {
      console.warn("[env] TRUSTED_PROXY is unset in production — per-IP rate limiting may collapse to one bucket if behind a proxy.");
    }
  }

  return parsed.data;
}

export const env = loadEnv();
