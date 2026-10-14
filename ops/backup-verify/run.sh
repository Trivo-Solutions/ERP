#!/bin/sh
# TRIVO production snapshot + manifest + dump, run INSIDE a postgres:16-alpine container. READ-ONLY against the database.
#
# Mounts:   /scripts  (read-only)  this file + snapshot_dump.sql          /out  (read-write)  the dedicated output directory
# Env:      PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD (+ optional PGSSLMODE)      EXPECT_DB EXPECT_USER   (mandatory guards)
#           EXPECT_PG_MAJOR (default 16: both the CLIENT tools in this container and the SERVER must be this major version)
#
# PUBLICATION MODEL (all-or-nothing):
#   1. A private staging directory /out/.tmp-<id> (mode 700, created with plain mkdir - it fails if the name exists) receives ALL
#      FOUR files: trivo_snap.dump, manifest.tsv, SNAPSHOT_OK (the success marker), SHA256SUMS.
#   2. Everything is generated and verified INSIDE that directory.
#   3. Only then is the whole directory published with ONE rename(2) to a unique, never-reused name /out/bundle-<id>.
#      Nothing is ever visible under a final name until all four files are complete and verified.
#   4. An existing bundle is never overwritten. A stale .tmp-* directory left by an earlier killed run is NEVER deleted
#      automatically: this script refuses to start while one exists, so the operator inspects it first (see RUNBOOK).
# On an ordinary failure or TERM/INT this run removes only ITS OWN staging directory (never anything from an earlier run).
set -eu
umask 077
: "${EXPECT_DB:?EXPECT_DB required}"; : "${EXPECT_USER:?EXPECT_USER required}"
EXPECT_PG_MAJOR="${EXPECT_PG_MAJOR:-16}"
BASE=/out
SQL=/scripts/snapshot_dump.sql
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
TMPD="$BASE/.tmp-$ID"
FINAL="$BASE/${TEST_FINAL_NAME:-bundle-$ID}"     # TEST_FINAL_NAME is a test hook; unset in production

# Test hooks (no effect unless the variable is set; the production command never sets them).
pause_at() { if [ "${TEST_PAUSE_AT:-}" = "$1" ]; then echo "PAUSED at $1"; sleep 3600 & wait $!; fi; return 0; }
fail_at()  { if [ "${TEST_FAIL_AT:-}" = "$1" ]; then echo "TEST-INJECTED FAILURE at $1"; exit 1; fi; return 0; }

# Test-only corruption hooks (inert unless TEST_MUTATE is set): used by the local failure-injection tests, never by production.
mutate() { # mutate STAGE   (run inside the staging directory)
  [ "${TEST_MUTATE_AT:-}" = "$1" ] || return 0
  case "${TEST_MUTATE:-}" in
    truncate_dump)       head -c 4096 trivo_snap.dump > t.tmp && mv t.tmp trivo_snap.dump;;
    drop_manifest_row)   awk -F'	' 'BEGIN{d=0} /^#/{print;next} d==0{d=1;next} {print}' manifest.tsv > t.tmp && mv t.tmp manifest.tsv;;
    dup_manifest_row)    awk -F'	' 'BEGIN{d=0} /^#end/{ if(first!="") print first } {print} !/^#/ && first==""{first=$0}' manifest.tsv > t.tmp && mv t.tmp manifest.tsv;;
    bad_manifest_header) sed -i 's/^#trivo-count-manifest	v2$/#trivo-count-manifest	v9/' manifest.tsv;;
    rename_table)        sed -i 's/^accounts	/accountz	/' manifest.tsv;;
    flip_dump)           printf 'X' >> trivo_snap.dump;;
    *) echo "unknown TEST_MUTATE"; exit 1;;
  esac
  echo "TEST-MUTATION $TEST_MUTATE applied at $1"
}

CREATED=0; PUBLISHED=0
cleanup() {
  rc=$?
  trap '' TERM INT
  rm -f /tmp/dump.rc /tmp/toc.txt /tmp/man.txt /tmp/toc_hdr.txt
  if [ "$CREATED" = 1 ] && [ -d "$TMPD" ]; then rm -rf "$TMPD"; fi      # only THIS run's own staging directory
  if [ "$rc" != 0 ]; then
    if [ "$PUBLISHED" = 1 ]; then echo "WARNING (exit $rc): bundle $FINAL WAS published but the final re-verification failed - treat it as UNVERIFIED"
    else echo "FAILED (exit $rc): this run's staging directory was removed; nothing was published"; fi
  fi
}
# TERM/INT: stop every child (psql, its pg_dump) first, give them a moment to exit, then the EXIT trap cleans our own staging dir.
on_signal() { trap '' TERM INT; kill -TERM 0 2>/dev/null || true; sleep 1; exit "$1"; }
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap cleanup EXIT

