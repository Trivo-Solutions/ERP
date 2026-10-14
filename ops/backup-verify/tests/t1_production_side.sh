#!/usr/bin/env bash
# Production-side tests: run.sh + snapshot_dump.sql inside postgres:16-alpine against the DISPOSABLE PG16 test server
# (container trivo_pg16_snaptest, 127.0.0.1:54316, database trivo_prod = seeded copy of staging data, real role split).
# NEVER touches production. Every test uses its own fresh Docker volume as /out; nothing is deleted.
#   TRIVO_TEST_SECRETS=<dir> TRIVO_TEST_LOGS=<dir> bash tests/t1_production_side.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export TARGET=pg16; . "$HERE/env.sh"
: "${TRIVO_TEST_LOGS:?}"
SCRIPTS_WIN="$(cygpath -m "$HERE/..")"
RUN="t1$(date -u +%H%M%S)"; LOGDIR="$TRIVO_TEST_LOGS/$RUN"; mkdir -p "$LOGDIR"
IMG=postgres:16-alpine; DB=$SRC_DB
BK18="$(tr -d '\r\n' < /c/trivo-staging/backup-pw.txt)"

vol() { local v="trivo_vt_${RUN}_$1"; docker volume create "$v" >/dev/null; echo "$v"; }
listing() { docker run --rm -v "$1:/out" alpine sh -c 'cd /out; find . -mindepth 1 -not -name .run.lock | sed "s#^\./##" | sort | tr "\n" " "'; }
dargs() { # container args shared by every run
  echo --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --add-host host.docker.internal:host-gateway -v "$SCRIPTS_WIN:/scripts:ro"
}
run_c() { # run_c VOL [KEY=VAL ...]  -> container exit code; full output in $LOGDIR/<vol>.log, last lines echoed
  local v="$1"; shift
  local pu=trivo_backup pw="$BK_PW" pdb=$DB ed=$DB eu=trivo_backup img=$IMG port=$T_PORT ssl="" extra=() vmount="$v:/out"
  for kv in "$@"; do case "$kv" in
    PGUSER=*) pu="${kv#PGUSER=}";; PGPASSWORD=*) pw="${kv#PGPASSWORD=}";; PGDATABASE=*) pdb="${kv#PGDATABASE=}";; EXPECT_DB=*) ed="${kv#EXPECT_DB=}";;
    EXPECT_USER=*) eu="${kv#EXPECT_USER=}";; IMG=*) img="${kv#IMG=}";; PGPORT=*) port="${kv#PGPORT=}";; PGSSLMODE=*) ssl="${kv#PGSSLMODE=}";;
    OUTMOUNT=*) vmount="${kv#OUTMOUNT=}";; *) extra+=(-e "$kv");; esac; done
  docker run --rm --name "trivo_vt_c_$$_$RANDOM" $(dargs) -v "$vmount" \
    -e PGHOST=host.docker.internal -e PGPORT="$port" -e PGUSER="$pu" -e PGDATABASE="$pdb" -e PGPASSWORD="$pw" ${ssl:+-e PGSSLMODE="$ssl"} \
    -e EXPECT_DB="$ed" -e EXPECT_USER="$eu" "${extra[@]}" $img sh /scripts/run.sh > "$LOGDIR/$v.log" 2>&1
  local rc=$?; tail -2 "$LOGDIR/$v.log" | sed 's/^/        /'; return $rc
}
logs_have() { grep -q -- "$2" "$LOGDIR/$1.log"; }
nothing_left() { [ -z "$(listing "$1")" ]; }
sessions() { sup -d postgres -c "select count(*) from pg_stat_activity where usename='trivo_backup' and datname='$DB'"; }
modes() { docker run --rm -v "$1:/out" alpine sh -c 'cd /out; for d in bundle-*; do stat -c "%a %U %n" "$d"; for f in "$d"/*; do stat -c "%a %U %n" "$f"; done; done'; }

