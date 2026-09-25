-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security — extended to the 36 tables Phase 3 made company-owned (the full
-- 81-model tenant-scoping rollout): hardware_devices, designs, design_files, bom_items,
-- bom_processes, metal_rates, cost_estimates, suppliers, metal_stocks, stone_lots,
-- stone_lot_splits, consumables, consumable_transactions, sales_orders, order_items,
-- material_reservations, client_notifications, job_cards, job_processes, wip_tracking,
-- qc_checkpoints, artisans, karigar_ledger, process_tolerances, subcontractor_invoices,
-- stock_audit_items, branch_transfer_items, tag_estimates, tag_estimate_items,
-- estimate_templates, price_masters, jewelry_tag_materials, making_charges,
-- sales_return_items, export_documents, tax_invoices.
--
-- Same inert-but-proven deployment status as every other RLS migration in this project — see
-- 20260923130000's own comment for the full "why not FORCE yet" reasoning. These policies are
-- live but do not affect the current app connection (the table-owner role bypasses RLS unless
-- FORCE ROW LEVEL SECURITY is also set, which this migration deliberately does not do).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hardware_devices', 'designs', 'design_files', 'bom_items', 'bom_processes', 'metal_rates',
    'cost_estimates', 'suppliers', 'metal_stocks', 'stone_lots', 'stone_lot_splits',
    'consumables', 'consumable_transactions', 'sales_orders', 'order_items',
    'material_reservations', 'client_notifications', 'job_cards', 'job_processes',
    'wip_tracking', 'qc_checkpoints', 'artisans', 'karigar_ledger', 'process_tolerances',
    'subcontractor_invoices', 'stock_audit_items', 'branch_transfer_items', 'tag_estimates',
    'tag_estimate_items', 'estimate_templates', 'price_masters', 'jewelry_tag_materials',
    'making_charges', 'sales_return_items', 'export_documents', 'tax_invoices'
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

-- Still deliberately GLOBAL (no companyId column — genuine shared reference/platform data, see
-- the Phase 3 report's classification matrix): role_templates, companies, users, system_configs,
-- design_categories, karat_master, product_categories, sub_categories, collections,
-- material_codes, hsn_codes, state_master, stock_types, stone_types, stone_grades.
--
-- Still NOT company-scoped at all (no companyId column yet — out of Phase 3's scope, the same
-- 81-model-rollout boundary as before): job_cards' upstream Design/BOM chain IS scoped now, but
-- nothing here remains unscoped among live+dormant operational tables except the intentionally
-- global masters listed above.
