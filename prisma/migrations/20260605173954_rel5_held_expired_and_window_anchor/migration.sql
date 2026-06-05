-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "message_status" ADD VALUE 'held';
ALTER TYPE "message_status" ADD VALUE 'expired';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "last_inbound_at" TIMESTAMP(3);
