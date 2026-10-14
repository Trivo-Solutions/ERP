#!/usr/bin/env bash
# Tests for the hardening pass that need NO restore and NO production contact:
#   L  local_restore_env.sh fails closed (fake credential dir + fake psql shim; the real cluster is not touched by these cases)
#   X  parse_xref_result (cross-company scan output parsing)
#   M  validate_marker strictness     T  validate_dump_toc against REAL `pg_restore -l` output     P  policy/RLS-flag normalisation
#   BUNDLE=<good bundle dir> TRIVO_TEST_LOGS=<dir> bash tests/t6_hardening_nodb.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export MSYS_NO_PATHCONV=1 PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"; export PATH="$PG_BIN:$PATH"
: "${BUNDLE:?good bundle dir}" "${TRIVO_TEST_LOGS:?}"
W="$TRIVO_TEST_LOGS/t6_$(date -u +%H%M%S)"; mkdir -p "$W"; TAB=$'\t'
. "$HERE/../manifest_check.sh"

echo "################ L. local_restore_env.sh fails closed"
FAKE_PW='Sup3r/p@ss:w?rd#100%é'          # deliberately full of URL-special characters
FAKE_BK='bk pw&=+;,'
mkdir -p "$W/shim" "$W/sec"
cat > "$W/shim/psql" <<'SH'
#!/usr/bin/env bash
# fake psql: logs the connection URL (fake credentials only) and answers by SHIM_MODE
echo "$1" >> "${SHIM_LOG:-/dev/null}"
case "${SHIM_MODE:-ok}" in
  ok) case "$*" in *system_identifier*) echo 7689165615054069924;; *server_version*) echo 18.1;; esac;;
  fail) exit 2;; empty) ;; garbage) echo "not-a-number";; crlf) case "$*" in *system_identifier*) printf '123\r\n';; *) printf '18.1\r\n';; esac;;