echo "################ environment"
echo "server: $(bk -c 'select version()' | cut -c1-60) | client image: $IMG | db: $DB | sessions now: $(sessions)"
HAVE_PROBE=$(own -c "select count(*) from information_schema.tables where table_name='snap_probe'")
own -c "CREATE TABLE IF NOT EXISTS snap_probe(id serial primary key, note text); GRANT SELECT ON snap_probe TO trivo_backup; GRANT SELECT ON SEQUENCE snap_probe_id_seq TO trivo_backup; DELETE FROM snap_probe; INSERT INTO snap_probe(note) SELECT 'before-'||g FROM generate_series(1,3) g;"
SAMPLE_NAME="$(bk -c "select name from clients where length(name)>6 order by id limit 1")"

echo "################ A. SUCCESS"
V=$(vol A); run_c "$V"; rc=$?
L=$(listing "$V"); BUN=$(echo "$L" | tr ' ' '\n' | grep '^bundle-[^/]*$' | head -1)
check "A1 success: rc=0, one bundle dir with exactly 4 files, no .tmp-*" "rc=0; bundle + 4 files" "rc=$rc; [$L]" $([ $rc = 0 ] && [ "$(echo "$L" | wc -w)" = 5 ] && ! echo "$L" | grep -q '\.tmp-'; echo $?)
M=$(modes "$V" | tr '\n' ';')
check "A2 permissions: bundle dir 700, every file 600, owner root" "700 + 4x600 root" "$M" $(echo "$M" | grep -q '^700 root bundle-[^;]*;600 root bundle-[^/]*/SHA256SUMS;600 root bundle-[^/]*/SNAPSHOT_OK;600 root bundle-[^/]*/manifest.tsv;600 root bundle-[^/]*/trivo_snap.dump;$'; echo $?)
check "A3 log says BUNDLE_OK and client tools are 16.x" "BUNDLE_OK + 16.x" "$(grep -o 'BUNDLE_OK [^ ]* tables=[0-9]*' "$LOGDIR/$V.log"); $(grep 'client tools' "$LOGDIR/$V.log")" $(logs_have "$V" BUNDLE_OK && logs_have "$V" 'psql (PostgreSQL) 16\.' ; echo $?)
check "A4 no customer value (a real client name) appears in the log" "absent" "searched for a $(echo -n "$SAMPLE_NAME" | wc -c)-char client name" $(! grep -qF -- "$SAMPLE_NAME" "$LOGDIR/$V.log"; echo $?)
mkdir -p "$LOGDIR/A_bundle"; docker run --rm -v "$V:/out" -v "$(cygpath -m "$LOGDIR/A_bundle"):/dst" alpine sh -c 'cp -a /out/bundle-* /dst/'
ABUN="$LOGDIR/A_bundle/$BUN"
check "A5 manifest has no customer value" "absent" "grep for the client name" $(! grep -qF -- "$SAMPLE_NAME" "$ABUN/manifest.tsv"; echo $?)
out=$(bash "$HERE/../restore-manifest.sh" --verify-only "$ABUN" 2>&1); rc=$?
check "A6 transferred-bundle check on the host (restore-manifest.sh --verify-only, no database)" "rc=0 BUNDLE VERIFIED" "rc=$rc; $(echo "$out" | tail -1)" $([ $rc = 0 ] && echo "$out" | grep -q 'BUNDLE VERIFIED'; echo $?)
check "A7 manifest table count equals the live table count" "141" "$(grep -vc '^#' "$ABUN/manifest.tsv") vs live $(bk -c "select count(*) from pg_tables where schemaname='public'")" $([ "$(grep -vc '^#' "$ABUN/manifest.tsv")" = "$(bk -c "select count(*) from pg_tables where schemaname='public'")" ]; echo $?)

