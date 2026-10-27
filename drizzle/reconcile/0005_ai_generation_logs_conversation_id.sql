ALTER TABLE "ai_generation_logs" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;

DO $$ BEGIN
  ALTER TABLE "ai_generation_logs" ADD CONSTRAINT "ai_generation_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