esac
SH
chmod +x "$W/shim/psql"
mksec() { # mksec DIR : a complete, valid fake credential directory
  mkdir -p "$1"; printf '%s\n' "$FAKE_PW" > "$1/superpw.txt"; printf '%s\r\n' "$FAKE_BK" > "$1/backup-pw.txt"
  printf 'DATABASE_URL=postgresql://trivo_runtime:rt%%40pw-1@localhost:54329/trivo_rlstest\nOWNER_DATABASE_URL="postgresql://trivo_owner:ow%%2Fn-2@localhost:54329/trivo_rlstest"\nJWT_SECRET=x\n' > "$1/rlstest.env"
}
runenv() { # runenv DIR [VAR=VAL ...] -> prints "rc|<state>"; output of the sourced script goes to $W/last.out
  local d="$1"; shift
  env -i HOME="$HOME" PATH="$PATH" TRIVO_LOCAL_SECRETS_DIR="$d" PG_BIN="$W/shim" SHIM_LOG="$W/shim.log" "$@" bash -c '
    ADMIN_DATABASE_URL=stale-from-an-earlier-run; RESTORE_EXPECT_SYSTEM_IDENTIFIER=stale
    . '"$HERE"'/../local_restore_env.sh; rc=$?
    n=0; for v in ADMIN_DATABASE_URL OWNER_DATABASE_URL SOURCE_DATABASE_URL RUNTIME_DATABASE_URL_TEMPLATE RESTORE_EXPECT_PORT RESTORE_EXPECT_SYSTEM_IDENTIFIER; do [ -n "${!v:-}" ] && n=$((n+1)); done
    echo "STATE rc=$rc setvars=$n"' > "$W/last.out" 2>&1
  grep -o 'STATE rc=[0-9]* setvars=[0-9]*' "$W/last.out"
}
refuse() { # refuse NAME DIR [env...]: must return rc=1 with NO managed variable left set (even the preset stale ones), and print no secret
  local n="$1" d="$2"; shift 2; local st; st="$(runenv "$d" "$@")"
  local leak=0; for s in "$FAKE_PW" "$FAKE_BK" 'rt%40pw-1' 'ow%2Fn-2' 'rt@pw-1' 'ow/n-2'; do grep -qF -- "$s" "$W/last.out" && leak=1; done
  check "$n" "rc=1, setvars=0, no secret in the output" "$st; leak=$leak" $([ "$st" = "STATE rc=1 setvars=0" ] && [ $leak = 0 ]; echo $?)
}
mksec "$W/sec/good"
: > "$W/shim.log"; st="$(runenv "$W/sec/good")"
check "L0 a complete valid environment succeeds and exports every variable" "rc=0, 6 URL/port/id vars set" "$st" $([ "$st" = "STATE rc=0 setvars=6" ]; echo $?)
enc_pw="$(grep -o 'postgres:[^@]*@' "$W/shim.log" | head -1)"
check "L0b special characters in the plain-text password are percent-encoded in the URL (nothing raw)" "postgres:Sup3r%2Fp%40ss%3Aw%3Frd%23100%25%C3%A9@" "$enc_pw" $([ "$enc_pw" = "postgres:Sup3r%2Fp%40ss%3Aw%3Frd%23100%25%C3%A9@" ]; echo $?)
check "L0c the script printed no password or URL" "absent" "$(grep -c . "$W/last.out") output line(s)" $(! grep -qE 'Sup3r|rt%40|ow%2F|postgresql://' "$W/last.out"; echo $?)
check "L0d a CRLF identity answer from psql is accepted (Windows psql)" "rc=0" "$(runenv "$W/sec/good" SHIM_MODE=crlf)" $([ "$(runenv "$W/sec/good" SHIM_MODE=crlf)" = "STATE rc=0 setvars=6" ]; echo $?)
mksec "$W/sec/c1"; rm "$W/sec/c1/superpw.txt";                 refuse L1 "$W/sec/c1"
mksec "$W/sec/c2"; : > "$W/sec/c2/backup-pw.txt";              refuse L2 "$W/sec/c2"
mksec "$W/sec/c3"; printf 'one\ntwo\n' > "$W/sec/c3/superpw.txt"; refuse L3 "$W/sec/c3"
mksec "$W/sec/c4"; printf '\n\n' > "$W/sec/c4/backup-pw.txt";  refuse L4 "$W/sec/c4"
mksec "$W/sec/c5"; grep -v '^OWNER_DATABASE_URL' "$W/sec/c5/rlstest.env" > "$W/sec/c5/t" && mv "$W/sec/c5/t" "$W/sec/c5/rlstest.env"; refuse L5 "$W/sec/c5"
mksec "$W/sec/c6"; echo 'DATABASE_URL=postgresql://trivo_runtime:dup@localhost:54329/x' >> "$W/sec/c6/rlstest.env"; refuse L6 "$W/sec/c6"
mksec "$W/sec/c7"; sed -i 's#trivo_runtime:#trivo_backup:#' "$W/sec/c7/rlstest.env"; refuse L7 "$W/sec/c7"
mksec "$W/sec/c8"; sed -i 's#rt%40pw-1@#rt@pw@1@#' "$W/sec/c8/rlstest.env"; refuse L8 "$W/sec/c8"
mksec "$W/sec/c9"; sed -i 's#rt%40pw-1#rt%4#' "$W/sec/c9/rlstest.env"; refuse L9 "$W/sec/c9"
mksec "$W/sec/c10"; sed -i 's#^DATABASE_URL=.*#DATABASE_URL=not-a-url#' "$W/sec/c10/rlstest.env"; refuse L10 "$W/sec/c10"
mksec "$W/sec/c11"; sed -i 's#^DATABASE_URL=.*#DATABASE_URL=#' "$W/sec/c11/rlstest.env"; refuse L11 "$W/sec/c11"
refuse L12 "$W/sec/does-not-exist"
refuse L13 "$W/sec/good" SHIM_MODE=fail
refuse L14 "$W/sec/good" SHIM_MODE=empty
refuse L15 "$W/sec/good" SHIM_MODE=garbage
mkdir -p "$W/emptybin"; refuse L16 "$W/sec/good" PG_BIN="$W/emptybin"
refuse L17 "$W/sec/good" TRIVO_LOCAL_PORT=abc
out="$(env -i HOME="$HOME" PATH="$PATH" bash "$HERE/../local_restore_env.sh" 2>&1)"; rc=$?
check "L18 executing (instead of sourcing) the script is refused" "rc=2 and a message" "rc=$rc; $(echo "$out" | head -1 | cut -c1-80)" $([ $rc = 2 ]; echo $?)

