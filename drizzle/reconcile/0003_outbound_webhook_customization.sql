ALTER TABLE "webhook_endpoints" ADD COLUMN IF NOT EXISTS "custom_headers_encrypted" text;
ALTER TABLE "webhook_endpoints" ADD COLUMN IF NOT EXISTS "extra_payload_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;
