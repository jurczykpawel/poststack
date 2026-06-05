-- CreateEnum
CREATE TYPE "channel_status" AS ENUM ('active', 'needs_reauth', 'paused', 'disabled');

-- AlterTable: add new columns (status, health tracking)
ALTER TABLE "channels" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_health_at" TIMESTAMP(3),
ADD COLUMN     "status" "channel_status" NOT NULL DEFAULT 'active';

-- Preserve existing state: active channels stay active, inactive become disabled
UPDATE "channels" SET "status" = CASE WHEN "is_active" THEN 'active'::"channel_status" ELSE 'disabled'::"channel_status" END;

-- Drop the old boolean
ALTER TABLE "channels" DROP COLUMN "is_active";

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");