echo "################ X. parse_xref_result"
GOODX=$'NOTICE:  XREF_RESULT checked=57 violations=0'
VIOX=$'NOTICE:  VIOLATION invoices -> clients (fk1): 3 rows\nNOTICE:  VIOLATION memos -> clients (fk2): 2 rows\nNOTICE:  XREF_RESULT checked=57 violations=5'
xt() { local n="$1" want="$2" out="$3" r rc; XCHK=""; XVIO=""; r="$(parse_xref_result "$out")"; rc=$?; parse_xref_result "$out" >/dev/null; check "$n" "$want" "rc=$rc [$r] XCHK=${XCHK:-} XVIO=${XVIO:-}" $({ [ "$want" = ok ] && [ $rc = 0 ]; } || { [ "$want" = fail ] && [ $rc != 0 ]; }; echo $?); }
xt X1 ok "$GOODX"
parse_xref_result "$GOODX" >/dev/null; check "X1b values parsed" "checked=57 violations=0" "checked=$XCHK violations=$XVIO" $([ "$XCHK" = 57 ] && [ "$XVIO" = 0 ]; echo $?)
xt X2 ok "$VIOX"
parse_xref_result "$VIOX" >/dev/null; check "X2b violations counted and cross-checked" "violations=5" "violations=$XVIO" $([ "$XVIO" = 5 ]; echo $?)
xt X3 fail ""
xt X4 fail $'NOTICE:  something else'
xt X5 fail "$GOODX"$'\n'"$GOODX"
xt X6 fail $'ERROR:  boom\nNOTICE:  XREF_RESULT checked=57 violations=0'
xt X7 fail $'psql:<stdin>:3: ERROR:  permission denied\n'"$GOODX"
xt X8 fail $'WARNING:  XREF_RESULT checked=57 violations=0'
xt X9 fail $'NOTICE:  XREF_RESULT checked=57 violations=0 extra'
xt X10 fail $'NOTICE:  XREF_RESULT checked=abc violations=0'
xt X11 fail $'NOTICE:  XREF_RESULT checked=57'
xt X12 fail $'NOTICE:  VIOLATION invoices -> clients (fk1): 3 rows\nNOTICE:  XREF_RESULT checked=57 violations=0'
xt X13 fail $'NOTICE:  XREF_RESULT checked=57 violations=7\nNOTICE:  VIOLATION invoices -> clients (fk1): 3 rows'
xt X14 fail $'NOTICE:  XREF_RESULT checked=57 violations=2'
xt X15 fail $'  NOTICE:  XREF_RESULT checked=57 violations=0'

