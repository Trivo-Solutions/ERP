-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security — Layer 3 backstop for the prototype's tenant-scoped tables.
--
-- IMPORTANT / DEPLOYMENT STATUS: this migration defines the policies but deliberately does
-- NOT set FORCE ROW LEVEL SECURITY, and the application's runtime connection is NOT (yet)
-- a non-owner role. Concretely:
--   - The table owner (the role in DATABASE_URL, which both migrations and the live app
--     currently use) bypasses RLS by default unless FORCE ROW LEVEL SECURITY is also set.
--   - This environment has no separate low-privilege "runtime" Postgres role available
--     (the app's DB role lacks CREATEROLE, and no superuser credentials were available to
--     create one) — see the implementation report's "G — PostgreSQL RLS" section for the
--     full reasoning.
--   - Several existing read paths (e.g. listBranches, getTag, listTags, searchTags,
--     listClients, getClient, and every not-yet-migrated finance/report query touching
--     clients/sales_invoices) do not yet run inside a transaction that sets
--     app.tenant_company_id — enabling FORCE today would silently return empty results
--     for all of them, a real regression, not just an RLS "deny."
--
-- These policies are therefore live but INERT against the current app connection — exactly
-- the safe, zero-blast-radius state to land them in. They are proven correct directly
-- against this migration (see server/src/test/rls.prototype.test.ts, which temporarily
-- sets FORCE ROW LEVEL SECURITY inside a transaction it always rolls back). Enabling FORCE
-- for real traffic is a deliberate, separate, later step — see the report's recommended
-- next steps — that requires either (a) a genuine non-owner runtime role, or (b) retrofitting
-- every remaining tenant-scoped read/write path to set the session variable first.
-- ═══════════════════════════════════════════════════════════════════════════

-- Tables with a direct companyId column — the common, cheap case.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'clients', 'jewelry_tags', 'sales_invoices', 'invoice_items',
    'roles', 'company_users', 'number_sequences'
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

-- user_branch_access has no direct companyId (only companyUserId) — its policy resolves
-- company ownership through company_users. Small, low-traffic table, so a correlated
-- subquery here doesn't carry the performance concern the RLS-denormalization rule exists
-- to avoid on high-volume tables (see the multi-tenant blueprint).
ALTER TABLE "user_branch_access" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_branch_access"
  USING (EXISTS (
    SELECT 1 FROM "company_users" cu
    WHERE cu.id = "user_branch_access"."companyUserId"
      AND cu."companyId" = current_setting('app.tenant_company_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "company_users" cu
    WHERE cu.id = "user_branch_access"."companyUserId"
      AND cu."companyId" = current_setting('app.tenant_company_id', true)
  ));

-- Deliberately NOT RLS-protected, on purpose:
--   companies      — the pre-authentication Company Code lookup at login must work before any
--                    tenant context exists; it has no companyId column (it IS the tenant row).
--   users          — global identity, deliberately not company-scoped (see the blueprint's
--                    explicit User-stays-global reasoning); login resolves by email globally.
--   role_templates — global platform data, not tenant data.
