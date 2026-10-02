-- G2g-7e: GSTR-2B ingestion & reconciliation foundation.
-- See PHASE_G2G7E_AUDIT.md / PHASE_G2G7E_IMPLEMENTATION.md for the full read-only audit and design
-- rationale. Purely additive — no existing row/table is touched.

-- CreateTable
CREATE TABLE "gst2b_statements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "taxPeriod" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GSTN_JSON',
    "generatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT,
    "sourceFileHash" TEXT NOT NULL,
    "canonicalPayloadHash" TEXT NOT NULL,
    "normalizerVersion" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL,

    CONSTRAINT "gst2b_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst2b_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "supplierGstin" TEXT,
    "supplierTradeName" TEXT,
    "documentNumber" TEXT,
    "documentDate" TIMESTAMP(3),
    "documentValue" DECIMAL(14,2),
    "placeOfSupply" TEXT,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "itcAvailability" TEXT,
    "ineligibilityReason" TEXT,
    "provenanceStatus" TEXT NOT NULL DEFAULT 'CURRENT',
    "amendsDocumentId" TEXT,
    "supportStatus" TEXT NOT NULL DEFAULT 'SUPPORTED',
    "rawRecord" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst2b_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gst2b_statements_companyId_idx" ON "gst2b_statements"("companyId");

-- CreateIndex
CREATE INDEX "gst2b_statements_gstRegistrationId_idx" ON "gst2b_statements"("gstRegistrationId");

-- CreateIndex
CREATE INDEX "gst2b_statements_companyId_gstRegistrationId_financialYear__idx" ON "gst2b_statements"("companyId", "gstRegistrationId", "financialYear", "taxPeriod", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gst2b_statements_companyId_gstRegistrationId_financialYear__key" ON "gst2b_statements"("companyId", "gstRegistrationId", "financialYear", "taxPeriod", "version");

-- CreateIndex
CREATE UNIQUE INDEX "gst2b_statements_id_companyId_key" ON "gst2b_statements"("id", "companyId");

-- CreateIndex
CREATE INDEX "gst2b_documents_companyId_idx" ON "gst2b_documents"("companyId");

-- CreateIndex
CREATE INDEX "gst2b_documents_statementId_idx" ON "gst2b_documents"("statementId");

-- CreateIndex
CREATE INDEX "gst2b_documents_companyId_supplierGstin_idx" ON "gst2b_documents"("companyId", "supplierGstin");

-- CreateIndex
CREATE INDEX "gst2b_documents_companyId_section_idx" ON "gst2b_documents"("companyId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "gst2b_documents_id_companyId_key" ON "gst2b_documents"("id", "companyId");

-- AddForeignKey
ALTER TABLE "gst2b_statements" ADD CONSTRAINT "gst2b_statements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst2b_statements" ADD CONSTRAINT "gst2b_statements_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst2b_statements" ADD CONSTRAINT "gst2b_statements_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst2b_documents" ADD CONSTRAINT "gst2b_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst2b_documents" ADD CONSTRAINT "gst2b_documents_statementId_companyId_fkey" FOREIGN KEY ("statementId", "companyId") REFERENCES "gst2b_statements"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst2b_documents" ADD CONSTRAINT "gst2b_documents_amendsDocumentId_companyId_fkey" FOREIGN KEY ("amendsDocumentId", "companyId") REFERENCES "gst2b_documents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity: both new tables are company-owned tenant tables — same policy shape as every
-- other tenant table (most recently rcm_liabilities/self_invoices, 20261002160000).
ALTER TABLE "gst2b_statements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst2b_statements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst2b_statements"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "gst2b_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst2b_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst2b_documents"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
