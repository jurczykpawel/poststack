DO $$ BEGIN
  CREATE TYPE "auto_story_mode" AS ENUM ('card', 'media');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "default_auto_story_mode" "auto_story_mode" NOT NULL DEFAULT 'card';
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "auto_story_mode" "auto_story_mode";
