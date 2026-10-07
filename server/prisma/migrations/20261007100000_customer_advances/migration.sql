-- Customer Advances, Phase 1 (schema only). Money received from a customer before any invoice, held as a
-- liability (ledger 2400 Customer Advances). Separate from the F2 on-account payment / Store Credit mechanism,
-- which is untouched. Purely additive: no existing row is updated, nothing is backfilled.

-- Composite-FK target so an advance application can only reference a payment of the SAME customer and company.
CREATE UNIQUE INDEX "invoice_payments_id_clientId_companyId_key" ON "invoice_payments"("id", "clientId", "companyId");

CREATE TABLE "customer_advances" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "advanceNumber" TEXT NOT NULL,
    "advanceDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "appliedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL,
    "referenceNo" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    CONSTRAINT "customer_advances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_advances_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "customer_advances_applied_nonneg" CHECK ("appliedAmount" >= 0),
    CONSTRAINT "customer_advances_refunded_nonneg" CHECK ("refundedAmount" >= 0),
    CONSTRAINT "customer_advances_balance_within_amount" CHECK ("appliedAmount" + "refundedAmount" <= "amount")
);

CREATE TABLE "customer_advance_applications" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoicePaymentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedById" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    CONSTRAINT "customer_advance_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_advance_applications_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "customer_advances_companyId_advanceNumber_key" ON "customer_advances"("companyId", "advanceNumber");
CREATE UNIQUE INDEX "customer_advances_companyId_idempotencyKey_key" ON "customer_advances"("companyId", "idempotencyKey");
CREATE UNIQUE INDEX "customer_advances_id_companyId_key" ON "customer_advances"("id", "companyId");
CREATE UNIQUE INDEX "customer_advances_id_clientId_companyId_key" ON "customer_advances"("id", "clientId", "companyId");
CREATE INDEX "customer_advances_companyId_clientId_idx" ON "customer_advances"("companyId", "clientId");
CREATE INDEX "customer_advances_companyId_branchId_idx" ON "customer_advances"("companyId", "branchId");
CREATE INDEX "customer_advances_companyId_advanceDate_idx" ON "customer_advances"("companyId", "advanceDate");

CREATE UNIQUE INDEX "customer_advance_applications_invoicePaymentId_key" ON "customer_advance_applications"("invoicePaymentId");
CREATE INDEX "customer_advance_applications_companyId_advanceId_idx" ON "customer_advance_applications"("companyId", "advanceId");
CREATE INDEX "customer_advance_applications_companyId_invoiceId_idx" ON "customer_advance_applications"("companyId", "invoiceId");

-- Foreign keys — every company-owned reference is composite (…, companyId), and an application's advance and
-- payment are both pinned to the same clientId, so a cross-company OR cross-customer application is refused by
-- the database itself. Nothing cascades.
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_clientId_companyId_fkey"
  FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_reversedById_fkey"
  FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_advanceId_clientId_companyId_fkey"
  FOREIGN KEY ("advanceId", "clientId", "companyId") REFERENCES "customer_advances"("id", "clientId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_invoiceId_companyId_fkey"
  FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_invoicePaymentId_clientId_co_fkey"
  FOREIGN KEY ("invoicePaymentId", "clientId", "companyId") REFERENCES "invoice_payments"("id", "clientId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_appliedById_fkey"
  FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_applications" ADD CONSTRAINT "customer_advance_applications_reversedById_fkey"
  FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security (FORCE is applied by db-secure.sql to every table carrying this policy).
ALTER TABLE "customer_advances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_advances"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "customer_advance_applications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_advance_applications"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- Ledger account 2400 Customer Advances for every existing company (new companies get it from the Starter
-- Package chart). `accounts` is a tenant table: FORCE is lifted for the statement and restored only where it
-- was on (same pattern as 20260927120000_invoice_round_off).
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'accounts' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "accounts" ("id", "companyId", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
  SELECT 'acc_' || c."id" || '_2400', c."id", '2400', 'Customer Advances', 'LIABILITY', 'CURRENT', 0, 'INR', true, true
  FROM "companies" c
  ON CONFLICT ("companyId", "code") DO NOTHING;

  IF forced THEN ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY; END IF;
END $$;
