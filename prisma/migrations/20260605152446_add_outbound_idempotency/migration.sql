-- CreateTable
CREATE TABLE "outbound_idempotency" (
    "key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_idempotency_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "outbound_idempotency_expires_at_idx" ON "outbound_idempotency"("expires_at");
