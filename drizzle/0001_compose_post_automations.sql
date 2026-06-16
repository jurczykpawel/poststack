-- COMPOSE1: per-post overrides for publish-time automations (first comment + auto-story).
-- The rest of the schema (channels.default_*, messages.delivered_at, comment_logs.post_url, the
-- 'recorded' enum value) is already in 0000_init.sql + live, so this migration adds ONLY the two new
-- posts columns. IF NOT EXISTS keeps it idempotent against any hand-patched database.
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "first_comment" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "auto_story" boolean;
