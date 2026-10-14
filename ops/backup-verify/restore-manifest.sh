#!/usr/bin/env bash
# TRIVO restore + verification of a snapshot BUNDLE (produced by run.sh) into a NEW scratch database on a LOCAL PostgreSQL instance.
# Isolated sibling of server/scripts/restore.sh (which is unchanged): same verification steps, but row counts come ONLY from the
# bundle's manifest (same snapshot as the dump), the bundle is verified BEFORE any database exists, and every connection is proven to
# reach the intended local instance.
#
#   restore-manifest.sh --verify-only <bundle-dir>          verify the bundle's files/checksums/manifest/marker/dump; touches NO database
#   restore-manifest.sh <bundle-dir> [scratch-db-name]      verify, then restore + verify into a NEW scratch database
#
# Required environment for the restore form (no secrets are echoed):
#   ADMIN_DATABASE_URL            postgresql://postgres:...@localhost:PORT/postgres         (superuser: CREATE DATABASE, identity check)
#   OWNER_DATABASE_URL            postgresql://trivo_owner:...@localhost:PORT/postgres      (restores + re-applies db-secure.sql)
#   SOURCE_DATABASE_URL           postgresql://trivo_backup:...@localhost:PORT/postgres     (BYPASSRLS credential TEMPLATE only: its database
#                                                                                           name is swapped for the scratch database;
#                                                                                           the source/production database is never contacted)
#   RUNTIME_DATABASE_URL_TEMPLATE postgresql://trivo_runtime:...@localhost:PORT/__DB__      (proves tenant isolation as the real runtime role)
#   RESTORE_EXPECT_PORT           the one TCP port of the intended local instance
#   RESTORE_EXPECT_SYSTEM_IDENTIFIER  that instance's pg_control_system().system_identifier (a tunnel to production cannot match it)
# Optional: OWNER_ROLE (default trivo_owner), PG_BIN (directory with psql/pg_restore), DB_SECURE_SQL, RESTORE_JOBS (ignored: restore is serial).
#
# A failed restore or verification KEEPS the scratch database for investigation. This script never drops or overwrites any database.
# Exit code is non-zero if anything fails.

set -euo pipefail
[ -z "${PG_BIN:-}" ] || PATH="$PG_BIN:$PATH"
# (Windows psql emits CRLF; harmless elsewhere, and it would otherwise poison every comparison below.)
psql() { command psql "$@" | tr -d '\r'; }
strip_prisma() { echo "$1" | sed -E 's/([?&])(schema|connection_limit|pool_timeout|connect_timeout|sslaccept|pgbouncer)=[^&]*&?/\1/g; s/[?&]$//'; }
swap_db() { echo "$1" | sed -E "s#/[^/?]+(\?|\$)#/$2\1#"; }
die() { echo "REFUSING: $*"; exit 1; }
FAIL=0
bad() { echo "  FAIL: $*"; FAIL=1; }
ok()  { echo "  ok:   $*"; }

VERIFY_ONLY=0
if [ "${1:-}" = "--verify-only" ]; then VERIFY_ONLY=1; shift; fi
BUNDLE="${1:?Usage: restore-manifest.sh [--verify-only] <bundle-dir> [scratch-db-name]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/manifest_check.sh"
command -v pg_restore >/dev/null || die "pg_restore not found on PATH (set PG_BIN)"
command -v sha256sum >/dev/null || die "sha256sum not found"

# ---- 1. the bundle, before any database exists --------------------------------------------------------------------------------
echo "== verifying bundle $BUNDLE (no database is contacted in this step)"
verify_bundle "$BUNDLE" || die "bundle verification failed - no database was created"
MANIFEST="$BUNDLE/manifest.tsv"
ok "bundle complete: exactly 4 files, checksums match, manifest valid, marker bound to the manifest (snapshot $(mhdr "$MANIFEST" '#snapshot_id')), dump readable and its table list/database/version equal the manifest"
ok "source: database $(mhdr "$MANIFEST" '#database'), PostgreSQL $(mhdr "$MANIFEST" '#server_version'), $(mhdr "$MANIFEST" '#table_count') tables, snapshot taken $(mhdr "$MANIFEST" '#txn_start_utc')"
if [ "$VERIFY_ONLY" = 1 ]; then echo; echo "BUNDLE VERIFIED (verify-only): no database was contacted."; exit 0; fi

