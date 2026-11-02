CREATE INDEX IF NOT EXISTS "deliveries_workspace_status_scheduled_idx" ON "deliveries" USING btree ("workspace_id", "status", "scheduled_at", "id");
