ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "secret_secondary_expires_at" timestamp (3) with time zone;
