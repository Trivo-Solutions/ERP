-- G8c: e-invoice (IRN) operation records. One new company-owned table, purely additive — no existing
-- table altered, no row touched (nothing to lift FORCE RLS around).

-- CreateTable
CREATE TABLE "einvoice_records" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "irn" TEXT,
    "ackNumber" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedInvoice" TEXT,
    "signedQrCode" TEXT,
    "providerStatus" TEXT,
    "providerTimestamp" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3),
    "errorCategory" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "einvoice_records_companyId_idx" ON "einvoice_records"("companyId");

-- CreateIndex
CREATE INDEX "einvoice_records_invoiceId_idx" ON "einvoice_records"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_records_companyId_gstRegistrationId_documentType_i_key" ON "einvoice_records"("companyId", "gstRegistrationId", "documentType", "invoiceId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_records_companyId_idempotencyKey_key" ON "einvoice_records"("companyId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RowLevelSecurity: company-owned tenant table, same policy shape as every other tenant table.
ALTER TABLE "einvoice_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "einvoice_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "einvoice_records"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
