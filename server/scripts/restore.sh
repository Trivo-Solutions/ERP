#!/usr/bin/env bash
# TRIVO restore + verification. ALWAYS restores into a NEW scratch database — never over a live one.
#
#   ADMIN_DATABASE_URL=postgresql://postgres:...@host:5432/postgres \
#   OWNER_ROLE=trivo_owner \
#   SOURCE_DATABASE_URL=postgresql://trivo_platform:...@host:5432/trivo   (optional: compare row counts to the source)
#   RUNTIME_DATABASE_URL_TEMPLATE=postgresql://trivo_runtime:...@host:5432/__DB__?sslmode=require  (optional: prove RLS)
#   ./restore.sh path/to/trivo_XXXX.dump [scratch-db-name]
#
# Steps: create scratch DB owned by the owner role -> pg_restore -> re-apply prisma/db-secure.sql (grants + FORCE RLS
# are re-established from the source of truth, not trusted from the dump) -> verify:
#   1. every table's row count equals the source (when SOURCE_DATABASE_URL is given)
#   2. every company-owned table still has RLS enabled + FORCED and a policy; composite FKs present
#   3. every journal entry still balances; no cross-company foreign key exists
#   4. (when a runtime URL is given) the runtime role, in one company's context, sees ONLY that company's rows —
#      and with no context sees nothing: i.e. isolation survived the restore
# Exit code is non-zero if any verification fails.

set -euo pipefail
# (Windows psql emits CRLF; harmless elsewhere, and it would otherwise poison every comparison below.)
psql() { command psql "$@" | tr -d '\r'; }
strip_prisma() { echo "$1" | sed -E 's/([?&])(schema|connection_limit|pool_timeout|connect_timeout|sslaccept|pgbouncer)=[^&]*&?/\1/g; s/[?&]$//'; }
swap_db() { echo "$1" | sed -E "s#/[^/?]+(\?|\$)#/$2\1#"; }

DUMP="${1:?Usage: restore.sh <dump-file> [scratch-db-name]}"
SCRATCH="${2:-trivo_restore_verify_$(date -u +%Y%m%dT%H%M%SZ | tr 'A-Z' 'a-z')}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL must point at the server (a role allowed to CREATE DATABASE)}"
OWNER_ROLE="${OWNER_ROLE:-trivo_owner}"
: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL (the owner role, any database on the server) is needed to restore + re-secure}"

ADMIN="$(strip_prisma "$ADMIN_DATABASE_URL")"
OWNER_SCRATCH="$(swap_db "$(strip_prisma "$OWNER_DATABASE_URL")" "$SCRATCH")"
HERE="$(cd "$(dirname "$0")" && pwd)"
FAIL=0
bad() { echo "  FAIL: $*"; FAIL=1; }
ok()  { echo "  ok:   $*"; }

[ -f "$DUMP.sha256" ] && ( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" ) && ok "checksum matches"

echo "== creating scratch database $SCRATCH (owner $OWNER_ROLE)"
psql "$ADMIN" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$SCRATCH\" OWNER $OWNER_ROLE ENCODING 'UTF8' TEMPLATE template0"

echo "== restoring $DUMP"
# Run as the owner: objects become owned by it. Grants are NOT taken from the dump (--no-privileges); db-secure.sql
# re-establishes them below.
# SERIAL (-j 1) and --exit-on-error, both deliberate: tables are FORCE-RLS, and FK validation queries are themselves filtered
# by RLS. In a serial restore pg_dump's ordering enables RLS only after data + foreign keys are in place; a parallel
# restore (-j N) does not guarantee that and fails with "query would be affected by row-level security policy".
# --exit-on-error: a restore that "ignored some errors" is NOT a restore.
pg_restore -d "$OWNER_SCRATCH" --no-owner --no-privileges --exit-on-error -j "${RESTORE_JOBS:-1}" "$DUMP"

echo "== re-applying prisma/db-secure.sql (grants + FORCE RLS)"
psql "$OWNER_SCRATCH" -v ON_ERROR_STOP=1 -q -f "$HERE/../prisma/db-secure.sql"

# Verification reads as the BACKUP role (BYPASSRLS): under FORCE ROW LEVEL SECURITY an owner session with no tenant set
# correctly sees ZERO rows, so counting as the owner would prove nothing.
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL (the trivo_backup role on any DB of the server) is required for verification}"
psql "$ADMIN" -qc "GRANT CONNECT ON DATABASE \"$SCRATCH\" TO trivo_backup" >/dev/null
VERIFY="$(swap_db "$(strip_prisma "$SOURCE_DATABASE_URL")" "$SCRATCH")"
q() { psql "$VERIFY" -Atq -c "$1"; }

