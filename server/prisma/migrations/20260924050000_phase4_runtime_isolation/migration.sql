-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4: runtime isolation.
--
--   hardware_devices.branchId — the branch a device physically sits in (optional; NULL = company-wide).
--     Tied to the branch by a COMPOSITE foreign key (branchId, companyId) so a device can never
--     reference another company's branch. Lets a branch-restricted user be shown only their own
--     branches' devices.
--
--   design_files.filePath CHECK — a stored file path may only live under its OWN company's object-storage
--     prefix (`companies/<companyId>/...`). Object storage is not wired up yet (nothing writes
--     design_files today); this makes the company boundary a database guarantee the moment it is, so a
--     path pointing at another company's objects — or a bare `uploads/...` path — cannot be stored.
--     (See shared/objectKey.ts for the key rule the application follows.)
-- ═══════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "hardware_devices" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "hardware_devices_branchId_idx" ON "hardware_devices"("branchId");

-- AddForeignKey
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Company-namespaced object paths only.
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_filePath_company_prefix_chk"
  CHECK ("filePath" LIKE 'companies/' || "companyId" || '/%' AND "filePath" NOT LIKE '%..%');
