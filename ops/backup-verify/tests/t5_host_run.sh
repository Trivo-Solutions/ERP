#!/usr/bin/env bash
# Orchestration tests of host_run.sh (the production-host driver) in TEST mode against the DISPOSABLE PG16 test server:
# hashes, time window, secrets handling, container flags, bundle publication, post-verification. File-mode checks are NOT possible
# on this NTFS bind mount - they are tested separately on real Linux (t4_postcheck_linux.sh) and in a Docker volume (t1, A2).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export TARGET=pg16; . "$HERE/env.sh"
: "${TRIVO_TEST_LOGS:?}"
W="$TRIVO_TEST_LOGS/t5_$(date -u +%H%M%S)"; OUT="$W/out"; mkdir -p "$OUT/scripts"
SRCD="$HERE/.."; for f in run.sh snapshot_dump.sql bundle_postcheck.sh manifest_check.sh; do cp "$SRCD/$f" "$OUT/scripts/$f"; done
H1=$(sha256sum "$OUT/scripts/run.sh" | cut -d' ' -f1); H2=$(sha256sum "$OUT/scripts/snapshot_dump.sql" | cut -d' ' -f1); H3=$(sha256sum "$OUT/scripts/bundle_postcheck.sh" | cut -d' ' -f1); H4=$(sha256sum "$OUT/scripts/manifest_check.sh" | cut -d' ' -f1)
ENVF="$W/env"; echo "BACKUP_PW=$BK_PW" > "$ENVF"
export TRIVO_VERIFY_TEST=1 TRIVO_VERIFY_OUT="$(cygpath -m "$OUT")" TRIVO_VERIFY_ENV_FILE="$ENVF" TRIVO_VERIFY_NETWORK="" TRIVO_VERIFY_PGHOST=host.docker.internal TRIVO_VERIFY_PGPORT=$T_PORT
export TRIVO_VERIFY_EXTRA_DOCKER_ARGS="--add-host host.docker.internal:host-gateway" TEST_NOW_HHMM_IST=1200
HR="$HERE/../host_run.sh"
run() { bash "$HR" "$@" > "$W/last.out" 2>&1; echo $?; }
nb() { ls "$OUT" | grep -c '^bundle-'; }
reject() { local rc; rc=$(run "${@:3}"); check "$1" "rc!=0; '$2'; no bundle created" "rc=$rc; $(grep -o "REFUSING: [^.]*" "$W/last.out" | head -1 | cut -c1-120); bundles=$(nb)" $([ "$rc" != 0 ] && grep -qF -- "$2" "$W/last.out" && [ "$(nb)" = 0 ]; echo $?); }

reject X1 "do not match the reviewed values" "$H1" "$H2" "0000000000000000000000000000000000000000000000000000000000000000" "$H4"
reject X2 "usage" "$H1" "$H2"
export TEST_NOW_HHMM_IST=0215; reject X3 "too close to the 02:15 IST nightly" "$H1" "$H2" "$H3" "$H4"; export TEST_NOW_HHMM_IST=0144
rc=$(run "$H1" "$H2" "$H3" "$H4"); check "X3b 01:44 IST is outside the window (allowed; run proceeds)" "no 'too close' refusal" "rc=$rc" $(! grep -q 'too close' "$W/last.out"; echo $?)
rm -rf "$OUT"/bundle-* "$OUT"/.run.lock "$OUT"/run-*.log; export TEST_NOW_HHMM_IST=1200
export TRIVO_VERIFY_ENV_FILE="$W/env_none"; : > "$W/env_none";                  reject X4 "exactly one BACKUP_PW=" "$H1" "$H2" "$H3" "$H4"
printf 'BACKUP_PW=a\nBACKUP_PW=b\n' > "$W/env_dup"; export TRIVO_VERIFY_ENV_FILE="$W/env_dup"; reject X5 "exactly one BACKUP_PW=" "$H1" "$H2" "$H3" "$H4"
printf 'BACKUP_PW=\n' > "$W/env_empty"; export TRIVO_VERIFY_ENV_FILE="$W/env_empty"; reject X6 "BACKUP_PW is empty" "$H1" "$H2" "$H3" "$H4"
export TRIVO_VERIFY_ENV_FILE="$ENVF"
TRIVO_VERIFY_IMAGE=postgres:99-does-not-exist reject X7 "not present locally" "$H1" "$H2" "$H3" "$H4"
TRIVO_VERIFY_OUT=/var/backups/trivo-prod reject X8 "nightly backup directory" "$H1" "$H2" "$H3" "$H4"
# wrong password: container runs, cannot connect, nothing published
printf 'BACKUP_PW=wrong-password-xyz\n' > "$W/env_wrong"; export TRIVO_VERIFY_ENV_FILE="$W/env_wrong"
rc=$(run "$H1" "$H2" "$H3" "$H4"); check "X9 wrong database password: container fails, nothing published, nonzero exit" "rc!=0; no bundle" "rc=$rc; bundles=$(nb); $(grep -o 'FAILED[^.]*' "$W/last.out" | head -1)" $([ "$rc" != 0 ] && [ "$(nb)" = 0 ]; echo $?)
export TRIVO_VERIFY_ENV_FILE="$ENVF"
# tampered script on the "host": hash no longer matches
echo "# tampered" >> "$OUT/scripts/manifest_check.sh"; reject X10b "do not match the reviewed values" "$H1" "$H2" "$H3" "$H4"; cp "$SRCD/manifest_check.sh" "$OUT/scripts/manifest_check.sh"
echo "# tampered" >> "$OUT/scripts/run.sh"; reject X10 "do not match the reviewed values" "$H1" "$H2" "$H3" "$H4"; cp "$SRCD/run.sh" "$OUT/scripts/run.sh"
# fail-fast pre-checks added in the hardening pass (all must refuse BEFORE any container starts and leave no bundle / staging directory)
reject X16 "not a lowercase 64-hex sha256" "$H1" "$H2" "$H3" "NOT-A-HASH"
TRIVO_VERIFY_NETWORK=trivo_no_such_network reject X17 "does not exist" "$H1" "$H2" "$H3" "$H4"
TRIVO_VERIFY_NETWORK=bridge reject X18 "no container on network bridge answers to the database host name" "$H1" "$H2" "$H3" "$H4"
mkdir "$OUT/.tmp-stale-from-earlier-run"; reject X19 "stale staging" "$H1" "$H2" "$H3" "$H4"; rmdir "$OUT/.tmp-stale-from-earlier-run"
# in PRODUCTION mode (TRIVO_VERIFY_TEST unset) every test override is refused, notably an EMPTY network that would silently drop --network
ALLOV="TRIVO_VERIFY_NETWORK TRIVO_VERIFY_OUT TRIVO_VERIFY_IMAGE TRIVO_VERIFY_PGHOST TRIVO_VERIFY_PGPORT TRIVO_VERIFY_ENV_FILE TEST_NOW_HHMM_IST TRIVO_VERIFY_EXTRA_DOCKER_ARGS"
UNS=""; for u in TRIVO_VERIFY_TEST $ALLOV; do UNS="$UNS -u $u"; done      # start from a clean environment: only the ONE override under test is set
for v in $ALLOV; do
  out=$(env $UNS "$v=x" bash "$HR" "$H1" "$H2" "$H3" "$H4" 2>&1); rc=$?
  check "X20 production mode refuses the override $v" "rc!=0; 'test overrides are refused'" "rc=$rc; $(echo "$out" | grep -o 'REFUSING: [^;]*' | head -1 | cut -c1-90)" $([ $rc != 0 ] && echo "$out" | grep -q "$v is set; test overrides are refused"; echo $?)
