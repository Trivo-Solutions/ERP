# Operator convenience, SOURCED (never executed): builds the environment restore-manifest.sh needs for the LOCAL staging cluster
# (PostgreSQL 18, localhost:54329, the real trivo_owner / trivo_backup / trivo_runtime role split). Credentials are read from files on
# this machine and exported into the current shell only - nothing is printed (no password, no URL). Usage:   . ./local_restore_env.sh
#
# FAILS CLOSED. Any problem makes `.` return non-zero, prints one generic reason (never a secret), and leaves NONE of the variables it
# manages set - not even ones left over from an earlier successful run - so restore-manifest.sh cannot be run on a half-built environment.
# A problem is: a credential file missing/unreadable/empty/multi-line; a required KEY missing or present more than once in rlstest.env;
# a URL that is not exactly postgresql://<role>:<password>@host:port/db with the expected role; a password that is not safely
# percent-encoded; psql missing; or the instance-identity lookup failing, returning nothing, or returning something that is not a number.
# Passwords taken from a URL are already percent-encoded and are used as-is; passwords read from the plain-text files are percent-encoded
# here before they go into a URL (so @ : / ? # % space etc. in them cannot corrupt or redirect the URL).
# Overridable for tests only: TRIVO_LOCAL_SECRETS_DIR (default /c/trivo-staging), TRIVO_LOCAL_PORT (default 54329), PG_BIN.

# percent-encode every byte except the RFC 3986 unreserved set (pure bash, byte-wise)
_trivo_urlenc() {
  local LC_ALL=C s="$1" i c out=""
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [A-Za-z0-9._~-]) out+="$c";; *) out+="$(printf '%%%02X' "'$c")";; esac
  done
  printf '%s' "$out"
}

# the single non-empty line of a secret file (CR/LF tolerated at the end only); fails if missing, empty or more than one line
_trivo_read_secret() {
  local f="$1" line rest n
  [ -f "$f" ] && [ -r "$f" ] && [ -s "$f" ] || return 1
  n="$(LC_ALL=C tr -d '\r' < "$f" | grep -c .)" || true
  [ "$n" = 1 ] || return 1
  line="$(LC_ALL=C tr -d '\r' < "$f" | grep .)" || return 1
  [ -n "$line" ] || return 1
  printf '%s' "$line"
}

