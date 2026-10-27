DO $$ BEGIN
  ALTER TABLE "channels" RENAME COLUMN "ai_draft_prompt" TO "ai_draft_prompt_dm";
EXCEPTION WHEN undefined_column THEN null; END $$;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_draft_prompt_dm" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_draft_prompt_public" text;

DO $$ BEGIN
  ALTER TABLE "workspaces" RENAME COLUMN "ai_draft_prompt" TO "ai_draft_prompt_dm";
EXCEPTION WHEN undefined_column THEN null; END $$;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_draft_prompt_dm" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_draft_prompt_public" text;
