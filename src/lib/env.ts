import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default("7d"),

  // Encryption - must be 32-byte hex (64 chars)
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, "TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 chars). Generate: openssl rand -hex 32"),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url(),

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
  // Skip validation during next build prerendering (no runtime env available)
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return process.env as unknown as z.infer<typeof envSchema>;
  }

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
