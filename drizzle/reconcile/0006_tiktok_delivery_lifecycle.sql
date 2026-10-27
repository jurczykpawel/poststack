ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'processing';
DO $$ BEGIN
  CREATE TYPE "tiktok_confirmation" AS ENUM ('scheduled', 'immediate', 'required', 'confirmed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "tiktok_confirmation" "tiktok_confirmation" DEFAULT 'scheduled' NOT NULL;
