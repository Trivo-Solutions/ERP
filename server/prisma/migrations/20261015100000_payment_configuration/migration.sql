-- Payment Configuration & Collection: a company-owned bank/provider master, which providers each branch collects
-- through, POS terminals (TID / MID), and optional per-payment-leg metadata. Purely additive: three new tables and
-- nullable columns - no existing payment row is read, rewritten or back-filled, and no accounting path changes.
-- Nothing here is a credential: no PIN/OTP/CVV/card data/API secret/account number column exists.

CREATE TABLE "payment_providers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortCode" TEXT,
    "category" TEXT NOT NULL,
    "supportedMethods" TEXT[],
    "merchantRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_providers_category_valid" CHECK ("category" IN ('BANK', 'UPI_PROVIDER', 'ACQUIRER', 'OTHER')),
    CONSTRAINT "payment_providers_methods_valid" CHECK ("supportedMethods" <@ ARRAY['CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'CHEQUE']::TEXT[]),
    CONSTRAINT "payment_providers_name_not_blank" CHECK (btrim("name") <> '')
);
CREATE UNIQUE INDEX "payment_providers_companyId_name_key" ON "payment_providers"("companyId", "name");
CREATE UNIQUE INDEX "payment_providers_companyId_shortCode_key" ON "payment_providers"("companyId", "shortCode");
CREATE UNIQUE INDEX "payment_providers_id_companyId_key" ON "payment_providers"("id", "companyId");
CREATE INDEX "payment_providers_companyId_isActive_idx" ON "payment_providers"("companyId", "isActive");

CREATE TABLE "branch_payment_providers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "branch_payment_providers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "branch_payment_providers_branchId_providerId_key" ON "branch_payment_providers"("branchId", "providerId");
CREATE UNIQUE INDEX "branch_payment_providers_id_companyId_key" ON "branch_payment_providers"("id", "companyId");
CREATE INDEX "branch_payment_providers_companyId_branchId_idx" ON "branch_payment_providers"("companyId", "branchId");

CREATE TABLE "pos_terminals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "tid" TEXT NOT NULL,
    "mid" TEXT,
    "supportedMethods" TEXT[],
    "branchId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pos_terminals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pos_terminals_methods_valid" CHECK ("supportedMethods" <@ ARRAY['CARD', 'UPI']::TEXT[]),
    CONSTRAINT "pos_terminals_tid_not_blank" CHECK (btrim("tid") <> '')
);
CREATE UNIQUE INDEX "pos_terminals_companyId_code_key" ON "pos_terminals"("companyId", "code");
CREATE UNIQUE INDEX "pos_terminals_id_companyId_key" ON "pos_terminals"("id", "companyId");
CREATE INDEX "pos_terminals_companyId_branchId_isActive_idx" ON "pos_terminals"("companyId", "branchId", "isActive");
-- A TID identifies a terminal only within its acquirer (and merchant): the same number can legitimately exist at two
-- acquirers, so it is never globally unique. A missing MID counts as one value, so two MID-less rows of one acquirer clash.
CREATE UNIQUE INDEX "pos_terminals_company_provider_mid_tid_key" ON "pos_terminals"("companyId", "providerId", COALESCE("mid", ''), "tid");

-- Per-leg metadata on the two tables that hold one row per payment leg. All nullable.
ALTER TABLE "invoice_payments"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "providerId" TEXT,
  ADD COLUMN "terminalId" TEXT,
  ADD COLUMN "providerName" TEXT,
  ADD COLUMN "terminalCode" TEXT,
  ADD COLUMN "terminalTid" TEXT,
  ADD COLUMN "terminalMid" TEXT,
  ADD COLUMN "authCode" TEXT,
  ADD COLUMN "chequeNumber" TEXT,
  ADD COLUMN "chequeDate" TIMESTAMP(3),
  ADD COLUMN "chequeBank" TEXT;
ALTER TABLE "customer_advance_payments"
  ADD COLUMN "providerId" TEXT,
  ADD COLUMN "terminalId" TEXT,
  ADD COLUMN "providerName" TEXT,
  ADD COLUMN "terminalCode" TEXT,
  ADD COLUMN "terminalTid" TEXT,
  ADD COLUMN "terminalMid" TEXT,
  ADD COLUMN "authCode" TEXT,
  ADD COLUMN "chequeNumber" TEXT,
  ADD COLUMN "chequeDate" TIMESTAMP(3),
  ADD COLUMN "chequeBank" TEXT;
CREATE INDEX "invoice_payments_companyId_terminalId_idx" ON "invoice_payments"("companyId", "terminalId");
CREATE INDEX "customer_advance_payments_companyId_terminalId_idx" ON "customer_advance_payments"("companyId", "terminalId");

-- Foreign keys - composite (id, companyId) so the database itself refuses a row pointing at another company's
-- provider / terminal / branch. RESTRICT everywhere: a provider or terminal that was ever used is deactivated, never deleted.
ALTER TABLE "payment_providers" ADD CONSTRAINT "payment_providers_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_payment_providers" ADD CONSTRAINT "branch_payment_providers_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_payment_providers" ADD CONSTRAINT "branch_payment_providers_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_payment_providers" ADD CONSTRAINT "branch_payment_providers_providerId_companyId_fkey"
  FOREIGN KEY ("providerId", "companyId") REFERENCES "payment_providers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_providerId_companyId_fkey"
  FOREIGN KEY ("providerId", "companyId") REFERENCES "payment_providers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_providerId_companyId_fkey"
  FOREIGN KEY ("providerId", "companyId") REFERENCES "payment_providers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_terminalId_companyId_fkey"
  FOREIGN KEY ("terminalId", "companyId") REFERENCES "pos_terminals"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_payments" ADD CONSTRAINT "customer_advance_payments_providerId_companyId_fkey"
  FOREIGN KEY ("providerId", "companyId") REFERENCES "payment_providers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_advance_payments" ADD CONSTRAINT "customer_advance_payments_terminalId_companyId_fkey"
  FOREIGN KEY ("terminalId", "companyId") REFERENCES "pos_terminals"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (FORCE is applied by db-secure.sql to every table carrying this policy).
ALTER TABLE "payment_providers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_providers"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "branch_payment_providers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branch_payment_providers"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "pos_terminals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_terminals"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
