-- ═══════════════════════════════════════════════════════════════════════════
-- system_configs was the last GLOBAL key/value table: `key` was unique on its own, so every
-- company read and overwrote the same row (e.g. one company changing DEFAULT_GOLD_MARGIN changed
-- it for all of them). It is now company-owned: unique on ("companyId", "key"), RLS-protected
-- like every other tenant table.
--
-- Existing rows are not discarded (unlike the Phase 3 seed-row clears, these are settings someone
-- may have edited): every existing global row is COPIED to every existing company, so each
-- company starts with exactly the values it was already effectively using, then diverges
-- independently from here. The original companyId-less rows are deleted afterwards.
-- ═══════════════════════════════════════════════════════════════════════════

-- The old global uniqueness on key alone must go before the fan-out, since the copies reuse keys.
DROP INDEX "system_configs_key_key";

-- Nullable first so the existing rows survive the column add.
ALTER TABLE "system_configs" ADD COLUMN "companyId" TEXT;

-- Fan out: one copy of each existing global row per existing company.
INSERT INTO "system_configs" ("id", "companyId", "key", "value", "category", "updatedAt")
SELECT gen_random_uuid()::text, c."id", s."key", s."value", s."category", s."updatedAt"
FROM "system_configs" s
CROSS JOIN "companies" c
WHERE s."companyId" IS NULL;

-- Drop the original unscoped rows (their per-company copies now exist).
DELETE FROM "system_configs" WHERE "companyId" IS NULL;

ALTER TABLE "system_configs" ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "system_configs_companyId_idx" ON "system_configs"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_companyId_key_key" ON "system_configs"("companyId", "key");

-- AddForeignKey
ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — same inert-but-proven deployment status as every other tenant table (see
-- 20260923130000's own comment for the full "why not FORCE yet" reasoning).
ALTER TABLE "system_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "system_configs"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
