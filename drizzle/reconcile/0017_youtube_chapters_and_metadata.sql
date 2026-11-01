DO $$ BEGIN
  CREATE TYPE "public"."youtube_license" AS ENUM('youtube', 'creativeCommon');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_chapters" jsonb;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_license" "youtube_license";
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_embeddable" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_public_stats_viewable" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_notify_subscribers" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_default_language" text;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_recording_date" timestamp (3);
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "youtube_localizations" jsonb;
