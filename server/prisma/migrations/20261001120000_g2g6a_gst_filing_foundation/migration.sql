-- G2g-6a — Filing Period, Snapshot & Filing Attempt: PERSISTENCE FOUNDATION ONLY.
--
-- Three brand-new, empty tables. No snapshot builder, filing service, mutation lock, or endpoint
-- exists yet (see CLAUDE.md's G2g-6a entry and schema.prisma's model comments) — this migration is
-- schema + RLS + composite-FK only, same scope discipline as 20260929120000_g2a_credit_debit_notes_foundation.
--
-- Architecture: Company -> CompanyGstRegistration -> GstReturnPeriod -> { GstFilingSnapshot, GstFilingAttempt }.
-- There is deliberately no separate "GstPeriodLock" table — GstReturnPeriod itself owns the
-- lifecycle/status and eventual filing/lock metadata.

-- CreateTable
CREATE TABLE "gst_return_periods" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstRegistrationId" TEXT NOT NULL,
    "returnType" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "taxPeriod" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "filedAt" TIMESTAMP(3),
    "filedSnapshotId" TEXT,
    "arn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_return_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_filing_snapshots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "returnPeriodId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "canonicalDtoJson" JSONB NOT NULL,
    "wireJson" JSONB NOT NULL,
    "canonicalDtoHash" TEXT NOT NULL,
    "wireJsonHash" TEXT NOT NULL,
    "serializerVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "gstnSchemaVersion" TEXT NOT NULL DEFAULT 'UNSPECIFIED',
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "branchScope" JSONB NOT NULL,
    "validationResult" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceDataCutoff" TIMESTAMP(3) NOT NULL,
    "reportParams" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "gst_filing_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_filing_attempts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "returnPeriodId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ATTEMPTED',
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filedAt" TIMESTAMP(3),
    "arn" TEXT,
    "externalReference" TEXT,
    "payloadHash" TEXT NOT NULL,
    "responseMetadata" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "gst_filing_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gst_return_periods_companyId_idx" ON "gst_return_periods"("companyId");

-- CreateIndex
CREATE INDEX "gst_return_periods_gstRegistrationId_idx" ON "gst_return_periods"("gstRegistrationId");

-- CreateIndex: the statutory identity of a return period. Explicitly named — the unhashed default
-- exceeds Postgres's 63-byte identifier limit and gets silently truncated (same issue
-- CreditNote.creditNoteNumber's own constraint documents).
CREATE UNIQUE INDEX "gst_return_periods_company_registration_period_key" ON "gst_return_periods"("companyId", "gstRegistrationId", "returnType", "financialYear", "taxPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "gst_return_periods_id_companyId_key" ON "gst_return_periods"("id", "companyId");

-- CreateIndex
CREATE INDEX "gst_filing_snapshots_companyId_idx" ON "gst_filing_snapshots"("companyId");

-- CreateIndex
CREATE INDEX "gst_filing_snapshots_returnPeriodId_idx" ON "gst_filing_snapshots"("returnPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "gst_filing_snapshots_returnPeriodId_version_key" ON "gst_filing_snapshots"("returnPeriodId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "gst_filing_snapshots_id_companyId_key" ON "gst_filing_snapshots"("id", "companyId");

-- CreateIndex
CREATE INDEX "gst_filing_attempts_companyId_idx" ON "gst_filing_attempts"("companyId");

-- CreateIndex
CREATE INDEX "gst_filing_attempts_returnPeriodId_idx" ON "gst_filing_attempts"("returnPeriodId");

-- CreateIndex
CREATE INDEX "gst_filing_attempts_snapshotId_idx" ON "gst_filing_attempts"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "gst_filing_attempts_returnPeriodId_attemptNumber_key" ON "gst_filing_attempts"("returnPeriodId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "gst_filing_attempts_id_companyId_key" ON "gst_filing_attempts"("id", "companyId");

-- AddForeignKey
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite — the database refuses a return period pointing at another company's GST registration.
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite — the database refuses a period's "filed snapshot" pointer crossing into another company's snapshot.
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_filedSnapshotId_companyId_fkey" FOREIGN KEY ("filedSnapshotId", "companyId") REFERENCES "gst_filing_snapshots"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_filing_snapshots" ADD CONSTRAINT "gst_filing_snapshots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite — the database refuses a snapshot pointing at another company's return period.
ALTER TABLE "gst_filing_snapshots" ADD CONSTRAINT "gst_filing_snapshots_returnPeriodId_companyId_fkey" FOREIGN KEY ("returnPeriodId", "companyId") REFERENCES "gst_return_periods"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_filing_snapshots" ADD CONSTRAINT "gst_filing_snapshots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_filing_attempts" ADD CONSTRAINT "gst_filing_attempts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite — the database refuses a filing attempt pointing at another company's return period.
ALTER TABLE "gst_filing_attempts" ADD CONSTRAINT "gst_filing_attempts_returnPeriodId_companyId_fkey" FOREIGN KEY ("returnPeriodId", "companyId") REFERENCES "gst_return_periods"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: composite — the database refuses a filing attempt pointing at another company's snapshot.
ALTER TABLE "gst_filing_attempts" ADD CONSTRAINT "gst_filing_attempts_snapshotId_companyId_fkey" FOREIGN KEY ("snapshotId", "companyId") REFERENCES "gst_filing_snapshots"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_filing_attempts" ADD CONSTRAINT "gst_filing_attempts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RowLevelSecurity: all three tables are brand-new (no pre-existing rows) — same policy shape as
-- every other tenant table (prisma/production-rls-roles.sql): FORCE ROW LEVEL SECURITY so even the
-- owning role is bound by it, and a `tenant_isolation` policy keyed off app.tenant_company_id for
-- USING and WITH CHECK alike.
ALTER TABLE "gst_return_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_return_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_return_periods"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "gst_filing_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_filing_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_filing_snapshots"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "gst_filing_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gst_filing_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gst_filing_attempts"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
