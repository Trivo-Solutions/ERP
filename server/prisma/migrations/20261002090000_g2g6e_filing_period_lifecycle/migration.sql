-- G2g-6e — Filing / Period Lifecycle Boundary. Adds the FILED/LOCKED transition metadata to the
-- already-existing GstReturnPeriod table (G2g-6a). No new table — per the approved brief, the
-- lifecycle/status and its eventual filing/lock metadata live on GstReturnPeriod itself; there is
-- still deliberately no separate "GstPeriodLock" table.
--
-- filedAt/filedSnapshotId/arn already existed (G2g-6a placeholders, first actually written by this
-- phase's gstr1FilingPeriod.service.ts). New in this migration:
--   filedByAttemptId — the exact ACCEPTED GstFilingAttempt that established the FILED boundary.
--   filedById        — the actor who performed the FILED transition.
--   lockedAt/lockedById — the later, separate, one-way FILED -> LOCKED transition.

-- AlterTable
ALTER TABLE "gst_return_periods" ADD COLUMN     "filedByAttemptId" TEXT,
ADD COLUMN     "filedById" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedById" TEXT;

-- AddForeignKey: composite — the database refuses a period's "filed by attempt" pointer crossing
-- into another company's filing attempt. RESTRICT: an attempt that established a filing boundary
-- is never deletable out from under it (attempts are append-only everywhere in this codebase).
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_filedByAttemptId_companyId_fkey" FOREIGN KEY ("filedByAttemptId", "companyId") REFERENCES "gst_filing_attempts"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_return_periods" ADD CONSTRAINT "gst_return_periods_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No RLS/policy change needed — "gst_return_periods" already has FORCE ROW LEVEL SECURITY and its
-- tenant_isolation policy from the G2g-6a migration; new nullable columns on an existing RLS table
-- need no new policy.