# ---- 2. configuration + proof that every connection is the intended LOCAL instance ---------------------------------------------
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL must point at the local server (a role allowed to CREATE DATABASE)}"
: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL (the owner role) is needed to restore + re-secure}"
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL (the trivo_backup role: credential template for the scratch database) is required}"
: "${RUNTIME_DATABASE_URL_TEMPLATE:?RUNTIME_DATABASE_URL_TEMPLATE (trivo_runtime, with __DB__) is required to prove tenant isolation}"
: "${RESTORE_EXPECT_PORT:?RESTORE_EXPECT_PORT (port of the intended local instance) is required}"
: "${RESTORE_EXPECT_SYSTEM_IDENTIFIER:?RESTORE_EXPECT_SYSTEM_IDENTIFIER (system_identifier of the intended local instance) is required}"
[[ "$RESTORE_EXPECT_PORT" =~ ^[0-9]+$ ]] || die "RESTORE_EXPECT_PORT is not a number"
OWNER_ROLE="${OWNER_ROLE:-trivo_owner}"; [[ "$OWNER_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || die "OWNER_ROLE is not a plain identifier"

check_local_url() { # check_local_url URL LABEL : loopback host, the expected port, no host/port/service overrides in the query
  local u="$1" label="$2"
  [[ "$u" =~ ^postgres(ql)?://([^@/]*@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:([0-9]+))?(/[^?]*)?(\?.*)?$ ]] || die "$label is not a recognisable postgresql:// URL"
  local host="${BASH_REMATCH[3]}" port="${BASH_REMATCH[5]:-5432}" query="${BASH_REMATCH[7]:-}"
  case "$host" in localhost|127.0.0.1|'[::1]') ;; *) die "$label points at host '$host', not the local machine";; esac
  [ "$port" = "$RESTORE_EXPECT_PORT" ] || die "$label uses port $port, expected $RESTORE_EXPECT_PORT"
  if [[ "$query" =~ (^\?|\&)(host|hostaddr|port|service|dbname|user)= ]]; then die "$label overrides host/port/service in its query string"; fi
}
ADMIN="$(strip_prisma "$ADMIN_DATABASE_URL")"
check_local_url "$ADMIN" ADMIN_DATABASE_URL
check_local_url "$(strip_prisma "$OWNER_DATABASE_URL")" OWNER_DATABASE_URL
check_local_url "$(strip_prisma "$SOURCE_DATABASE_URL")" SOURCE_DATABASE_URL
check_local_url "$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/placeholder}")" RUNTIME_DATABASE_URL_TEMPLATE

# Explicit identity of one connection: who it is, which database, which TCP port, which instance, and its privilege flags. Every field is
# compared; an unreadable or incomplete answer is a refusal (never "assume it is fine").
#   assert_identity URL LABEL EXPECT_ROLE EXPECT_DB SUPERUSER(t|f|any) BYPASSRLS(t|f|any)
assert_identity() {
  local url="$1" label="$2" role="$3" db="$4" su="$5" byp="$6" row r d port sid rsu rbyp extra
  row="$(command psql "$url" -Atq -v ON_ERROR_STOP=1 -c "select current_user||'|'||current_database()||'|'||coalesce(inet_server_port()::text,'')||'|'||(select system_identifier::text from pg_control_system())||'|'||(case when r.rolsuper then 't' else 'f' end)||'|'||(case when r.rolbypassrls then 't' else 'f' end) from pg_roles r where r.rolname=current_user" 2>/dev/null | tr -d '\r')" || die "$label: cannot read the connection's identity"
  IFS='|' read -r r d port sid rsu rbyp extra <<< "$row"
  [ -n "$r" ] && [ -n "$d" ] && [ -n "$port" ] && [ -n "$sid" ] && [ -n "$rsu" ] && [ -n "$rbyp" ] && [ -z "$extra" ] || die "$label: incomplete identity answer"
  [ "$r" = "$role" ] || die "$label connects as role '$r', expected '$role'"
  [ "$d" = "$db" ] || die "$label reaches database '$d', expected '$db'"
  [ "$port" = "$RESTORE_EXPECT_PORT" ] || die "$label is served on TCP port $port, expected $RESTORE_EXPECT_PORT"
  [ "$sid" = "$RESTORE_EXPECT_SYSTEM_IDENTIFIER" ] || die "$label reaches an instance with a different system_identifier - not the intended local instance"
  [ "$su" = any ] || [ "$rsu" = "${su}" ] || die "$label: role superuser flag is '$rsu', expected '$su'"
  [ "$byp" = any ] || [ "$rbyp" = "${byp}" ] || die "$label: role bypassrls flag is '$rbyp', expected '$byp'"
}
assert_identity "$ADMIN" "ADMIN_DATABASE_URL" postgres postgres t any
ok "admin connection is the intended local instance (role postgres, superuser, port $RESTORE_EXPECT_PORT, system_identifier matches), server $(psql "$ADMIN" -Atq -c 'show server_version')"

# The other three credentials are proven BEFORE anything is created: each must authenticate as exactly the role it is meant to be, on the
# intended instance, with the privilege flags the verification relies on. A wrong or swapped URL is a refusal with no database made.
assert_identity "$(strip_prisma "$OWNER_DATABASE_URL")" "OWNER_DATABASE_URL" "$OWNER_ROLE" postgres f any
assert_identity "$(strip_prisma "$SOURCE_DATABASE_URL")" "SOURCE_DATABASE_URL" trivo_backup postgres f t
assert_identity "$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/postgres}")" "RUNTIME_DATABASE_URL_TEMPLATE" trivo_runtime postgres f f
ok "owner ($OWNER_ROLE), source/verification (trivo_backup, BYPASSRLS) and runtime (trivo_runtime, no BYPASSRLS) credentials each authenticate as the intended role on the intended instance"

