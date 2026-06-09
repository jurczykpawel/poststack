CREATE TYPE "public"."outbound_delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'held', 'expired', 'unknown');--> statement-breakpoint
CREATE TABLE "outbound_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"task_name" text NOT NULL,
	"status" "outbound_delivery_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"platform_message_id" text,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_delivery_key_key" ON "outbound_deliveries" USING btree ("delivery_key");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_channel_id_status_idx" ON "outbound_deliveries" USING btree ("channel_id","status");