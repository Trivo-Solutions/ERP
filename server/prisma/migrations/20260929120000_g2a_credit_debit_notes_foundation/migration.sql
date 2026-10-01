-- CreateTable
CREATE TABLE "credit_note_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "branchId" TEXT,
    "layout" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_note_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_note_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "branchId" TEXT,
    "layout" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_note_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "debitNoteNumber" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "debitNoteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grnId" TEXT NOT NULL,
    "supplierInvoiceNumber" TEXT,
    "supplierInvoiceDate" TIMESTAMP(3),
    "purchaseReturnId" TEXT,
    "supplierId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNotes" TEXT,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTax" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "journalEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_note_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "debitNoteId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hsnCodeId" TEXT,
    "taxRate" DECIMAL(5,4) NOT NULL,
    "uom" TEXT,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grossWeight" DECIMAL(10,4),
    "netWeight" DECIMAL(10,4),
    "stoneWeight" DECIMAL(10,4),
    "karat" TEXT,

    CONSTRAINT "debit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "creditNoteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "originalInvoiceNumber" TEXT NOT NULL,
    "originalInvoiceDate" TIMESTAMP(3) NOT NULL,
    "salesReturnId" TEXT,
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
    "totalTax" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "journalEntryId" TEXT,
    "irn" TEXT,
    "ackNumber" TEXT,
    "ackDate" TIMESTAMP(3),
    "qrCodeData" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_items" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceItemId" TEXT,
    "description" TEXT NOT NULL,
    "hsnCodeId" TEXT,
    "taxRate" DECIMAL(5,4) NOT NULL,
    "uom" TEXT,
    "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grossWeight" DECIMAL(10,4),
    "netWeight" DECIMAL(10,4),
    "stoneWeight" DECIMAL(10,4),
    "karat" TEXT,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_note_templates_companyId_idx" ON "credit_note_templates"("companyId");

-- CreateIndex
CREATE INDEX "credit_note_templates_branchId_idx" ON "credit_note_templates"("branchId");

-- CreateIndex
CREATE INDEX "debit_note_templates_companyId_idx" ON "debit_note_templates"("companyId");

-- CreateIndex
CREATE INDEX "debit_note_templates_branchId_idx" ON "debit_note_templates"("branchId");

-- CreateIndex
CREATE INDEX "debit_notes_companyId_idx" ON "debit_notes"("companyId");

-- CreateIndex
CREATE INDEX "debit_notes_grnId_idx" ON "debit_notes"("grnId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_companyId_debitNoteNumber_key" ON "debit_notes"("companyId", "debitNoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_id_companyId_key" ON "debit_notes"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_purchaseReturnId_companyId_key" ON "debit_notes"("purchaseReturnId", "companyId");

-- CreateIndex
CREATE INDEX "debit_note_items_companyId_idx" ON "debit_note_items"("companyId");

-- CreateIndex
CREATE INDEX "debit_note_items_debitNoteId_idx" ON "debit_note_items"("debitNoteId");

-- CreateIndex
CREATE INDEX "credit_notes_companyId_idx" ON "credit_notes"("companyId");

-- CreateIndex
CREATE INDEX "credit_notes_invoiceId_idx" ON "credit_notes"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_companyId_creditNoteNumber_key" ON "credit_notes"("companyId", "creditNoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_id_companyId_key" ON "credit_notes"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_salesReturnId_companyId_key" ON "credit_notes"("salesReturnId", "companyId");

-- CreateIndex
CREATE INDEX "credit_note_items_companyId_idx" ON "credit_note_items"("companyId");

-- CreateIndex
CREATE INDEX "credit_note_items_creditNoteId_idx" ON "credit_note_items"("creditNoteId");

-- CreateIndex
CREATE INDEX "credit_note_items_invoiceItemId_idx" ON "credit_note_items"("invoiceItemId");

-- AddForeignKey
ALTER TABLE "credit_note_templates" ADD CONSTRAINT "credit_note_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_templates" ADD CONSTRAINT "credit_note_templates_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_templates" ADD CONSTRAINT "credit_note_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_templates" ADD CONSTRAINT "debit_note_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_templates" ADD CONSTRAINT "debit_note_templates_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_templates" ADD CONSTRAINT "debit_note_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_grnId_companyId_fkey" FOREIGN KEY ("grnId", "companyId") REFERENCES "goods_receipt_notes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_purchaseReturnId_companyId_fkey" FOREIGN KEY ("purchaseReturnId", "companyId") REFERENCES "purchase_returns"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_items" ADD CONSTRAINT "debit_note_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_items" ADD CONSTRAINT "debit_note_items_debitNoteId_companyId_fkey" FOREIGN KEY ("debitNoteId", "companyId") REFERENCES "debit_notes"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_items" ADD CONSTRAINT "debit_note_items_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_salesReturnId_companyId_fkey" FOREIGN KEY ("salesReturnId", "companyId") REFERENCES "sales_returns"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_creditNoteId_companyId_fkey" FOREIGN KEY ("creditNoteId", "companyId") REFERENCES "credit_notes"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_invoiceItemId_companyId_fkey" FOREIGN KEY ("invoiceItemId", "companyId") REFERENCES "invoice_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RowLevelSecurity: all six tables are brand-new (no pre-existing rows), so — unlike
-- 20260929032454_g1_gst_foundation, which had to backfill company_gst_registrations/
-- tax_invoice_templates BEFORE turning RLS on — there is no data to migrate first. Same policy
-- shape as every other tenant table (see prisma/production-rls-roles.sql and the G1 migration
-- referenced above): FORCE ROW LEVEL SECURITY so even the owning role is bound by it, and a
-- `tenant_isolation` policy keyed off app.tenant_company_id for USING and WITH CHECK alike.
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "credit_notes"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "credit_note_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "credit_note_items"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "debit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "debit_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_notes"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "debit_note_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "debit_note_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_note_items"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "credit_note_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "credit_note_templates"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "debit_note_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "debit_note_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "debit_note_templates"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