SCRATCH="${2:-trivo_prodverify_$(date -u +%Y%m%dt%H%M%Sz | tr 'A-Z' 'a-z')}"
[[ "$SCRATCH" =~ ^trivo_[a-z0-9_]*(verify|restore|scratch|test)[a-z0-9_]*$ ]] && [ "${#SCRATCH}" -le 63 ] || die "scratch database name '$SCRATCH' must match trivo_*(verify|restore|scratch|test)* (never a live database name)"
[ "$(psql "$ADMIN" -Atq -c "select count(*) from pg_database where datname='$SCRATCH'")" = 0 ] || die "database $SCRATCH already exists (this script never overwrites or drops a database)"

OWNER_SCRATCH="$(swap_db "$(strip_prisma "$OWNER_DATABASE_URL")" "$SCRATCH")"
VERIFY="$(swap_db "$(strip_prisma "$SOURCE_DATABASE_URL")" "$SCRATCH")"
RT="$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/$SCRATCH}")"
DB_SECURE_SQL="${DB_SECURE_SQL:-$HERE/../../server/prisma/db-secure.sql}"
[ -f "$DB_SECURE_SQL" ] || die "db-secure.sql not found at $DB_SECURE_SQL"
q() { psql "$VERIFY" -Atq -c "$1"; }

CREATED=0
on_exit() { local rc=$?; [ -z "${WORKT:-}" ] || rm -rf "$WORKT"; if [ "$rc" != 0 ] && [ "$CREATED" = 1 ]; then echo; echo "FAILED (exit $rc): scratch database $SCRATCH was KEPT for investigation (this script never drops databases)"; fi; }
trap on_exit EXIT

# ---- 3. create the scratch database and prove every connection reaches THAT database on THAT instance -------------------------
TOKEN="trivo-restore-token-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
echo "== creating scratch database $SCRATCH (owner $OWNER_ROLE)"
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$SCRATCH\" OWNER $OWNER_ROLE ENCODING 'UTF8' TEMPLATE template0"
CREATED=1
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "COMMENT ON DATABASE \"$SCRATCH\" IS '$TOKEN'"
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO trivo_backup" >/dev/null
check_token() { local got; got="$(psql "$1" -Atq -c "select shobj_description(d.oid,'pg_database') from pg_database d where d.datname=current_database()")" || die "cannot connect ($2)"; [ "$got" = "$TOKEN" ] || die "$2 does not reach the scratch database just created on the intended instance"; }
check_token "$OWNER_SCRATCH" "owner connection"; check_token "$VERIFY" "verification (backup role) connection"; check_token "$RT" "runtime connection"
# and say exactly WHO each one is: owner = the configured owner (not a superuser); verification = trivo_backup (BYPASSRLS, not superuser: it must see
# every row under FORCE RLS); runtime = trivo_runtime (neither superuser nor BYPASSRLS, otherwise the isolation proof below would prove nothing)
assert_identity "$OWNER_SCRATCH" "owner connection" "$OWNER_ROLE" "$SCRATCH" f any
assert_identity "$VERIFY" "verification connection" trivo_backup "$SCRATCH" f t
assert_identity "$RT" "runtime connection" trivo_runtime "$SCRATCH" f f
ok "owner ($OWNER_ROLE), verification (trivo_backup, BYPASSRLS) and runtime (trivo_runtime, no BYPASSRLS, not superuser) connections each reach the scratch database on the intended instance (port, system_identifier, role and privilege flags checked)"

