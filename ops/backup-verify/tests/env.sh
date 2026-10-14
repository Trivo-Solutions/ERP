# Sourced by the test scripts. Selects a LOCAL, DISPOSABLE test cluster and exports every connection setting; reads credentials from
# files outside the repository (never printed). Usage:  TARGET=pg16|pg18 TRIVO_TEST_SECRETS=<dir> . tests/env.sh
#   pg16 = the throw-away postgres:16-alpine container (container trivo_pg16_snaptest, 127.0.0.1:54316) - mirrors production's version
#          and holds a database named trivo_prod seeded from staging data. Credentials: $TRIVO_TEST_SECRETS/{super,owner,runtime,backup}.pw
#   pg18 = the existing local staging cluster (localhost:54329), the machine the real restore will run on.
export MSYS_NO_PATHCONV=1
export PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
export PATH="$PG_BIN:$PATH"
: "${TARGET:?TARGET=pg16|pg18}"
case "$TARGET" in
  pg16)
    : "${TRIVO_TEST_SECRETS:?TRIVO_TEST_SECRETS (directory with *.pw files) is required}"
    T_HOST=127.0.0.1; T_PORT=54316; T_SSL=""
    SUPER_PW="$(tr -d '\r\n' < "$TRIVO_TEST_SECRETS/super.pw")"; OWNER_PW="$(tr -d '\r\n' < "$TRIVO_TEST_SECRETS/owner.pw")"
    RUN_PW="$(tr -d '\r\n' < "$TRIVO_TEST_SECRETS/runtime.pw")"; BK_PW="$(tr -d '\r\n' < "$TRIVO_TEST_SECRETS/backup.pw")"
    export SRC_DB=trivo_prod;;
  pg18)
    T_HOST=localhost; T_PORT=54329; T_SSL="?sslmode=require"; export PGSSLMODE=require
    SUPER_PW="$(tr -d '\r\n' < /c/trivo-staging/superpw.txt)"
    OWNER_PW="$(grep '^OWNER_DATABASE_URL' /c/trivo-staging/rlstest.env | sed -E 's#.*://trivo_owner:([^@]+)@.*#\1#')"
    RUN_PW="$(grep '^DATABASE_URL' /c/trivo-staging/rlstest.env | sed -E 's#.*://trivo_runtime:([^@]+)@.*#\1#')"
    BK_PW="$(tr -d '\r\n' < /c/trivo-staging/backup-pw.txt)"
    export SRC_DB=trivo_snaptest_src_20261013;;
  *) echo "unknown TARGET"; return 1;;
esac
export T_HOST T_PORT SUPER_PW OWNER_PW RUN_PW BK_PW
export ADMIN_DATABASE_URL="postgresql://postgres:${SUPER_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}"
export OWNER_DATABASE_URL="postgresql://trivo_owner:${OWNER_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}"
export SOURCE_DATABASE_URL="postgresql://trivo_backup:${BK_PW}@${T_HOST}:${T_PORT}/postgres${T_SSL}"
export RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:${RUN_PW}@${T_HOST}:${T_PORT}/__DB__${T_SSL}"
export OWNER_ROLE=trivo_owner RESTORE_EXPECT_PORT="$T_PORT"
export RESTORE_EXPECT_SYSTEM_IDENTIFIER="$(command psql "$ADMIN_DATABASE_URL" -Atq -c 'select system_identifier from pg_control_system()' | tr -d '\r')"
sup()  { PGPASSWORD="$SUPER_PW" command psql -h "$T_HOST" -p "$T_PORT" -U postgres -d postgres -Atq "$@" | tr -d '\r'; }
own()  { PGPASSWORD="$OWNER_PW" command psql -h "$T_HOST" -p "$T_PORT" -U trivo_owner -d "$SRC_DB" -v ON_ERROR_STOP=1 -Atq "$@" | tr -d '\r'; }
bk()   { PGPASSWORD="$BK_PW" command psql -h "$T_HOST" -p "$T_PORT" -U trivo_backup -d "$SRC_DB" -v ON_ERROR_STOP=1 -Atq "$@" | tr -d '\r'; }
