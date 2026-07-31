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