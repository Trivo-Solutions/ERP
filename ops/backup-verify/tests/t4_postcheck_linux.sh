#!/usr/bin/env bash
# Tests bundle_postcheck.sh (the host-side verification) on REAL Linux file permissions/ownership, as root - the same conditions as the
# production host. Run inside WSL2 Ubuntu:
#   wsl -d Ubuntu -u root -- bash /mnt/p/ERP/ops/backup-verify/tests/t4_postcheck_linux.sh /mnt/c/.../bundle-XXXX /mnt/c/.../toc.txt
# toc.txt = the REAL `pg_restore -l` output of that bundle's dump (the host has no pg_restore; host_run.sh makes it with the pinned image).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
SRC="${1:?bundle dir}"; TOCF="${2:?pg_restore -l listing of the bundle dump}"; PC="$HERE/../bundle_postcheck.sh"
[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 2; }
DB="$(grep '^#database' "$SRC/manifest.tsv" | cut -f2)"
W="$(mktemp -d /tmp/trivo_pc_XXXXXX)"; chmod 700 "$W"; echo "work dir (my own, root-only): $W   kernel: $(uname -sr)"
mk() { rm -rf "$W/$1"; cp -a "$SRC" "$W/$1"; chmod 700 "$W/$1"; chmod 600 "$W/$1"/*; chown -R root:root "$W/$1"; echo "$W/$1"; }
bad() { local out rc; out=$(bash "$PC" "$2" "${4:-$DB}" "${5-$TOCF}" 2>&1); rc=$?; check "$1" "rc!=0; '$3'" "rc=$rc; $(echo "$out" | head -1 | cut -c1-150)" $([ $rc != 0 ] && echo "$out" | grep -qF -- "$3"; echo $?); }
out=$(bash "$PC" "$(mk p0)" "$DB" "$TOCF" 2>&1); rc=$?
check "P0 a correct bundle (700 dir, 600 files, root) passes" "rc=0; POSTCHECK OK" "rc=$rc; $out" $([ $rc = 0 ] && echo "$out" | grep -q 'POSTCHECK OK'; echo $?)
d=$(mk p1); chmod 755 "$d";                                   bad "P1 directory mode 755" "$d" "mode 700"
d=$(mk p2); chmod 644 "$d/trivo_snap.dump";                   bad "P2 dump file mode 644" "$d" "must be mode 600"
d=$(mk p3); chmod 640 "$d/SHA256SUMS";                        bad "P3 SHA256SUMS mode 640" "$d" "must be mode 600"
d=$(mk p4); chown nobody "$d/manifest.tsv";                   bad "P4 a file owned by another user" "$d" "owned by root"
d=$(mk p5); chown nobody "$d";                                bad "P5 directory owned by another user" "$d" "owned by root"
d=$(mk p6); echo x > "$d/extra"; chmod 600 "$d/extra";        bad "P6 an extra file" "$d" "exactly the four"
d=$(mk p7); rm "$d/SNAPSHOT_OK";                              bad "P7 a missing file" "$d" "exactly the four"
d=$(mk p8); rm "$d/manifest.tsv"; ln -s /etc/hostname "$d/manifest.tsv"; bad "P8 a symlink instead of the manifest" "$d" "not a regular file"
d=$(mk p9); printf 'X' >> "$d/trivo_snap.dump";             bad "P9 dump altered after checksumming" "$d" "checksum verification FAILED"
d=$(mk p10); sed -i '$d' "$d/SNAPSHOT_OK"; ( cd "$d" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); chmod 600 "$d/SHA256SUMS"; bad "P10 success marker truncated" "$d" "marker:"
d=$(mk p11); echo "# x" >> "$d/SHA256SUMS";                  bad "P11 SHA256SUMS with a 4th line" "$d" "exactly 3 lines"
d=$(mk p12);                                                  bad "P12 the wrong database expected" "$d" "marker names a different database" some_other_db
d=$(mk p13); sed -i "s/^accounts\t.*/accounts\t1/" "$d/manifest.tsv"; ( cd "$d" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); chmod 600 "$d/SHA256SUMS"
                                                              bad "P13 manifest edited and checksums regenerated (marker still binds the original)" "$d" "marker manifest_sha256 differs"
d=$(mk p14); rmdir "$W/nonexistent" 2>/dev/null;              bad "P14 not a bundle directory" "$W/nonexistent" "not a real directory"
d=$(mk p15); ln -s "$W/p15" "$W/p15link"; bad "P15 the bundle path is a SYMLINK to a perfect bundle" "$W/p15link" "symbolic link"
bad "P16 the same symlink given with a trailing slash" "$W/p15link/" "symbolic link"
d=$(mk p17);                                                  bad "P17 no pg_restore listing supplied and no pg_restore on this host: the dump check is refused, not skipped" "$d" "refusing to skip" "$DB" ""
d=$(mk p18); printf 'x' > "$W/empty.toc"; : > "$W/empty.toc";    bad "P18 an empty pg_restore listing" "$d" "missing or empty" "$DB" "$W/empty.toc"
d=$(mk p19); sed -i "s/^;     dbname: .*/;     dbname: another_db/" "$W/toc_bad" 2>/dev/null; cp "$TOCF" "$W/toc_bad"; sed -i "s/^;     dbname: .*/;     dbname: another_db/" "$W/toc_bad"; bad "P19 the dump header (real listing) names another database" "$d" "dump header dbname" "$DB" "$W/toc_bad"
d=$(mk p20); sed -i "/^database	/p" "$d/SNAPSHOT_OK"; ( cd "$d" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); chmod 600 "$d/SHA256SUMS"; bad "P20 marker with a duplicated key (checksums regenerated)" "$d" "appears 2 times"
d=$(mk p21); sed -i "s/^database	.*/database	trivo_prod	extra/" "$d/SNAPSHOT_OK"; ( cd "$d" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); chmod 600 "$d/SHA256SUMS"; bad "P21 marker line with an extra field" "$d" "marker:"
d=$(mk p22); sed -i "s/^snapshot_id	.*/snapshot_id	garbage/" "$d/SNAPSHOT_OK"; ( cd "$d" && sha256sum trivo_snap.dump manifest.tsv SNAPSHOT_OK > SHA256SUMS ); chmod 600 "$d/SHA256SUMS"; bad "P22 marker with a malformed snapshot id" "$d" "snapshot_id is malformed"
# verify_bundle itself (the code restore-manifest.sh --verify-only runs on the operator machine) must refuse a symlinked bundle directory too
vb() { local out rc; out=$(bash -c '. "$1/manifest_check.sh"; verify_bundle "$2" "$3"' _ "$HERE/.." "$2" "$TOCF" 2>&1); rc=$?; check "$1" "rc!=0; '$3'" "rc=$rc; $(echo "$out" | tail -1 | cut -c1-120)" $([ $rc != 0 ] && echo "$out" | grep -qF -- "$3"; echo $?); }
vb "P23 verify_bundle: symlink to a perfect bundle" "$W/p15link" "symbolic link"
vb "P24 verify_bundle: the same symlink with a trailing slash" "$W/p15link/" "symbolic link"
out=$(bash -c '. "$1/manifest_check.sh"; verify_bundle "$2" "$3"' _ "$HERE/.." "$W/p15/" "$TOCF" 2>&1); rc=$?
check "P25 verify_bundle: the real directory with a trailing slash passes" "rc=0" "rc=$rc" $([ $rc = 0 ]; echo $?)
d=$(mk p26); rm "$d/manifest.tsv"; ln -s "$W/p15/manifest.tsv" "$d/manifest.tsv"; vb "P26 verify_bundle: manifest.tsv is a symlink to the right content" "$d" "regular file"
rm -rf "$W"
summary
