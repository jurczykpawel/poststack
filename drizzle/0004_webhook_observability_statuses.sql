ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_ok';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_fail';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_signature';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_parse';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_object';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_too_large';--> statement-breakpoint
ALTER TABLE channels ADD COLUMN IF NOT EXISTS messaging_token_expires_at timestamptz;--> statement-breakpoint
CREATE TYPE "public"."approval_source" AS ENUM('rule', 'ai_auto', 'ai_manual');--> statement-breakpoint
CREATE TYPE "public"."ai_draft_target" AS ENUM('dm', 'public', 'both');--> statement-breakpoint
ALTER TABLE "pending_approvals" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN "source" "approval_source" DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_target" "ai_draft_target" DEFAULT 'dm' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_prompt" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_autosend_dm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_autosend_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_draft_prompt" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_rephrase_prompt" text;