echo "client tools: $(psql --version | head -1) | $(pg_dump --version | head -1)"
for tool in psql pg_dump pg_restore; do
  v="$($tool --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/')"
  [ "$v" = "$EXPECT_PG_MAJOR" ] || { echo "REFUSING: $tool is major version $v, expected $EXPECT_PG_MAJOR (client and server must match)"; exit 1; }
done

# One run at a time (the lock is released automatically when the process dies, however it dies).
exec 9>"$BASE/.run.lock"
flock -n 9 || { echo "REFUSING: another run holds $BASE/.run.lock"; exit 1; }

# Refuse to start if an earlier run left a staging directory: it may hold a partial dump of customer data and is evidence.
STALE="$(find "$BASE" -maxdepth 1 -name '.tmp-*' | sort)"
if [ -n "$STALE" ]; then
  echo "REFUSING: stale staging director(y/ies) from an earlier interrupted run exist. NOTHING was deleted or changed."
  echo "Inspect them, then remove them yourself if appropriate:"; echo "$STALE"
  exit 1
fi
[ ! -e "$FINAL" ] || { echo "REFUSING: $FINAL already exists (will not overwrite)"; exit 1; }

# Cheap identity + disk preflight (still read-only; the SQL guards below remain authoritative).
IDENT="$(psql -v ON_ERROR_STOP=1 -Atq -c "select current_database()||'|'||current_user||'|'||pg_database_size(current_database())")" || { echo "FAILED: cannot connect"; exit 1; }
[ "${IDENT%%|*}" = "$EXPECT_DB" ] || { echo "REFUSING: connected database is not the expected one"; exit 1; }
rest="${IDENT#*|}"; [ "${rest%%|*}" = "$EXPECT_USER" ] || { echo "REFUSING: connected role is not the expected one"; exit 1; }
DBBYTES="${rest#*|}"
FREEKB="$(df -Pk "$BASE" | awk 'NR==2{print $4}')"
NEEDKB=$(( (DBBYTES / 1024) * 2 + 102400 ))
[ "$FREEKB" -ge "$NEEDKB" ] || { echo "REFUSING: only ${FREEKB} KB free in $BASE, need at least ${NEEDKB} KB (2x database size + 100 MB)"; exit 1; }
echo "preflight ok: database size ${DBBYTES} bytes, ${FREEKB} KB free"

# The backup role is limited to 3 connections and this run needs 2 (psql + pg_dump). No OTHER session of the role may be active:
# an overlapping nightly dump (or a lingering session of an earlier killed run) would make pg_dump fail AFTER the snapshot was taken.
i=0
while :; do
  n="$(psql -v ON_ERROR_STOP=1 -Atq -c "select count(*) from pg_stat_activity where usename = current_user and backend_type = 'client backend' and pid <> pg_backend_pid()")" || { echo "FAILED: cannot connect"; exit 1; }
  [ "$n" = 0 ] && break
  i=$((i+1)); [ "$i" -le 20 ] || { echo "REFUSING: $n other session(s) of role $EXPECT_USER are active (a backup running? an earlier killed run still closing?)"; exit 1; }
  sleep 1
done

mkdir -m 700 "$TMPD"; CREATED=1
pause_at after_mkdir; fail_at after_mkdir

rm -f /tmp/dump.rc
psql -v ON_ERROR_STOP=1 -v hold="${HOLD:-0}" -v outdir="$TMPD" -v expect_db="$EXPECT_DB" -v expect_user="$EXPECT_USER" -v expect_major="$EXPECT_PG_MAJOR" -f "$SQL" &
wait $!
pause_at after_dump
[ -f /tmp/dump.rc ] && [ "$(cat /tmp/dump.rc)" = 0 ] || { echo "FAILED: pg_dump did not exit 0 (rc=$(cat /tmp/dump.rc 2>/dev/null || echo none))"; exit 1; }

