#!/usr/bin/env bash
# Restore-side tests that use the local PG18 staging cluster (localhost:54329, the machine the real restore will run on).
# Creates NEW scratch databases only (names trivo_prodverify_*); drops nothing.
#   BUNDLE=<good bundle dir> TRIVO_TEST_LOGS=<dir> TAG=<unique suffix> bash tests/t3_restore.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export TARGET=pg18; . "$HERE/env.sh"
: "${BUNDLE:?}" "${TRIVO_TEST_LOGS:?}" "${TAG:?unique suffix for scratch db names, e.g. 20261013a}"
W="$TRIVO_TEST_LOGS/t3_$TAG"; mkdir -p "$W"
RM="$HERE/../restore-manifest.sh"
TAB=$'\t'
dbexists() { [ "$(sup -c "select count(*) from pg_database where datname='$1'")" = 1 ]; }
dbcount() { sup -c "select count(*) from pg_database"; }

echo "################ H. REFUSALS (no database may be created or touched)"
N0=$(dbcount)
r() { # r NAME WANT_TEXT [ENV=VAL...] -- ARGS...   : runs restore-manifest.sh, must fail with WANT_TEXT, DB count unchanged
  local n="$1" want="$2"; shift 2; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local out rc; out=$(env "${envs[@]}" bash "$RM" "$@" 2>&1); rc=$?
  check "$n" "rc!=0; '$want'; database count unchanged ($N0)" "rc=$rc; $(echo "$out" | grep -E 'REFUSING|FAIL' | head -1 | cut -c1-140); dbs=$(dbcount)" $([ $rc != 0 ] && echo "$out" | grep -qF -- "$want" && [ "$(dbcount)" = "$N0" ]; echo $?)
}
r H1 "RESTORE_EXPECT_SYSTEM_IDENTIFIER" RESTORE_EXPECT_SYSTEM_IDENTIFIER= -- "$BUNDLE" trivo_prodverify_h1_$TAG
r H2 "not the local machine" ADMIN_DATABASE_URL="postgresql://postgres:x@db.example.com:$T_PORT/postgres" -- "$BUNDLE" trivo_prodverify_h2_$TAG
r H3 "uses port 5432, expected $T_PORT" OWNER_DATABASE_URL="postgresql://trivo_owner:x@localhost/postgres" -- "$BUNDLE" trivo_prodverify_h3_$TAG
r H4 "overrides host/port/service" SOURCE_DATABASE_URL="postgresql://trivo_backup:x@localhost:$T_PORT/postgres?host=203.0.113.9" -- "$BUNDLE" trivo_prodverify_h4_$TAG
r H5 "not the local machine" RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:x@10.0.0.5:$T_PORT/__DB__" -- "$BUNDLE" trivo_prodverify_h5_$TAG
r H6 "different system_identifier" RESTORE_EXPECT_SYSTEM_IDENTIFIER=1234567890123456789 -- "$BUNDLE" trivo_prodverify_h6_$TAG
r H7 "must match trivo_*(verify|restore|scratch|test)*" -- "$BUNDLE" trivo_prod
r H8 "must match" -- "$BUNDLE" postgres
r H9 "must match" -- "$BUNDLE" 'trivo_prodverify_x; drop database postgres'
r H10 "already exists" -- "$BUNDLE" trivo_prodverify_smoke18_b
# the PG16 test server is a DIFFERENT instance (right port, right password, but not the instance whose system_identifier is expected): refused
pw16() { cat "${TRIVO_TEST_SECRETS:?}/$1.pw" | tr -d '\r\n'; }
# (the container publishes 54316 but the server itself reports its internal port 5432: refused at the explicit port check, before the system_identifier one)
r H11 "ADMIN_DATABASE_URL is served on TCP port 5432, expected 54316" RESTORE_EXPECT_PORT=54316 PGSSLMODE=prefer \
  ADMIN_DATABASE_URL="postgresql://postgres:$(pw16 super)@127.0.0.1:54316/postgres" OWNER_DATABASE_URL="postgresql://trivo_owner:$(pw16 owner)@127.0.0.1:54316/postgres" \
  SOURCE_DATABASE_URL="postgresql://trivo_backup:$(pw16 backup)@127.0.0.1:54316/postgres" RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:$(pw16 runtime)@127.0.0.1:54316/__DB__" \
  -- "$BUNDLE" trivo_prodverify_h11_$TAG
