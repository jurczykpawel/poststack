-- Populate newly added toggles from legacy settings without overwriting current choices.
DO $$
DECLARE
  has_legacy_settings boolean := (
    SELECT count(*) = 2 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels'
      AND column_name IN ('ai_draft_enabled', 'ai_draft_target')
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels'
      AND column_name = 'ai_draft_dm_enabled'
  ) THEN
    ALTER TABLE "channels" ADD COLUMN "ai_draft_dm_enabled" boolean DEFAULT false NOT NULL;
    IF has_legacy_settings THEN
      UPDATE "channels" SET "ai_draft_dm_enabled" =
        "ai_draft_enabled" AND "ai_draft_target"::text IN ('dm', 'both');
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels'
      AND column_name = 'ai_draft_public_enabled'
  ) THEN
    ALTER TABLE "channels" ADD COLUMN "ai_draft_public_enabled" boolean DEFAULT false NOT NULL;
    IF has_legacy_settings THEN
      UPDATE "channels" SET "ai_draft_public_enabled" =
        "ai_draft_enabled" AND "ai_draft_target"::text IN ('public', 'both');
    END IF;
  END IF;
END $$;

ALTER TABLE "channels" DROP COLUMN IF EXISTS "ai_draft_enabled";
ALTER TABLE "channels" DROP COLUMN IF EXISTS "ai_draft_target";
DROP TYPE IF EXISTS "public"."ai_draft_target";
