-- Customer advances: split receipts. One advance (one ADV number / receipt) can now be paid in several modes
-- (e.g. Cash + UPI). Each mode is a row here; the rows sum to customer_advances.amount. customer_advances.mode
-- stays: the single mode, or 'SPLIT' when there are several.

CREATE TABLE "customer_advance_payments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "referenceNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_advance_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_advance_payments_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "customer_advance_payments_companyId_advanceId_idx" ON "customer_advance_payments"("companyId", "advanceId");
CREATE INDEX "customer_advance_payments_companyId_mode_idx" ON "customer_advance_payments"("companyId", "mode");

ALTER TABLE "customer_advance_payments" ADD CONSTRAINT "customer_advance_payments_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_payments" ADD CONSTRAINT "customer_advance_payments_advanceId_companyId_fkey"
  FOREIGN KEY ("advanceId", "companyId") REFERENCES "customer_advances"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_advance_payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_advance_payments"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- Backfill: every existing advance becomes a single-line payment. customer_advances is tenant data, so FORCE RLS is
-- lifted for the statement and restored only where it was on (same pattern as 20260927120000_invoice_round_off).
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'customer_advances' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "customer_advances" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "customer_advance_payments" ("id", "companyId", "advanceId", "mode", "amount", "referenceNo", "createdAt")
  SELECT 'advpay_' || a."id", a."companyId", a."id", a."mode", a."amount", a."referenceNo", a."createdAt"
  FROM "customer_advances" a;

  IF forced THEN ALTER TABLE "customer_advances" FORCE ROW LEVEL SECURITY; END IF;
END $$;