echo "################ M. validate_marker (strict)"
GM="$BUNDLE/SNAPSHOT_OK"
mt() { # mt NAME WANT(ok|fail) FILE
  local out rc; out="$(validate_marker "$3" 2>&1)"; rc=$?
  check "$1" "$2" "rc=$rc $(echo "$out" | head -1 | cut -c1-110)" $({ [ "$2" = ok ] && [ $rc = 0 ]; } || { [ "$2" = fail ] && [ $rc != 0 ]; }; echo $?)
}
mm() { cp "$GM" "$W/m_$1"; echo "$W/m_$1"; }
mt M0 ok "$GM"
f=$(mm dup);    sed -i "/^database${TAB}/p" "$f";                                   mt M1 fail "$f"
f=$(mm dup2);   sed -i "s/^server_version${TAB}.*/database${TAB}other/" "$f";        mt M2 fail "$f"
f=$(mm unk);    sed -i "/^database${TAB}/a surprise${TAB}x" "$f";                    mt M3 fail "$f"
f=$(mm order);  awk -F'\t' 'NR==2{a=$0;next} NR==3{print;print a;next}{print}' "$GM" > "$f"; mt M4 fail "$f"
f=$(mm blank);  sed -i '/^table_count/a \\' "$f";                                   mt M5 fail "$f"
f=$(mm xtra);   sed -i "s/^dump_file${TAB}.*/dump_file${TAB}trivo_snap.dump${TAB}extra/" "$f"; mt M6 fail "$f"
f=$(mm empty);  sed -i "s/^completed_utc${TAB}.*/completed_utc${TAB}/" "$f";        mt M7 fail "$f"
f=$(mm trail);  sed -i "s/^database${TAB}\(.*\)/database${TAB}\1 /" "$f";            mt M8 fail "$f"
f=$(mm nonl);   printf '%s' "$(cat "$GM")" > "$f";                                    mt M9 fail "$f"
f=$(mm crlf);   sed -i 's/$/\r/' "$f";                                               mt M10 fail "$f"
f=$(mm sha);    sed -i "s/^dump_sha256${TAB}./dump_sha256${TAB}Z/" "$f";             mt M11 fail "$f"
f=$(mm cmt);    sed -i "1a # a comment" "$f";                                         mt M12 fail "$f"
f=$(mm case);   sed -i "s/^database${TAB}/Database${TAB}/" "$f";                      mt M13 fail "$f"
f=$(mm ver);    sed -i "s/^server_version${TAB}.*/server_version${TAB}sixteen/" "$f"; mt M14 fail "$f"
f=$(mm bytes);  sed -i "s/^dump_bytes${TAB}.*/dump_bytes${TAB}0/" "$f";               mt M15 fail "$f"
f=$(mm nul);    { cat "$GM"; printf 'x\000y\n'; } > "$f";                           mt M16 fail "$f"
f=$(mm after);  echo "extra${TAB}after-end" >> "$f";                                  mt M17 fail "$f"
: > "$W/m_empty"; mt M18 fail "$W/m_empty"
mt M19 fail "$W/does-not-exist"
r=$(mval "$W/m_dup" database) ; rc=$?
check "M20 mval refuses a duplicated key (no value, rc!=0)" "rc!=0, empty" "rc=$rc value='$r'" $([ $rc != 0 ] && [ -z "$r" ]; echo $?)
check "M21 mval returns the value of a unique key" "trivo_prod" "$(mval "$GM" database)" $([ "$(mval "$GM" database)" = trivo_prod ]; echo $?)

echo "################ T. validate_dump_toc against the REAL pg_restore -l listing of the bundle's dump"
TOC="$W/toc.txt"; ( cd "$BUNDLE" && pg_restore -l trivo_snap.dump ) | tr -d '\r' > "$TOC"
check "T-pre the listing is real pg_restore output" "header + entries" "$(grep -c '^;' "$TOC") comment lines, $(grep -vc '^;' "$TOC") entries; first header: $(sed -n 3p "$TOC")" $([ -s "$TOC" ] && grep -q 'Selected TOC Entries' "$TOC"; echo $?)
MAN="$BUNDLE/manifest.tsv"
tt() { local out rc; out="$(validate_dump_toc "$3" "$MAN" "${4:-$GM}" 2>&1)"; rc=$?; check "$1" "$2" "rc=$rc $(echo "$out" | head -1 | cut -c1-120)" $({ [ "$2" = ok ] && [ $rc = 0 ]; } || { [ "$2" = fail ] && [ $rc != 0 ]; }; echo $?); }
tv() { cp "$TOC" "$W/toc_$1"; echo "$W/toc_$1"; }
tt T0 ok "$TOC"
f=$(tv db);    sed -i 's/^;     dbname: trivo_prod$/;     dbname: trivo_other/' "$f";      tt T1 fail "$f"
f=$(tv db2);   sed -i '/dbname:/p' "$f";                                                    tt T2 fail "$f"
f=$(tv fmt);   sed -i 's/Format: CUSTOM/Format: TAR/' "$f";                                  tt T3 fail "$f"
f=$(tv ver);   sed -i 's/Dumped from database version: 16.15/Dumped from database version: 15.4/' "$f"; tt T4 fail "$f"
f=$(tv pgd);   sed -i 's/Dumped by pg_dump version: 16.15/Dumped by pg_dump version: 17.0/' "$f"; tt T5 fail "$f"
f=$(tv nover); sed -i '/Dumped from database version/d' "$f";                                tt T6 fail "$f"
f=$(tv nosel); sed -i '/Selected TOC Entries/d' "$f";                                        tt T7 fail "$f"
f=$(tv tbl);   sed -i '0,/ TABLE DATA public accounts /{/ TABLE DATA public accounts /d}' "$f"; tt T8 fail "$f"
f=$(tv xtbl);  echo '99999; 0 99999 TABLE DATA public ghost_table trivo_owner' >> "$f";      tt T9 fail "$f"
f=$(tv spoof); sed -i 's/^;     dbname: trivo_prod$/;     dbname: trivo_other/' "$f"; echo '; dbname: trivo_prod' >> "$f"; tt T10 fail "$f"
f=$(tv spoof2); sed -i 's/Format: CUSTOM/Format: TAR/' "$f"; echo ';     Format: CUSTOM' >> "$f"; tt T11 fail "$f"
f=$(tv junk);  sed -i '3i garbage line in the header' "$f";                                  tt T12 fail "$f"
: > "$W/toc_empty"; tt T13 fail "$W/toc_empty"
f=$(tv noent); sed '/^; Selected TOC Entries:$/q' "$TOC" > "$f";                            tt T14 fail "$f"
tt T15 ok "$TOC" "$GM"
out="$(PATH=/usr/bin:/bin verify_bundle "$BUNDLE" 2>&1)"; rc=$?
check "T16 verify_bundle with NO listing and NO pg_restore on PATH refuses (does not skip the dump check)" "rc!=0, 'refusing to skip'" "rc=$rc $(echo "$out" | tail -1 | cut -c1-100)" $([ $rc != 0 ] && echo "$out" | grep -q 'refusing to skip'; echo $?)
out="$(verify_bundle "$BUNDLE" "$TOC" 2>&1)"; rc=$?
check "T17 verify_bundle with the real listing passes the good bundle" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)
out="$(verify_bundle "$BUNDLE/" "$TOC" 2>&1)"; rc=$?
check "T18 a trailing slash on the bundle path is accepted for a real directory" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)

