-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 of full company isolation: identity and membership.
--
--   User        = global LOGIN identity only (email, password hash, name, active flag).
--   CompanyUser = the person's identity INSIDE one company (employee id, department, phone,
--                 username, role, branch access, last login there).
--
--   1. employeeId / department / phone move off users onto company_users. employeeId becomes
--      unique PER COMPANY (was globally unique). lastLoginAt is added per membership so a company
--      never sees a person's activity in another company.
--   2. user_branch_access gets companyId, tied to BOTH parents by composite foreign keys so the
--      database itself rejects a grant that links one company's membership to another's branch.
--   3. audit_logs.companyId becomes required. Platform-level events get their own table.
--   4. company_invitations: the explicit, pending offer that replaces silent attach-by-email.
--
-- Ambiguous existing data is NEVER guessed at — this migration aborts instead (see the two
-- precondition checks) or, for legacy audit rows only, moves them to platform_audit_logs so no
-- history is lost and none is assigned to a company it may not belong to.
-- ═══════════════════════════════════════════════════════════════════════════

-- The whole migration is ONE transaction: a failed precondition or statement rolls back everything.
BEGIN;

-- ── Precondition 1: employee data can only be moved if its owning company is unambiguous ──────
-- users.employeeId/department/phone were company-agnostic. A user with exactly ONE membership
-- has an obvious owner. A user with two or more does not — copying to all of them, or picking one,
-- would be a guess, so if any such user carries employee data the migration stops and a person
-- must resolve it first.
DO $$
DECLARE
  ambiguous text;
BEGIN
  SELECT string_agg(u."email", ', ') INTO ambiguous
  FROM "users" u
  WHERE (u."employeeId" IS NOT NULL OR u."department" IS NOT NULL OR u."phone" IS NOT NULL)
    AND (SELECT count(*) FROM "company_users" c WHERE c."userId" = u."id") > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 2 aborted: user(s) [%] belong to more than one company and carry employeeId/department/phone; the owning company is ambiguous. Clear or assign these fields manually, then re-run.', ambiguous;
  END IF;
END $$;

-- ── Precondition 2: no branch grant may already cross companies ──────────────────────────────
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM "user_branch_access" a
  JOIN "company_users" c ON c."id" = a."companyUserId"
  JOIN "branches" b ON b."id" = a."branchId"
  WHERE c."companyId" <> b."companyId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'Phase 2 aborted: % user_branch_access row(s) link a membership of one company to a branch of another; resolve manually, then re-run.', bad;
  END IF;
END $$;

-- ── 1. Employee data: users -> company_users ─────────────────────────────────────────────────
ALTER TABLE "company_users" ADD COLUMN "department" TEXT,
ADD COLUMN "employeeId" TEXT,
ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "phone" TEXT;

-- Only users with exactly one membership (precondition 1 guarantees no multi-membership user has
-- employee data; lastLogin for one is simply left NULL rather than attributed to a company).
UPDATE "company_users" c
SET "employeeId" = u."employeeId",
    "department" = u."department",
    "phone"      = u."phone",
    "lastLoginAt" = u."lastLogin"
FROM "users" u
WHERE u."id" = c."userId"
  AND (SELECT count(*) FROM "company_users" x WHERE x."userId" = u."id") = 1;

-- DropIndex
DROP INDEX "users_employeeId_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "department",
DROP COLUMN "employeeId",
DROP COLUMN "phone";

-- CreateIndex
CREATE UNIQUE INDEX "company_users_companyId_employeeId_key" ON "company_users"("companyId", "employeeId");
CREATE UNIQUE INDEX "company_users_id_companyId_key" ON "company_users"("id", "companyId");
CREATE UNIQUE INDEX "branches_id_companyId_key" ON "branches"("id", "companyId");

