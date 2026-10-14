# Strict bundle + row-count manifest checking for restore verification. SOURCED by restore-manifest.sh; defines functions only.
#
# Bundle (directory produced by run.sh) = exactly four files:  trivo_snap.dump  manifest.tsv  SNAPSHOT_OK  SHA256SUMS
#
# manifest.tsv, format v2 (tab separated, LF only), produced by snapshot_dump.sql:
#   #trivo-count-manifest <TAB> v2                      (exactly the first line)
#   #database | #server_version | #snapshot_id | #pg_snapshot | #txn_start_utc | #relation_set | #table_count |
#   #tenant_isolation_policies | #forced_rls_tables | #composite_company_fks                         (each exactly once)
#   <table> <TAB> <count>                               (one per table; unique)
#   #end <TAB> <N>                                      (exactly once, the LAST line)
# SNAPSHOT_OK (success marker; binds the dump to the manifest):
#   #trivo-snapshot-ok <TAB> v1 / database / server_version / snapshot_id / table_count / dump_file / dump_bytes / dump_sha256 /
#   manifest_sha256 / pg_dump_version / completed_utc / #end <TAB> ok
# Fails CLOSED: any deviation is an error (never a skipped check). Prints counts and table names only - never row data.

MANIFEST_RELATION_SET='schema public; relkind r (ordinary tables)'
BUNDLE_FILES='SHA256SUMS SNAPSHOT_OK manifest.tsv trivo_snap.dump'
MANIFEST_HEADERS='#database #server_version #snapshot_id #pg_snapshot #txn_start_utc #relation_set #table_count #tenant_isolation_policies #forced_rls_tables #composite_company_fks #end'

mhdr() { awk -F'\t' -v k="$2" '$1==k{print $2; exit}' "$1"; }   # mhdr FILE '#key' -> value