done
out=$(env $UNS TRIVO_VERIFY_NETWORK= bash "$HR" "$H1" "$H2" "$H3" "$H4" 2>&1); rc=$?
check "X21 production mode refuses an EMPTY network override (would drop --network)" "rc!=0; refused" "rc=$rc; $(echo "$out" | grep -o 'REFUSING: [^;]*' | head -1 | cut -c1-90)" $([ $rc != 0 ] && echo "$out" | grep -q 'TRIVO_VERIFY_NETWORK is set'; echo $?)
# the real run
rc=$(run "$H1" "$H2" "$H3" "$H4")
cp "$W/last.out" "$W/success.out"
check "X11 success: rc=0, one new bundle, VERIFIED_BUNDLE printed" "rc=0; bundles=1; VERIFIED_BUNDLE" "rc=$rc; bundles=$(nb); $(grep -o 'VERIFIED_BUNDLE .*' "$W/success.out" | cut -c1-90)" $([ "$rc" = 0 ] && [ "$(nb)" = 1 ] && grep -q '^VERIFIED_BUNDLE' "$W/success.out"; echo $?)
check "X12 the database password appears nowhere in the stdout/log files" "absent" "searched stdout and $(ls "$OUT" | grep -c '^run-.*log') log file(s)" $(! grep -rqF -- "$BK_PW" "$W/success.out" "$OUT"/run-*.log; echo $?)
check "X13 the host_run output shows the image id and the reviewed-hash confirmation" "present" "$(grep -o 'image postgres:16-alpine = sha256:[0-9a-f]\{12\}' "$W/success.out" | head -1); $(grep -c 'script hashes match' "$W/success.out") hash line" $(grep -q 'script hashes match' "$W/success.out" && grep -q 'image postgres:16-alpine = sha256:' "$W/success.out"; echo $?)
check "X11b the post-publication verification used a real pg_restore -l listing and the strict checks" "present" "$(grep -c 'TEST mode: file-mode checks skipped' "$W/success.out") test-mode line; verified bundle line $(grep -c '^VERIFIED_BUNDLE' "$W/success.out")" $(grep -q '^VERIFIED_BUNDLE' "$W/success.out"; echo $?)
B=$(ls -d "$OUT"/bundle-* | head -1)
out=$(bash "$HERE/../restore-manifest.sh" --verify-only "$B" 2>&1); rc=$?
check "X14 the bundle written by host_run.sh passes the local transferred-bundle verification" "rc=0" "rc=$rc; $(echo "$out" | tail -1)" $([ $rc = 0 ]; echo $?)
check "X15 a failed pre-check never started a container: all refusals happened with 0 bundles and the staging dir is absent" "no .tmp-*" "$(ls -A "$OUT" | grep -c '^\.tmp-') staging dirs" $([ "$(ls -A "$OUT" | grep -c '^\.tmp-')" = 0 ]; echo $?)
summary; echo "work dir: $W"
