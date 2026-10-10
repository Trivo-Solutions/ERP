-- Splits report:view / report:financial_view into one permission per report so the Role editor can grant
-- each report on its own (see server/src/shared/permissionCatalog.ts, "Reports" group). report:view now means
-- the Dashboard only; report:financial_view now means the GST / statutory report family only.
--
-- Data-only, additive: a role that held report:view gets the ten operational report strings; a role that
-- held report:financial_view gets the eight financial ones. Nobody loses a report they could open before.
-- `roles` is a tenant table: FORCE ROW LEVEL SECURITY is lifted around the UPDATE and restored (same
-- precedent as 20260927150000_split_role_manage_permission).
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'roles' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY; END IF;

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY[
      'report:stock_summary', 'report:stock_book', 'report:stock_on_hand', 'report:dead_stock', 'report:barcode_history',
      'report:sales_register', 'report:sales_report', 'report:wip', 'report:karigar', 'report:cost_centers']))
  )
  WHERE 'report:view' = ANY("permissions");

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY[
      'report:trial_balance', 'report:pnl', 'report:balance_sheet', 'report:day_book', 'report:dealer_aging',
      'report:aging_receivables', 'report:client_ledger', 'report:supplier_ledger']))
  )
  WHERE 'report:financial_view' = ANY("permissions");

  IF forced THEN ALTER TABLE "roles" FORCE ROW LEVEL SECURITY; END IF;
END $$;
