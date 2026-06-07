-- Resolve any pre-existing duplicates so at most one non-disabled channel exists
-- per (platform, platform_id) before the unique index below is created. Keep the
-- earliest-connected channel (tie-break by id) and disable the rest. On a fresh
-- single-workspace instance this matches nothing and is a no-op.
UPDATE "channels" AS c
SET "status" = 'disabled'
WHERE c."status" <> 'disabled'
  AND EXISTS (
    SELECT 1 FROM "channels" AS keep
    WHERE keep."platform" = c."platform"
      AND keep."platform_id" = c."platform_id"
      AND keep."status" <> 'disabled'
      AND (keep."created_at" < c."created_at"
           OR (keep."created_at" = c."created_at" AND keep."id" < c."id"))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_platform_platform_id_key" ON "channels" USING btree ("platform","platform_id") WHERE status <> 'disabled';
