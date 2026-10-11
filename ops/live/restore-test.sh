#!/usr/bin/env bash
# Restores a dump into a NEW scratch database on the live postgres container, runs server/scripts/restore.sh's
# verification (row counts vs source, RLS forced, composite FKs, journals balance, runtime role isolation), then DROPS the
# scratch database. Never touches trivo_prod. Usage: restore-test.sh [dump-file]  (default: newest local dump)
set -euo pipefail
ROOT=/opt/trivo-prod; BK=/var/backups/trivo-prod
DUMP="${1:-$(ls -1t "$BK"/trivo_*.dump | head -1)}"; SCR="trivo_restore_verify_$(date -u +%H%M%S)"
cd "$ROOT"; set -a; . ./.env; set +a
set +e
docker run --rm --network trivoprod_default -v "$ROOT/server:/srv:ro" -v "$BK:/bk:ro" \
  -e ADMIN_DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@postgres:5432/postgres" \
  -e OWNER_DATABASE_URL="postgresql://trivo_owner:$OWNER_PW@postgres:5432/trivo_prod" \
  -e SOURCE_DATABASE_URL="postgresql://trivo_platform:$PLATFORM_PW@postgres:5432/trivo_prod" \
  -e RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:$RUNTIME_PW@postgres:5432/__DB__" \
  postgres:16-alpine sh -c "apk add --no-cache bash >/dev/null 2>&1; bash /srv/scripts/restore.sh /bk/$(basename "$DUMP") $SCR"
RC=$?
set -e
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" trivoprod_postgres psql -U postgres -d postgres -qc "DROP DATABASE IF EXISTS $SCR" || true
echo "restore-test exit code: $RC (scratch database $SCR dropped)"; exit $RC