# ---- 4. restore ----------------------------------------------------------------------------------------------------------------
echo "== restoring $BUNDLE/trivo_snap.dump with $(pg_restore --version)"
# Run as the owner: objects become owned by it. Grants are NOT taken from the dump (--no-privileges); db-secure.sql re-establishes
# them below. SERIAL and --exit-on-error, both deliberate: tables are FORCE-RLS, and FK validation queries are themselves filtered
# by RLS. In a serial restore pg_dump's ordering enables RLS only after data + foreign keys are in place; a parallel restore does
# not guarantee that. A restore that "ignored some errors" is NOT a restore.
# (cd + relative name: a native Windows pg_restore cannot open an MSYS-style /c/... path)
( cd "$BUNDLE" && pg_restore -d "$OWNER_SCRATCH" --no-owner --no-privileges --exit-on-error -j 1 trivo_snap.dump )
echo "== re-applying db-secure.sql (grants + FORCE RLS), sha256 $(sha256sum "$DB_SECURE_SQL" | cut -c1-16)…"
psql "$OWNER_SCRATCH" -v ON_ERROR_STOP=1 -q -f - < "$DB_SECURE_SQL"

# ---- 5. verification (reads as the BACKUP role: under FORCE ROW LEVEL SECURITY an owner session with no tenant correctly sees 0 rows)
echo "== verification"
# 5.1 row counts vs the snapshot manifest (strict: same table set, same count in every table). No live-source fallback exists.
compare_manifest "$MANIFEST" "$VERIFY" || FAIL=1
# 5.2 RLS + policies + composite FKs: must reproduce the SOURCE snapshot's catalog numbers exactly
eq() { # eq LABEL RESTORED EXPECTED
  if [ "$2" = "$3" ]; then ok "$1: $2 (identical to the source snapshot)"; else bad "$1: restored=$2 but the source snapshot had $3"; fi
}
eq "tenant_isolation policies" "$(q "select count(*) from pg_policies where schemaname='public' and policyname='tenant_isolation'")" "$(mhdr "$MANIFEST" '#tenant_isolation_policies')"
eq "tables with RLS enabled AND forced" "$(q "select count(*) from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where k.relkind='r' and k.relrowsecurity and k.relforcerowsecurity")" "$(mhdr "$MANIFEST" '#forced_rls_tables')"
eq "composite (id, companyId) foreign keys" "$(q "select count(*) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='companyId' where c.contype='f' and array_length(c.conkey,1)=2")" "$(mhdr "$MANIFEST" '#composite_company_fks')"
# 5.2b per-table RLS flags and every policy's full definition vs what the DUMP itself declares (counts alone would miss a swapped flag or a
# policy whose USING / WITH CHECK was weakened). Source of truth = `pg_restore -s` of the bundle's dump (schema only, no row data).
WORKT="$(mktemp -d)"      # this run's own temp directory (schema text only, no row data); on_exit removes exactly it
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
if ( cd "$BUNDLE" && pg_restore -s --no-owner --no-privileges -f "$(winpath "$WORKT/schema.sql")" trivo_snap.dump ) 2>"$WORKT/pgr.err" && [ -s "$WORKT/schema.sql" ]; then
  dump_rls_flags "$WORKT/schema.sql" > "$WORKT/rls.dump"; restored_rls_flags "$VERIFY" > "$WORKT/rls.restored"
  dump_policy_defs "$WORKT/schema.sql" > "$WORKT/pol.dump"; restored_policy_defs "$VERIFY" > "$WORKT/pol.restored"
  NPOL_TOC="$( (cd "$BUNDLE" && pg_restore -l trivo_snap.dump) | tr -d '\r' | grep -cE '^[0-9]+; [0-9]+ [0-9]+ POLICY ' || true)"
  if [ "$NPOL_TOC" = 0 ] || [ "$(wc -l < "$WORKT/pol.dump" | tr -d ' ')" != "$NPOL_TOC" ]; then bad "could not read the policy definitions from the dump reliably (parsed $(wc -l < "$WORKT/pol.dump" | tr -d ' '), the dump lists $NPOL_TOC POLICY entries)"
  else
    if diff "$WORKT/rls.dump" "$WORKT/rls.restored" >"$WORKT/rls.diff"; then ok "per-table RLS enabled/forced flags: the restored database matches the dump table by table ($(wc -l < "$WORKT/rls.dump" | tr -d ' ') tables)"
    else bad "per-table RLS flags differ between the dump and the restored database (< dump, > restored): $(head -6 "$WORKT/rls.diff" | tr '\n' ';')"; fi
    if diff "$WORKT/pol.dump" "$WORKT/pol.restored" >"$WORKT/pol.diff"; then ok "all $NPOL_TOC policy definitions (name, table, command, roles, USING, WITH CHECK) match the dump exactly"
    else bad "policy definitions differ between the dump and the restored database ($(grep -c '^<' "$WORKT/pol.diff") only in the dump, $(grep -c '^>' "$WORKT/pol.diff") only restored): $(head -4 "$WORKT/pol.diff" | cut -c1-160 | tr '\n' ';')"; fi
  fi
