-- TRIVO snapshot-consistent dump + row-count manifest (READ-ONLY against the database).  Format: manifest v2.
-- Run (via run.sh) as the read-only, BYPASSRLS role trivo_backup so every company's rows are counted and dumped.
--
-- ONE REPEATABLE READ READ ONLY transaction exports its snapshot, counts every relation in the defined set, and stays OPEN while
-- pg_dump imports that very snapshot (--snapshot). COMMIT happens only after pg_dump exits. So manifest and dump describe the SAME
-- database snapshot by construction. The exported snapshot id is valid only while this transaction is open; if this session dies
-- the transaction aborts and the snapshot disappears with it.
--
-- Defined relation set: every ORDINARY table (pg_class.relkind = 'r') in schema "public".
-- Output goes ONLY into the private staging directory :outdir (created by run.sh): manifest.tsv (counts and catalog numbers
-- only - NO row data) and trivo_snap.dump. pg_dump's exit status goes to container-local /tmp/dump.rc.
--
-- Variables (required): outdir, expect_db, expect_user.   Optional: expect_major (default 16), hold (seconds; TEST HOOK, 0 in production).
\set ON_ERROR_STOP on
\if :{?hold}
\else
  \set hold 0
\endif
\if :{?expect_major}
\else
  \set expect_major 16
\endif
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '2h';

\o /dev/null
SELECT set_config('trivo.expect_db', :'expect_db', true), set_config('trivo.expect_user', :'expect_user', true),
       set_config('trivo.expect_major', :'expect_major', true);
-- GUARDS. Fail closed: the first failing guard aborts the transaction with "GUARD_FAILED:<name>" and (ON_ERROR_STOP) psql exits non-zero,
-- so nothing is counted and no dump is started.
DO $guard$
DECLARE
  who pg_roles%ROWTYPE;
  bad text;
BEGIN
  IF current_database() <> current_setting('trivo.expect_db') THEN RAISE EXCEPTION 'GUARD_FAILED:database_is_expected'; END IF;
  IF current_user <> current_setting('trivo.expect_user') OR session_user <> current_setting('trivo.expect_user') THEN
    RAISE EXCEPTION 'GUARD_FAILED:role_is_expected'; END IF;
  SELECT * INTO who FROM pg_roles WHERE rolname = current_user;
  IF who.rolsuper THEN RAISE EXCEPTION 'GUARD_FAILED:role_is_not_superuser'; END IF;
  IF NOT who.rolbypassrls THEN RAISE EXCEPTION 'GUARD_FAILED:role_bypasses_rls'; END IF;
  IF (current_setting('server_version_num')::int / 10000) <> current_setting('trivo.expect_major')::int THEN
    RAISE EXCEPTION 'GUARD_FAILED:server_major_version_is_expected'; END IF;
  IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'GUARD_FAILED:transaction_is_read_only'; END IF;
  -- prove it, do not just read the flag: a write must be refused by the server
  BEGIN
    CREATE TEMP TABLE trivo_write_probe(x int);
    RAISE EXCEPTION 'GUARD_FAILED:transaction_rejects_writes';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r') THEN
    RAISE EXCEPTION 'GUARD_FAILED:relation_set_is_not_empty'; END IF;
  -- the manifest only describes schema public: refuse a database whose dump would contain tables it cannot describe
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('public','pg_catalog','information_schema') AND n.nspname !~ '^pg_toast') THEN
    RAISE EXCEPTION 'GUARD_FAILED:no_tables_outside_public'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND (c.relkind = 'p' OR c.relispartition)) THEN
    RAISE EXCEPTION 'GUARD_FAILED:no_partitioned_tables'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT has_table_privilege(current_user, c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'GUARD_FAILED:can_select_every_table'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT has_sequence_privilege(current_user, c.oid, 'SELECT')) THEN
    RAISE EXCEPTION 'GUARD_FAILED:can_select_every_sequence'; END IF;
  -- the role is the read-only backup role: it holds no write privilege anywhere in public
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','S')
                AND (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE')
                     OR has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE'))) THEN
    RAISE EXCEPTION 'GUARD_FAILED:role_has_no_write_privileges'; END IF;
  IF has_schema_privilege(current_user, 'public', 'CREATE') THEN RAISE EXCEPTION 'GUARD_FAILED:role_cannot_create_in_public'; END IF;
END
$guard$;
SELECT pg_export_snapshot() AS snap \gset
\o
\setenv SNAP :snap
\setenv OUTDIR :outdir
-- test hook only (hold=0 in production): widen the window so a concurrent writer can be proven NOT to leak into the snapshot
\o /dev/null
SELECT pg_sleep(:hold);
\o

\pset tuples_only on
\pset format unaligned
\pset fieldsep '\t'
\o :outdir/manifest.tsv
SELECT '#trivo-count-manifest', 'v2';
SELECT '#database', current_database();
SELECT '#server_version', current_setting('server_version');
SELECT '#snapshot_id', :'snap';
SELECT '#pg_snapshot', pg_current_snapshot()::text;
SELECT '#txn_start_utc', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SELECT '#relation_set', 'schema public; relkind r (ordinary tables)';
SELECT '#table_count', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
-- catalog numbers of the same snapshot: the restore must reproduce them EXACTLY (RLS is the tenant boundary)
SELECT '#tenant_isolation_policies', count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation';
SELECT '#forced_rls_tables', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
SELECT '#composite_company_fks', count(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'companyId'
 WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 2;
SELECT format('SELECT %L, count(*) FROM %I.%I', c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname \gexec
SELECT '#end', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
\o

-- pg_dump runs on the SAME snapshot while this transaction is still open. Its exit status is recorded (psql ignores it).
\! timeout 3600 pg_dump -Fc -Z 6 --no-owner --snapshot="$SNAP" -f "$OUTDIR/trivo_snap.dump"; echo $? > /tmp/dump.rc
COMMIT;