-- ── 2. user_branch_access: company-owned, internally consistent ──────────────────────────────
ALTER TABLE "user_branch_access" DROP CONSTRAINT "user_branch_access_companyUserId_fkey";
ALTER TABLE "user_branch_access" DROP CONSTRAINT "user_branch_access_branchId_fkey";

ALTER TABLE "user_branch_access" ADD COLUMN "companyId" TEXT;
UPDATE "user_branch_access" a SET "companyId" = c."companyId"
  FROM "company_users" c WHERE c."id" = a."companyUserId";
ALTER TABLE "user_branch_access" ALTER COLUMN "companyId" SET NOT NULL;

CREATE INDEX "user_branch_access_companyId_idx" ON "user_branch_access"("companyId");

ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_companyUserId_companyId_fkey" FOREIGN KEY ("companyUserId", "companyId") REFERENCES "company_users"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replaces the earlier policy, which had to resolve the company through a companyUserId subquery
-- because this table had no companyId of its own (20260923130000_rls_prototype_policies).
DROP POLICY tenant_isolation ON "user_branch_access";
ALTER TABLE "user_branch_access" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_branch_access"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- ── 3a. platform_audit_logs (created first: legacy audit rows may be moved into it) ──────────
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_audit_logs_timestamp_idx" ON "platform_audit_logs"("timestamp");
CREATE INDEX "platform_audit_logs_action_idx" ON "platform_audit_logs"("action");
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3b. audit_logs.companyId required ────────────────────────────────────────────────────────
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_companyId_fkey";

-- A row with no company is attributed ONLY when its actor has exactly one membership (the only
-- company they could have acted in). Everything else is not guessed: it is moved, content intact,
-- to platform_audit_logs as LEGACY_UNATTRIBUTED_AUDIT — no history deleted, none mis-assigned.
UPDATE "audit_logs" a SET "companyId" = m."companyId"
FROM (
  SELECT "userId", min("companyId") AS "companyId"
  FROM "company_users" GROUP BY "userId" HAVING count(*) = 1
) m
WHERE a."companyId" IS NULL AND a."userId" = m."userId";

INSERT INTO "platform_audit_logs" ("id", "actorUserId", "action", "subjectType", "subjectId", "metadata", "timestamp")
SELECT gen_random_uuid()::text, a."userId", 'LEGACY_UNATTRIBUTED_AUDIT:' || a."action", a."tableName", a."recordId",
       jsonb_build_object('originalAuditLogId', a."id", 'oldValues', a."oldValues", 'newValues', a."newValues",
                          'ipAddress', a."ipAddress", 'userAgent', a."userAgent"),
       a."timestamp"
FROM "audit_logs" a WHERE a."companyId" IS NULL;
DELETE FROM "audit_logs" WHERE "companyId" IS NULL;

ALTER TABLE "audit_logs" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. company_invitations ───────────────────────────────────────────────────────────────────
CREATE TABLE "company_invitations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "allBranches" BOOLEAN NOT NULL DEFAULT false,
    "branchIds" TEXT[],
    "username" TEXT,
    "employeeId" TEXT,
    "department" TEXT,
    "phone" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedCompanyUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "company_invitations_tokenHash_key" ON "company_invitations"("tokenHash");
CREATE UNIQUE INDEX "company_invitations_acceptedCompanyUserId_key" ON "company_invitations"("acceptedCompanyUserId");
CREATE INDEX "company_invitations_companyId_email_idx" ON "company_invitations"("companyId", "email");
CREATE INDEX "company_invitations_companyId_status_idx" ON "company_invitations"("companyId", "status");
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_acceptedCompanyUserId_fkey" FOREIGN KEY ("acceptedCompanyUserId") REFERENCES "company_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: a company only ever sees its own invitations. (The one place an invitation is read WITHOUT
-- a company context — the public accept endpoint, which only has the one-time token — is a
-- documented platform-level lookup; see auth.service.ts acceptInvitation and CLAUDE.md §11.)
ALTER TABLE "company_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_invitations"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

COMMIT;
