#!/usr/bin/env bash
# Tests preflight_host.sh locally (docker + the throw-away PG16 test container on the default bridge network). It is READ-ONLY by design;
# nothing here contacts production.   TRIVO_TEST_LOGS=<dir> bash tests/t7_preflight.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export MSYS_NO_PATHCONV=1
: "${TRIVO_TEST_LOGS:?}"
W="$TRIVO_TEST_LOGS/t7_$(date -u +%H%M%S)"; mkdir -p "$W"
PF="$HERE/../preflight_host.sh"
printf 'BACKUP_PW=fake-test-password-123\n' > "$W/env_ok"
BASE=(TRIVO_PREFLIGHT_TEST=1 TRIVO_PREFLIGHT_NO_SYSTEMD=1 TRIVO_PREFLIGHT_NOW_HHMM_IST=1200 TRIVO_PREFLIGHT_NETWORK=bridge TRIVO_PREFLIGHT_PGHOST=trivo_pg16_snaptest
      "TRIVO_PREFLIGHT_ENV_FILE=$W/env_ok" "TRIVO_PREFLIGHT_OUT=$W/does-not-exist-yet")
run() { env -i HOME="$HOME" PATH="$PATH" "${BASE[@]}" "$@" bash "$PF" > "$W/last.out" 2>&1; echo $?; }
want_fail() { local rc; rc=$(run "${@:3}"); check "$1" "rc=1; '$2'; no PREFLIGHT OK" "rc=$rc; $(grep -o 'PREFLIGHT FAILED: .*' "$W/last.out" | head -1 | cut -c1-110)" $([ "$rc" = 1 ] && grep -qF -- "$2" "$W/last.out" && ! grep -q 'PREFLIGHT OK' "$W/last.out"; echo $?); }
rc=$(run); check "Q0 every check holds -> PREFLIGHT OK, rc=0" "rc=0; PREFLIGHT OK" "rc=$rc; $(tail -1 "$W/last.out")" $([ "$rc" = 0 ] && tail -1 "$W/last.out" | grep -q 'PREFLIGHT OK'; echo $?)
check "Q0b it lists the network members and says this is not isolation" "present" "$(grep -c 'is not isolation' "$W/last.out") line" $(grep -q 'not isolation' "$W/last.out"; echo $?)
check "Q0c it prints no password" "absent" "$(grep -c 'fake-test-password' "$W/last.out") matches" $(! grep -q 'fake-test-password' "$W/last.out"; echo $?)
want_fail Q1 "too close to the 02:15 IST nightly backup" TRIVO_PREFLIGHT_NOW_HHMM_IST=0215
want_fail Q2 "image postgres:99-none is not present locally" TRIVO_PREFLIGHT_IMAGE=postgres:99-none
want_fail Q3 "docker network trivo_no_such_net does not exist" TRIVO_PREFLIGHT_NETWORK=trivo_no_such_net
want_fail Q4 "no container on network bridge answers to the database host name 'postgres'" TRIVO_PREFLIGHT_PGHOST=postgres
: > "$W/env_none"; want_fail Q5 "exactly one BACKUP_PW= line" "TRIVO_PREFLIGHT_ENV_FILE=$W/env_none"
printf 'BACKUP_PW=a\nBACKUP_PW=b\n' > "$W/env_dup"; want_fail Q6 "exactly one BACKUP_PW= line" "TRIVO_PREFLIGHT_ENV_FILE=$W/env_dup"
printf 'BACKUP_PW=\n' > "$W/env_empty"; want_fail Q7 "BACKUP_PW is empty" "TRIVO_PREFLIGHT_ENV_FILE=$W/env_empty"
want_fail Q8 "is not readable" "TRIVO_PREFLIGHT_ENV_FILE=$W/no-such-file"
mkdir -p "$W/already"; want_fail Q9 "already exists" "TRIVO_PREFLIGHT_OUT=$W/already"
# fail-fast: the first failure stops the script - a time-window refusal must not have run (or printed) any later check
run TRIVO_PREFLIGHT_NOW_HHMM_IST=0215 >/dev/null
check "Q10 fail-fast: after the time-window refusal no later check ran (no image / network line)" "no 'image ' or 'network ' line" "$(grep -c '^image \|^network ' "$W/last.out") such lines" $(! grep -q '^image \|^network ' "$W/last.out"; echo $?)
# production mode: no override may be honoured
out=$(env -i HOME="$HOME" PATH="$PATH" TRIVO_PREFLIGHT_NETWORK=bridge bash "$PF" 2>&1); rc=$?
check "Q11 without TRIVO_PREFLIGHT_TEST=1 an override is refused" "rc=1; 'test overrides are refused'" "rc=$rc; $(echo "$out" | grep -o 'PREFLIGHT FAILED: .*' | head -1 | cut -c1-100)" $([ $rc = 1 ] && echo "$out" | grep -q 'test overrides are refused'; echo $?)
out=$(env -i HOME="$HOME" PATH="$PATH" bash -c 'bash -s' < "$PF" 2>&1); rc=$?
check "Q12 it works when piped on stdin (the way ssh runs it): same refusal logic, never a silent pass" "rc!=0 here (no root/systemd/prod paths on this machine) and a PREFLIGHT FAILED reason" "rc=$rc; $(echo "$out" | grep -o 'PREFLIGHT FAILED: .*' | head -1 | cut -c1-110)" $([ $rc != 0 ] && echo "$out" | grep -q 'PREFLIGHT FAILED'; echo $?)
out=$(env -i HOME="$HOME" PATH="$PATH" "${BASE[@]}" bash -s < "$PF" 2>&1); rc=$?
check "Q13 piped on stdin exactly like ssh does (no command swallows the rest of the script): PREFLIGHT OK" "rc=0; PREFLIGHT OK as the last line" "rc=$rc; $(echo "$out" | tail -1)" $([ $rc = 0 ] && echo "$out" | tail -1 | grep -q 'PREFLIGHT OK'; echo $?)
summary; echo "work dir: $W"
