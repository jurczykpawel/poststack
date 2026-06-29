ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_ok';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'handshake_fail';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_signature';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_parse';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_object';--> statement-breakpoint
ALTER TYPE "public"."webhook_event_handling_status" ADD VALUE IF NOT EXISTS 'rejected_too_large';