echo "== verification"
# 1. row counts vs source
if [ -n "${SOURCE_DATABASE_URL:-}" ]; then
  SRC="$(strip_prisma "$SOURCE_DATABASE_URL")"
  TABLES="$(psql "$SRC" -Atq -c "select tablename from pg_tables where schemaname='public' order by 1")"
  MISMATCH=0; N=0
  for t in $TABLES; do
    a="$(psql "$SRC" -Atq -c "select count(*) from \"$t\"")"; b="$(psql "$VERIFY" -Atq -c "select count(*) from \"$t\"" 2>/dev/null || echo ERR)"
    N=$((N+1)); if [ "$a" != "$b" ]; then bad "row count differs in $t: source=$a restored=$b"; MISMATCH=1; fi
  done
  [ "$MISMATCH" = 0 ] && ok "row counts identical in all $N tables"
fi
# 2. RLS + policies + composite FKs
NORLS="$(q "select count(*) from pg_class k join pg_namespace n on n.oid=k.relnamespace and n.nspname='public' where k.relkind='r' and exists (select 1 from pg_policy p where p.polrelid=k.oid) and not (k.relrowsecurity and k.relforcerowsecurity)")"
[ "$NORLS" = 0 ] && ok "every policy-protected table has RLS enabled AND forced" || bad "$NORLS tables lost RLS/FORCE"
NPOL="$(q "select count(*) from pg_policies where schemaname='public' and policyname='tenant_isolation'")"; [ "$NPOL" -ge 80 ] && ok "$NPOL tenant_isolation policies restored" || bad "only $NPOL policies restored"
NFK="$(q "select count(*) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='companyId' where c.contype='f' and array_length(c.conkey,1)=2")"; [ "$NFK" -ge 58 ] && ok "$NFK composite foreign keys restored" || bad "only $NFK composite FKs"
# 3. accounting + reference integrity
UNBAL="$(q "select count(*) from (select e.id from journal_entries e join journal_lines l on l.\"entryId\"=e.id group by e.id having abs(sum(l.debit)-sum(l.credit))>0.01) x")"
[ "$UNBAL" = 0 ] && ok "every journal entry balances" || bad "$UNBAL unbalanced journal entries"
XREF="$(q "select count(*) from sales_invoices i join clients c on c.id=i.\"clientId\" where c.\"companyId\"<>i.\"companyId\"")"; [ "$XREF" = 0 ] && ok "no invoice points at another company's client" || bad "$XREF cross-company invoice->client references"
XREF2="$(q "select count(*) from invoice_items i join jewelry_tags t on t.id=i.\"tagId\" where t.\"companyId\"<>i.\"companyId\"")"; [ "$XREF2" = 0 ] && ok "no invoice line points at another company's tag" || bad "$XREF2 cross-company line->tag references"
# 4. isolation survives: the runtime role, per company context
if [ -n "${RUNTIME_DATABASE_URL_TEMPLATE:-}" ]; then
  RT="$(strip_prisma "${RUNTIME_DATABASE_URL_TEMPLATE//__DB__/$SCRATCH}")"
  NOCTX="$(psql "$RT" -Atq -c "select count(*) from clients")"; [ "$NOCTX" = 0 ] && ok "runtime role with NO company context sees 0 clients (fail-closed)" || bad "runtime role saw $NOCTX clients with no context"
  for cid in $(q "select id from companies order by \"createdAt\""); do
    own="$(q "select count(*) from clients where \"companyId\"='$cid'")"
    seen="$(psql "$RT" -Atq -c "begin; select set_config('app.tenant_company_id','$cid',true); select count(*)||'/'||count(*) filter (where \"companyId\"='$cid') from clients; rollback;" | tail -1)"
    total="${seen%/*}"; mine="${seen#*/}"
    if [ "$total" = "$mine" ] && [ "$mine" = "$own" ]; then ok "company ${cid:0:8}…: runtime role sees exactly its own $own clients"; else bad "company $cid: sees $seen, expected $own/$own"; fi
  done
fi

echo
if [ "$FAIL" = 0 ]; then echo "RESTORE VERIFIED into $SCRATCH. Drop it when done:  psql \"\$ADMIN_DATABASE_URL\" -c 'DROP DATABASE \"$SCRATCH\"'"; else echo "RESTORE VERIFICATION FAILED (scratch DB $SCRATCH kept for inspection)"; exit 1; fi
