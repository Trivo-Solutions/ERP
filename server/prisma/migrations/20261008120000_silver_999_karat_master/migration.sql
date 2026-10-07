-- Silver 999 purity master. The market quotes Silver (like Gold's 24K) against 999 purity, so the daily rate sheet needs a
-- real, active Silver '999' purity row (exactly 0.9990) to carry the entered Silver 999 / Old Silver 999 base rates; every
-- other Silver purity (925 ...) is then calculated as base x purity / 99.9.
--
-- One row per existing company; companies provisioned from now on get it from the Starter Package. Idempotent
-- (ON CONFLICT DO NOTHING on the (companyId, code) unique), so a company that already added its own '999' keeps it
-- untouched. No existing row, rate, invoice or purchase is modified - historical MetalRate rows stay as they were.
-- `karat_master` is a tenant table: once db-secure.sql has FORCEd row-level security even its owner (who runs migrations)
-- is filtered by the policy, so FORCE is lifted for the statement and restored only where it was on.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'karat_master' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "karat_master" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "karat_master" ("id", "companyId", "code", "metalType", "purity", "isActive")
  SELECT 'karatmaster_' || c."id" || '_999', c."id", '999', 'SILVER', 0.9990, true
  FROM "companies" c
  ON CONFLICT ("companyId", "code") DO NOTHING;

  IF forced THEN ALTER TABLE "karat_master" FORCE ROW LEVEL SECURITY; END IF;
END $$;
