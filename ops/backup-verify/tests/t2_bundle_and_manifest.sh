#!/usr/bin/env bash
# Restore-side tests that need NO database: bundle verification (--verify-only) against forged/damaged bundles, and strict
# manifest validation. Then (needs the local PG18 cluster + an already restored scratch database) manifest-vs-database comparison.
#   BUNDLE=<good bundle dir> OTHER_BUNDLE=<a bundle from another snapshot> RESTORED_DB=<scratch db restored from BUNDLE> \
#   TRIVO_TEST_LOGS=<dir> bash tests/t2_bundle_and_manifest.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
export TARGET=pg18 TRIVO_TEST_SECRETS=${TRIVO_TEST_SECRETS:-}; . "$HERE/env.sh"
: "${BUNDLE:?}" "${OTHER_BUNDLE:?}" "${TRIVO_TEST_LOGS:?}"
W="$TRIVO_TEST_LOGS/t2_$(date -u +%H%M%S)"; mkdir -p "$W"
RM="$HERE/../restore-manifest.sh"
TAB=$'\t'
DBS_BEFORE="$(sup -c "select count(*) from pg_database")"

variant() { rm -rf "$W/$1"; cp -a "$BUNDLE" "$W/$1"; echo "$W/$1"; }
regen() { ( cd "$1" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); }
fixmarker() { # make the marker's own hashes agree with the files (a forger who knows the format would do this)
  local d="$1" ds ms db; ds=$(sha256sum "$d/trivo_snap.dump" | cut -d' ' -f1); ms=$(sha256sum "$d/manifest.tsv" | cut -d' ' -f1); db=$(wc -c < "$d/trivo_snap.dump" | tr -d ' ')
  sed -i "s/^dump_sha256${TAB}.*/dump_sha256${TAB}$ds/; s/^manifest_sha256${TAB}.*/manifest_sha256${TAB}$ms/; s/^dump_bytes${TAB}.*/dump_bytes${TAB}$db/" "$d/SNAPSHOT_OK"
}
bad() { # bad NAME DIR WANT_TEXT : verify-only must fail with that text, and must not have contacted any database
  local out rc; out=$(bash "$RM" --verify-only "$2" 2>&1); rc=$?
  check "$1" "rc!=0; '$3'; no database contacted" "rc=$rc; $(echo "$out" | grep -E 'bundle:|marker:|manifest:|REFUSING|FAILED|WARNING' | head -2 | tr '\n' '|' | cut -c1-170)" $([ $rc != 0 ] && echo "$out" | grep -qF -- "$3" && ! echo "$out" | grep -q 'BUNDLE VERIFIED'; echo $?)
}

