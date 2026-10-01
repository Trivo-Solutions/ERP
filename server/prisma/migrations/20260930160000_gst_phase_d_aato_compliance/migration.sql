-- GST Phase D: AATO (Annual Aggregate Turnover) management & audit history.
--
-- Adds company_gst_aatos and company_gst_aato_histories.
-- Bound to Company -> GST Registration -> Financial Year.
-- Enforces row-level security with the standard tenant_isolation policy.

-- CreateTable
CREATE TABLE "company_gst_aatos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "turnover" DECIMAL(15,2) NOT NULL,
    "precedingTurnover" DECIMAL(15,2),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedDate" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_gst_aatos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_gst_aato_histories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "aatoId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "turnover" DECIMAL(15,2) NOT NULL,
    "precedingTurnover" DECIMAL(15,2),
    "source" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "verifiedDate" TIMESTAMP(3),
    "notes" TEXT,
    "action" TEXT NOT NULL,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_gst_aato_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_gst_aatos_companyId_gstRegistrationId_financialYear_key" ON "company_gst_aatos"("companyId", "gstRegistrationId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "company_gst_aatos_id_companyId_key" ON "company_gst_aatos"("id", "companyId");

-- CreateIndex
CREATE INDEX "company_gst_aatos_companyId_idx" ON "company_gst_aatos"("companyId");

-- CreateIndex
CREATE INDEX "company_gst_aatos_gstRegistrationId_idx" ON "company_gst_aatos"("gstRegistrationId");

-- CreateIndex
CREATE INDEX "company_gst_aato_histories_companyId_idx" ON "company_gst_aato_histories"("companyId");

-- CreateIndex
CREATE INDEX "company_gst_aato_histories_aatoId_idx" ON "company_gst_aato_histories"("aatoId");

-- CreateIndex
CREATE INDEX "company_gst_aato_histories_gstRegistrationId_financialYear_idx" ON "company_gst_aato_histories"("gstRegistrationId", "financialYear");

-- AddForeignKey
ALTER TABLE "company_gst_aatos" ADD CONSTRAINT "company_gst_aatos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_gst_aatos" ADD CONSTRAINT "company_gst_aatos_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "company_gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_gst_aato_histories" ADD CONSTRAINT "company_gst_aato_histories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_gst_aato_histories" ADD CONSTRAINT "company_gst_aato_histories_aatoId_fkey" FOREIGN KEY ("aatoId") REFERENCES "company_gst_aatos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_gst_aato_histories" ADD CONSTRAINT "company_gst_aato_histories_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "company_gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity: both tables are company-owned tenant tables — same policy shape as every other tenant table
ALTER TABLE "company_gst_aatos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_gst_aatos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_gst_aatos"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "company_gst_aato_histories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_gst_aato_histories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_gst_aato_histories"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
