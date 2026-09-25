-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security — Layer 3 backstop, extended to the 12 tables Phase 2 made
-- company-owned (see migration 20260923140000_phase2_finance_memo_transfer_tenant_scope):
-- old_gold_exchanges, memo_outs, memo_items, stock_audits, branch_transfers, tag_templates,
-- invoice_payments, sales_returns, accounts, journal_entries, journal_lines, cost_centers.
--
-- Same deployment status as the prototype's own RLS migration (20260923130000) — these
-- policies are live but INERT against the current app connection:
--   - The table owner (the role in DATABASE_URL, used by both migrations and the live app)
--     bypasses RLS by default unless FORCE ROW LEVEL SECURITY is also set. It is NOT set here.
--   - No separate low-privilege "runtime" Postgres role exists in this environment yet (still
--     needs CREATEROLE/superuser, not available here — see the Phase 2 report's RLS-readiness
--     section for the exact role DDL to run once such access exists).
--   - Several read paths across these 12 tables still don't run inside a transaction that sets
--     app.tenant_company_id (routers doing a manual `where: { companyId }` filter via a bare
--     `prisma.X` call instead of tenantQuery/tenantTransaction/tenantBatch) — enabling FORCE
--     today would silently return empty results for those, a real regression. The Phase 2
--     report's RLS-readiness section lists every such path found.
--
-- Proven correct the same way as the prototype set: see server/src/test/rls.phase2.test.ts,
-- which temporarily sets FORCE ROW LEVEL SECURITY inside a transaction it always rolls back.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'old_gold_exchanges', 'memo_outs', 'memo_items', 'stock_audits', 'branch_transfers',
    'tag_templates', 'invoice_payments', 'sales_returns', 'accounts', 'journal_entries',
    'journal_lines', 'cost_centers'
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

-- Still deliberately NOT RLS-protected (unchanged from the prototype migration's list):
--   companies, users, role_templates — see that migration's own comment for why.
-- Also NOT protected here, and NOT yet company-scoped at all (out of Phase 2's scope — see the
-- Phase 2 report's NumberGen/model-scoping findings): purchase_orders, purchase_requisitions,
-- goods_receipt_notes, purchase_returns, repair_jobs, hallmarking_batches, job_cards,
-- sales_orders, cost_estimates, subcontractor_invoices, audit_logs, and every other model not
-- listed in either RLS migration. These remain the 81-model rollout's territory.