echo "################ F. BUNDLE VERIFICATION (--verify-only) of the GOOD bundle and of forged/damaged copies"
out=$(bash "$RM" --verify-only "$BUNDLE" 2>&1); rc=$?
check "F0 good bundle verifies" "rc=0; BUNDLE VERIFIED" "rc=$rc; $(echo "$out" | tail -1)" $([ $rc = 0 ] && echo "$out" | grep -q 'BUNDLE VERIFIED'; echo $?)
d=$(variant f1); echo x > "$d/evil.sh";                                              bad "F1 extra file in the bundle" "$d" "unexpected contents"
d=$(variant f2); rm "$d/SNAPSHOT_OK";                                                 bad "F2 success marker missing" "$d" "unexpected contents"
d=$(variant f3); rm "$d/SHA256SUMS";                                                  bad "F3 SHA256SUMS missing" "$d" "unexpected contents"
d=$(variant f4); printf 'X' >> "$d/trivo_snap.dump";                                  bad "F4 dump altered after checksumming" "$d" "checksum verification FAILED"
d=$(variant f5); sed -i '0,/^accounts'"$TAB"'/s/^accounts'"$TAB"'.*/accounts'"$TAB"'1/' "$d/manifest.tsv"; bad "F5 manifest edited after checksumming" "$d" "checksum verification FAILED"
d=$(variant f6); sed -i '0,/^accounts'"$TAB"'/s/^accounts'"$TAB"'.*/accounts'"$TAB"'1/' "$d/manifest.tsv"; regen "$d"; bad "F6 manifest edited AND checksums regenerated (marker still binds the original)" "$d" "marker manifest_sha256 differs"
d=$(variant f7); sed -i "s/^snapshot_id${TAB}.*/snapshot_id${TAB}00000001-00000001-1/" "$d/SNAPSHOT_OK"; regen "$d"; bad "F7 marker names another snapshot id (checksums regenerated)" "$d" "marker snapshot_id differs"
d=$(variant f8); grep -v 'manifest.tsv' "$d/SHA256SUMS" > "$d/s.tmp" && mv "$d/s.tmp" "$d/SHA256SUMS"; bad "F8 SHA256SUMS does not cover the manifest" "$d" "SHA256SUMS"
d=$(variant f9); echo "$(sha256sum "$d/manifest.tsv" | cut -d' ' -f1)  extra.txt" >> "$d/SHA256SUMS"; bad "F9 SHA256SUMS has an extra line" "$d" "SHA256SUMS"
d=$(variant f10); sed -i '1s/^./Z/' "$d/SHA256SUMS"; bad "F10 SHA256SUMS has a malformed hash" "$d" "SHA256SUMS"
d=$(variant f11); cp "$OTHER_BUNDLE/trivo_snap.dump" "$d/trivo_snap.dump"; regen "$d"; bad "F11 dump from ANOTHER snapshot swapped in (checksums regenerated)" "$d" "marker dump_sha256 differs"
d=$(variant f12); cp "$OTHER_BUNDLE/manifest.tsv" "$d/manifest.tsv"; regen "$d"; bad "F12 manifest from ANOTHER snapshot swapped in (checksums regenerated)" "$d" "marker"
d=$(variant f13); head -c 8192 "$d/trivo_snap.dump" > "$d/t" && mv "$d/t" "$d/trivo_snap.dump"; fixmarker "$d"; regen "$d"; bad "F13 truncated dump, everything else made consistent" "$d" "dump is not readable"
d=$(variant f14); sed -i 's/$/\r/' "$d/manifest.tsv"; fixmarker "$d"; regen "$d"; bad "F14 CRLF manifest, everything else made consistent" "$d" "contains CR"
d=$(variant f15); sed -i "s/^accounts${TAB}/accountz${TAB}/" "$d/manifest.tsv"; fixmarker "$d"; regen "$d"; bad "F15 manifest names a table the dump does not hold (fully consistent forgery)" "$d" "table(s) in the dump but not in the manifest"
d=$(variant f16); rm "$d/manifest.tsv"; ln -s /etc/hostname "$d/manifest.tsv" 2>/dev/null || cp "$d/SNAPSHOT_OK" "$d/manifest.tsv"; bad "F16 manifest replaced by a symlink/other file" "$d" "bundle:"
d=$(variant f17); sed -i '$d' "$d/SNAPSHOT_OK"; regen "$d"; bad "F17 success marker truncated (no #end ok)" "$d" "marker:"
d=$(variant f18); sed -i "s/^dump_file${TAB}.*/dump_file${TAB}other.dump/" "$d/SNAPSHOT_OK"; regen "$d"; bad "F18 marker points at a different dump file name" "$d" "dump_file"
d=$(variant f19); sed -i "s/^database${TAB}.*/database${TAB}someotherdb/" "$d/SNAPSHOT_OK"; regen "$d"; bad "F19 marker names a different database than the manifest" "$d" "marker database differs"
bad "F20 nonexistent directory" "$W/does-not-exist" "not a directory"
mkdir -p "$W/empty"; bad "F21 empty directory" "$W/empty" "unexpected contents"
# the full (database) form must also refuse a bad bundle BEFORE creating anything
d=$(variant f22); printf 'X' >> "$d/trivo_snap.dump"
out=$(bash "$RM" "$d" trivo_prodverify_never_created 2>&1); rc=$?
check "F22 restore form with a damaged bundle refuses before any database exists" "rc!=0; REFUSING; database count unchanged; no such database" "rc=$rc; dbs $DBS_BEFORE -> $(sup -c 'select count(*) from pg_database'); exists=$(sup -c "select count(*) from pg_database where datname='trivo_prodverify_never_created'")" $([ $rc != 0 ] && echo "$out" | grep -q 'REFUSING' && [ "$(sup -c 'select count(*) from pg_database')" = "$DBS_BEFORE" ]; echo $?)