r H12 "Usage" --
# explicit connection identity (hardening pass): a swapped / wrong-role credential is refused BEFORE any database is created
r H15 "connects as role 'trivo_runtime', expected 'trivo_backup'" SOURCE_DATABASE_URL="postgresql://trivo_runtime:${RUN_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}" -- "$BUNDLE" trivo_prodverify_h15_$TAG
r H16 "connects as role 'trivo_backup', expected 'trivo_runtime'" RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_backup:${BK_PW}@${T_HOST}:${T_PORT}/__DB__${T_SSL}" -- "$BUNDLE" trivo_prodverify_h16_$TAG
r H17 "connects as role 'trivo_runtime', expected 'trivo_owner'" OWNER_DATABASE_URL="postgresql://trivo_runtime:${RUN_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}" -- "$BUNDLE" trivo_prodverify_h17_$TAG
r H18 "connects as role 'trivo_owner', expected 'postgres'" ADMIN_DATABASE_URL="postgresql://trivo_owner:${OWNER_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}" -- "$BUNDLE" trivo_prodverify_h18_$TAG
# an existing database is never overwritten: its identity is unchanged after the refused attempt
OID1=$(sup -c "select oid from pg_database where datname='trivo_prodverify_smoke18_b'"); SZ1=$(sup -c "select pg_database_size('trivo_prodverify_smoke18_b')")
bash "$RM" "$BUNDLE" trivo_prodverify_smoke18_b >/dev/null 2>&1
check "H13 an existing database is untouched by a refused restore attempt" "same oid and size" "oid $OID1->$(sup -c "select oid from pg_database where datname='trivo_prodverify_smoke18_b'") size $SZ1->$(sup -c "select pg_database_size('trivo_prodverify_smoke18_b')")" $([ "$OID1" = "$(sup -c "select oid from pg_database where datname='trivo_prodverify_smoke18_b'")" ] && [ "$SZ1" = "$(sup -c "select pg_database_size('trivo_prodverify_smoke18_b')")" ]; echo $?)
DROPS="$(grep -nEi 'drop database|truncate |delete from' "$RM" "$HERE/../manifest_check.sh" | grep -v 'YOU may drop' | wc -l)"
check "H14 the restore scripts contain no executed DROP DATABASE / TRUNCATE / DELETE statement" "0 (only the operator hint text)" "$DROPS matches" $([ "$DROPS" = 0 ]; echo $?)

if [ -n "${ONLY_H:-}" ]; then summary; echo "work dir: $W (ONLY_H: restore sections skipped)"; exit; fi
echo "################ R. FULL RESTORE of the good bundle into a NEW scratch database"
S1="trivo_prodverify_r1_$TAG"
bash "$RM" "$BUNDLE" "$S1" > "$W/r1.log" 2>&1; rc=$?
sed 's/^/        /' "$W/r1.log" | tail -14
check "R1 restore + all verifications pass" "rc=0; RESTORE VERIFIED; scratch database exists (kept)" "rc=$rc; exists=$(dbexists $S1 && echo yes || echo no)" $([ $rc = 0 ] && grep -q 'RESTORE VERIFIED' "$W/r1.log" && dbexists "$S1"; echo $?)
for want in "per-table RLS enabled/forced flags: the restored database matches the dump table by table" "policy definitions (name, table, command, roles, USING, WITH CHECK) match the dump exactly" "company-scoped foreign keys scanned, equal to the independent catalog count" "credentials each authenticate as the intended role" "(trivo_backup, BYPASSRLS) and runtime (trivo_runtime, no BYPASSRLS, not superuser) connections each reach the scratch database"; do
  check "R1a the verification reports: $want" "ok line present" "$(grep -c -F -- "$want" "$W/r1.log") match(es)" $(grep -qF -- "$want" "$W/r1.log"; echo $?)
done
check "R1b every verification line is an ok line (no FAIL)" "0 FAIL lines" "$(grep -c '  FAIL:' "$W/r1.log") FAIL lines, $(grep -c '  ok:' "$W/r1.log") ok lines" $([ "$(grep -c '  FAIL:' "$W/r1.log")" = 0 ]; echo $?)
check "R1c restored snap_probe equals the SNAPSHOT (3 rows) not the live table" "3" "$(PGPASSWORD=$BK_PW command psql -h $T_HOST -p $T_PORT -U trivo_backup -d $S1 -Atqc 'select count(*) from snap_probe' | tr -d '\r')" $([ "$(PGPASSWORD=$BK_PW command psql -h $T_HOST -p $T_PORT -U trivo_backup -d $S1 -Atqc 'select count(*) from snap_probe' | tr -d '\r')" = 3 ]; echo $?)

