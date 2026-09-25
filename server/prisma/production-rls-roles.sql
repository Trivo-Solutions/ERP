-- ═══════════════════════════════════════════════════════════════════════════
-- TRIVO DATABASE ROLE BOOTSTRAP — run ONCE per database, as a PostgreSQL superuser (or your managed
-- provider's admin role that has CREATEROLE/CREATEDB), with psql:
--
--   psql -h <host> -p <port> -U <superuser> -d postgres \
--        -v db=trivo -v owner_pw='…' -v runtime_pw='…' -v platform_pw='…' \
--        -f prisma/production-rls-roles.sql
--
-- (Supply real secrets from your secrets manager; never commit them.)
--
-- THREE database identities, none of which is a superuser:
--
--   trivo_owner     OWNS the schema and every table. Used ONLY to run `prisma migrate deploy` and
--                   prisma/db-secure.sql. The running application must NEVER connect as this role —
--                   an owner is exempt from row-level security unless FORCEd, and could ALTER/DISABLE it.
--
--   trivo_runtime   The application's role (DATABASE_URL). Owns nothing, no BYPASSRLS, DML only, and only on
--                   what the app needs. RLS applies to it unconditionally: a query on a company-owned table
--                   sees/writes only the company named by `app.tenant_company_id`, set per transaction by
--                   the tenant wrappers. Forgetting the wrapper returns ZERO rows (fail closed).
--
--   trivo_backup    READ-ONLY, BYPASSRLS. Used only by scripts/backup.sh (pg_dump must see every company's rows, and a
--                   FORCEd-RLS table hides them even from its owner). SELECT on everything incl. _prisma_migrations;
--                   can change nothing. Optional: pass -v backup_pw='…' (skipped if not supplied).
--
--   trivo_platform  The operator/platform role (PLATFORM_DATABASE_URL). BYPASSRLS, DML only, not the owner.
--                   Reached only through runAsPlatform(): provisioning a company, operator endpoints,
--                   platform audit events, startup device enumeration, test fixtures/backups tooling.
--
-- After this script: run `prisma migrate deploy` AS trivo_owner, then `prisma/db-secure.sql` AS trivo_owner
-- (idempotent — re-run after EVERY deploy so new tables are granted deliberately, not by default).
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- Roles are cluster-wide, so creation is idempotent (a second database on the same cluster reuses them;
-- to CHANGE a password use ALTER ROLE separately).
SELECT format('CREATE ROLE trivo_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', :'owner_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_owner') \gexec

SELECT format('CREATE ROLE trivo_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 100', :'runtime_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_runtime') \gexec

SELECT format('CREATE ROLE trivo_platform LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION CONNECTION LIMIT 20', :'platform_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_platform') \gexec

SELECT format('CREATE ROLE trivo_backup LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION CONNECTION LIMIT 3', :'backup_pw')
  WHERE :'backup_pw' <> '' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_backup') \gexec

-- Per-role guard rails (apply to every new session of that role).
--   statement_timeout                    a runaway query is cancelled instead of pinning a connection
--   idle_in_transaction_session_timeout  a request that opened a transaction and stalled is killed, so it
--                                        cannot hold locks / a pooled connection indefinitely
--   lock_timeout                         waiting on a lock fails fast instead of queueing up
--   row_security = on                    never silently disable RLS for this role
ALTER ROLE trivo_runtime  SET statement_timeout = '30s';
ALTER ROLE trivo_runtime  SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE trivo_runtime  SET lock_timeout = '10s';
ALTER ROLE trivo_runtime  SET row_security = on;
ALTER ROLE trivo_platform SET statement_timeout = '120s';
ALTER ROLE trivo_platform SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE trivo_platform SET lock_timeout = '15s';

CREATE DATABASE :"db" OWNER trivo_owner ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO trivo_runtime, trivo_platform;
SELECT format('GRANT CONNECT ON DATABASE %I TO trivo_backup', :'db') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_backup') \gexec
ALTER DATABASE :"db" SET log_min_duration_statement = 500;   -- log anything slower than 500ms

\connect :"db"

-- Nobody but the owner may create objects; the runtime and platform roles may only USE the schema.
ALTER SCHEMA public OWNER TO trivo_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO trivo_runtime, trivo_platform;
SELECT 'GRANT USAGE ON SCHEMA public TO trivo_backup' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trivo_backup') \gexec