echo "################ G. STRICT MANIFEST VALIDATION (validate_manifest) and COMPARISON with a restored database"
. "$HERE/../manifest_check.sh"
GOOD="$BUNDLE/manifest.tsv"; T="$W/mt"; mkdir -p "$T"
URL="postgresql://trivo_backup:${BK_PW}@${T_HOST}:${T_PORT}/${RESTORED_DB}${T_SSL}"
psql() { command psql "$@" | tr -d '\r'; }
mv_() { # mv_ pass|fail NAME FILE : compare_manifest outcome
  local want="$1" name="$2" file="$3" out rc; out=$(compare_manifest "$file" "$URL" 2>&1); rc=$?
  check "G $name" "$want" "rc=$rc: $(echo "$out" | head -2 | tr '\n' '|' | cut -c1-150)" $({ [ "$want" = pass ] && [ $rc = 0 ]; } || { [ "$want" = fail ] && [ $rc != 0 ]; }; echo $?)
}
mk() { cp "$GOOD" "$T/$1"; }
mv_ pass "valid manifest vs the restored database" "$GOOD"
mk crlf.tsv;     sed -i 's/$/\r/' "$T/crlf.tsv";                                    mv_ fail "CRLF line endings" "$T/crlf.tsv"
: > "$T/empty.tsv";                                                                  mv_ fail "empty file" "$T/empty.tsv"
mk nohdr.tsv;    sed -i '1d' "$T/nohdr.tsv";                                         mv_ fail "missing format header" "$T/nohdr.tsv"
mk ver.tsv;      sed -i '1s/v2/v1/' "$T/ver.tsv";                                    mv_ fail "wrong version (v1)" "$T/ver.tsv"
mk noend.tsv;    sed -i '$d' "$T/noend.tsv";                                         mv_ fail "truncated: no #end" "$T/noend.tsv"
mk trunc.tsv;    head -n 60 "$GOOD" > "$T/trunc.tsv";                                mv_ fail "truncated mid-file" "$T/trunc.tsv"
for h in '#database' '#server_version' '#snapshot_id' '#pg_snapshot' '#txn_start_utc' '#relation_set' '#table_count' '#tenant_isolation_policies' '#forced_rls_tables' '#composite_company_fks'; do
  mk "no$h.tsv"; sed -i "/^$h${TAB}/d" "$T/no$h.tsv";                                mv_ fail "missing $h header" "$T/no$h.tsv"
