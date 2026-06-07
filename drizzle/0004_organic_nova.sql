DROP INDEX "channels_workspace_id_platform_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "channels_platform_platform_id_key" ON "channels" USING btree ("platform","platform_id");