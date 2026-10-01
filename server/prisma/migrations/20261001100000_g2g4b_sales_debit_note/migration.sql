-- G2g-4b — Sales (outward) Debit Note. A wholly separate domain from the existing procurement-side
-- "debit_notes"/"debit_note_items" tables, which stay purchase-side only. Mirrors the credit_notes/
-- credit_note_items foundation (20260929120000_g2a_credit_debit_notes_foundation) in shape, plus
-- 20260930110000_g2g3g0_1_credit_note_registration_scoped_uniqueness's registration-scoped
-- numbering fix applied directly from the start (no later DropIndex/CreateIndex pass needed, since
-- this table has no pre-existing rows to migrate).
--
-- branchId is new here (CreditNote carries none, inheriting branch through its invoice instead) —
-- see the schema.prisma model comment for why this document carries it directly.

-- CreateTable
CREATE TABLE "sales_debit_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "debitNoteNumber" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "debitNoteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "originalInvoiceNumber" TEXT NOT NULL,
    "originalInvoiceDate" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNotes" TEXT,
    "gstin" TEXT NOT NULL,
    "placeOfSupply" TEXT NOT NULL,
    "sellerRegistrationId" TEXT,
    "sellerLegalName" TEXT,
    "sellerTradeName" TEXT,
    "sellerStateCode" TEXT,
    "sellerAddress" TEXT,
    "sellerCity" TEXT,
    "sellerDistrict" TEXT,
    "sellerPincode" TEXT,
    "sellerCountry" TEXT,
    "buyerName" TEXT,
    "buyerGstin" TEXT,
    "buyerPan" TEXT,
    "buyerAddress" TEXT,
    "buyerCity" TEXT,
    "buyerState" TEXT,
    "buyerStateCode" TEXT,
    "buyerPincode" TEXT,
    "buyerCountry" TEXT,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTax" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "journalEntryId" TEXT,
    "isEInvoice" BOOLEAN NOT NULL DEFAULT false,
    "irn" TEXT,
    "ackNumber" TEXT,
    "ackDate" TIMESTAMP(3),
    "qrCodeData" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_debit_note_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "salesDebitNoteId" TEXT NOT NULL,
    "invoiceItemId" TEXT,
    "description" TEXT NOT NULL,
    "hsnCodeId" TEXT,
    "taxRate" DECIMAL(5,4) NOT NULL,
    "uom" TEXT,
    "quantity" DECIMAL(10,4),
    "uqc" TEXT,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cessAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grossWeight" DECIMAL(10,4),
    "netWeight" DECIMAL(10,4),
    "stoneWeight" DECIMAL(10,4),
    "karat" TEXT,

    CONSTRAINT "sales_debit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_debit_notes_companyId_idx" ON "sales_debit_notes"("companyId");

-- CreateIndex
CREATE INDEX "sales_debit_notes_invoiceId_idx" ON "sales_debit_notes"("invoiceId");

-- CreateIndex
CREATE INDEX "sales_debit_notes_branchId_idx" ON "sales_debit_notes"("branchId");

-- CreateIndex: registration-scoped uniqueness (Rule 46(b) — the statutory numbering unit is
-- per-GSTIN, not company-wide), same fix 20260930110000 applied to credit_notes, built in directly
-- here since there are no pre-existing rows to migrate.
CREATE UNIQUE INDEX "sales_debit_notes_company_registration_number_key" ON "sales_debit_notes"("companyId", "sellerRegistrationId", "debitNoteNumber");

-- CreateIndex (partial — legacy/NULL-registration rows only; Postgres never treats two NULLs as
-- equal in a unique index, so the index above alone would not stop two legacy sales debit notes
-- from sharing a number).
CREATE UNIQUE INDEX "sales_debit_notes_legacy_number_key" ON "sales_debit_notes"("companyId", "debitNoteNumber") WHERE "sellerRegistrationId" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "sales_debit_notes_id_companyId_key" ON "sales_debit_notes"("id", "companyId");

-- CreateIndex
CREATE INDEX "sales_debit_note_items_companyId_idx" ON "sales_debit_note_items"("companyId");

-- CreateIndex
CREATE INDEX "sales_debit_note_items_salesDebitNoteId_idx" ON "sales_debit_note_items"("salesDebitNoteId");

-- CreateIndex
CREATE INDEX "sales_debit_note_items_invoiceItemId_idx" ON "sales_debit_note_items"("invoiceItemId");

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_notes" ADD CONSTRAINT "sales_debit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_note_items" ADD CONSTRAINT "sales_debit_note_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_note_items" ADD CONSTRAINT "sales_debit_note_items_salesDebitNoteId_companyId_fkey" FOREIGN KEY ("salesDebitNoteId", "companyId") REFERENCES "sales_debit_notes"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_note_items" ADD CONSTRAINT "sales_debit_note_items_invoiceItemId_companyId_fkey" FOREIGN KEY ("invoiceItemId", "companyId") REFERENCES "invoice_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_debit_note_items" ADD CONSTRAINT "sales_debit_note_items_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RowLevelSecurity: both tables are brand-new (no pre-existing rows) — same policy shape as every
-- other tenant table (prisma/production-rls-roles.sql): FORCE ROW LEVEL SECURITY so even the
-- owning role is bound by it, and a `tenant_isolation` policy keyed off app.tenant_company_id for
-- USING and WITH CHECK alike.
ALTER TABLE "sales_debit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_debit_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_debit_notes"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "sales_debit_note_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_debit_note_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_debit_note_items"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