echo "################ B. ORDINARY FAILURES (each must publish nothing and leave nothing)"
f() { # f NAME DESC WANT_LOG_TEXT [KEY=VAL...]
  local n="$1" d="$2" want="$3"; shift 3; local v; v=$(vol "$n"); run_c "$v" "$@"; local rc=$?
  check "$n $d" "rc!=0; nothing left; log has '$want'" "rc=$rc; left=[$(listing "$v")]" $([ $rc != 0 ] && nothing_left "$v" && logs_have "$v" "$want"; echo $?)
}
f B1 "wrong database name"                                "REFUSING: connected database"        EXPECT_DB=some_other_db
f B2 "wrong role name"                                    "REFUSING: connected role"            EXPECT_USER=trivo_owner
f B3 "client tools of the wrong major version (18 vs 16)" "REFUSING: psql is major version 18"  IMG=postgres:18-alpine
f B4 "wrong password"                                     "FAILED: cannot connect"              PGPASSWORD=wrong-password-xyz
f B5 "server unreachable (closed port)"                   "FAILED: cannot connect"              PGPORT=1
f B6 "dump unreadable (truncated)"                        "FAILED: dump is not readable"        TEST_MUTATE=truncate_dump TEST_MUTATE_AT=after_dump
f B7 "manifest row dropped (count/end disagree)"          "FAILED: manifest has"                TEST_MUTATE=drop_manifest_row TEST_MUTATE_AT=after_dump
f B8 "manifest row duplicated"                            "FAILED: manifest has"                TEST_MUTATE=dup_manifest_row TEST_MUTATE_AT=after_dump
f B9 "manifest header corrupted"                          "FAILED: manifest header"             TEST_MUTATE=bad_manifest_header TEST_MUTATE_AT=after_dump
f B10 "manifest table list differs from the dump's"       "FAILED: dump table list differs"     TEST_MUTATE=rename_table TEST_MUTATE_AT=after_dump
f B11 "checksum generation fails"                         "TEST-INJECTED FAILURE at checksum"   TEST_FAIL_AT=checksum
f B12 "checksum verification fails (dump altered after sums written)" "FAILED"                   TEST_MUTATE=flip_dump TEST_MUTATE_AT=after_sums
f B13 "rename (publication) fails after checksums verified" "TEST-INJECTED FAILURE at rename"   TEST_FAIL_AT=rename
# insufficient disk: /out is a 20 MB tmpfs
docker run --rm --name "trivo_vt_c_disk_$$" $(dargs) --tmpfs /out:size=20m,mode=700 -e PGHOST=host.docker.internal -e PGPORT=$T_PORT -e PGUSER=trivo_backup -e PGDATABASE=$DB -e PGPASSWORD="$BK_PW" -e EXPECT_DB=$DB -e EXPECT_USER=trivo_backup $IMG sh /scripts/run.sh > "$LOGDIR/B14.log" 2>&1; rc=$?
check "B14 not enough free disk (20 MB tmpfs) is refused before anything is written" "rc!=0; REFUSING: only ... KB free" "rc=$rc; $(grep REFUSING "$LOGDIR/B14.log" | cut -c1-100)" $([ $rc != 0 ] && grep -q 'REFUSING: only' "$LOGDIR/B14.log"; echo $?)
# pg_dump failure AFTER guards and counts passed: revoke SELECT on a sequence mid-run
V=$(vol B15); ( sleep 5; own -c "REVOKE ALL ON SEQUENCE snap_probe_id_seq FROM trivo_backup" ) & run_c "$V" HOLD=14; rc=$?; wait
own -c "GRANT SELECT ON SEQUENCE snap_probe_id_seq TO trivo_backup" >/dev/null
check "B15 pg_dump fails after the guards and the manifest counts passed (sequence privilege revoked mid-run)" "rc!=0; FAILED: pg_dump did not exit 0; nothing left" "rc=$rc; left=[$(listing "$V")]; $(grep -o 'FAILED: pg_dump did not exit 0[^)]*)' "$LOGDIR/$V.log")" $([ $rc != 0 ] && nothing_left "$V" && logs_have "$V" 'FAILED: pg_dump did not exit 0'; echo $?)
# existing outputs
V=$(vol B16); docker run --rm -v "$V:/out" alpine sh -c 'mkdir /out/taken && echo KEEP > /out/taken/marker.txt && mkdir /out/bundle-OLD && echo OLD > /out/bundle-OLD/trivo_snap.dump'
run_c "$V" TEST_FINAL_NAME=taken; rc=$?; L=$(listing "$V")
check "B16 destination name already exists: refused, existing directory untouched and not nested into" "rc!=0; [bundle-OLD, bundle-OLD/trivo_snap.dump, taken, taken/marker.txt] only" "rc=$rc; [$L]" $([ $rc != 0 ] && [ "$L" = "bundle-OLD bundle-OLD/trivo_snap.dump taken taken/marker.txt " ] && [ "$(docker run --rm -v $V:/out alpine cat /out/taken/marker.txt)" = KEEP ]; echo $?)
V=$(vol B17); docker run --rm -v "$V:/out" alpine sh -c 'mkdir -m 700 /out/.tmp-OLDRUN && echo EVIDENCE > /out/.tmp-OLDRUN/trivo_snap.dump'
run_c "$V"; rc=$?; L=$(listing "$V")
check "B17 stale .tmp-* from an earlier run: new run refuses, evidence untouched" "rc!=0; only [.tmp-OLDRUN, .tmp-OLDRUN/trivo_snap.dump]; content EVIDENCE" "rc=$rc; [$L]" $([ $rc != 0 ] && [ "$L" = ".tmp-OLDRUN .tmp-OLDRUN/trivo_snap.dump " ] && [ "$(docker run --rm -v $V:/out alpine cat /out/.tmp-OLDRUN/trivo_snap.dump)" = EVIDENCE ]; echo $?)
V=$(vol B18); run_c "$V" >/dev/null; run_c "$V" >/dev/null; rc=$?; L=$(listing "$V")
check "B18 two successful runs in one directory: two distinct bundles, neither touched" "rc=0; 2 bundles x 5 entries" "rc=$rc; $(echo "$L" | tr ' ' '\n' | grep -c '^bundle-[^/]*$') bundles" $([ $rc = 0 ] && [ "$(echo "$L" | tr ' ' '\n' | grep -c '^bundle-[^/]*$')" = 2 ]; echo $?)

