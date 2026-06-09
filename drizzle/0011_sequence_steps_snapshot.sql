ALTER TABLE "sequence_enrollments" ADD COLUMN "steps_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill existing enrollments with their sequence's current steps, so an in-flight
-- enrollment created before this migration keeps being driven by the definition it started on.
UPDATE "sequence_enrollments" e SET "steps_snapshot" = s."steps" FROM "sequences" s WHERE e."sequence_id" = s."id";