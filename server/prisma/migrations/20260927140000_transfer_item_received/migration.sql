-- Branch transfers are received piece by piece: the receiving branch verifies what actually arrived and
-- receives only that. branch_transfer_items.receivedAt marks a piece that has been taken in; a null one is
-- still in transit. A transfer with some but not all pieces received is PARTIALLY_RECEIVED (a status string,
-- no schema change for it).
ALTER TABLE "branch_transfer_items" ADD COLUMN "receivedAt" TIMESTAMP(3);

-- Transfers already RECEIVED took every piece in at once: mark each piece received at the transfer's own time.
-- Both tables are tenant tables: once db-secure.sql has FORCEd row-level security even their owner (who runs
-- migrations) is filtered by the policy, so this UPDATE would read no transfers and touch nothing. FORCE is
-- lifted for the statement and restored — only where it was on.
DO $$
DECLARE forced_items boolean; forced_transfers boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced_items FROM pg_class WHERE relname = 'branch_transfer_items' AND relnamespace = 'public'::regnamespace;
  SELECT relforcerowsecurity INTO forced_transfers FROM pg_class WHERE relname = 'branch_transfers' AND relnamespace = 'public'::regnamespace;
  IF forced_items THEN ALTER TABLE "branch_transfer_items" NO FORCE ROW LEVEL SECURITY; END IF;
  IF forced_transfers THEN ALTER TABLE "branch_transfers" NO FORCE ROW LEVEL SECURITY; END IF;

  UPDATE "branch_transfer_items" i
  SET "receivedAt" = COALESCE(t."receivedAt", t."updatedAt")
  FROM "branch_transfers" t
  WHERE i."transferId" = t."id" AND i."companyId" = t."companyId" AND t."status" = 'RECEIVED';

  IF forced_items THEN ALTER TABLE "branch_transfer_items" FORCE ROW LEVEL SECURITY; END IF;
  IF forced_transfers THEN ALTER TABLE "branch_transfers" FORCE ROW LEVEL SECURITY; END IF;
END $$;
