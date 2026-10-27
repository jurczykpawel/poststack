DO $$ BEGIN
  CREATE TYPE "public"."ai_generation_kind" AS ENUM('draft', 'rephrase');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "ai_generation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "ai_generation_kind" NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_message" text NOT NULL,
	"response" text,
	"error" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp (3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "ai_generation_logs" ADD CONSTRAINT "ai_generation_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ai_generation_logs_workspace_created_idx" ON "ai_generation_logs" USING btree ("workspace_id","created_at" DESC NULLS LAST);
