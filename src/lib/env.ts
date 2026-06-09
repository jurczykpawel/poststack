import { z } from "zod";

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

  // AI rephrase (optional -- rule type "ai_rephrase" falls back to original text without key)
  OPENAI_API_KEY: z.string().default(""),

  // Meta (optional — app starts without them, OAuth won't work until configured)
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),

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

  return parsed.data;
}

export const env = loadEnv();
