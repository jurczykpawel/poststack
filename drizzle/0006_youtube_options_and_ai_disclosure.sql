CREATE TYPE "public"."ai_disclosure_level" AS ENUM('none', 'ai_assisted', 'ai_generated');--> statement-breakpoint
CREATE TYPE "public"."youtube_privacy" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "default_ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "default_ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "default_ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "default_ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_privacy" "youtube_privacy";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_tags" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_category_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_made_for_kids" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure" "ai_disclosure_level";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure_note" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "ai_disclosure_sent" jsonb;
--> statement-breakpoint
CREATE TYPE "public"."tiktok_publish_mode" AS ENUM('inbox', 'direct');
--> statement-breakpoint
CREATE TYPE "public"."tiktok_privacy_level" AS ENUM('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_publish_mode" "tiktok_publish_mode";
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_privacy_level" "tiktok_privacy_level";
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_comment" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_duet" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_disable_stitch" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_brand_content_toggle" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_brand_organic_toggle" boolean;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "tiktok_cover_timestamp_ms" integer;

--> statement-breakpoint
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'processing';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "tiktok_confirmation" AS ENUM ('scheduled', 'immediate', 'required', 'confirmed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "tiktok_confirmation" "tiktok_confirmation" DEFAULT 'scheduled' NOT NULL;

--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_comment_id" uuid REFERENCES "comment_logs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_message_id_idx" ON "pending_approvals" ("inbound_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_comment_id_idx" ON "pending_approvals" ("inbound_comment_id");
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "http_status" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_workspace_endpoint_created_idx" ON "webhook_deliveries" ("workspace_id", "endpoint_id", "created_at", "id");

--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'media'
      AND column_name = 'size' AND data_type = 'integer') THEN
    ALTER TABLE "media" ALTER COLUMN "size" TYPE bigint;
  END IF;
END $$;

--> statement-breakpoint
ALTER TYPE "public"."media_status" ADD VALUE IF NOT EXISTS 'ingesting';
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "source_url" text;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "error" text;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "canonical_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_canonical_id_fkey' AND conrelid = 'media'::regclass) THEN
    ALTER TABLE "media" ADD CONSTRAINT "media_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "media"("id") ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "media_workspace_status_idx" ON "media" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "media_canonical_idx" ON "media" ("canonical_id");
--> statement-breakpoint
CREATE TYPE "public"."youtube_license" AS ENUM('youtube', 'creativeCommon');--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_chapters" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_license" "youtube_license";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_embeddable" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_public_stats_viewable" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_notify_subscribers" boolean;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_default_language" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_recording_date" timestamp (3);--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "youtube_localizations" jsonb;--> statement-breakpoint
CREATE INDEX "message_reactions_workspace_id_created_at_idx" ON "message_reactions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "deliveries_workspace_status_scheduled_idx" ON "deliveries" USING btree ("workspace_id","status","scheduled_at","id");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sent_at" timestamp (3);--> statement-breakpoint
CREATE TYPE "public"."post_preview_status" AS ENUM('ready', 'failed');--> statement-breakpoint
CREATE TABLE "post_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"post_id" text NOT NULL,
	"status" "post_preview_status" NOT NULL,
	"text" text,
	"image_url" text,
	"permalink" text,
	"posted_at" timestamp (3),
	"fetched_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "post_previews_workspace_channel_post_key" ON "post_previews" USING btree ("workspace_id","channel_id","post_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."video_carousel_state" AS ENUM ('unknown', 'unavailable', 'available');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "video_carousel" "public"."video_carousel_state" DEFAULT 'unknown' NOT NULL;

--> statement-breakpoint
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

--> statement-breakpoint
-- Shared insights storage
CREATE TYPE "public"."insight_access_state" AS ENUM('unknown', 'ready', 'missing_permission', 'needs_reauth', 'unsupported');
--> statement-breakpoint
CREATE TYPE "public"."insight_collection_mode" AS ENUM('off', 'on');
--> statement-breakpoint
CREATE TYPE "public"."insight_grain" AS ENUM('day', 'range', 'snapshot', 'audience_window');
--> statement-breakpoint
CREATE TYPE "public"."insight_level" AS ENUM('account', 'post', 'audience');
--> statement-breakpoint
CREATE TYPE "public"."insight_metric_type" AS ENUM('time_series', 'total_value', 'profile_field', 'media_lifetime');
--> statement-breakpoint
CREATE TYPE "public"."insight_period" AS ENUM('day', 'lifetime');
--> statement-breakpoint
CREATE TYPE "public"."insight_reason" AS ENUM('none', 'first_sync', 'provider_unavailable', 'rate_limited', 'token_required', 'permission_required', 'channel_paused', 'collection_off', 'worker_delayed');
--> statement-breakpoint
CREATE TYPE "public"."insight_response_state" AS ENUM('available', 'not_available', 'insufficient_audience', 'unsupported');
--> statement-breakpoint
CREATE TABLE "insight_connections" (
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"collection_mode" "insight_collection_mode" DEFAULT 'off' NOT NULL,
	"access_state" "insight_access_state" DEFAULT 'unknown' NOT NULL,
	"transport" text,
	"credential_revision" text,
	"budget_key" text,
	"ig_grants" jsonb DEFAULT '{"version":1,"names":[],"checkedAt":null,"revision":null}'::jsonb NOT NULL,
	"fb_grants" jsonb DEFAULT '{"version":1,"names":[],"checkedAt":null,"revision":null}'::jsonb NOT NULL,
	"reason" "insight_reason" DEFAULT 'none' NOT NULL,
	"access_checked_at" timestamp with time zone,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"backoff_until" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_until" timestamp with time zone,
	"checkpoint" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"usage_budget" jsonb DEFAULT '{"version":1,"requestTimes":[],"nextSafeAt":null}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insight_connections_pkey" PRIMARY KEY("workspace_id","channel_id"),
	CONSTRAINT "insight_connections_strings_check" CHECK (length("insight_connections"."transport") BETWEEN 1 AND 128 AND length("insight_connections"."credential_revision") BETWEEN 1 AND 128 AND length("insight_connections"."budget_key") BETWEEN 1 AND 128),
	CONSTRAINT "insight_connections_failure_check" CHECK ("insight_connections"."failure_count" >= 0),
	CONSTRAINT "insight_connections_claim_check" CHECK (("insight_connections"."claim_token" IS NULL) = ("insight_connections"."claim_until" IS NULL)),
	CONSTRAINT "insight_connections_ig_grants_check" CHECK (CASE WHEN jsonb_typeof("insight_connections"."ig_grants") = 'object' AND jsonb_typeof("insight_connections"."ig_grants"->'names') = 'array' THEN
		"insight_connections"."ig_grants" @> '{"version":1}'::jsonb AND "insight_connections"."ig_grants" ?& ARRAY['names','checkedAt','revision']
		AND "insight_connections"."ig_grants" - ARRAY['version','names','checkedAt','revision'] = '{}'::jsonb
		AND octet_length("insight_connections"."ig_grants"::text) <= 16384 AND jsonb_array_length("insight_connections"."ig_grants"->'names') <= 64
		AND NOT jsonb_path_exists("insight_connections"."ig_grants", '$.names[*] ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:.-]{1,128}$"))')
		AND jsonb_typeof("insight_connections"."ig_grants"->'checkedAt') IN ('null','string') AND jsonb_typeof("insight_connections"."ig_grants"->'revision') IN ('null','string')
		AND length(coalesce("insight_connections"."ig_grants"->>'checkedAt','')) <= 128 AND length(coalesce("insight_connections"."ig_grants"->>'revision','')) <= 128
		ELSE false END),
	CONSTRAINT "insight_connections_fb_grants_check" CHECK (CASE WHEN jsonb_typeof("insight_connections"."fb_grants") = 'object' AND jsonb_typeof("insight_connections"."fb_grants"->'names') = 'array' THEN
		"insight_connections"."fb_grants" @> '{"version":1}'::jsonb AND "insight_connections"."fb_grants" ?& ARRAY['names','checkedAt','revision']
		AND "insight_connections"."fb_grants" - ARRAY['version','names','checkedAt','revision'] = '{}'::jsonb
		AND octet_length("insight_connections"."fb_grants"::text) <= 16384 AND jsonb_array_length("insight_connections"."fb_grants"->'names') <= 64
		AND NOT jsonb_path_exists("insight_connections"."fb_grants", '$.names[*] ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_:.-]{1,128}$"))')
		AND jsonb_typeof("insight_connections"."fb_grants"->'checkedAt') IN ('null','string') AND jsonb_typeof("insight_connections"."fb_grants"->'revision') IN ('null','string')
		AND length(coalesce("insight_connections"."fb_grants"->>'checkedAt','')) <= 128 AND length(coalesce("insight_connections"."fb_grants"->>'revision','')) <= 128
		ELSE false END),
	CONSTRAINT "insight_connections_checkpoint_check" CHECK (jsonb_typeof("insight_connections"."checkpoint") = 'object'
		AND "insight_connections"."checkpoint" @> '{"version":1}'::jsonb AND octet_length("insight_connections"."checkpoint"::text) <= 8192
		AND "insight_connections"."checkpoint" - ARRAY['version','from','to','cursor'] = '{}'::jsonb
		AND length(coalesce("insight_connections"."checkpoint"->>'cursor','')) <= 4096 AND length(coalesce("insight_connections"."checkpoint"->>'from','')) <= 128 AND length(coalesce("insight_connections"."checkpoint"->>'to','')) <= 128
		AND NOT jsonb_path_exists("insight_connections"."checkpoint", '$.keyvalue() ? (@.key != "version" && (@.value.type() != "string" || !(@.value like_regex "^.+$" flag "s")))')),
	CONSTRAINT "insight_connections_usage_budget_check" CHECK (CASE WHEN jsonb_typeof("insight_connections"."usage_budget") = 'object' AND jsonb_typeof("insight_connections"."usage_budget"->'requestTimes') = 'array' THEN
		"insight_connections"."usage_budget" @> '{"version":1}'::jsonb AND "insight_connections"."usage_budget" ? 'nextSafeAt'
		AND "insight_connections"."usage_budget" - ARRAY['version','requestTimes','nextSafeAt','usagePercent'] = '{}'::jsonb
		AND octet_length("insight_connections"."usage_budget"::text) <= 16384 AND jsonb_array_length("insight_connections"."usage_budget"->'requestTimes') <= 120
		AND NOT jsonb_path_exists("insight_connections"."usage_budget", '$.requestTimes[*] ? (@.type() != "string" || !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]{5,40}$"))')
		AND (("insight_connections"."usage_budget"->'nextSafeAt') = 'null'::jsonb OR jsonb_path_exists("insight_connections"."usage_budget", '$.nextSafeAt ? (@.type() == "string" && @ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]{5,40}$")'))
		AND (NOT ("insight_connections"."usage_budget" ? 'usagePercent') OR "insight_connections"."usage_budget"->'usagePercent' = 'null'::jsonb OR jsonb_path_exists("insight_connections"."usage_budget", '$.usagePercent ? (@.type() == "number" && @ >= 0 && @ <= 100)'))
		ELSE false END)
);

--> statement-breakpoint
CREATE TABLE "insight_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"metric_key" text NOT NULL,
	"level" "insight_level" NOT NULL,
	"subject_key" text NOT NULL,
	"grain" "insight_grain" NOT NULL,
	"period" "insight_period" NOT NULL,
	"metric_type" "insight_metric_type" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"provider_day" date,
	"boundary_basis" text NOT NULL,
	"snapshot_day" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"scalar" numeric,
	"response_state" "insight_response_state" NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"query_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transport" text NOT NULL,
	"api_version" text NOT NULL,
	"definition_version" text NOT NULL,
	"coverage_basis" text NOT NULL,
	"query_key" text NOT NULL,
	CONSTRAINT "insight_observations_window_check" CHECK ("insight_observations"."window_end" > "insight_observations"."window_start"),
	CONSTRAINT "insight_observations_scalar_check" CHECK ("insight_observations"."scalar" >= 0 AND "insight_observations"."scalar" NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
	CONSTRAINT "insight_observations_response_check" CHECK (("insight_observations"."response_state" = 'available' AND "insight_observations"."scalar" IS NOT NULL) OR ("insight_observations"."response_state" <> 'available' AND "insight_observations"."scalar" IS NULL)),
	CONSTRAINT "insight_observations_strings_check" CHECK (length("insight_observations"."metric_key") BETWEEN 1 AND 128 AND length("insight_observations"."subject_key") BETWEEN 1 AND 255 AND length("insight_observations"."boundary_basis") BETWEEN 1 AND 128 AND length("insight_observations"."transport") BETWEEN 1 AND 128 AND length("insight_observations"."api_version") BETWEEN 1 AND 128 AND length("insight_observations"."definition_version") BETWEEN 1 AND 128 AND length("insight_observations"."coverage_basis") BETWEEN 1 AND 128),
	CONSTRAINT "insight_observations_query_key_check" CHECK ("insight_observations"."query_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "insight_observations_dimensions_check" CHECK (CASE WHEN jsonb_typeof("insight_observations"."dimensions") = 'object' THEN octet_length("insight_observations"."dimensions"::text) <= 8192
		AND jsonb_array_length(jsonb_path_query_array("insight_observations"."dimensions", '$.keyvalue()')) <= 32
		AND NOT jsonb_path_exists("insight_observations"."dimensions", '$.keyvalue() ? (!(@.key like_regex "^.{1,128}$" flag "s") || @.value.type() != "string" || !(@.value like_regex "^.{0,128}$" flag "s"))')
		ELSE false END),
	CONSTRAINT "insight_observations_query_params_check" CHECK (CASE WHEN jsonb_typeof("insight_observations"."query_params") = 'object' THEN octet_length("insight_observations"."query_params"::text) <= 8192
		AND jsonb_array_length(jsonb_path_query_array("insight_observations"."query_params", '$.keyvalue()')) <= 32
		AND NOT jsonb_path_exists("insight_observations"."query_params", '$.keyvalue() ? (!(@.key like_regex "^.{1,128}$" flag "s") || @.value.type() != "string" || !(@.value like_regex "^.{0,128}$" flag "s"))')
		ELSE false END)
);

--> statement-breakpoint
CREATE UNIQUE INDEX "channels_workspace_id_id_platform_key" ON "channels" USING btree ("workspace_id","id","platform");
--> statement-breakpoint
ALTER TABLE "insight_connections" ADD CONSTRAINT "insight_connections_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insight_connections" ADD CONSTRAINT "insight_connections_channel_fk" FOREIGN KEY ("workspace_id","channel_id","platform") REFERENCES "public"."channels"("workspace_id","id","platform") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insight_observations" ADD CONSTRAINT "insight_observations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "insight_observations" ADD CONSTRAINT "insight_observations_channel_fk" FOREIGN KEY ("workspace_id","channel_id","platform") REFERENCES "public"."channels"("workspace_id","id","platform") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "insight_connections_due_idx" ON "insight_connections" USING btree ("workspace_id","collection_mode","next_due_at");
--> statement-breakpoint
CREATE INDEX "insight_connections_budget_idx" ON "insight_connections" USING btree ("workspace_id","budget_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "insight_observations_identity_key" ON "insight_observations" USING btree ("workspace_id","channel_id","platform","level","subject_key","metric_key","query_key","snapshot_day");
--> statement-breakpoint
CREATE INDEX "insight_observations_channel_window_idx" ON "insight_observations" USING btree ("workspace_id","channel_id","window_start","window_end");
--> statement-breakpoint
CREATE INDEX "insight_observations_retention_idx" ON "insight_observations" USING btree ("workspace_id","grain","snapshot_day");
