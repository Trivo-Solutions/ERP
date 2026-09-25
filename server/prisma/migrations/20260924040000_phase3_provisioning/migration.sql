-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3: company provisioning + the TRIVO Starter Package.
--
--   companies.starterPackageVersion / starterPackageAppliedAt — which versioned Starter Package a
--     company was provisioned with (NULL = predates starter packages, e.g. the original SEA company).
--   company_invitations.invitedById becomes optional — an invitation issued by a TRIVO platform
--     operator (the first admin of a new company, when that email already has a login) has no
--     inviting user; it is recorded in platform_audit_logs instead. ON DELETE now SET NULL.
--   role_templates is dropped — the role definitions live in the versioned Starter Package
--     (modules/platform/starterPackage/v1.ts) and are COPIED into each company at provisioning, so
--     a separate platform table would only be a second, drifting source of truth.
-- ═══════════════════════════════════════════════════════════════════════════

-- DropForeignKey
ALTER TABLE "company_invitations" DROP CONSTRAINT "company_invitations_invitedById_fkey";

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "starterPackageAppliedAt" TIMESTAMP(3),
ADD COLUMN     "starterPackageVersion" INTEGER;

-- AlterTable
ALTER TABLE "company_invitations" ALTER COLUMN "invitedById" DROP NOT NULL;

-- DropTable
DROP TABLE "role_templates";

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
