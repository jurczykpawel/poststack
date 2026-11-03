DO $$ BEGIN
  CREATE TYPE "public"."post_preview_status" AS ENUM('ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS "post_previews" (
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_previews_workspace_id_fkey' AND conrelid = 'post_previews'::regclass) THEN
    ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE cascade;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_previews_channel_id_fkey' AND conrelid = 'post_previews'::regclass) THEN
    ALTER TABLE "post_previews" ADD CONSTRAINT "post_previews_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE cascade;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "post_previews_workspace_channel_post_key" ON "post_previews" USING btree ("workspace_id","channel_id","post_id");
