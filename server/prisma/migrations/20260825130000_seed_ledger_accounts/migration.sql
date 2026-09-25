-- F1: seed the specific chart-of-accounts rows the automatic system journal entries (sales,
-- payments, returns, GRN intake — see shared/ledgerAccounts.ts LEDGER_ACCOUNT) depend on existing.
-- finance.service.ts's seedChartOfAccounts() already defines these (and more) but is only ever
-- run manually via prisma/seed.ts — not guaranteed present in every database that has merely run
-- migrations (e.g. the dedicated test DB, migrated with `prisma migrate deploy` and nothing else).
-- Same "seed it directly in a migration" precedent as DEFAULT_HSN_CODE (20260823184530) and
-- KaratMaster (20260825060603). ON CONFLICT ("code") DO NOTHING so this is a no-op against a
-- database where seedChartOfAccounts() already created these rows (own ids, same codes).
INSERT INTO "accounts" ("id", "code", "name", "type", "subType", "balance", "currency", "isSystem", "isActive")
VALUES
  ('account_1101', '1101', 'Cash in Hand', 'ASSET', 'CASH', 0, 'INR', true, true),
  ('account_1102', '1102', 'Bank Account', 'ASSET', 'BANK', 0, 'INR', true, true),
  ('account_1200', '1200', 'Accounts Receivable', 'ASSET', 'RECEIVABLE', 0, 'INR', true, true),
  ('account_1300', '1300', 'Inventory - Gold Stock', 'ASSET', 'INVENTORY', 0, 'INR', true, true),
  ('account_2100', '2100', 'Accounts Payable', 'LIABILITY', 'PAYABLE', 0, 'INR', true, true),
  ('account_2201', '2201', 'CGST Payable', 'LIABILITY', 'TAX', 0, 'INR', true, true),
  ('account_2202', '2202', 'SGST Payable', 'LIABILITY', 'TAX', 0, 'INR', true, true),
  ('account_2203', '2203', 'IGST Payable', 'LIABILITY', 'TAX', 0, 'INR', true, true),
  ('account_4000', '4000', 'Sales Revenue', 'REVENUE', NULL, 0, 'INR', true, true),
  ('account_5000', '5000', 'Cost of Goods', 'EXPENSE', NULL, 0, 'INR', true, true)
ON CONFLICT ("code") DO NOTHING;
