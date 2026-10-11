#!/usr/bin/env bash
# TRIVO LIVE nightly backup (stack /opt/trivo-prod, database trivo_prod). Runs as root via trivoprod-backup.timer.
# 1) logical dump as the read-only trivo_backup role (server/scripts/backup.sh: dump + readability check + sha256)
# 2) an AES-256 encrypted copy (*.dump.enc) for OFF-SITE upload; key: /root/.trivo-backup.key (600; keep a copy OFF this host)
# 3) retention: 14 days of local files. Off-site sync (if configured) is run by offsite-sync.sh afterwards.
set -euo pipefail
ROOT=/opt/trivo-prod; BK=/var/backups/trivo-prod; KEY=/root/.trivo-backup.key
mkdir -p "$BK"; chmod 700 "$BK"
[ -f "$KEY" ] || { umask 077; openssl rand -base64 48 > "$KEY"; echo "created new backup key $KEY - COPY IT OFF-HOST" >&2; }
cd "$ROOT"; set -a; . ./.env; set +a
docker run --rm --network trivoprod_default -v "$ROOT/server:/srv:ro" -v "$BK:/bk" \
  -e BACKUP_DATABASE_URL="postgresql://trivo_backup:$BACKUP_PW@postgres:5432/trivo_prod" \
  postgres:16-alpine sh -c "apk add --no-cache bash >/dev/null 2>&1; bash /srv/scripts/backup.sh /bk"
LATEST=$(ls -1t "$BK"/trivo_*.dump | head -1)
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$LATEST" -out "$LATEST.enc" -pass file:"$KEY"
chmod 600 "$BK"/trivo_* 
find "$BK" -name 'trivo_*' -mtime +14 -delete
echo "backup ok: $(basename "$LATEST") $(du -h "$LATEST" | cut -f1); encrypted copy written"
[ -x "$ROOT/ops/live/offsite-sync.sh" ] && "$ROOT/ops/live/offsite-sync.sh" "$LATEST.enc" || echo "NOTE: no offsite-sync.sh configured - backup is on this host only"
