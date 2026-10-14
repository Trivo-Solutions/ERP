#!/usr/bin/env bash
# TRIVO production snapshot - HOST-SIDE driver. Run as root ON THE PRODUCTION HOST, only after the operator has uploaded the reviewed
# scripts and verified their SHA-256 (see RUNBOOK.md). Writes ONLY inside the dedicated output directory.
#
#   ./host_run.sh <sha256-of-run.sh> <sha256-of-snapshot_dump.sql> <sha256-of-bundle_postcheck.sh> <sha256-of-manifest_check.sh>
#
# Steps: refuse if anything is off (every check runs BEFORE the container starts and aborts on the first failure) -> read the backup
# password WITHOUT printing it -> run the approved postgres:16-alpine container -> independently re-verify the published bundle
# (directory/file permissions, exact file set, checksums, strict manifest + marker, dump header/table list from a real `pg_restore -l`)
# -> print the bundle path + hashes.
#
# NETWORK: the container joins the production compose network ($NET) because that is the only way to reach the database host by name.
# That is NOT isolation: any container attached to a Docker network can reach every other container on it (verified locally - see the
# report addendum). What actually limits it: the only credential it holds is the read-only trivo_backup password; all capabilities are
# dropped, the root filesystem is read-only, no ports are published, only /scripts (ro) and the output directory are mounted, and the
# SQL guards refuse any database/role other than trivo_prod/trivo_backup. This script prints the network's members so the operator sees
# exactly what shares the network, and refuses unless the database host name resolves to a container on it.
# It never deletes anything, never touches the nightly backup directory, never connects to any database other than trivo_prod
# (the SQL guards also refuse any role other than trivo_backup).
set -euo pipefail
umask 077

OUT="${TRIVO_VERIFY_OUT:-/var/backups/trivo-prod-verify}"           # the dedicated output directory (production default)
SCRIPTS="$OUT/scripts"
ENV_FILE="${TRIVO_VERIFY_ENV_FILE:-/opt/trivo-prod/.env}"
NET="${TRIVO_VERIFY_NETWORK-trivoprod_default}"
IMAGE="${TRIVO_VERIFY_IMAGE:-postgres:16-alpine}"                    # the same image the nightly backup uses
PGHOST_="${TRIVO_VERIFY_PGHOST:-postgres}"; PGPORT_="${TRIVO_VERIFY_PGPORT:-5432}"
EXPECT_DB=trivo_prod; EXPECT_USER=trivo_backup                       # NOT overridable
EXTRA_DOCKER_ARGS=( ${TRIVO_VERIFY_EXTRA_DOCKER_ARGS:-} )            # tests only (e.g. --add-host); empty in production

die() { echo "REFUSING: $*" >&2; exit 1; }
# Every override above exists for the local tests only. In production (TRIVO_VERIFY_TEST not 1) ANY of them being set - including an
# EMPTY network, which would silently drop the --network flag - is refused instead of being honoured.
if [ "${TRIVO_VERIFY_TEST:-}" != 1 ]; then
  for v in TRIVO_VERIFY_OUT TRIVO_VERIFY_ENV_FILE TRIVO_VERIFY_NETWORK TRIVO_VERIFY_IMAGE TRIVO_VERIFY_PGHOST TRIVO_VERIFY_PGPORT TRIVO_VERIFY_EXTRA_DOCKER_ARGS TEST_NOW_HHMM_IST; do
    [ -z "${!v+x}" ] || die "$v is set; test overrides are refused outside TRIVO_VERIFY_TEST=1"
  done
