-- Material Purchase (non-tagged old gold at tested purity) extends old_gold_exchanges with nullable snapshot columns.
-- Pure ADD COLUMN + one partial-by-NULL unique index: no row is touched, so no FORCE RLS lifting is needed.
ALTER TABLE "old_gold_exchanges"
  ADD COLUMN "metalType" TEXT,
  ADD COLUMN "testedPurityPercent" DECIMAL(7,4),
  ADD COLUMN "fineWeight" DECIMAL(12,4),
  ADD COLUMN "baseRate24K" DECIMAL(12,4),
  ADD COLUMN "effectivePurchaseRate" DECIMAL(12,4),
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "old_gold_exchanges_companyId_idempotencyKey_key" ON "old_gold_exchanges"("companyId", "idempotencyKey");
