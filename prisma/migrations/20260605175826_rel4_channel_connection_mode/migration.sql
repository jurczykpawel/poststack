-- CreateEnum
CREATE TYPE "channel_connection_mode" AS ENUM ('oauth', 'manual_token');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "connection_mode" "channel_connection_mode" NOT NULL DEFAULT 'oauth';
