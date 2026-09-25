-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security — extended to the 16 procurement + quality tables Phase 2b made
-- company-owned (see 20260923162000_procurement_quality_tenant_scope): purchase_returns,
-- purchase_return_items, purchase_orders, po_items, goods_receipt_notes, grn_items,
-- purchase_requisitions, pr_items, approval_history, hallmarking_batches, hallmarking_items,
-- repair_jobs, repair_transactions. Same inert-but-proven deployment status as every other RLS
-- migration in this project — see 20260923130000's own comment for the full "why not FORCE yet"
-- reasoning.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase_returns', 'purchase_return_items', 'purchase_orders', 'po_items',
    'goods_receipt_notes', 'grn_items', 'purchase_requisitions', 'pr_items', 'approval_history',
    'hallmarking_batches', 'hallmarking_items', 'repair_jobs', 'repair_transactions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I ' ||
      'USING ("companyId" = current_setting(''app.tenant_company_id'', true)) ' ||
      'WITH CHECK ("companyId" = current_setting(''app.tenant_company_id'', true))',
      t
    );
  END LOOP;
END $$;

-- Still NOT scoped (no companyId column at all yet — out of Phase 2's scope, see the report's
-- "remaining gaps"): suppliers (shared global master data, same bucket as ProductCategory/
-- StockType), job_cards (dormant, manufacturing).
