-- Prompt and surface columns are reconciled in their final form by later files.
DO $$ BEGIN
  CREATE TYPE "public"."approval_source" AS ENUM('rule', 'ai_auto', 'ai_manual');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "pending_approvals" ALTER COLUMN "rule_id" DROP NOT NULL;
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "source" "approval_source" DEFAULT 'rule' NOT NULL;

ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_draft_autosend_dm" boolean DEFAULT false NOT NULL;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_draft_autosend_public" boolean DEFAULT false NOT NULL;
