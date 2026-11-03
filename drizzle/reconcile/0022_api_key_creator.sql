-- AIPROVIDER1: remember which user created an API key, so instance-operator scopes can be re-checked against the creator.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_created_by_user_id_fkey') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;
  END IF;
END $$;
