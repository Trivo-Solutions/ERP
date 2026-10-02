-- G2g-7d: Inward RCM (reverse-charge) & self-invoicing foundation.
-- See PHASE_G2G7D_AUDIT.md / PHASE_G2G7D_IMPLEMENTATION.md for the full read-only audit, legal
-- research, and design rationale. This migration is purely additive — no row is rewritten, no
-- historical PoItem.rcmCategory is backfilled (every existing line stays NULL = not assessed /
-- RCM_NOT_APPLICABLE).

-- AlterTable
ALTER TABLE "po_items" ADD COLUMN     "rcmCategory" TEXT;

-- CreateTable
CREATE TABLE "rcm_liabilities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT,
    "grnItemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "rcmCategory" TEXT NOT NULL,
    "taxableValue" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "selfInvoiceRequirement" TEXT NOT NULL,
    "paymentVoucherRequirement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LIABILITY_RECOGNIZED',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentMode" TEXT,
    "paymentJournalEntryId" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rcm_liabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_invoices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "selfInvoiceNumber" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "gstRegistrationId" TEXT,
    "rcmLiabilityId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierAddress" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taxableValue" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hsnCodeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rcm_liabilities_companyId_idx" ON "rcm_liabilities"("companyId");

-- CreateIndex
CREATE INDEX "rcm_liabilities_gstRegistrationId_idx" ON "rcm_liabilities"("gstRegistrationId");

-- CreateIndex
CREATE INDEX "rcm_liabilities_supplierId_idx" ON "rcm_liabilities"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "rcm_liabilities_grnItemId_companyId_key" ON "rcm_liabilities"("grnItemId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "rcm_liabilities_id_companyId_key" ON "rcm_liabilities"("id", "companyId");

-- CreateIndex
CREATE INDEX "self_invoices_companyId_idx" ON "self_invoices"("companyId");

-- CreateIndex
CREATE INDEX "self_invoices_gstRegistrationId_idx" ON "self_invoices"("gstRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "self_invoices_companyId_selfInvoiceNumber_key" ON "self_invoices"("companyId", "selfInvoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "self_invoices_id_companyId_key" ON "self_invoices"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "self_invoices_rcmLiabilityId_companyId_key" ON "self_invoices"("rcmLiabilityId", "companyId");

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_grnItemId_companyId_fkey" FOREIGN KEY ("grnItemId", "companyId") REFERENCES "grn_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_paymentJournalEntryId_fkey" FOREIGN KEY ("paymentJournalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rcm_liabilities" ADD CONSTRAINT "rcm_liabilities_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_rcmLiabilityId_companyId_fkey" FOREIGN KEY ("rcmLiabilityId", "companyId") REFERENCES "rcm_liabilities"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_invoices" ADD CONSTRAINT "self_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RowLevelSecurity: both new tables are company-owned tenant tables — same policy shape as every
-- other tenant table (see e.g. 20260930160000's company_gst_aatos).
ALTER TABLE "rcm_liabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rcm_liabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rcm_liabilities"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "self_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "self_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "self_invoices"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- New ledger accounts (none of the 36 existing accounts can represent an RCM liability or
-- RCM-specific ITC without mixing into ordinary Input/Output GST — see PHASE_G2G7D_AUDIT.md's
-- architecture section). Seeded into every company that already exists; new companies get them
-- from the Starter Package chart of accounts (starterPackage/v1.ts). Same "lift FORCE RLS around
-- the INSERT, then restore it" precedent as 20260927120000's Round Off seed — `accounts` is a
-- tenant table and, once db-secure.sql has FORCEd row-level security, even the owner running
-- migrations is filtered by the policy.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'accounts' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "accounts" ("id", "companyId", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
  SELECT 'acc_' || c."id" || '_1404', c."id", '1404', 'RCM Input Tax Credit (ITC)', 'ASSET', 'TAX', 0, 'INR', true, true
  FROM "companies" c
  ON CONFLICT ("companyId", "code") DO NOTHING;

  INSERT INTO "accounts" ("id", "companyId", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
  SELECT 'acc_' || c."id" || '_2204', c."id", '2204', 'RCM Tax Payable', 'LIABILITY', 'TAX', 0, 'INR', true, true
  FROM "companies" c
  ON CONFLICT ("companyId", "code") DO NOTHING;

  IF forced THEN ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY; END IF;
END $$;
