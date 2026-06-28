CREATE TYPE "public"."capture_field" AS ENUM('email', 'phone');--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "awaiting_capture" "capture_field";--> statement-breakpoint
ALTER TABLE "telemetry_state" ADD COLUMN "last_attempt_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "telemetry_state" ADD COLUMN "report_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "platform_post_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_workspace_platform_post_id_idx" ON "posts" USING btree ("workspace_id","platform_post_id");