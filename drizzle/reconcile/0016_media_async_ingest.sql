ALTER TYPE "public"."media_status" ADD VALUE IF NOT EXISTS 'ingesting';
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "source_url" text;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "error" text;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "canonical_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_canonical_id_fkey' AND conrelid = 'media'::regclass) THEN
    ALTER TABLE "media" ADD CONSTRAINT "media_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "media"("id") ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "media_workspace_status_idx" ON "media" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "media_canonical_idx" ON "media" ("canonical_id");
