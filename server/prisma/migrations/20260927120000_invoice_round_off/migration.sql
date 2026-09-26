-- Sales round-off: the biller rounds the bill to the nearest rupee (automatic, editable at the counter).
--
--   sales_invoices.roundOff  the adjustment included in totalAmount (positive = customer pays more).
--
-- Existing invoices default to 0, i.e. exactly what they were billed at — nothing is restated.
ALTER TABLE "sales_invoices" ADD COLUMN "roundOff" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- The account the round-off is posted to (credit when billed up, debit when down), for every company that
-- already exists. New companies get it from the Starter Package chart of accounts.
-- `accounts` is a tenant table: once db-secure.sql has FORCEd row-level security, even its owner (who runs
-- migrations) is filtered by the policy and this INSERT would be refused. So FORCE is lifted for the statement
-- and restored — only where it was on; a single-role dev/test database never had it and is left as it was.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'accounts' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "accounts" ("id", "companyId", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
  SELECT 'acc_' || c."id" || '_6600', c."id", '6600', 'Round Off', 'EXPENSE', NULL, 0, 'INR', true, true
  FROM "companies" c
  ON CONFLICT ("companyId", "code") DO NOTHING;

  IF forced THEN ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY; END IF;
END $$;
