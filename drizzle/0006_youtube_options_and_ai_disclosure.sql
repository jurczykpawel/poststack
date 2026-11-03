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

--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'media'
      AND column_name = 'size' AND data_type = 'integer') THEN
    ALTER TABLE "media" ALTER COLUMN "size" TYPE bigint;
  END IF;
END $$;

--> statement-breakpoint
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
--> statement-breakpoint
CREATE TYPE "public"."youtube_license" AS ENUM('youtube', 'creativeCommon');--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_chapters" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_license" "youtube_license";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_embeddable" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_public_stats_viewable" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_notify_subscribers" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_default_language" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_recording_date" timestamp (3);--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_localizations" jsonb;--> statement-breakpoint
CREATE INDEX "message_reactions_workspace_id_created_at_idx" ON "message_reactions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "deliveries_workspace_status_scheduled_idx" ON "deliveries" USING btree ("workspace_id","status","scheduled_at","id");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "failure_reason" text;--> statement-breakpoint
CREATE TYPE "public"."post_preview_status" AS ENUM('ready', 'failed');--> statement-breakpoint
CREATE TABLE "post_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"post_id" text NOT NULL,
	"status" "post_preview_status" NOT NULL,
	"text" text,
	"image_url" text,
	"permalink" text,
	"posted_at" timestamp (3),
	"fetched_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "post_previews_workspace_channel_post_key" ON "post_previews" USING btree ("workspace_id","channel_id","post_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;
