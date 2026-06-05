-- CreateTable
CREATE TABLE "rule_cooldowns" (
    "rule_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_cooldowns_pkey" PRIMARY KEY ("rule_id","contact_id")
);

-- CreateTable
CREATE TABLE "rule_send_counts" (
    "rule_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rule_send_counts_pkey" PRIMARY KEY ("rule_id","contact_id")
);

-- CreateIndex
CREATE INDEX "rule_cooldowns_expires_at_idx" ON "rule_cooldowns"("expires_at");
