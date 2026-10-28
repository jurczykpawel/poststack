CREATE TYPE "public"."ai_disclosure_level" AS ENUM('none', 'ai_assisted', 'ai_generated');--> statement-breakpoint
CREATE TYPE "public"."youtube_privacy" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "default_ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "default_ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "default_ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "default_ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_privacy" "youtube_privacy";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_tags" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_category_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_made_for_kids" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure_sent" jsonb;
--> statement-breakpoint
CREATE TYPE "public"."tiktok_publish_mode" AS ENUM('inbox', 'direct');
--> statement-breakpoint
CREATE TYPE "public"."tiktok_privacy_level" AS ENUM('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_publish_mode" "tiktok_publish_mode";
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_privacy_level" "tiktok_privacy_level";
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_comment" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_duet" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_stitch" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_brand_content_toggle" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_brand_organic_toggle" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_cover_timestamp_ms" integer;

--> statement-breakpoint
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'processing';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "tiktok_confirmation" AS ENUM ('scheduled', 'immediate', 'required', 'confirmed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "tiktok_confirmation" "tiktok_confirmation" DEFAULT 'scheduled' NOT NULL;

--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_comment_id" uuid REFERENCES "comment_logs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_message_id_idx" ON "pending_approvals" ("inbound_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_comment_id_idx" ON "pending_approvals" ("inbound_comment_id");
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "http_status" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_workspace_endpoint_created_idx" ON "webhook_deliveries" ("workspace_id", "endpoint_id", "created_at", "id");