V=$(vol B19); ( bk -c "select pg_sleep(40)" >/dev/null ) & sleep 2
run_c "$V"; rc=$?; wait
check "B19 another session of the backup role is active (e.g. the nightly dump): refused before the snapshot, nothing left" "rc!=0; REFUSING: 1 other session(s)" "rc=$rc; $(grep -o 'REFUSING: [0-9]* other session' "$LOGDIR/$V.log"); left=[$(listing "$V")]" $([ $rc != 0 ] && logs_have "$V" 'REFUSING: 1 other session' && nothing_left "$V"; echo $?)

echo "################ C. FORCED TERMINATION at each stage (SIGKILL: no trap runs; SIGTERM/docker stop: trap runs)"
kt() { # kt NAME STAGE SIGNAL [VOL]  -> sets CT_VOL CT_LIST CT_CODE
  local name="$1" stage="$2" sig="$3" v cn="trivo_vt_k_${RUN}_$1"; v=${4:-$(vol "$name")}
  docker run -d --name "$cn" $(dargs) -v "$v:/out" -e PGHOST=host.docker.internal -e PGPORT=$T_PORT -e PGUSER=trivo_backup -e PGDATABASE=$DB -e PGPASSWORD="$BK_PW" \
    -e EXPECT_DB=$DB -e EXPECT_USER=trivo_backup -e TEST_PAUSE_AT="$stage" $IMG sh /scripts/run.sh > /dev/null
  local i; for i in $(seq 1 90); do docker logs "$cn" 2>&1 | grep -q "PAUSED at $stage" && break; sleep 1; done
  if ! docker logs "$cn" 2>&1 | grep -q "PAUSED at $stage"; then echo "        $name never reached $stage"; docker rm -f "$cn" >/dev/null 2>&1; CT_VOL=$v; CT_LIST="NEVER_REACHED"; CT_CODE=-; return; fi
  local t0=$(date +%s)
  case "$sig" in
    KILL) docker kill "$cn" > /dev/null;;
    TERM) docker kill -s TERM "$cn" > /dev/null; docker wait "$cn" > /dev/null;;
    STOP) docker stop -t 30 "$cn" > /dev/null;;      # docker stop sends the image's STOPSIGNAL, which for postgres images is SIGINT
  esac
  CT_SECS=$(( $(date +%s) - t0 ))
  CT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$cn"); docker rm "$cn" >/dev/null
  CT_VOL=$v; CT_LIST=$(listing "$v"); echo "        $name: signal=$sig stopped in ${CT_SECS}s, exit=$CT_CODE, remains: [$CT_LIST]"
}
kt C1k after_mkdir KILL
check "C1 SIGKILL after mkdir: only an empty stale .tmp-* remains, nothing published" "[.tmp-X]" "[$CT_LIST]" $(echo "$CT_LIST" | grep -qE '^\.tmp-[^ /]+ $'; echo $?)
run_c "$CT_VOL"; rc=$?
check "C1b follow-up run refuses (stale dir) and changes nothing" "rc!=0, same listing" "rc=$rc; [$(listing "$CT_VOL")]" $([ $rc != 0 ] && [ "$(listing "$CT_VOL")" = "$CT_LIST" ]; echo $?)
kt C1t after_mkdir TERM
check "C1t SIGTERM after mkdir: exit 143, this run's own staging dir removed, nothing remains" "exit 143; []" "exit=$CT_CODE [$CT_LIST] took ${CT_SECS}s" $([ -z "$CT_LIST" ] && [ "$CT_CODE" = 143 ] && [ "$CT_SECS" -lt 25 ]; echo $?)
kt C1s after_mkdir STOP
check "C1s docker stop (SIGINT, the postgres image's STOPSIGNAL) after mkdir: exit 130, own staging dir removed" "exit 130; []" "exit=$CT_CODE [$CT_LIST]" $([ -z "$CT_LIST" ] && [ "$CT_CODE" = 130 ]; echo $?)
# inside the snapshot transaction (hold)
V=$(vol C2k); cn="trivo_vt_k_${RUN}_c2k"
docker run -d --name "$cn" $(dargs) -v "$V:/out" -e PGHOST=host.docker.internal -e PGPORT=$T_PORT -e PGUSER=trivo_backup -e PGDATABASE=$DB -e PGPASSWORD="$BK_PW" -e EXPECT_DB=$DB -e EXPECT_USER=trivo_backup -e HOLD=3600 $IMG sh /scripts/run.sh >/dev/null
for i in $(seq 1 60); do [ "$(sup -d postgres -c "select count(*) from pg_stat_activity where usename='trivo_backup' and datname='$DB' and query like '%pg_sleep%'")" -ge 1 ] && break; sleep 1; done
echo "        snapshot-holding session while paused: $(sessions)"
docker kill -s TERM "$cn" >/dev/null; docker wait "$cn" >/dev/null; code=$(docker inspect -f '{{.State.ExitCode}}' "$cn"); docker rm "$cn" >/dev/null
# NOTE (test artifact, not a production path): the hold hook is a server-side pg_sleep(3600), and PostgreSQL cannot notice a vanished client while a
# statement is running, so that one backend lingers. A real run holds the snapshot only for the few seconds the counts + dump take.
LINGER=$(sessions); sup -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where usename='trivo_backup' and datname='$DB'" >/dev/null
for i in $(seq 1 20); do [ "$(sessions)" = 0 ] && break; sleep 1; done
check "C2t SIGTERM inside the snapshot transaction: exit 143, container gone, own staging dir removed; the only DB session left is the test hook's pg_sleep backend (terminated by the test)" "exit 143; nothing left; sessions after cleanup=0" "exit=$code; lingering pg_sleep backends=$LINGER; left=[$(listing "$V")]; sessions now=$(sessions)" $([ "$code" = 143 ] && nothing_left "$V" && [ "$(sessions)" = 0 ]; echo $?)
for st in after_dump validated checksummed; do
  kt "Ck_$st" $st KILL
  check "C $st SIGKILL: stale .tmp-* with unpublished files only; no bundle-*" "[.tmp-X, .tmp-X/files...]; no bundle" "[$CT_LIST]" $(echo "$CT_LIST" | grep -qE '^\.tmp-' && ! echo "$CT_LIST" | grep -q 'bundle-'; echo $?)
  run_c "$CT_VOL"; rc=$?; check "C $st follow-up run refused; nothing deleted or changed" "rc!=0; same listing" "rc=$rc" $([ $rc != 0 ] && [ "$(listing "$CT_VOL")" = "$CT_LIST" ]; echo $?)
  kt "Ct_$st" $st TERM
  check "C $st SIGTERM: exit 143, own staging dir removed; nothing published" "exit 143; []" "exit=$CT_CODE [$CT_LIST]" $([ -z "$CT_LIST" ] && [ "$CT_CODE" = 143 ]; echo $?)