echo "################ P. RLS-flag and policy-definition normalisation (dump text vs live catalog text)"
cat > "$W/schema.sql" <<'SQL'
CREATE POLICY tenant_isolation ON public.accounts USING (("companyId" = current_setting('app.tenant_company_id'::text, true))) WITH CHECK (("companyId" = current_setting('app.tenant_company_id'::text, true)));
CREATE POLICY "Odd Name" ON public.t2 AS RESTRICTIVE FOR SELECT TO trivo_runtime, other USING (x > 1);
ALTER TABLE ONLY public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.t2 ENABLE ROW LEVEL SECURITY;
SQL
dump_policy_defs "$W/schema.sql" > "$W/p.dump"
printf '%s\n' "tenant_isolation on public.accounts using ((\"companyId\" = current_setting('app.tenant_company_id'::text, true))) with check ((\"companyId\" = current_setting('app.tenant_company_id'::text, true)))" "Odd Name on public.t2 as restrictive for SELECT to trivo_runtime,other using (x > 1)" | norm_def | LC_ALL=C sort > "$W/p.live"
check "P1 equivalent policy text (extra parentheses/spacing/quotes/case differences) normalises identically" "no diff" "$(diff "$W/p.dump" "$W/p.live" | head -2 | tr '\n' ' ')" $(diff -q "$W/p.dump" "$W/p.live" >/dev/null; echo $?)
printf '%s\n' "tenant_isolation on public.accounts using (true) with check (true)" "Odd Name on public.t2 as restrictive for SELECT to trivo_runtime,other using (x > 1)" | norm_def | LC_ALL=C sort > "$W/p.weak"
check "P2 a weakened USING / WITH CHECK is detected" "diff" "$(diff "$W/p.dump" "$W/p.weak" | grep -c '^[<>]') differing lines" $(! diff -q "$W/p.dump" "$W/p.weak" >/dev/null; echo $?)
dump_rls_flags "$W/schema.sql" > "$W/f.dump"
check "P3 RLS flags parsed per table (enabled+forced vs enabled only)" "accounts|t|t and t2|t|f" "$(tr '\n' ' ' < "$W/f.dump")" $([ "$(tr '\n' ' ' < "$W/f.dump")" = "accounts|t|t t2|t|f " ]; echo $?)
summary; echo "work dir: $W"
