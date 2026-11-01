CREATE INDEX IF NOT EXISTS "message_reactions_workspace_id_created_at_idx" ON "message_reactions" USING btree ("workspace_id","created_at");
