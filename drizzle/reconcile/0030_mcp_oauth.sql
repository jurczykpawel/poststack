DO $$ BEGIN CREATE TYPE "public"."oauth_grant_status" AS ENUM('pending', 'active'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"status" "oauth_grant_status" DEFAULT 'pending' NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_expires_at" timestamp (3) NOT NULL,
	"refresh_token_hash" text,
	"refresh_expires_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "oauth_grant_id" uuid;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_grants_code_hash_key" ON "oauth_grants" USING btree ("code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_grants_refresh_token_hash_key" ON "oauth_grants" USING btree ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_workspace_id_idx" ON "oauth_grants" USING btree ("workspace_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_oauth_grant_id_fkey" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_oauth_grant_id_idx" ON "api_keys" USING btree ("oauth_grant_id");
