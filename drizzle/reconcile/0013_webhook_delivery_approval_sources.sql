ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "inbound_comment_id" uuid REFERENCES "comment_logs"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_message_id_idx" ON "pending_approvals" ("inbound_message_id");
CREATE INDEX IF NOT EXISTS "pending_approvals_inbound_comment_id_idx" ON "pending_approvals" ("inbound_comment_id");
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "http_status" integer;
CREATE INDEX IF NOT EXISTS "webhook_deliveries_workspace_endpoint_created_idx" ON "webhook_deliveries" ("workspace_id", "endpoint_id", "created_at", "id");
