DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'media'
      AND column_name = 'size' AND data_type = 'integer') THEN
    ALTER TABLE "media" ALTER COLUMN "size" TYPE bigint;
  END IF;
END $$;
