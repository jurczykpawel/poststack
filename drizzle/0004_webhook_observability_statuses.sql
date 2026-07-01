ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_ok';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_fail';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_signature';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_parse';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_object';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_too_large';--> statement-breakpoint
ALTER TABLE channels ADD COLUMN IF NOT EXISTS messaging_token_expires_at timestamptz;--> statement-breakpoint
CREATE TYPE "public"."approval_source" AS ENUM('rule', 'ai_auto', 'ai_manual');--> statement-breakpoint
ALTER TABLE "pending_approvals" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN "source" "approval_source" DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_dm_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_public_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_prompt_dm" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_prompt_public" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_autosend_dm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "ai_draft_autosend_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_draft_prompt_dm" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_draft_prompt_public" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_rephrase_prompt" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "custom_headers_encrypted" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "extra_payload_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TYPE "public"."ai_generation_kind" AS ENUM('draft', 'rephrase');--> statement-breakpoint
CREATE TABLE "ai_generation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "ai_generation_kind" NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_message" text NOT NULL,
	"response" text,
	"error" text,
	"duration_ms" integer NOT NULL,
	"conversation_id" uuid,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_generation_logs" ADD CONSTRAINT "ai_generation_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ai_generation_logs" ADD CONSTRAINT "ai_generation_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "ai_generation_logs_workspace_created_idx" ON "ai_generation_logs" USING btree ("workspace_id","created_at" DESC NULLS LAST);
