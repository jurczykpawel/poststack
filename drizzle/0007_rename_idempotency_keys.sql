ALTER TABLE "outbound_idempotency" RENAME TO "idempotency_keys";--> statement-breakpoint
ALTER INDEX "outbound_idempotency_expires_at_idx" RENAME TO "idempotency_keys_expires_at_idx";
