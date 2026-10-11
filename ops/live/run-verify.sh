#!/usr/bin/env bash
# Runs ops/live/verify-live.mjs against a THROWAWAY database (trivo_verify) using the freshly built production images.
# Never touches trivo_prod. Always tears the scratch database and temporary API container down, pass or fail.
set -uo pipefail
ROOT=/opt/trivo-prod; cd "$ROOT"; set -a; . ./.env; set +a
DB=trivo_verify; NET=trivoprod_default; API=trivoverify_server
PSQL() { docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" trivoprod_postgres psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 "$@"; }
cleanup() { docker rm -f $API >/dev/null 2>&1; PSQL -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1; rm -f /tmp/verify.env; echo "(throwaway database and API removed)"; }
trap cleanup EXIT
PSQL -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"; PSQL -c "CREATE DATABASE $DB OWNER trivo_owner ENCODING 'UTF8' TEMPLATE template0"
docker run --rm --network $NET -e DATABASE_URL="postgresql://trivo_owner:$OWNER_PW@postgres:5432/$DB?schema=public" trivoprod-migrate \
  sh -c "npx prisma migrate deploy && npx prisma db execute --file prisma/db-secure.sql --schema prisma/schema.prisma" 2>&1 | grep -E "applied|Script executed|rror" 
PLATFORM_KEY=$(openssl rand -hex 24)
sed -e "s#/trivo_prod?#/$DB?#g" -e "s#^TRIVO_PLATFORM_API_KEY=.*#TRIVO_PLATFORM_API_KEY=$PLATFORM_KEY#" -e "s#^REDIS_URL=.*#REDIS_URL=#" -e 's#^API_RATE_LIMIT_MAX=.*#API_RATE_LIMIT_MAX=100000#' -e 's#^AUTH_RATE_LIMIT_MAX=.*#AUTH_RATE_LIMIT_MAX=100000#' server/.env.production > /tmp/verify.env
docker run -d --name $API --network $NET --env-file /tmp/verify.env trivoprod-server >/dev/null
for i in $(seq 1 30); do docker exec $API node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 2; done
docker logs $API 2>&1 | grep -E "Database roles" | cut -c1-160
docker run --rm --network $NET -v "$ROOT/ops/live/verify-live.mjs:/v.mjs:ro" -e API="http://$API:3001/api/v1" -e PLATFORM_KEY="$PLATFORM_KEY" node:20-bookworm-slim node /v.mjs
RC=$?; echo "verify exit code: $RC"; exit $RC
