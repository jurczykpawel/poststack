-- CreateEnum
CREATE TYPE "workspace_member_role" AS ENUM ('owner', 'admin', 'agent');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "broadcast_recipient_status" AS ENUM ('pending', 'sent', 'delivered', 'failed');

-- AlterTable: convert String status/role columns to enums, preserving existing data.
ALTER TABLE "workspace_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "workspace_members" ALTER COLUMN "role" TYPE "workspace_member_role" USING ("role"::text::"workspace_member_role");
ALTER TABLE "workspace_members" ALTER COLUMN "role" SET DEFAULT 'owner';

ALTER TABLE "pending_approvals" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "pending_approvals" ALTER COLUMN "status" TYPE "approval_status" USING ("status"::text::"approval_status");
ALTER TABLE "pending_approvals" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "broadcast_recipients" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "broadcast_recipients" ALTER COLUMN "status" TYPE "broadcast_recipient_status" USING ("status"::text::"broadcast_recipient_status");
ALTER TABLE "broadcast_recipients" ALTER COLUMN "status" SET DEFAULT 'pending';

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "auto_reply_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
