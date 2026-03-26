-- AlterTable
ALTER TABLE "auto_reply_rules" ADD COLUMN     "max_sends_per_contact" INTEGER,
ADD COLUMN     "requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "needs_manual_reply" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "pending_approvals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "recipient_platform_id" TEXT NOT NULL,
    "proposed_content" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,

    CONSTRAINT "pending_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_approvals_workspace_id_status_idx" ON "pending_approvals"("workspace_id", "status");