else bad "could not read the schema out of the dump with pg_restore -s ($(head -c 200 "$WORKT/pgr.err" | tr '\n' ' '))"; fi
NORLS="$(q "select count(*) from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where k.relkind='r' and exists (select 1 from pg_policy p where p.polrelid=k.oid) and not (k.relrowsecurity and k.relforcerowsecurity)")"
[ "$NORLS" = 0 ] && ok "every policy-protected table has RLS enabled AND forced" || bad "$NORLS tables lost RLS/FORCE"
# 5.3 accounting + reference integrity
UNBAL="$(q "select count(*) from (select e.id from journal_entries e join journal_lines l on l.\"entryId\"=e.id group by e.id having abs(sum(l.debit)-sum(l.credit))>0.01) x")"
[ "$UNBAL" = 0 ] && ok "every journal entry balances" || bad "$UNBAL unbalanced journal entries"
XOUT="$(command psql "$VERIFY" -Atq -v ON_ERROR_STOP=1 2>&1 <<'SQL' | tr -d '\r'
DO $$
DECLARE r record; n bigint; checked int := 0; viol bigint := 0;
BEGIN
  FOR r IN
    SELECT c.conname, ct.relname AS child, pt.relname AS parent, ca.attname AS ccol, pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_class ct ON ct.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ct.relnamespace AND cn.nspname = 'public'
      JOIN pg_class pt ON pt.oid = c.confrelid
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid  AND x.attname = 'companyId' AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.confrelid AND x.attname = 'companyId' AND NOT x.attisdropped)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I c JOIN public.%I p ON p.%I = c.%I WHERE c."companyId" <> p."companyId"', r.child, r.parent, r.pcol, r.ccol) INTO n;
    checked := checked + 1; viol := viol + n;
    IF n > 0 THEN RAISE NOTICE 'VIOLATION % -> % (%): % rows', r.child, r.parent, r.conname, n; END IF;
  END LOOP;
  RAISE NOTICE 'XREF_RESULT checked=% violations=%', checked, viol;
END $$;
SQL
)" || { bad "cross-company reference scan failed to run"; XOUT=""; }
XEXPECT="$(q "select count(*) from pg_constraint c join pg_class ct on ct.oid=c.conrelid join pg_namespace cn on cn.oid=ct.relnamespace and cn.nspname='public' where c.contype='f' and array_length(c.conkey,1)=1 and exists (select 1 from pg_attribute x where x.attrelid=c.conrelid and x.attname='companyId' and not x.attisdropped) and exists (select 1 from pg_attribute x where x.attrelid=c.confrelid and x.attname='companyId' and not x.attisdropped)")"
XCHK=""; XVIO=""
if ! XWHY="$(parse_xref_result "$XOUT")"; then bad "cross-company reference scan output is not a clean result: $XWHY"
else
  parse_xref_result "$XOUT" >/dev/null   # (re-run in this shell to set XCHK / XVIO; the call above ran in a subshell)
  if [ "$XVIO" != 0 ]; then bad "cross-company references: $XVIO violating rows ($(echo "$XOUT" | grep VIOLATION | tr '\n' ';'))"
  elif [ "$XCHK" != "$XEXPECT" ] || [ "$XEXPECT" = 0 ]; then bad "cross-company scan covered $XCHK foreign keys but $XEXPECT exist (the scan must cover every one)"
  else ok "no plain foreign key anywhere points at another company's row (all $XCHK company-scoped foreign keys scanned, equal to the independent catalog count)"; fi
