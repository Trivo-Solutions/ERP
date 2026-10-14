#!/usr/bin/env bash
# TRIVO production snapshot - READ-ONLY PRE-FLIGHT, run ON THE PRODUCTION HOST by piping this file into bash over ssh (nothing is uploaded):
#     ssh -o StrictHostKeyChecking=yes trivo-e2e 'bash -s' < preflight_host.sh
# It changes nothing, reads no database and prints no secret. FAIL-FAST: it stops at the FIRST problem with "PREFLIGHT FAILED: <reason>"
# and a non-zero exit status (ssh passes the status through, so `ssh ... < preflight_host.sh && next-step` is safe). It ends with
# "PREFLIGHT OK" only when every check held. host_run.sh repeats the checks that matter, but this lets the operator see them first.
# The TRIVO_PREFLIGHT_* overrides exist for the local tests only and are ignored (refused) unless TRIVO_PREFLIGHT_TEST=1.
set -euo pipefail
fail() { echo "PREFLIGHT FAILED: $*" >&2; exit 1; }
if [ "${TRIVO_PREFLIGHT_TEST:-}" != 1 ]; then
  for v in TRIVO_PREFLIGHT_OUT TRIVO_PREFLIGHT_ENV_FILE TRIVO_PREFLIGHT_NETWORK TRIVO_PREFLIGHT_IMAGE TRIVO_PREFLIGHT_PGHOST TRIVO_PREFLIGHT_NOW_HHMM_IST TRIVO_PREFLIGHT_NO_SYSTEMD; do
    [ -z "${!v+x}" ] || fail "$v is set; test overrides are refused outside TRIVO_PREFLIGHT_TEST=1"
  done
fi
OUT="${TRIVO_PREFLIGHT_OUT:-/var/backups/trivo-prod-verify}"; ENV_FILE="${TRIVO_PREFLIGHT_ENV_FILE:-/opt/trivo-prod/.env}"
NET="${TRIVO_PREFLIGHT_NETWORK:-trivoprod_default}"; IMAGE="${TRIVO_PREFLIGHT_IMAGE:-postgres:16-alpine}"; PGHOST_="${TRIVO_PREFLIGHT_PGHOST:-postgres}"
echo "host: $(hostname) | utc $(date -u +%Y-%m-%dT%H:%M:%SZ) | ist $(TZ=Asia/Kolkata date +%H:%M)"
[ "$(id -u)" = 0 ] || [ "${TRIVO_PREFLIGHT_TEST:-}" = 1 ] || fail "not running as root"
command -v docker >/dev/null || fail "docker not found"
command -v sha256sum >/dev/null || fail "sha256sum not found"
# 1. not inside the nightly-backup window (02:15 IST; allowed outside 01:45-03:30 IST) and nothing backup-like is running
NOW="${TRIVO_PREFLIGHT_NOW_HHMM_IST:-$(TZ=Asia/Kolkata date +%H%M)}"; [[ "$NOW" =~ ^[0-9]{4}$ ]] || fail "cannot determine the IST time"
M=$(( 10#${NOW:0:2} * 60 + 10#${NOW:2:2} ))
[ "$M" -lt $((1*60+45)) ] || [ "$M" -gt $((3*60+30)) ] || fail "it is $NOW IST: too close to the 02:15 IST nightly backup (run outside 01:45-03:30 IST)"
if [ -z "${TRIVO_PREFLIGHT_NO_SYSTEMD:-}" ]; then
  command -v systemctl >/dev/null || fail "systemctl not found: cannot confirm the nightly backup is idle"
  st="$(systemctl is-active trivoprod-backup.service 2>/dev/null || true)"; [ "$st" != active ] || fail "trivoprod-backup.service is running right now"
  echo "trivoprod-backup.service: $st"; systemctl list-timers trivoprod-backup.timer --no-pager 2>/dev/null | head -3 || true
fi
! pgrep -f 'scripts/backup.sh|pg_dump' >/dev/null 2>&1 || fail "a backup / pg_dump process is already running"
# 2. the approved image is present locally (it is never pulled) and the compose network exists with a member answering to the DB host name
id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)" || fail "image $IMAGE is not present locally (the run never pulls)"
echo "image $IMAGE = $id"
docker network inspect "$NET" >/dev/null 2>&1 || fail "docker network $NET does not exist"
MEMBERS="$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET")"; [ -n "$MEMBERS" ] || fail "docker network $NET has no running containers"
FOUND=0
for m in $MEMBERS; do
  al="$(docker inspect --format '{{with index .NetworkSettings.Networks "'"$NET"'"}}{{range .Aliases}}{{.}} {{end}}{{end}}' "$m" 2>/dev/null || true)"
  case " $al $m " in *" $PGHOST_ "*) FOUND=1;; esac
done
[ "$FOUND" = 1 ] || fail "no container on network $NET answers to the database host name '$PGHOST_' (members: $MEMBERS)"
echo "network $NET: '$PGHOST_' resolves to a member. The snapshot container joins this network, so it can reach EVERY member (this is not isolation): $MEMBERS"
# 3. the backup password: exactly one non-empty BACKUP_PW= line (count only; the value is never read into the output)
[ -r "$ENV_FILE" ] || fail "$ENV_FILE is not readable"
[ "$(grep -c '^BACKUP_PW=' "$ENV_FILE" || true)" = 1 ] || fail "$ENV_FILE must contain exactly one BACKUP_PW= line"
[ "$(grep -c '^BACKUP_PW=..*' "$ENV_FILE" || true)" = 1 ] || fail "BACKUP_PW is empty"
echo "BACKUP_PW lines: 1 (non-empty)"
# 4. the output location: the dedicated directory must NOT exist yet (the runbook creates it, 700 root), and the volume must have room
[ ! -e "$OUT" ] || fail "$OUT already exists (a previous attempt? inspect it; nothing was changed)"
PARENT="$(dirname "$OUT")"; [ -d "$PARENT" ] || fail "$PARENT does not exist"
df -h "$PARENT" | tail -1
FREE_KB="$(df -Pk "$PARENT" | awk 'NR==2{print $4}')"; [ "$FREE_KB" -ge 1048576 ] || fail "less than 1 GB free under $PARENT (run.sh checks 2x the database size + 100 MB exactly)"
echo "PREFLIGHT OK"