cd "$TMPD"
mutate after_dump
[ -s trivo_snap.dump ] && [ -s manifest.tsv ] || { echo "FAILED: dump or manifest missing/empty"; exit 1; }
pg_restore -l trivo_snap.dump > /tmp/toc.txt || { echo "FAILED: dump is not readable"; exit 1; }
# manifest sanity (structure only; the restore side re-validates strictly)
grep -q '^#trivo-count-manifest	v2$' manifest.tsv || { echo "FAILED: manifest header"; exit 1; }
n=$(grep -vc '^#' manifest.tsv); e=$(grep '^#end	' manifest.tsv | cut -f2); t=$(grep '^#table_count	' manifest.tsv | cut -f2)
[ "$n" -ge 1 ] && [ "$n" = "$e" ] && [ "$n" = "$t" ] || { echo "FAILED: manifest has $n rows, table_count=$t, end=$e"; exit 1; }
[ "$(cut -f1 manifest.tsv | grep -v '^#' | sort | uniq -d | wc -l)" = 0 ] || { echo "FAILED: duplicate table in manifest"; exit 1; }
# the dump's own table list must equal the manifest's table list
awk '$4=="TABLE" && $5=="DATA" && $6=="public"{print $7}' /tmp/toc.txt | sort > /tmp/toc_tables.txt
grep -v '^#' manifest.tsv | cut -f1 | sort > /tmp/man.txt
cmp -s /tmp/toc_tables.txt /tmp/man.txt || { echo "FAILED: dump table list differs from manifest table list"; exit 1; }
rm -f /tmp/toc_tables.txt
# the dump's own header must agree with the manifest (same database, same server)
mdb="$(grep '^#database	' manifest.tsv | cut -f2)"; msv="$(grep '^#server_version	' manifest.tsv | cut -f2)"
grep -qE "^; +dbname: ${mdb}\$" /tmp/toc.txt || { echo "FAILED: dump header database differs from manifest"; exit 1; }
grep -qE "^; +Dumped from database version: ${msv}( |\$)" /tmp/toc.txt || { echo "FAILED: dump header server version differs from manifest"; exit 1; }
pause_at validated

# success marker: binds the dump to the manifest (same snapshot id, hashes of both) and records the client that produced it
DSHA="$(sha256sum trivo_snap.dump | cut -d' ' -f1)"; MSHA="$(sha256sum manifest.tsv | cut -d' ' -f1)"
DBYTES="$(wc -c < trivo_snap.dump | tr -d ' ')"
{
  printf '#trivo-snapshot-ok\tv1\n'
  printf 'database\t%s\n' "$mdb"
  printf 'server_version\t%s\n' "$msv"
  printf 'snapshot_id\t%s\n' "$(grep '^#snapshot_id	' manifest.tsv | cut -f2)"
  printf 'table_count\t%s\n' "$n"
  printf 'dump_file\ttrivo_snap.dump\n'
  printf 'dump_bytes\t%s\n' "$DBYTES"
  printf 'dump_sha256\t%s\n' "$DSHA"
  printf 'manifest_sha256\t%s\n' "$MSHA"
  printf 'pg_dump_version\t%s\n' "$(pg_dump --version | sed -E 's/.* ([0-9][0-9.]*).*/\1/')"
  printf 'completed_utc\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '#end\tok\n'
} > SNAPSHOT_OK

fail_at checksum
sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS
mutate after_sums
sha256sum -c SHA256SUMS
chmod 600 trivo_snap.dump manifest.tsv SNAPSHOT_OK SHA256SUMS
pause_at checksummed

# the bundle must contain exactly the four expected files
[ "$(ls -A "$TMPD" | sort | tr '\n' ' ')" = "SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || { echo "FAILED: unexpected bundle contents: $(ls -A "$TMPD")"; exit 1; }
cd "$BASE"
fail_at rename
[ ! -e "$FINAL" ] || { echo "REFUSING: $FINAL already exists (will not overwrite)"; exit 1; }
mv -T "$TMPD" "$FINAL"          # ONE rename(2): the complete, verified directory appears under its final name atomically
PUBLISHED=1
pause_at renamed

( cd "$FINAL" && sha256sum -c SHA256SUMS )
echo "BUNDLE_OK $FINAL tables=$n"