done
kt Ck_renamed renamed KILL
BUN=$(echo "$CT_LIST" | tr ' ' '\n' | grep '^bundle-[^/]*$' | head -1)
docker run --rm -v "$CT_VOL:/out" alpine sh -c "cd /out/$BUN && sha256sum -c SHA256SUMS >/dev/null"; rc=$?
check "C renamed SIGKILL: published bundle is complete and verifies; no .tmp-*" "bundle checksums OK; no .tmp" "rc=$rc [$CT_LIST]" $([ $rc = 0 ] && ! echo "$CT_LIST" | grep -q '\.tmp-'; echo $?)
run_c "$CT_VOL" >/dev/null; rc=$?
check "C renamed follow-up: a SECOND bundle is created, the first untouched" "rc=0; 2 bundles" "rc=$rc; $(listing "$CT_VOL" | tr ' ' '\n' | grep -c '^bundle-[^/]*$') bundles" $([ $rc = 0 ] && [ "$(listing "$CT_VOL" | tr ' ' '\n' | grep -c '^bundle-[^/]*$')" = 2 ]; echo $?)
kt Ct_renamed renamed TERM
check "C renamed SIGTERM: published bundle remains complete" "bundle present, no .tmp" "[$CT_LIST]" $(echo "$CT_LIST" | grep -q '^bundle-' && ! echo "$CT_LIST" | grep -q '\.tmp-'; echo $?)
# SIGKILL while pg_dump is actually writing
V=$(vol Cdump); run_c "$V" >/dev/null; FIRST=$(listing "$V" | grep -o 'bundle-[^/ ]*' | sort -u | head -1); cn="trivo_vt_k_${RUN}_cdump"
docker run -d --name "$cn" $(dargs) -v "$V:/out" -e PGHOST=host.docker.internal -e PGPORT=$T_PORT -e PGUSER=trivo_backup -e PGDATABASE=$DB -e PGPASSWORD="$BK_PW" -e EXPECT_DB=$DB -e EXPECT_USER=trivo_backup $IMG sh /scripts/run.sh >/dev/null
for i in $(seq 1 400); do docker exec "$cn" sh -c 'ls /out/.tmp-*/trivo_snap.dump >/dev/null 2>&1' 2>/dev/null && break; sleep 0.05; done
docker kill "$cn" >/dev/null 2>&1; docker rm "$cn" >/dev/null 2>&1
for i in $(seq 1 20); do [ "$(sessions)" = 0 ] && break; sleep 1; done
L=$(listing "$V")
check "C SIGKILL while pg_dump is writing: a stale .tmp-* appears, NO new bundle (only the earlier one), DB sessions released" "stale .tmp-*; bundles={earlier}; sessions=0" "[$L]; sessions=$(sessions)" $(echo "$L" | grep -q '^\.tmp-' && [ "$(echo "$L" | grep -o 'bundle-[^/ ]*' | sort -u)" = "$FIRST" ] && [ "$(sessions)" = 0 ]; echo $?)
run_c "$V"; rc=$?; check "C pg_dump-kill follow-up refused, nothing changed" "rc!=0, same listing" "rc=$rc" $([ $rc != 0 ] && [ "$(listing "$V")" = "$L" ]; echo $?)
# documented recovery: the operator inspects, then deliberately abandons the stale staging directory; the next run is a brand-new snapshot
docker run --rm -v "$V:/out" alpine sh -c 'rm -rf /out/.tmp-*'
run_c "$V" >/dev/null; rc=$?; L2=$(listing "$V")
docker run --rm -v "$V:/out" alpine sh -c "cd /out/$FIRST && sha256sum -c SHA256SUMS >/dev/null"; rc2=$?
check "C recovery: after the operator removes the stale .tmp-* by hand, a new run succeeds; the earlier completed bundle is untouched and still verifies" "rc=0; 2 bundles; no .tmp-*; first bundle verifies" "rc=$rc; $(echo "$L2" | grep -o 'bundle-[^/ ]*' | sort -u | wc -l) bundles; first bundle verify rc=$rc2" $([ $rc = 0 ] && [ "$rc2" = 0 ] && [ "$(echo "$L2" | grep -o 'bundle-[^/ ]*' | sort -u | wc -l)" = 2 ] && ! echo "$L2" | grep -q '\.tmp-'; echo $?)
# concurrent run: the lock
V=$(vol Clock); cn="trivo_vt_k_${RUN}_lock"
docker run -d --name "$cn" $(dargs) -v "$V:/out" -e PGHOST=host.docker.internal -e PGPORT=$T_PORT -e PGUSER=trivo_backup -e PGDATABASE=$DB -e PGPASSWORD="$BK_PW" -e EXPECT_DB=$DB -e EXPECT_USER=trivo_backup -e TEST_PAUSE_AT=validated $IMG sh /scripts/run.sh >/dev/null
for i in $(seq 1 90); do docker logs "$cn" 2>&1 | grep -q "PAUSED at validated" && break; sleep 1; done
run_c "$V"; rc=$?
check "C2 a second run while one is in progress is refused (lock), the first is unaffected" "rc!=0; REFUSING: another run holds" "rc=$rc; $(grep -o 'REFUSING: [a-z ]*' "$LOGDIR/$V.log" | head -1)" $([ $rc != 0 ] && logs_have "$V" 'REFUSING: another run holds'; echo $?)
docker kill "$cn" >/dev/null; docker rm "$cn" >/dev/null

