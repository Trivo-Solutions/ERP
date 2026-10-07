-- Customer Advances, Phase 3: retry guard for applying an advance to an invoice. Purely additive (one nullable
-- column + a unique index); no row is touched, so FORCE RLS needs no lifting.
ALTER TABLE "customer_advance_applications" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "customer_advance_applications_companyId_idempotencyKey_key" ON "customer_advance_applications"("companyId", "idempotencyKey");
