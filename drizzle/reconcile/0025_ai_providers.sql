DO $$ BEGIN CREATE TYPE "public"."ai_provider_kind" AS ENUM('openai', 'anthropic', 'openrouter', 'groq', 'custom'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."ai_provider_status" AS ENUM('untested', 'ok', 'invalid_key', 'model_not_found', 'rate_limited', 'no_credits', 'timeout', 'unreachable', 'blocked_target', 'bad_response', 'invalid_request'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"position" integer NOT NULL,
	"provider" "ai_provider_kind" NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hint" text NOT NULL,
	"last_test_status" "ai_provider_status" DEFAULT 'untested' NOT NULL,
	"last_test_at" timestamp (3),
	"last_success_at" timestamp (3),
	"created_by_user_id" uuid,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_position_check" CHECK ("ai_providers"."position" >= 1)
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_creator_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_workspace_position" ON "ai_providers" USING btree ("workspace_id","position") WHERE "ai_providers"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_instance_position" ON "ai_providers" USING btree ("position") WHERE "ai_providers"."workspace_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_creator_idx" ON "ai_providers" USING btree ("created_by_user_id");
