CREATE TYPE "public"."capture_field" AS ENUM('email', 'phone');--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "awaiting_capture" "capture_field";