echo "################ S. A restore whose verification MUST FAIL: forged-consistent manifest + a tampered restored database"
# (a) a bundle forged so that EVERYTHING in it is self-consistent (manifest count +1, marker hashes and checksums regenerated)
F="$W/forged"; rm -rf "$F"; cp -a "$BUNDLE" "$F"
sed -i "0,/^accounts${TAB}/s/^accounts${TAB}.*/accounts${TAB}$(( $(awk -F'\t' '$1=="accounts"{print $2}' "$BUNDLE/manifest.tsv") + 1 ))/" "$F/manifest.tsv"
ms=$(sha256sum "$F/manifest.tsv" | cut -d' ' -f1); sed -i "s/^manifest_sha256${TAB}.*/manifest_sha256${TAB}$ms/" "$F/SNAPSHOT_OK"
( cd "$F" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS )
out=$(bash "$RM" --verify-only "$F" 2>&1); rc=$?
check "S0 the forged-consistent bundle passes the file-level checks (as designed: only the database comparison can catch it)" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)
# (b) tamper with the restored database through db-secure.sql (the one SQL file the restore runs as the owner): remove a policy, unbalance a
#     journal, point a plain FK at another company's row, delete rows
TS="$W/db-secure-tampered.sql"; cp "$HERE/../../../server/prisma/db-secure.sql" "$TS"
cat >> "$TS" <<'SQL'
-- ===== TEST TAMPER (appended after the real db-secure.sql) =====
ALTER TABLE clients NO FORCE ROW LEVEL SECURITY; ALTER TABLE clients DISABLE ROW LEVEL SECURITY; DROP POLICY tenant_isolation ON clients;
ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY;
UPDATE journal_lines SET debit = debit + 5 WHERE id = (SELECT id FROM journal_lines ORDER BY id LIMIT 1);
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE snap_probe NO FORCE ROW LEVEL SECURITY;
DELETE FROM snap_probe WHERE note = 'before-3';
DO $$
DECLARE r record; n bigint; done boolean := false;
BEGIN
  FOR r IN
    SELECT ct.relname AS child, pt.relname AS parent, ca.attname AS ccol, pa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_class ct ON ct.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ct.relnamespace AND cn.nspname = 'public'
      JOIN pg_class pt ON pt.oid = c.confrelid
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND ct.relname <> pt.relname
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid  AND x.attname = 'companyId' AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.confrelid AND x.attname = 'companyId' AND NOT x.attisdropped)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', r.child);
      EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', r.parent);
      EXECUTE format('UPDATE public.%1$I c SET %2$I = (SELECT p.%3$I FROM public.%4$I p WHERE p."companyId" <> c."companyId" LIMIT 1) WHERE c.ctid = (SELECT c2.ctid FROM public.%1$I c2 WHERE c2.%2$I IS NOT NULL AND EXISTS (SELECT 1 FROM public.%4$I p2 WHERE p2."companyId" <> c2."companyId") LIMIT 1)', r.child, r.ccol, r.pcol, r.parent);
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.child);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.parent);
      IF n > 0 THEN done := true; RAISE NOTICE 'TAMPER cross-company ref set on %.%', r.child, r.ccol; EXIT; END IF;
    EXCEPTION WHEN others THEN RAISE NOTICE 'candidate %.% skipped: %', r.child, r.ccol, SQLERRM;
    END;
  END LOOP;
  IF NOT done THEN RAISE EXCEPTION 'no cross-company tamper candidate found'; END IF;
