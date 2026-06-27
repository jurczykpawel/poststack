ALTER TABLE "telemetry_state" ADD COLUMN "last_attempt_at" timestamp (3);--> statement-breakpoint
ALTER TABLE "telemetry_state" ADD COLUMN "report_id" uuid;