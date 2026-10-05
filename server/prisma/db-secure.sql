-- ═══════════════════════════════════════════════════════════════════════════
-- TRIVO DATABASE SECURITY — run AS trivo_owner after EVERY `prisma migrate deploy`. Idempotent.
--
--   npx prisma db execute --file prisma/db-secure.sql --schema prisma/schema.prisma   (DATABASE_URL = trivo_owner)
--
-- It (1) resets the runtime/platform roles' privileges to NOTHING, (2) grants back exactly what each needs,
-- and (3) FORCEs row-level security on every company-owned table. New tables are therefore inaccessible to the
-- application until this script has run — a new table is granted deliberately, never by default.
--
-- "Company-owned table" = a table with a `tenant_isolation` policy (the schema-guard test guarantees every
-- table that has a companyId column has one).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Start from nothing.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM trivo_runtime, trivo_platform;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM trivo_runtime, trivo_platform;

-- 2. Company-owned tables: the runtime role gets ordinary DML, and RLS is FORCEd (so it also binds the table
--    owner — an ad-hoc session as trivo_owner sees no tenant's rows either). The platform role bypasses RLS.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO trivo_runtime', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The audit trail is APPEND-ONLY for the application: it can write and read it, never rewrite history.
REVOKE UPDATE, DELETE ON audit_logs FROM trivo_runtime;
-- Tag (barcode) history is append-only for the same reason: written by a trigger, never rewritten.
REVOKE UPDATE, DELETE ON tag_history FROM trivo_runtime;

-- 3. Platform tables (owned by no company). Least privilege for the runtime role:
GRANT SELECT ON companies, hsn_codes, state_master TO trivo_runtime;          -- read-only reference / company identity
GRANT SELECT, INSERT, UPDATE ON users TO trivo_runtime;                        -- login identities (never deleted by the app)
-- platform_audit_logs and _prisma_migrations: NO access for the runtime role.

-- 4. The platform role: DML everywhere (BYPASSRLS), but never the migration bookkeeping table.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trivo_platform;
REVOKE ALL ON _prisma_migrations FROM trivo_platform;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trivo_runtime, trivo_platform;

-- 4b. The backup role (if it exists): read-only on EVERYTHING, including the migration bookkeeping table, so a dump
--     is complete and restorable. BYPASSRLS is on the role itself; it can change nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_backup') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM trivo_backup;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO trivo_backup;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO trivo_backup;
  END IF;
END $$;

-- 5. Never let a future table be granted implicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM trivo_runtime, trivo_platform;