END $$;
SQL
S2="trivo_prodverify_s1_$TAG"
DB_SECURE_SQL="$TS" bash "$RM" "$F" "$S2" > "$W/s1.log" 2>&1; rc=$?
sed 's/^/        /' "$W/s1.log" | grep -E 'FAIL|ok:|VERIF|KEPT|TAMPER|NOTICE' | cut -c1-210 | head -30
check "S1 verification FAILS (rc=1) and the scratch database is KEPT" "rc=1; 'scratch DB ... kept'; database exists" "rc=$rc; exists=$(dbexists $S2 && echo yes || echo no)" $([ $rc = 1 ] && grep -q 'kept for inspection' "$W/s1.log" && dbexists "$S2"; echo $?)
chk() { grep -q -- "$2" "$W/s1.log"; check "$1" "FAIL line containing '$2'" "$(grep -c -- "$2" "$W/s1.log") match(es)" $?; }
chk "S2 forged manifest count is caught against the restored data" "row count differs in accounts"
chk "S3 the dropped tenant policy is caught (policy count)" "tenant_isolation policies: restored=133 but the source snapshot had 134"
chk "S4 the lost RLS-forced table is caught" "tables with RLS enabled AND forced: restored="
chk "S5 the unbalanced journal is caught" "unbalanced journal entries"
chk "S6 the cross-company reference is caught" "cross-company references"
chk "S7 tenant escape is caught through the REAL runtime role (clients visible with no company context)" "runtime role with NO company context saw rows in clients"
chk "S8 a deleted row is caught by the count comparison" "row count differs in snap_probe"
echo "################ T. Hardening: count-neutral RLS / policy tampering and a missing runtime grant MUST fail"
# (c) counts stay identical: one table gains RLS+FORCE while another loses FORCE (forced-table count unchanged) and one policy is weakened in place
#     (policy count unchanged). Only the per-table / per-definition comparison can see this.
TS2="$W/db-secure-tampered-b.sql"; cp "$HERE/../../../server/prisma/db-secure.sql" "$TS2"
cat >> "$TS2" <<'SQL'
-- ===== TEST TAMPER B (count-neutral) =====
ALTER TABLE _prisma_migrations ENABLE ROW LEVEL SECURITY; ALTER TABLE _prisma_migrations FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_history NO FORCE ROW LEVEL SECURITY;
ALTER POLICY tenant_isolation ON accounts USING (true);
SQL
S3="trivo_prodverify_t1_$TAG"
DB_SECURE_SQL="$TS2" bash "$RM" "$BUNDLE" "$S3" > "$W/t1.log" 2>&1; rc=$?
sed 's/^/        /' "$W/t1.log" | grep -E 'FAIL|VERIF|KEPT|forced' | cut -c1-230 | head -12
check "T1 verification FAILS (rc=1) and the scratch database is KEPT" "rc=1; kept; exists" "rc=$rc; exists=$(dbexists $S3 && echo yes || echo no)" $([ $rc = 1 ] && grep -q 'kept for inspection' "$W/t1.log" && dbexists "$S3"; echo $?)
check "T2 the forced-table COUNT check alone is satisfied (this tamper is count-neutral)" "an ok line for 'tables with RLS enabled AND forced'" "$(grep -c 'ok:   tables with RLS enabled AND forced' "$W/t1.log") ok line(s)" $(grep -q 'ok:   tables with RLS enabled AND forced' "$W/t1.log"; echo $?)
check "T3 the policy COUNT check alone is satisfied" "an ok line for 'tenant_isolation policies'" "$(grep -c 'ok:   tenant_isolation policies' "$W/t1.log") ok line(s)" $(grep -q 'ok:   tenant_isolation policies' "$W/t1.log"; echo $?)
check "T4 the per-table RLS flag comparison catches the swapped flags" "FAIL per-table RLS flags differ" "$(grep -c 'FAIL: per-table RLS flags differ' "$W/t1.log") match(es)" $(grep -q 'FAIL: per-table RLS flags differ' "$W/t1.log"; echo $?)
check "T5 the policy-definition comparison catches the weakened USING" "FAIL policy definitions differ" "$(grep -c 'FAIL: policy definitions differ' "$W/t1.log") match(es)" $(grep -q 'FAIL: policy definitions differ' "$W/t1.log"; echo $?)
# (d) the runtime role loses SELECT on a company-scoped table: the isolation of that table cannot be proven -> FAIL, never "skipped"
TS3="$W/db-secure-tampered-c.sql"; cp "$HERE/../../../server/prisma/db-secure.sql" "$TS3"
{ echo '-- ===== TEST TAMPER C ====='; echo 'REVOKE SELECT ON accounts FROM trivo_runtime;'; } >> "$TS3"
S4="trivo_prodverify_t2_$TAG"
DB_SECURE_SQL="$TS3" bash "$RM" "$BUNDLE" "$S4" > "$W/t2.log" 2>&1; rc=$?
sed 's/^/        /' "$W/t2.log" | grep -E 'FAIL|VERIF|KEPT|note' | cut -c1-230 | head -8
check "T6 verification FAILS (rc=1), scratch DB kept" "rc=1; kept" "rc=$rc; exists=$(dbexists $S4 && echo yes || echo no)" $([ $rc = 1 ] && dbexists "$S4"; echo $?)
check "T7 a company-scoped table the runtime role cannot read is a FAILURE, not a note" "FAIL ... accounts: its isolation CANNOT be proven" "$(grep -c 'FAIL: runtime role has no access to company-scoped table accounts' "$W/t2.log") match(es); skip notes: $(grep -c 'not tested through the runtime role' "$W/t2.log")" $(grep -q 'FAIL: runtime role has no access to company-scoped table accounts' "$W/t2.log" && ! grep -q 'not tested through the runtime role' "$W/t2.log"; echo $?)
summary; echo "work dir: $W"