fi
command -v docker >/dev/null || die "docker not found"
command -v sha256sum >/dev/null || die "sha256sum not found"
case "$OUT" in /var/backups/trivo-prod|/var/backups/trivo-prod/*|/) die "refusing to write into the nightly backup directory";; esac
[ "$#" = 4 ] || die "usage: host_run.sh <sha256 of run.sh> <sha256 of snapshot_dump.sql> <sha256 of bundle_postcheck.sh> <sha256 of manifest_check.sh>"
for h in "$@"; do [[ "$h" =~ ^[0-9a-f]{64}$ ]] || die "argument '$h' is not a lowercase 64-hex sha256"; done
[ "$(id -u)" = 0 ] || [ "${TRIVO_VERIFY_TEST:-}" = 1 ] || die "must run as root"

# 1. the scripts about to run are exactly the reviewed ones
[ -d "$SCRIPTS" ] || die "$SCRIPTS does not exist"
printf '%s  %s\n%s  %s\n%s  %s\n%s  %s\n' "$1" "$SCRIPTS/run.sh" "$2" "$SCRIPTS/snapshot_dump.sql" "$3" "$SCRIPTS/bundle_postcheck.sh" "$4" "$SCRIPTS/manifest_check.sh" | sha256sum -c - >/dev/null || die "script hashes do not match the reviewed values"
echo "script hashes match the reviewed values"

# 2. output directory: root-owned, mode 700, nothing but our own artefacts
perm() { stat -c '%a %U' "$1"; }
if [ "${TRIVO_VERIFY_TEST:-}" != 1 ]; then
  [ "$(perm "$OUT")" = "700 root" ] || die "$OUT must be mode 700 owned by root (found: $(perm "$OUT"))"
  [ "$(perm "$SCRIPTS")" = "700 root" ] || die "$SCRIPTS must be mode 700 owned by root (found: $(perm "$SCRIPTS"))"
fi

# 3. not near the nightly backup (02:15 IST = 20:45 UTC) and no backup job running
if [ -n "${TEST_NOW_HHMM_IST:-}" ]; then NOW="$TEST_NOW_HHMM_IST"; else NOW="$(TZ=Asia/Kolkata date +%H%M)"; fi
NOWM=$(( 10#${NOW:0:2} * 60 + 10#${NOW:2:2} ))
if [ "$NOWM" -ge $((1*60+45)) ] && [ "$NOWM" -le $((3*60+30)) ]; then die "it is $NOW IST: too close to the 02:15 IST nightly backup (allowed outside 01:45-03:30 IST)"; fi
if command -v systemctl >/dev/null 2>&1; then
  [ "$(systemctl is-active trivoprod-backup.service 2>/dev/null || true)" != active ] || die "trivoprod-backup.service is running right now"
elif [ "${TRIVO_VERIFY_TEST:-}" != 1 ]; then die "systemctl not found: cannot confirm the nightly backup is idle"; fi
if pgrep -f 'scripts/backup.sh|pg_dump' >/dev/null 2>&1; then die "a backup / pg_dump process is already running on this host"; fi

# 4. image: must already be present locally (never pulled); record its id
IMGID="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)" || die "image $IMAGE is not present locally (will not pull)"
echo "image $IMAGE = $IMGID"

# 4b. network: it must exist and the database host name must resolve to a container ON it; list what else shares it (see header: this is
#     not isolation). Skipped only when a test deliberately runs without a network (TRIVO_VERIFY_NETWORK="" under TRIVO_VERIFY_TEST=1).
if [ -n "$NET" ]; then
  docker network inspect "$NET" >/dev/null 2>&1 || die "docker network $NET does not exist"
  MEMBERS="$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET")"
  [ -n "$MEMBERS" ] || die "docker network $NET has no running containers"
  FOUND=0
  for m in $MEMBERS; do
    al="$(docker inspect --format '{{with index .NetworkSettings.Networks "'"$NET"'"}}{{range .Aliases}}{{.}} {{end}}{{end}}' "$m" 2>/dev/null || true)"
    case " $al $m " in *" $PGHOST_ "*) FOUND=1;; esac
  done
  [ "$FOUND" = 1 ] || die "no container on network $NET answers to the database host name '$PGHOST_' (members: $MEMBERS)"
  echo "network $NET: database host '$PGHOST_' resolves to a member; ALL members are reachable from the container: $MEMBERS"
fi
# 4c. an earlier interrupted run leaves a staging directory that must be inspected, never ignored (run.sh refuses too; fail here first)
STALE="$(find "$OUT" -maxdepth 1 -name '.tmp-*' 2>/dev/null | sort)"
[ -z "$STALE" ] || die "stale staging director(y/ies) from an interrupted run exist (inspect, then remove them yourself): $STALE"

# 5. the backup password: read from the env file without printing it; passed to the container by NAME only (never on a command line)
[ -r "$ENV_FILE" ] || die "$ENV_FILE not readable"
[ "$(grep -c '^BACKUP_PW=' "$ENV_FILE")" = 1 ] || die "$ENV_FILE must contain exactly one BACKUP_PW= line"
PGPASSWORD="$(grep '^BACKUP_PW=' "$ENV_FILE" | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']\$//")"
[ -n "$PGPASSWORD" ] || die "BACKUP_PW is empty"
export PGPASSWORD

# 6. run
BEFORE="$(ls -1A "$OUT" | grep -c '^bundle-' || true)"
echo "== running snapshot container (database $EXPECT_DB as $EXPECT_USER via $PGHOST_:$PGPORT_) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm --pull never --name "trivo_verify_snapshot_$$" \
  ${NET:+--network "$NET"} "${EXTRA_DOCKER_ARGS[@]}" \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --memory 1g \
  -v "$SCRIPTS:/scripts:ro" -v "$OUT:/out" \
  -e PGHOST="$PGHOST_" -e PGPORT="$PGPORT_" -e PGUSER="$EXPECT_USER" -e PGDATABASE="$EXPECT_DB" -e PGPASSWORD \
  -e EXPECT_DB="$EXPECT_DB" -e EXPECT_USER="$EXPECT_USER" -e EXPECT_PG_MAJOR=16 \
  "$IMAGE" sh /scripts/run.sh 2>&1 | tee -a "$OUT/run-$(date -u +%Y%m%dT%H%M%SZ).log"
rc="${PIPESTATUS[0]}"; unset PGPASSWORD
[ "$rc" = 0 ] || { echo "FAILED: container exit $rc. Nothing was published. See RUNBOOK.md 'Failure recovery'." >&2; exit "$rc"; }

# 7. independent re-verification of the bundle that was just published (permissions, exact file set, checksums, marker, manifest)
AFTER="$(ls -1A "$OUT" | grep -c '^bundle-' || true)"
[ "$AFTER" = $((BEFORE+1)) ] || die "expected exactly one new bundle (before=$BEFORE after=$AFTER)"
B="$OUT/$(ls -1At "$OUT" | grep '^bundle-' | head -1)"
# The listing comes from a REAL `pg_restore -l` of the dump, run in the same pinned image with no network and nothing writable.
TOC="$(mktemp)"
docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --memory 512m \
  -v "$B:/b:ro" "$IMAGE" pg_restore -l /b/trivo_snap.dump | tr -d '\r' > "$TOC" || die "pg_restore -l failed on $B"
[ -s "$TOC" ] || die "pg_restore -l produced no listing for $B"
if [ "${TRIVO_VERIFY_TEST:-}" = 1 ]; then echo "(TEST mode: file-mode checks skipped here; bundle_postcheck.sh is tested separately on Linux)"
  ( . "$SCRIPTS/manifest_check.sh" && verify_bundle "$B" "$TOC" ) || die "bundle verification FAILED for $B"
else bash "$SCRIPTS/bundle_postcheck.sh" "$B" "$EXPECT_DB" "$TOC" || die "post-check failed for $B"; fi
rm -f "$TOC"
echo
echo "VERIFIED_BUNDLE $B"
ls -l "$B"
echo "SHA256SUMS content (compare these three lines on the operator console after transfer):"; cat "$B/SHA256SUMS"
echo "sha256 of SHA256SUMS itself: $(sha256sum "$B/SHA256SUMS" | cut -d' ' -f1)"
