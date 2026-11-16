CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "hash" text PRIMARY KEY NOT NULL,
  "grant_id" uuid NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_grant_id_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_grant_id_idx" ON "oauth_refresh_tokens" ("grant_id");