echo "################ D. GUARDS (fail closed, name of the failing guard asserted)"
g() { # g NAME DESC GUARD [KEY=VAL...]
  local n="$1" d="$2" gd="$3"; shift 3; local v; v=$(vol "$n"); run_c "$v" "$@"; local rc=$?
  check "$n $d" "rc!=0; GUARD_FAILED:$gd; nothing left" "rc=$rc; $(grep -o 'GUARD_FAILED:[a-z_]*' "$LOGDIR/$v.log" | head -1); left=[$(listing "$v")]" $([ $rc != 0 ] && logs_have "$v" "GUARD_FAILED:$gd" && nothing_left "$v"; echo $?)
}
g D1 "role WITHOUT BYPASSRLS (trivo_runtime)" role_bypasses_rls PGUSER=trivo_runtime PGPASSWORD="$RUN_PW" EXPECT_USER=trivo_runtime
g D2 "superuser role (postgres)" role_is_not_superuser PGUSER=postgres PGPASSWORD="$SUPER_PW" EXPECT_USER=postgres
g D2b "trivo_platform (BYPASSRLS, can write, cannot read _prisma_migrations)" can_select_every_table PGUSER=trivo_platform PGPASSWORD="$(tr -d '\r\n' < "$TRIVO_TEST_SECRETS/platform.pw")" EXPECT_USER=trivo_platform
own -c "DROP TABLE IF EXISTS snap_nosel; CREATE TABLE snap_nosel(id int primary key);"
g D3 "an ordinary public table the role cannot SELECT" can_select_every_table
own -c "DROP TABLE snap_nosel;"
own -c "DROP TABLE IF EXISTS snap_noseq; CREATE TABLE snap_noseq(id serial primary key); GRANT SELECT ON snap_noseq TO trivo_backup;"
g D4 "a public sequence the role cannot SELECT" can_select_every_sequence
own -c "DROP TABLE snap_noseq;"
own -c "GRANT INSERT ON snap_probe TO trivo_backup"
g D5 "role holding an INSERT privilege" role_has_no_write_privileges
own -c "REVOKE INSERT ON snap_probe FROM trivo_backup"
own -c "DROP SCHEMA IF EXISTS snap_other CASCADE; CREATE SCHEMA snap_other; CREATE TABLE snap_other.t(id int); GRANT USAGE ON SCHEMA snap_other TO trivo_backup; GRANT SELECT ON snap_other.t TO trivo_backup;"
g D6 "an ordinary table outside schema public (manifest could not describe it)" no_tables_outside_public
own -c "DROP SCHEMA snap_other CASCADE"
own -c "DROP TABLE IF EXISTS snap_part; CREATE TABLE snap_part(id int, k int) PARTITION BY RANGE (k); CREATE TABLE snap_part_1 PARTITION OF snap_part FOR VALUES FROM (0) TO (10); GRANT SELECT ON snap_part, snap_part_1 TO trivo_backup;"
g D7 "a partitioned table in public" no_partitioned_tables
own -c "DROP TABLE snap_part"
# PG16 client against a PG18 server (the local staging cluster): the tools check passes (16), the SERVER-major guard must refuse
V=$(vol D8); run_c "$V" PGPORT=54329 PGSSLMODE=require PGDATABASE=trivo_snaptest_src_20261013 EXPECT_DB=trivo_snaptest_src_20261013 PGPASSWORD="$BK18"; rc=$?
check "D8 PG16 client against a PG18 server is refused by the server-major guard" "rc!=0; GUARD_FAILED:server_major_version_is_expected; nothing left" "rc=$rc; $(grep -o 'GUARD_FAILED:[a-z_]*' "$LOGDIR/$V.log" | head -1); left=[$(listing "$V")]" $([ $rc != 0 ] && logs_have "$V" 'GUARD_FAILED:server_major_version_is_expected' && nothing_left "$V"; echo $?)
V=$(vol D9); run_c "$V"; rc=$?
check "D9 after the fixtures are removed the SAME run succeeds (guards are not blanket failures)" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)
echo "        non-SELECT privileges held by trivo_backup in schema public (must be none): [$(own -c "select count(*) from information_schema.role_table_grants where grantee='trivo_backup' and table_schema='public' and privilege_type<>'SELECT'")]"
echo "        write attempt as trivo_backup: $(PGPASSWORD=$BK_PW command psql -h $T_HOST -p $T_PORT -U trivo_backup -d $DB -Atq -c 'CREATE TABLE should_fail(x int)' 2>&1 | head -1)"