fi
# 5.4 isolation survives: the REAL runtime role, EVERY table carrying a companyId column (whether or not RLS is still on: a table that lost it must FAIL here), no context / unknown company / each real company
TABLES="$(q "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' join pg_attribute a on a.attrelid=c.oid and a.attname='companyId' and not a.attisdropped where c.relkind='r' order by 1")"
COMPANIES="$(q "select id from companies order by \"createdAt\"")"
[ -n "$COMPANIES" ] || bad "the restored database has no companies"
NCO=$(echo "$COMPANIES" | grep -c . || true)
UNKNOWN_CO="trivo-no-such-company"
checked=0; skipped=""; vacuous=0; tbad=0
for t in $TABLES; do
  declare -A own=(); while IFS='|' read -r cid cnt; do [ -n "$cid" ] && own["$cid"]="$cnt"; done < <(q "select \"companyId\"||'|'||count(*) from \"$t\" group by \"companyId\"")
  total="$(q "select count(*) from \"$t\"")"
  script="begin;
select 'NOCTX|'||count(*) from \"$t\";
select set_config('app.tenant_company_id','$UNKNOWN_CO',true) is null;
select 'UNKNOWN|'||count(*) from \"$t\";"
  for cid in $COMPANIES; do script="$script
select set_config('app.tenant_company_id','$cid',true) is null;
select 'CO|$cid|'||count(*)||'|'||count(*) filter (where \"companyId\"='$cid') from \"$t\";"; done
  script="$script
rollback;"
  out="$(printf '%s\n' "$script" | command psql "$RT" -Atq 2>&1 | tr -d '\r' || true)"
  if echo "$out" | grep -qi 'permission denied'; then bad "runtime role has no access to company-scoped table $t: its isolation CANNOT be proven (a required check is never skipped)"; tbad=1; continue; fi
  checked=$((checked+1)); [ "$total" -gt 0 ] || vacuous=$((vacuous+1))
  [ "$(echo "$out" | grep '^NOCTX|' | cut -d'|' -f2)" = 0 ] || { bad "runtime role with NO company context saw rows in $t"; tbad=1; }
  [ "$(echo "$out" | grep '^UNKNOWN|' | cut -d'|' -f2)" = 0 ] || { bad "runtime role in an UNKNOWN company context saw rows in $t"; tbad=1; }
  for cid in $COMPANIES; do
    line="$(echo "$out" | grep "^CO|$cid|" || true)"; seen="$(echo "$line" | cut -d'|' -f3)"; mine="$(echo "$line" | cut -d'|' -f4)"; want="${own[$cid]:-0}"
    if [ -z "$line" ] || [ "$seen" != "$mine" ] || [ "$mine" != "$want" ]; then bad "company ${cid:0:8}… in $t: runtime role saw '${seen:-?}' rows, ${mine:-?} of them its own, expected $want/$want"; tbad=1; fi
  done
  unset own
done
NTABLES="$(echo "$TABLES" | grep -c . || true)"; NFORCED="$(mhdr "$MANIFEST" '#forced_rls_tables')"
if [ "$checked" != "$NTABLES" ] || [ "$NTABLES" = 0 ]; then bad "only $checked of $NTABLES company-scoped tables were tested through the runtime role (every one is required)"
elif [ "$NTABLES" -lt "$NFORCED" ]; then bad "the snapshot had $NFORCED forced-RLS tables but only $NTABLES tables carry a companyId column here"
elif [ "$tbad" = 0 ]; then ok "runtime role: no rows with no context or an unknown company, and exactly each company's own rows in each of $NCO company context(s), on all $checked company-scoped RLS tables ($vacuous empty, so tested only for 'sees nothing')"; fi
[ "$((checked - vacuous))" -ge 5 ] || bad "only $((checked - vacuous)) company-scoped tables hold rows, so the isolation proof is mostly vacuous"

echo
if [ "$FAIL" = 0 ]; then echo "RESTORE VERIFIED into $SCRATCH (kept; nothing was dropped). When finished, YOU may drop it:  psql \"\$ADMIN_DATABASE_URL\" -c 'DROP DATABASE \"$SCRATCH\"'"; else echo "RESTORE VERIFICATION FAILED (scratch DB $SCRATCH kept for inspection)"; exit 1; fi
