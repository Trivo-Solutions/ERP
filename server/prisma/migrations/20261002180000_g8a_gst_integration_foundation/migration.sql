-- G8a: GST Integration Foundation. Pure additive schema — three new company-owned tables
-- (gst_integration_configs, gst_integration_credentials, gst_integration_request_logs) plus the
-- reverse-relation columns they need. No existing table is altered, no row is rewritten. See
-- PHASE_G8A_IMPLEMENTATION.md and schema.prisma's own G8a header comment for the full design.

-- CreateTable
CREATE TABLE "gst_integration_configs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_integration_credentials" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "credentialKey" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_integration_request_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestStartedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "httpStatus" INTEGER,
    "providerReferenceId" TEXT,
    "errorCategory" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_integration_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gst_integration_configs_gstRegistrationId_provider_environm_key" ON "gst_integration_configs"("gstRegistrationId", "provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "gst_integration_configs_id_companyId_key" ON "gst_integration_configs"("id", "companyId");

-- CreateIndex
CREATE INDEX "gst_integration_configs_companyId_idx" ON "gst_integration_configs"("companyId");

-- CreateIndex
CREATE INDEX "gst_integration_configs_gstRegistrationId_idx" ON "gst_integration_configs"("gstRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "gst_integration_credentials_configId_credentialKey_key" ON "gst_integration_credentials"("configId", "credentialKey");

-- CreateIndex
CREATE INDEX "gst_integration_credentials_companyId_idx" ON "gst_integration_credentials"("companyId");

-- CreateIndex
CREATE INDEX "gst_integration_credentials_configId_idx" ON "gst_integration_credentials"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "gst_integration_request_logs_companyId_idempotencyKey_key" ON "gst_integration_request_logs"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "gst_integration_request_logs_companyId_idx" ON "gst_integration_request_logs"("companyId");

-- CreateIndex
CREATE INDEX "gst_integration_request_logs_configId_idx" ON "gst_integration_request_logs"("configId");

-- CreateIndex
CREATE INDEX "gst_integration_request_logs_correlationId_idx" ON "gst_integration_request_logs"("correlationId");

-- AddForeignKey
ALTER TABLE "gst_integration_configs" ADD CONSTRAINT "gst_integration_configs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_configs" ADD CONSTRAINT "gst_integration_configs_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_configs" ADD CONSTRAINT "gst_integration_configs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_configs" ADD CONSTRAINT "gst_integration_configs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_credentials" ADD CONSTRAINT "gst_integration_credentials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_credentials" ADD CONSTRAINT "gst_integration_credentials_configId_companyId_fkey" FOREIGN KEY ("configId", "companyId") REFERENCES "gst_integration_configs"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_request_logs" ADD CONSTRAINT "gst_integration_request_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_integration_request_logs" ADD CONSTRAINT "gst_integration_request_logs_configId_companyId_fkey" FOREIGN KEY ("configId", "companyId") REFERENCES "gst_integration_configs"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- RowLevelSecurity: all three new tables are company-owned tenant tables — same policy shape as
-- every other tenant table (see e.g. 20261002160000's rcm_liabilities).
ALTER TABLE "gst_integration_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_integration_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_integration_configs"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "gst_integration_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_integration_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_integration_credentials"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "gst_integration_request_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_integration_request_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_integration_request_logs"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
