DO $$ BEGIN
  CREATE TYPE "public"."video_carousel_state" AS ENUM ('unknown', 'unavailable', 'available');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "video_carousel" "public"."video_carousel_state" DEFAULT 'unknown' NOT NULL;