done
mk dup.tsv;      sed -i '/^#database/p' "$T/dup.tsv";                                mv_ fail "duplicate #database header" "$T/dup.tsv"
mk unk.tsv;      sed -i "/^#database/a #surprise${TAB}x" "$T/unk.tsv";               mv_ fail "unknown header line" "$T/unk.tsv"
mk rel.tsv;      sed -i "s/^#relation_set.*/#relation_set${TAB}schema public; everything/" "$T/rel.tsv"; mv_ fail "different relation_set definition" "$T/rel.tsv"
mk badsnap.tsv;  sed -i "s/^#snapshot_id${TAB}.*/#snapshot_id${TAB}garbage/" "$T/badsnap.tsv"; mv_ fail "malformed #snapshot_id" "$T/badsnap.tsv"
mk badts.tsv;    sed -i "s/^#txn_start_utc${TAB}.*/#txn_start_utc${TAB}yesterday/" "$T/badts.tsv"; mv_ fail "malformed #txn_start_utc" "$T/badts.tsv"
mk nonumpol.tsv; sed -i "s/^#tenant_isolation_policies${TAB}.*/#tenant_isolation_policies${TAB}many/" "$T/nonumpol.tsv"; mv_ fail "non-numeric #tenant_isolation_policies" "$T/nonumpol.tsv"
mk duprow.tsv;   L=$(grep -vm1 '^#' "$GOOD"); sed -i "/^#end/i $L" "$T/duprow.tsv"; mv_ fail "duplicate table row" "$T/duprow.tsv"
mk nonnum.tsv;   sed -i "0,/^accounts${TAB}/s/^accounts${TAB}.*/accounts${TAB}abc/" "$T/nonnum.tsv"; mv_ fail "non-numeric count" "$T/nonnum.tsv"
mk neg.tsv;      sed -i "0,/^accounts${TAB}/s/^accounts${TAB}.*/accounts${TAB}-1/" "$T/neg.tsv"; mv_ fail "negative count" "$T/neg.tsv"
mk cols.tsv;     sed -i "0,/^accounts${TAB}/s/^accounts${TAB}.*/accounts${TAB}270${TAB}extra/" "$T/cols.tsv"; mv_ fail "extra column" "$T/cols.tsv"
mk blank.tsv;    sed -i '/^#end/i \\' "$T/blank.tsv";                                mv_ fail "blank line" "$T/blank.tsv"
mk badname.tsv;  sed -i "0,/^accounts${TAB}/s/^accounts${TAB}/acc ounts;drop${TAB}/" "$T/badname.tsv"; mv_ fail "illegal table name" "$T/badname.tsv"
mk tc.tsv;       sed -i "s/^#table_count${TAB}.*/#table_count${TAB}999/" "$T/tc.tsv"; mv_ fail "#table_count mismatch" "$T/tc.tsv"
# structurally VALID manifests that disagree with the restored database (the parser alone must not be what catches these)
mk mism.tsv;     sed -i "0,/^accounts${TAB}/s/^accounts${TAB}.*/accounts${TAB}$(( $(awk -F'\t' '$1=="accounts"{print $2}' "$GOOD") + 1 ))/" "$T/mism.tsv"; mv_ fail "count mismatch (+1 in accounts)" "$T/mism.tsv"
mk mism0.tsv;    sed -i "s/^snap_probe${TAB}.*/snap_probe${TAB}999/" "$T/mism0.tsv"; mv_ fail "count mismatch (a live count instead of the snapshot count)" "$T/mism0.tsv"
mk missing.tsv;  sed -i '/^approval_history\t/d; s/^#table_count\t.*/#table_count\t140/; s/^#end\t.*/#end\t140/' "$T/missing.tsv"
                 sed -i "/^approval_history${TAB}/d; s/^#table_count${TAB}.*/#table_count${TAB}140/; s/^#end${TAB}.*/#end${TAB}140/" "$T/missing.tsv"; mv_ fail "table missing from the manifest (restored has it)" "$T/missing.tsv"
mk extra.tsv;    sed -i "/^#end/i ghost_table${TAB}0" "$T/extra.tsv"; sed -i "s/^#table_count${TAB}.*/#table_count${TAB}142/; s/^#end${TAB}.*/#end${TAB}142/" "$T/extra.tsv"; mv_ fail "extra table in the manifest (restored lacks it)" "$T/extra.tsv"
echo "        databases before/after these tests: $DBS_BEFORE / $(sup -c 'select count(*) from pg_database') (no database was created or dropped)"
check "G-end no database was created by the no-database tests" "unchanged" "$DBS_BEFORE -> $(sup -c 'select count(*) from pg_database')" $([ "$(sup -c 'select count(*) from pg_database')" = "$DBS_BEFORE" ]; echo $?)
summary; echo "work dir: $W"