echo "################ E. CONCURRENT WRITES DURING THE SNAPSHOT WINDOW"
own -c "DROP TABLE IF EXISTS snap_ddl_during"
V=$(vol E)
( sleep 4
  own -c "INSERT INTO snap_probe(note) SELECT 'DURING-'||g FROM generate_series(1,5) g; UPDATE snap_probe SET note='CHANGED' WHERE note='before-1'; DELETE FROM snap_probe WHERE note='before-2'; CREATE TABLE snap_ddl_during(x int); GRANT SELECT ON snap_ddl_during TO trivo_backup;"
  echo "        writer finished at +4s (inside the 12s hold, AFTER the snapshot was exported)" ) &
run_c "$V" HOLD=12; rc=$?; wait
EBUN=$(listing "$V" | tr ' ' '\n' | grep '^bundle-[^/]*$' | head -1)
mkdir -p "$LOGDIR/E_bundle"; docker run --rm -v "$V:/out" -v "$(cygpath -m "$LOGDIR/E_bundle"):/dst" alpine sh -c 'cp -a /out/bundle-* /dst/'
EB="$LOGDIR/E_bundle/$EBUN"
MP=$(awk -F'\t' '$1=="snap_probe"{print $2}' "$EB/manifest.tsv")
DUMPROWS=$(cd "$EB" && pg_restore -a -t snap_probe -f - trivo_snap.dump | tr -d '\r' | awk '/^COPY /{c=1;next} /^\\\./{c=0} c' | cut -f2 | sort | tr '\n' ',')
LIVE=$(own -c "select count(*) from snap_probe")
check "E1 run succeeded with a concurrent writer" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)
check "E2 manifest counts the table as of the snapshot (3), not the live table ($LIVE)" "snap_probe=3, live>3" "manifest=$MP live=$LIVE" $([ "$MP" = 3 ] && [ "$LIVE" -gt 3 ]; echo $?)
check "E3 the dump holds exactly the three original rows: no DURING row, no update, the deleted row still present" "before-1,before-2,before-3," "$DUMPROWS" $([ "$DUMPROWS" = "before-1,before-2,before-3," ]; echo $?)
check "E4 a table created during the window is in neither the manifest nor the dump" "absent" "manifest: $(grep -c snap_ddl_during "$EB/manifest.tsv"), dump: $(cd "$EB" && pg_restore -l trivo_snap.dump | tr -d '\r' | grep -c snap_ddl_during)" $([ "$(grep -c snap_ddl_during "$EB/manifest.tsv")" = 0 ] && [ "$(cd "$EB" && pg_restore -l trivo_snap.dump | tr -d '\r' | grep -c snap_ddl_during)" = 0 ]; echo $?)
echo "        E bundle kept for the restore tests: $EB"
echo "$EB" > "$LOGDIR/E_bundle_path.txt"
own -c "DROP TABLE snap_ddl_during" 2>/dev/null
summary; echo "logs: $LOGDIR"
