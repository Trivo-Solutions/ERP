-- Purchase-side (input) GST for finished-goods intake.
--
-- Until now the intake entry was Dr Inventory / Cr Accounts Payable for the bare cost, so any GST on the
-- supplier's bill was invisible: no input tax credit, and the payable was understated by the tax.
--
--   po_items:              hsnCodeId + a taxRate snapshot (the rate the supplier charged, copied at PO time)
--   grn_items:             taxableValue + inputCgst/inputSgst/inputIgst, stamped once when the line is tagged
--   purchase_returns:      taxAmount (the input GST reversed on the goods sent back)
--   purchase_return_items: cgst/sgst/igst reversed per line
--
-- Existing rows: taxRate defaults to 0 and the GRN tax columns to NULL/0, i.e. exactly the behaviour every
-- past purchase was booked under. Nothing is restated.

ALTER TABLE "po_items"
  ADD COLUMN "hsnCodeId" TEXT,
  ADD COLUMN "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0;
ALTER TABLE "po_items" ADD CONSTRAINT "po_items_hsnCodeId_fkey"
  FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "grn_items"
  ADD COLUMN "taxableValue" DECIMAL(12,2),
  ADD COLUMN "inputCgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "inputSgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "inputIgst" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "purchase_returns" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "purchase_return_items"
  ADD COLUMN "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "igst" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Input-tax-credit accounts (assets: GST paid to suppliers that offsets GST collected on sales) for every
-- company that already exists. New companies get them from the Starter Package chart of accounts.
-- Same "seed it in the migration" precedent as 20260825130000_seed_ledger_accounts.
--
-- `accounts` is a tenant table: once db-secure.sql has FORCEd row-level security, even its owner (who runs
-- migrations) is filtered by the policy and this INSERT would be refused. So FORCE is lifted for the statement
-- and restored — only where it was on; a single-role dev/test database never had it and is left as it was.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'accounts' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY; END IF;

  INSERT INTO "accounts" ("id", "companyId", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
  SELECT 'acc_' || c."id" || '_' || a."code", c."id", a."code", a."name", 'ASSET', 'TAX', 0, 'INR', true, true
  FROM "companies" c
  CROSS JOIN (VALUES
    ('1401', 'Input CGST (ITC)'),
    ('1402', 'Input SGST (ITC)'),
    ('1403', 'Input IGST (ITC)')
  ) AS a("code", "name")
  ON CONFLICT ("companyId", "code") DO NOTHING;

  IF forced THEN ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY; END IF;
END $$;
