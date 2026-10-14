#!/usr/bin/env bash
# Independent, database-free re-verification of a published snapshot bundle, run ON THE PRODUCTION HOST (Linux, as root) after
# run.sh published it. Read-only: it only inspects.
#   bundle_postcheck.sh <bundle-dir> <expected-database> [<pg_restore -l listing file>]
# Checks: the bundle path is a real directory (a symlink - also with a trailing slash - is refused); directory mode 700 and every file
# mode 600, all owned by root; then everything verify_bundle (manifest_check.sh, the SAME code the restore side runs) proves: exactly the
# four regular files, SHA256SUMS exact, manifest and success marker STRICTLY valid (fixed shape/keys/order, no duplicate or unknown keys),
# marker bound to the manifest and the files, and the dump's header + table list equal to the manifest's, read from the real
# `pg_restore -l` output. The production host has no pg_restore: host_run.sh produces the listing with the pinned postgres image and
# passes it as the third argument. With neither a listing nor a local pg_restore the check FAILS (it never skips the dump check).
# manifest_check.sh must sit next to this file (host_run.sh hash-verifies it before anything runs).
set -euo pipefail
B="${1:?bundle dir}"; DB="${2:?expected database}"; TOC="${3:-}"
die() { echo "POSTCHECK FAILED: $*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/manifest_check.sh" ] || die "manifest_check.sh not found next to $0"
. "$HERE/manifest_check.sh"
while [ "${#B}" -gt 1 ] && [ "${B%/}" != "$B" ]; do B="${B%/}"; done      # `test -L dir/` follows the link, so strip trailing slashes first
[ ! -L "$B" ] || die "$B is a symbolic link (the bundle must be a real directory)"
[ -d "$B" ] || die "$B is not a real directory"
[ "$(stat -c '%a %U' "$B")" = "700 root" ] || die "bundle directory must be mode 700 owned by root (found $(stat -c '%a %U' "$B"))"
[ "$(ls -A "$B" | LC_ALL=C sort | tr '\n' ' ')" = "SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || die "bundle does not contain exactly the four expected files"
for f in SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump; do
  [ -f "$B/$f" ] && [ ! -L "$B/$f" ] || die "$f is not a regular file"
  [ "$(stat -c '%a %U' "$B/$f")" = "600 root" ] || die "$f must be mode 600 owned by root (found $(stat -c '%a %U' "$B/$f"))"
done
[ "$(awk 'END{print NR}' "$B/SHA256SUMS")" = 3 ] || die "SHA256SUMS must have exactly 3 lines"
OUT="$(verify_bundle "$B" "$TOC" 2>&1)" || { printf '%s\n' "$OUT" >&2; die "bundle verification failed"; }
[ "$(mval "$B/SNAPSHOT_OK" database)" = "$DB" ] || die "marker names a different database"
echo "POSTCHECK OK $B tables=$(mval "$B/SNAPSHOT_OK" table_count) server=$(mval "$B/SNAPSHOT_OK" server_version) snapshot=$(mval "$B/SNAPSHOT_OK" snapshot_id)"