# validate_manifest FILE -> 0 if structurally valid; otherwise prints every problem and returns 1.
validate_manifest() {
  local f="$1" bad=0 k n
  merr() { echo "  manifest: $*"; bad=1; }
  [ -s "$f" ] || { merr "missing or empty"; return 1; }
  if [ "$(LC_ALL=C tr -cd '\r' < "$f" | wc -c)" -gt 0 ]; then merr "contains CR characters (must be LF-only; was it edited or transferred in text mode?)"; fi
  [ "$(head -n1 "$f")" = $'#trivo-count-manifest\tv2' ] || merr "first line is not '#trivo-count-manifest<TAB>v2'"
  [ "$(tail -n1 "$f" | cut -f1)" = '#end' ] || merr "last line is not '#end' (truncated?)"
  for k in $MANIFEST_HEADERS; do
    n=$(awk -F'\t' -v k="$k" '$1==k{c++} END{print c+0}' "$f")
    [ "$n" = 1 ] || merr "header '$k' appears $n times (expected exactly 1)"
  done
  local unknown; unknown=$(awk -F'\t' '/^#/{print $1}' "$f" | sort -u | grep -vxE "#trivo-count-manifest|$(echo $MANIFEST_HEADERS | tr ' ' '|')" || true)
  [ -z "$unknown" ] || merr "unknown header line(s): $(echo $unknown)"
  [ "$(mhdr "$f" '#relation_set')" = "$MANIFEST_RELATION_SET" ] || merr "#relation_set is not the expected definition"
  [[ "$(mhdr "$f" '#database')" =~ ^[A-Za-z0-9_]+$ ]] || merr "#database is not a plain identifier"
  [[ "$(mhdr "$f" '#server_version')" =~ ^[0-9]+(\.[0-9]+)*$ ]] || merr "#server_version is malformed"
  [[ "$(mhdr "$f" '#snapshot_id')" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || merr "#snapshot_id is malformed"
  [[ "$(mhdr "$f" '#txn_start_utc')" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || merr "#txn_start_utc is malformed"
  [[ "$(mhdr "$f" '#pg_snapshot')" =~ ^[0-9]+:[0-9]+:[0-9,]*$ ]] || merr "#pg_snapshot is malformed"
  for k in '#tenant_isolation_policies' '#forced_rls_tables' '#composite_company_fks'; do
    [[ "$(mhdr "$f" "$k")" =~ ^[0-9]+$ ]] || merr "$k is not a non-negative integer"
  done
  if awk -F'	' '/^#/ && NF!=2{ print "  manifest: header line " NR " (" $1 ") does not have exactly one value field"; bad=1 } END{exit bad}' "$f"; then :; else bad=1; fi
  # data lines
  local rows; rows=$(grep -vc '^#' "$f" || true)
  if awk -F'\t' '!/^#/ && (NF!=2 || $1 !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || $2 !~ /^[0-9]+$/){ bad=1; print "  manifest: malformed data line " NR " (need <table><TAB><non-negative integer>)" } END{exit bad}' "$f"; then :; else bad=1; fi
  local dups; dups=$(awk -F'\t' '!/^#/{print $1}' "$f" | sort | uniq -d | tr '\n' ' ')
  [ -z "$dups" ] || merr "duplicate table(s): $dups"
  [ "$rows" -ge 1 ] || merr "no table rows"
  local tc en
  tc=$(mhdr "$f" '#table_count'); en=$(mhdr "$f" '#end')
  [[ "$tc" =~ ^[0-9]+$ ]] && [ "$tc" = "$rows" ] || merr "#table_count=$tc but $rows table rows present"
  [[ "$en" =~ ^[0-9]+$ ]] && [ "$en" = "$rows" ] || merr "#end=$en but $rows table rows present"
  [ "$bad" = 0 ]
}

# validate_marker FILE -> STRICT structural check of SNAPSHOT_OK. The marker is written by run.sh in ONE fixed shape, so the check is
# exact: line 1 is the format line; lines 2..11 are exactly the ten keys below, in this order, each ONCE, each "key<TAB>value" with a
# non-empty value of the right shape and no extra fields; line 12 is '#end<TAB>ok'; nothing before, between or after (no blank lines,
# no comments, no unknown or duplicated keys, no trailing whitespace, no CR).
MARKER_KEYS='database server_version snapshot_id table_count dump_file dump_bytes dump_sha256 manifest_sha256 pg_dump_version completed_utc'
validate_marker() {
  local f="$1" bad=0 k n i=1 line key val
  kerr() { echo "  marker: $*"; bad=1; }
  [ -f "$f" ] && [ ! -L "$f" ] && [ -s "$f" ] || { kerr "missing, empty or not a regular file"; return 1; }
  if [ "$(LC_ALL=C tr -cd '\r' < "$f" | wc -c)" -gt 0 ]; then kerr "contains CR characters"; fi
  [ "$(LC_ALL=C tr -d '\000' < "$f" | wc -c)" = "$(wc -c < "$f")" ] || kerr "contains NUL bytes"
  # duplicates / unknown keys are reported by name first (clear diagnostics), then the exact positional check below is authoritative
  for k in $MARKER_KEYS; do
    n=$(awk -F'\t' -v k="$k" '$1==k{c++} END{print c+0}' "$f")
    [ "$n" = 1 ] || kerr "key '$k' appears $n times (expected exactly 1)"
  done
  local unknown; unknown=$(awk -F'\t' -v keys="#trivo-snapshot-ok #end $MARKER_KEYS" 'BEGIN{n=split(keys,a," ");for(i=1;i<=n;i++)ok[a[i]]=1} !($1 in ok){print ($1==""?"<blank>":$1)}' "$f" | sort -u | tr '\n' ' ')
  [ -z "$unknown" ] || kerr "unknown key(s) or blank line(s): $unknown"
  [ "$(awk 'END{print NR}' "$f")" = 12 ] || kerr "has $(awk 'END{print NR}' "$f") lines (expected exactly 12)"
  [ "$(head -n1 "$f")" = $'#trivo-snapshot-ok\tv1' ] || kerr "first line is not exactly '#trivo-snapshot-ok<TAB>v1'"
  [ "$(tail -n1 "$f")" = $'#end\tok' ] || kerr "last line is not exactly '#end<TAB>ok' (truncated?)"
  [ "$(tail -c1 "$f" | od -An -c | tr -d ' ')" = '\n' ] || kerr "does not end with a newline"
  for k in $MARKER_KEYS; do
    i=$((i+1)); line="$(sed -n "${i}p" "$f")"
    case "$line" in "$k"$'\t'*) ;; *) kerr "line $i is not the key '$k' (keys must appear in the fixed order)"; continue;; esac
    [ "$(printf '%s' "$line" | awk -F'\t' '{print NF}')" = 2 ] || { kerr "'$k' does not have exactly one value field"; continue; }
    val="${line#*$'\t'}"
    case "$k" in
      database)          [[ "$val" =~ ^[A-Za-z0-9_]+$ ]] || kerr "database is not a plain identifier";;
      server_version|pg_dump_version) [[ "$val" =~ ^[0-9]+(\.[0-9]+)*$ ]] || kerr "$k is malformed";;
      snapshot_id)       [[ "$val" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || kerr "snapshot_id is malformed";;
      table_count)       [[ "$val" =~ ^[1-9][0-9]*$ ]] || kerr "table_count is not a positive integer";;
      dump_file)         [ "$val" = trivo_snap.dump ] || kerr "dump_file is not trivo_snap.dump";;
      dump_bytes)        [[ "$val" =~ ^[1-9][0-9]*$ ]] || kerr "dump_bytes is not a positive integer";;
      dump_sha256|manifest_sha256) [[ "$val" =~ ^[0-9a-f]{64}$ ]] || kerr "$k is not a lowercase sha256";;
      completed_utc)     [[ "$val" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || kerr "completed_utc is malformed";;
    esac
  done
  [ "$bad" = 0 ]
}

# mval FILE KEY -> value of a marker/manifest key, but ONLY if the key occurs exactly once with exactly one value field; otherwise prints
# nothing and returns 1 (so a caller comparing against it can never "match" a duplicated/ambiguous key).
mval() { awk -F'\t' -v k="$2" '$1==k{c++; v=$2; nf=NF} END{ if(c==1 && nf==2){print v; exit 0} exit 1 }' "$1"; }

# validate_dump_toc TOCFILE MANIFEST [MARKER] -> checks a dump against the manifest using the ACTUAL output of `pg_restore -l <dump>`
# (TOCFILE holds that output, CR already stripped). Only the archive HEADER (the leading ';' block, up to '; Selected TOC Entries:') is
# trusted for header facts - a table, comment or role whose name looks like a header line can never spoof it. Required, each exactly once:
#   dbname == manifest #database ; Format: CUSTOM ; Dumped from database version == manifest #server_version (first token) ;
#   Dumped by pg_dump version == marker pg_dump_version (first token, when MARKER is given).
# The entry list must be non-empty and its 'TABLE DATA public <name>' set must equal the manifest's table set exactly.
validate_dump_toc() {
  local toc="$1" man="$2" mk="${3:-}" bad=0 hdr k n v
  terr() { echo "  dump: $*"; bad=1; }
  [ -s "$toc" ] || { terr "pg_restore -l produced no output"; return 1; }
  grep -qxF '; Selected TOC Entries:' "$toc" || { terr "no '; Selected TOC Entries:' line - not a pg_restore listing"; return 1; }
  hdr="$(sed '/^; Selected TOC Entries:$/,$d' "$toc")"
  [ "$(printf '%s\n' "$hdr" | grep -vc '^;')" = 0 ] || terr "non-comment line inside the archive header"
  for k in 'dbname' 'Format' 'Dumped from database version' 'Dumped by pg_dump version'; do
    n=$(printf '%s\n' "$hdr" | grep -cE "^; +${k}: ") || true
    [ "$n" = 1 ] || terr "header '$k' appears $n times (expected exactly 1)"
  done
  hv() { printf '%s\n' "$hdr" | sed -nE "s/^; +$1: (.*)\$/\\1/p"; }
  [ "$(hv dbname)" = "$(mhdr "$man" '#database')" ] || terr "dump header dbname '$(hv dbname)' differs from the manifest '$(mhdr "$man" '#database')'"
  [ "$(hv Format)" = CUSTOM ] || terr "dump format is '$(hv Format)', expected CUSTOM"
  v="$(hv 'Dumped from database version')"; v="${v%% *}"
  [ "$v" = "$(mhdr "$man" '#server_version')" ] || terr "dump header server version '$v' differs from the manifest '$(mhdr "$man" '#server_version')'"
  if [ -n "$mk" ]; then
    v="$(hv 'Dumped by pg_dump version')"; v="${v%% *}"
    [ "$v" = "$(mval "$mk" pg_dump_version)" ] || terr "dump header pg_dump version '$v' differs from the marker's"
  fi
  local entries; entries="$(sed '1,/^; Selected TOC Entries:$/d' "$toc" | grep -v '^;' || true)"
  [ -n "$entries" ] || terr "the dump lists no entries"
  local dt mt only_d only_m
  dt="$(printf '%s\n' "$entries" | awk '$4=="TABLE" && $5=="DATA" && $6=="public"{print $7}' | LC_ALL=C sort)"
  mt="$(awk -F'\t' '!/^#/{print $1}' "$man" | LC_ALL=C sort)"
  only_d=$(comm -23 <(echo "$dt") <(echo "$mt") | tr '\n' ' '); only_m=$(comm -13 <(echo "$dt") <(echo "$mt") | tr '\n' ' ')
  [ -z "$only_d" ] || terr "table(s) in the dump but not in the manifest: $only_d"
  [ -z "$only_m" ] || terr "table(s) in the manifest but not in the dump: $only_m"
  [ "$bad" = 0 ]
}

# verify_bundle DIR [TOCFILE] -> everything that can be proven about a transferred bundle WITHOUT any database:
#   DIR is a real directory (not a symlink; trailing slashes ignored); exact file set, every one a regular non-symlink file; SHA256SUMS
#   covers exactly the three data files and every hash matches; manifest valid; marker valid and bound to the manifest (same snapshot
#   id/database/version/table count/hashes/byte size); the dump is readable by pg_restore and its header + table list equal the manifest's.
# TOCFILE = a file already holding `pg_restore -l` output of the dump (used on the production host, which has no pg_restore: host_run.sh
# produces it with the pinned postgres image). Without it pg_restore must be on PATH - there is NO fallback that skips the dump check.
verify_bundle() {
  local d="$1" toc_in="${2:-}" bad=0 f
  while [ "${#d}" -gt 1 ] && [ "${d%/}" != "$d" ]; do d="${d%/}"; done     # a trailing '/' would make `test -L` follow the link
  berr() { echo "  bundle: $*"; bad=1; }
  [ ! -L "$d" ] || { echo "  bundle: $d is a symbolic link (refused: the bundle must be a real directory)"; return 1; }
  [ -d "$d" ] || { echo "  bundle: not a directory: $d"; return 1; }
  local have; have=$(cd "$d" && ls -A | LC_ALL=C sort | tr '\n' ' ')
  [ "$have" = "$(echo $BUNDLE_FILES | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ')" ] || { berr "unexpected contents: [$have] (expected exactly: $BUNDLE_FILES)"; return 1; }
  for f in $BUNDLE_FILES; do [ -f "$d/$f" ] && [ ! -L "$d/$f" ] || berr "$f is not a regular file (symlinks are refused)"; done
  [ "$bad" = 0 ] || return 1
  # SHA256SUMS: exactly the three data files, nothing else, every hash a real sha256, then verify
  # (a leading '*' on a name is sha256sum's own binary-mode marker, written by Windows builds of sha256sum; the name itself is still compared exactly)
  local listed; listed=$(awk '{n=$2; sub(/^\*/,"",n); print n}' "$d/SHA256SUMS" | LC_ALL=C sort | tr '\n' ' ')
  [ "$listed" = "SNAPSHOT_OK manifest.tsv trivo_snap.dump " ] || berr "SHA256SUMS lists [$listed], expected exactly SNAPSHOT_OK manifest.tsv trivo_snap.dump"
  [ "$(awk 'END{print NR}' "$d/SHA256SUMS")" = 3 ] || berr "SHA256SUMS does not have exactly 3 lines"
  awk '!($1 ~ /^[0-9a-f]{64}$/ && NF==2){exit 1}' "$d/SHA256SUMS" || berr "SHA256SUMS has a malformed line"
  [ "$bad" = 0 ] || return 1
  ( cd "$d" && sha256sum -c SHA256SUMS ) || { berr "checksum verification FAILED"; return 1; }
  validate_manifest "$d/manifest.tsv" || return 1
  validate_marker "$d/SNAPSHOT_OK" || return 1
  local k
  for k in database server_version snapshot_id table_count; do
    [ "$(mval "$d/SNAPSHOT_OK" "$k")" = "$(mhdr "$d/manifest.tsv" "#$k")" ] || berr "marker $k differs from the manifest (not the same snapshot)"
  done
  [ "$(mval "$d/SNAPSHOT_OK" manifest_sha256)" = "$(sha256sum "$d/manifest.tsv" | cut -d' ' -f1)" ] || berr "marker manifest_sha256 differs from manifest.tsv"
  [ "$(mval "$d/SNAPSHOT_OK" dump_sha256)" = "$(sha256sum "$d/trivo_snap.dump" | cut -d' ' -f1)" ] || berr "marker dump_sha256 differs from trivo_snap.dump"
  [ "$(mval "$d/SNAPSHOT_OK" dump_bytes)" = "$(wc -c < "$d/trivo_snap.dump" | tr -d ' ')" ] || berr "marker dump_bytes differs from trivo_snap.dump"
  [ "$bad" = 0 ] || return 1
  # the dump itself, through the real pg_restore listing
  local toc_file tmp=""
  if [ -n "$toc_in" ]; then
    [ -s "$toc_in" ] || { berr "supplied pg_restore listing is missing or empty"; return 1; }
    toc_file="$toc_in"
  else
    command -v pg_restore >/dev/null 2>&1 || { berr "pg_restore is not available and no listing was supplied: the dump cannot be checked (refusing to skip it)"; return 1; }
    tmp="$(mktemp)"; toc_file="$tmp"
    ( cd "$d" && pg_restore -l trivo_snap.dump ) 2>/dev/null | tr -d '\r' > "$toc_file" || true
    [ -s "$toc_file" ] || { rm -f "$tmp"; berr "dump is not readable by pg_restore"; return 1; }
  fi
  validate_dump_toc "$toc_file" "$d/manifest.tsv" "$d/SNAPSHOT_OK" || bad=1
  [ -z "$tmp" ] || rm -f "$tmp"
  [ "$bad" = 0 ]
}

# parse_xref_result OUTPUT -> sets XCHK / XVIO from the cross-company scan's captured output, STRICTLY: exactly one result line of the
# exact form 'NOTICE:  XREF_RESULT checked=<n> violations=<m>' (psql's own prefix; anything surrounding it on the line is refused), no
# ERROR/FATAL/PANIC line, and the VIOLATION lines must agree with it (none when m=0; when m>0 their per-row counts must sum to m).
# Returns 1 with a reason on stdout if anything is off - never guesses.
parse_xref_result() {
  local out="$1" res n v sum
  if printf '%s\n' "$out" | grep -qE '^(psql:.*)?(ERROR|FATAL|PANIC):'; then echo "the scan reported an error"; return 1; fi
  n=$(printf '%s\n' "$out" | grep -c 'XREF_RESULT') || true
  [ "$n" = 1 ] || { echo "expected exactly one XREF_RESULT line, found $n"; return 1; }
  res=$(printf '%s\n' "$out" | grep -E '^NOTICE:  XREF_RESULT checked=[0-9]+ violations=[0-9]+$') || true
  [ -n "$res" ] || { echo "the XREF_RESULT line is not in the exact expected form"; return 1; }
  XCHK="${res#*checked=}"; XCHK="${XCHK%% *}"; XVIO="${res##*violations=}"
  v=$(printf '%s\n' "$out" | grep -c '^NOTICE:  VIOLATION ') || true
  sum=$(printf '%s\n' "$out" | sed -nE 's/^NOTICE:  VIOLATION .*: ([0-9]+) rows$/\1/p' | awk '{s+=$1} END{print s+0}')
  if [ "$XVIO" = 0 ]; then
    [ "$v" = 0 ] || { echo "violations=0 but $v VIOLATION line(s) present"; return 1; }
  else
    [ "$sum" = "$XVIO" ] || { echo "violations=$XVIO but the VIOLATION lines sum to $sum"; return 1; }
  fi
  return 0
}

# ---- restored-database catalog vs the DUMP's own declarations (RLS flags per table, policy definitions) -------------------------------
# The manifest only carries COUNTS of policies / forced tables. These compare each table's RLS enabled/forced flags and every policy's full
# definition (name, table, permissive/restrictive, command, roles, USING, WITH CHECK) against what the dump itself declares, taken from
# `pg_restore -s` (schema only, no row data). Expressions are compared with whitespace, parentheses, quotes and case removed: the dump text
# was deparsed by the source server (PG16) and the restored catalog is deparsed by the local one (PG18), which may parenthesise differently.
norm_def() { LC_ALL=C tr 'A-Z' 'a-z' | tr -d ' \t()"'; }

# dump_rls_flags SCHEMA_SQL -> lines 'table|enabled|forced' (only tables the dump marks); dump_policy_defs SCHEMA_SQL -> normalised policies
dump_rls_flags() {
  awk '/^ALTER TABLE (ONLY )?public\.[A-Za-z0-9_"]+ (ENABLE|FORCE) ROW LEVEL SECURITY;$/{ t=$0; sub(/^ALTER TABLE (ONLY )?public\./,"",t); sub(/ .*$/,"",t); gsub(/"/,"",t); if($0 ~ / ENABLE ROW/)e[t]=1; else f[t]=1; seen[t]=1 }
       END{for(t in seen) printf "%s|%s|%s\n", t, (e[t]?"t":"f"), (f[t]?"t":"f")}' "$1" | LC_ALL=C sort
}
dump_policy_defs() {
  grep '^CREATE POLICY ' "$1" | sed -E 's/^CREATE POLICY //; s/;$//' | norm_def | LC_ALL=C sort
}
# restored_rls_flags URL / restored_policy_defs URL -> same shapes from the live catalog (every public ordinary table / every policy)
restored_rls_flags() {
  psql "$1" -Atq -v ON_ERROR_STOP=1 -c "select c.relname||'|'||case when c.relrowsecurity then 't' else 'f' end||'|'||case when c.relforcerowsecurity then 't' else 'f' end from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' where c.relkind='r' and (c.relrowsecurity or c.relforcerowsecurity)" | LC_ALL=C sort
}
restored_policy_defs() {
  psql "$1" -Atq -v ON_ERROR_STOP=1 -c "select policyname||' on public.'||tablename||case when permissive='RESTRICTIVE' then ' as restrictive' else '' end||case when cmd<>'ALL' then ' for '||cmd else '' end||case when roles::text<>'{public}' then ' to '||trim(both '{}' from roles::text) else '' end||case when qual is not null then ' using '||qual else '' end||case when with_check is not null then ' with check '||with_check else '' end from pg_policies where schemaname='public'" | norm_def | LC_ALL=C sort
}

# compare_manifest FILE VERIFY_URL -> compares STRICTLY against the restored database (read through a role that bypasses RLS):
# identical table set and an identical count in every table. VERIFY_URL is the restored scratch database.
# Needs a `psql` that prints unaligned/tuples-only (-Atq) and strips CR (restore-manifest.sh's wrapper does).
compare_manifest() {
  local f="$1" url="$2" bad=0
  validate_manifest "$f" || return 1
  local restored; restored=$(psql "$url" -Atq -c "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1") || { echo "  manifest: cannot read the restored database"; return 1; }
  local only_m only_r
  only_m=$(comm -23 <(awk -F'\t' '!/^#/{print $1}' "$f" | LC_ALL=C sort) <(echo "$restored" | LC_ALL=C sort) | tr '\n' ' ')
  only_r=$(comm -13 <(awk -F'\t' '!/^#/{print $1}' "$f" | LC_ALL=C sort) <(echo "$restored" | LC_ALL=C sort) | tr '\n' ' ')
  [ -z "$only_m" ] || { echo "  FAIL: table(s) in the manifest but NOT in the restored database: $only_m"; bad=1; }
  [ -z "$only_r" ] || { echo "  FAIL: table(s) in the restored database but NOT in the manifest: $only_r"; bad=1; }
  local t a b n=0 mism=0
  while IFS=$'\t' read -r t a; do
    case "$t" in '#'*) continue;; esac
    b=$(psql "$url" -Atq -c "select count(*) from public.\"$t\"" 2>/dev/null || echo ERR)
    n=$((n+1)); if [ "$a" != "$b" ]; then echo "  FAIL: row count differs in $t: manifest=$a restored=$b"; mism=1; fi
  done < "$f"
  [ "$mism" = 0 ] || bad=1
  [ "$bad" = 0 ] && echo "  ok:   row counts identical to the snapshot manifest in all $n tables (table sets identical)"
  [ "$bad" = 0 ]
}