# value of KEY in an env file: exactly one `KEY=...` line, optionally wrapped in one pair of quotes; fails otherwise
_trivo_env_value() {
  local f="$1" key="$2" n line v
  [ -f "$f" ] && [ -r "$f" ] && [ -s "$f" ] || return 1
  n="$(LC_ALL=C tr -d '\r' < "$f" | grep -c "^${key}=")" || true
  [ "$n" = 1 ] || return 1
  line="$(LC_ALL=C tr -d '\r' < "$f" | grep "^${key}=")" || return 1
  v="${line#"${key}="}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}";; \'*\') v="${v#\'}"; v="${v%\'}";; esac
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# password (still percent-encoded) out of a postgresql URL whose user must be exactly ROLE; fails on anything unexpected
_trivo_url_password() {
  local url="$1" role="$2" pw
  local re_url='^postgres(ql)?://([A-Za-z0-9_]+):([^@/?#]*)@([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?/([A-Za-z0-9_]+)(\?.*)?$'
  local re_pw='^([A-Za-z0-9._~!$&()*+,;=-]|'"'"'|%[0-9A-Fa-f]{2})+$'
  [[ "$url" =~ $re_url ]] || return 1
  [ "${BASH_REMATCH[2]}" = "$role" ] || return 1
  pw="${BASH_REMATCH[3]}"
  [ -n "$pw" ] || return 1
  # only unreserved characters, sub-delims and %XX escapes may remain (a raw @ / ? # would already have failed the match above)
  [[ "$pw" =~ $re_pw ]] || return 1
  printf '%s' "$pw"
}

_trivo_local_env() {
  local dir="${TRIVO_LOCAL_SECRETS_DIR:-/c/trivo-staging}" port="${TRIVO_LOCAL_PORT:-54329}" pgbin="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
  local H=localhost S="?sslmode=require" super bk owner_pw run_pw sysid ver raw
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
  [ -d "$dir" ] || return 1
  super="$(_trivo_read_secret "$dir/superpw.txt")" || return 1
  bk="$(_trivo_read_secret "$dir/backup-pw.txt")" || return 1
  raw="$(_trivo_env_value "$dir/rlstest.env" OWNER_DATABASE_URL)" || return 1
  owner_pw="$(_trivo_url_password "$raw" trivo_owner)" || return 1
  raw="$(_trivo_env_value "$dir/rlstest.env" DATABASE_URL)" || return 1
  run_pw="$(_trivo_url_password "$raw" trivo_runtime)" || return 1
  raw=""
  [ -d "$pgbin" ] && [ -x "$pgbin/psql" -o -x "$pgbin/psql.exe" ] || return 1
  local admin="postgresql://postgres:$(_trivo_urlenc "$super")@${H}:${port}/postgres${S}"
  # instance identity: must succeed, be non-empty and be a plain number (psql stderr is discarded: it can echo connection details)
  sysid="$(PATH="$pgbin:$PATH" PGSSLMODE=require PGCONNECT_TIMEOUT=10 command psql "$admin" -Atq -v ON_ERROR_STOP=1 -c 'select system_identifier from pg_control_system()' 2>/dev/null)" || return 1
  sysid="${sysid//$'\r'/}"; [[ "$sysid" =~ ^[0-9]+$ ]] || return 1
  ver="$(PATH="$pgbin:$PATH" PGSSLMODE=require PGCONNECT_TIMEOUT=10 command psql "$admin" -Atq -v ON_ERROR_STOP=1 -c 'show server_version' 2>/dev/null)" || return 1
  ver="${ver//$'\r'/}"; [[ "$ver" =~ ^[0-9]+(\.[0-9]+)*([[:space:]].*)?$ ]] || return 1
  # everything proven: only now export anything
  export PG_BIN="$pgbin"
  export PATH="$pgbin:$PATH"
  export MSYS_NO_PATHCONV=1 PGSSLMODE=require
  export ADMIN_DATABASE_URL="$admin"
  export OWNER_DATABASE_URL="postgresql://trivo_owner:${owner_pw}@${H}:${port}/postgres${S}"
  export SOURCE_DATABASE_URL="postgresql://trivo_backup:$(_trivo_urlenc "$bk")@${H}:${port}/postgres${S}"      # credential template only; its db name is swapped
  export RUNTIME_DATABASE_URL_TEMPLATE="postgresql://trivo_runtime:${run_pw}@${H}:${port}/__DB__${S}"
  export OWNER_ROLE=trivo_owner RESTORE_EXPECT_PORT="$port" RESTORE_EXPECT_SYSTEM_IDENTIFIER="$sysid"
  echo "local restore environment ready: instance port $RESTORE_EXPECT_PORT, system_identifier set (${ver%% *})"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "local_restore_env.sh must be SOURCED (. ./local_restore_env.sh), not executed: an executed script cannot export into your shell" >&2
  exit 2
fi
if _trivo_local_env; then
  _trivo_rc=0
else
  _trivo_rc=1
  unset ADMIN_DATABASE_URL OWNER_DATABASE_URL SOURCE_DATABASE_URL RUNTIME_DATABASE_URL_TEMPLATE OWNER_ROLE RESTORE_EXPECT_PORT RESTORE_EXPECT_SYSTEM_IDENTIFIER
  echo "local_restore_env.sh FAILED: credential files, required variables, URL parsing or the PostgreSQL identity lookup did not check out; no variable was exported (nothing secret is printed)" >&2
fi
unset -f _trivo_local_env _trivo_urlenc _trivo_read_secret _trivo_env_value _trivo_url_password
_trivo_ret="$_trivo_rc"; unset _trivo_rc
return "$_trivo_ret" 2>/dev/null || exit "$_trivo_ret"
