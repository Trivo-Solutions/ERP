#!/usr/bin/env bash
# TRIVO database backup (logical, custom format).
#
#   BACKUP_DATABASE_URL=postgresql://trivo_backup:...@host:5432/trivo?sslmode=require ./backup.sh [output-dir]
#
# Run as the BACKUP role (trivo_backup: read-only + BYPASSRLS). pg_dump must see EVERY company's rows, and with
# FORCE ROW LEVEL SECURITY neither the runtime role nor even the table owner can (they would silently dump nothing).
# The dump therefore contains every company: treat the file as the most sensitive artefact you own (encrypt it,
# restrict access, keep it off the app host).
#
# Prisma-only URL parameters (schema=, connection_limit=, ...) are stripped: libpq rejects them.
#
# What this does NOT give you: point-in-time recovery. A nightly dump loses up to 24h. For a smaller RPO run WAL
# archiving (pgBackRest / WAL-G / your managed provider's PITR) in addition to — not instead of — these dumps.
#
# Retention (wire into cron / your scheduler): dailies 14 days, weeklies 8 weeks, monthlies 12 months; never delete the
# newest successful backup. Copy dumps OFF the database host (object storage with its own lifecycle rules).
#
# A backup is only real once a RESTORE of it has been verified: run restore.sh on the file (restore.sh does).

set -euo pipefail

strip_prisma() { echo "$1" | sed -E 's/([?&])(schema|connection_limit|pool_timeout|connect_timeout|sslaccept|pgbouncer)=[^&]*&?/\1/g; s/[?&]$//'; }

SRC="${BACKUP_DATABASE_URL:-}"
if [ -z "$SRC" ]; then
  echo "Set BACKUP_DATABASE_URL to the trivo_backup role (read-only, BYPASSRLS)." >&2
  exit 1
fi
OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/trivo_${STAMP}.dump"
mkdir -p "$OUT_DIR"

# -Fc: compressed, and the only format pg_restore can restore selectively / in parallel.
# -Z 6: sensible compression. --no-owner: ownership is re-established by the restore role.
pg_dump "$(strip_prisma "$SRC")" -Fc -Z 6 --no-owner -f "$FILE"

# Prove the archive is readable, and record its checksum next to it.
pg_restore --list "$FILE" > /dev/null
( cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )

echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1)), checksum: $FILE.sha256"
echo "NEXT: restore it into a scratch database and verify (restore.sh) before trusting it."
