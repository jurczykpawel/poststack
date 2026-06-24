ALTER TYPE "public"."conversation_thread_type" ADD VALUE 'email';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "gmail_query" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "gmail_sync_cursor" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "subject" text;