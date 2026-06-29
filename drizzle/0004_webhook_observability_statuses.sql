ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_ok';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_fail';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_signature';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_parse';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_object';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_too_large';--> statement-breakpoint
ALTER TABLE channels ADD COLUMN IF NOT EXISTS messaging_token_expires_at timestamptz;
