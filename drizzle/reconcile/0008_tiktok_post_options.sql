DO $$ BEGIN
  CREATE TYPE "public"."tiktok_publish_mode" AS ENUM('inbox', 'direct');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."tiktok_privacy_level" AS ENUM('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_publish_mode" "tiktok_publish_mode";
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_privacy_level" "tiktok_privacy_level";
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_disable_comment" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_disable_duet" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_disable_stitch" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_brand_content_toggle" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_brand_organic_toggle" boolean;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "tiktok_cover_timestamp_ms" integer;
