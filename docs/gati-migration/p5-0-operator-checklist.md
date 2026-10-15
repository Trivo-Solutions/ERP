# P5-0 Operator Discovery Checklist (revision 2)

Status: **NOT EXECUTED.** This is a checklist for the operator. Nothing in it has been run against any machine or database.
Source: `phase3-design-draft.md` (rev 6) §P.1, §P.5; `DEPLOY.md`; `server/src/config/database.ts`; `server/src/config/logger.ts`; `server/scripts/deploy-db.ps1`; `server/.env.production.template`.
Audience: the operator who will run P5-0 on the hosted Windows server. Written for **Windows PowerShell 5.1** (also works in 7).

**Revision 2 changes** (from the review of revision 1): no `npx` anywhere (Prisma is hoisted to `C:\ERP\ERP\node_modules\.bin\prisma.cmd`; `npx` could download it); PowerShell 5.1 quoting fixed by sending SQL on stdin; reserved variable names avoided (`$pid`, `$host`); `exceptions.log` and `error.log` searched with `combined.log`; every printed line truncated; API PID found from the listening port; scheduled-task executables listed without arguments; explicit `psql.exe` path; one evidence helper for every step; temporary environment variables restored in `finally`; database access now uses explicit `READ ONLY` transactions and a default migration check that needs no credential in the environment.

## How to read this

**Action tags**
- `OS-ONLY`: queries Windows state and changes nothing.
- `READS FILE`: reads a file's contents (secrets possible, so output is filtered and truncated).
- `FILE-META`: reads only a file's name, size and dates.
- `DB-READ`: connects to PostgreSQL and runs only fixed `SELECT`/`SHOW` statements inside a `READ ONLY` transaction (see "What read-only means here").
- Every command changes nothing, except the empty evidence folder and the evidence files the `Ev` helper writes.

**Rules for the whole run**
- Run in an elevated PowerShell only where a step says 🛡.
- Never type a password into a command line, a variable assignment, an environment variable you set yourself, or a file. `psql` prompts for it.
- Never run `Get-Content` on `.env`, `Get-ChildItem Env:`, `pm2 env`, `pm2 jlist`, `nssm dump` or `sc qc` into the evidence. Only the filtered commands below touch those sources.
- Do not run `prisma migrate deploy|dev|reset`, `db:secure`, `deploy-db.ps1`, `backup.sh`, `restore.sh` or `company:provision`.
- Review every evidence file before it leaves the host. Output is truncated and filtered, but you are the final check.

**Approval and credential key**
- 🟢 = no approval needed (OS-only or file metadata).
- 🟡 = needs the owner's go-ahead first (reads a config or log file that may hold secrets, or connects to a database).
- 🔑 = needs a database credential.
- 🛡 = needs elevated Windows permissions.

---

## PART 0: Session setup (once per PowerShell window)

**0a. First command: console only, writes nothing** 🟢 `OS-ONLY`
```powershell
Get-Date -Format o; hostname; [Environment]::OSVersion.VersionString; $PSVersionTable.PSVersion.ToString()
```
Capture the four lines. Pass: the host is the intended hosted server. Fail: wrong host, stop. The PowerShell version tells you whether the 5.1 notes apply.

**0b. Evidence helper** 🟢 `OS-ONLY` (creates the evidence folder; the only write in Part A)
```powershell
$S = 'C:\ERP\ERP\server'                         # A2 confirms whether the API really runs from here
$E = "$env:USERPROFILE\p5-0-evidence"
New-Item -ItemType Directory -Force $E | Out-Null

function Ev {                                    # run a block, truncate each line, save and show it
  param([string]$Id, [scriptblock]$Do)
  $out = @(& $Do 2>&1 | ForEach-Object {
    $s = "$_"
    if ($s.Length -gt 300) { $s.Substring(0, 300) + ' ...[truncated]' } else { $s }
  })
  $out | Out-File -FilePath (Join-Path $E "$Id.txt") -Encoding utf8
  $out
}
```
Every step below is run as `Ev '<ID>' { ... }`. In PowerShell 5.1, a native command's stderr can appear wrapped as `NativeCommandError`; that is cosmetic and is still captured.

---

## PART A: OS, file and configuration checks (no database connection)

### A1. PostgreSQL service and listening address 🟢 `OS-ONLY`
```powershell
Ev 'A1' {
  Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'postgres|pgsql' } |
    Select-Object Name,State,StartName,ProcessId,PathName
  Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,OwningProcess
}
```
- **Capture:** service name(s), state, the account it runs as, the data directory (`-D` in `PathName`), and the listen addresses. `PathName` is a service command line: if it contains anything other than paths and `-D`/`-w`/`-N`, redact it before saving.
- **Pass:** exactly one PostgreSQL 18 service is Running and the listen address is documented.
- **Finding (draft P.1 #4):** `0.0.0.0` or `::` means all interfaces. Record it for the owner; it is not a P5-0 fail.
- **Unverified if:** no service matches, or more than one appears (note which serves TRIVO).

### A2. How the API runs 🟢 `OS-ONLY`
```powershell
Ev 'A2' {
  Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
  Get-Service | Where-Object { $_.Name -match 'trivo|erp|api|node|nssm|pm2|w3svc|caddy' } | Select-Object Name,Status,StartType
  Get-Command pm2,nssm,docker,caddy -ErrorAction SilentlyContinue | Select-Object Name,Source
  Get-ScheduledTask | Where-Object { $_.TaskName -match 'trivo|erp|backup|pg_dump|node' } |
    Select-Object TaskName,State,@{n='Exec';e={ ($_.Actions | ForEach-Object { $_.Execute }) -join ';' }}
}
```
Arguments and working directories are deliberately not selected (they can carry URLs or keys); only the executable names are shown.
- **Capture:** node PIDs and paths, the process manager, which tools are on PATH, and scheduled tasks mentioning backups (record the task and its last run for P5-1).
- **Pass:** you can say how the API starts and which directory it runs from (so `$S` and the log folder are right).
- **Unverified if:** the starter can't be identified, or `$S` differs from where the API runs. Then fix `$S` before A4/A5.

### A3. The API's PID, from its listening port, and its database connections 🟢 `OS-ONLY` (🛡 may be needed to see another account's process)
```powershell
Ev 'A3-listeners' {
  Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    $nodePid = $_.Id
    Get-NetTCPConnection -State Listen -OwningProcess $nodePid -ErrorAction SilentlyContinue |
      Select-Object @{n='Pid';e={$nodePid}},LocalAddress,LocalPort
  }
}
```
Pick the PID whose port is the API port (`PORT`, template default 3001; A6 shows the declared value). Then set it by hand (never `$pid`, which is reserved):
```powershell
$apiPid = 0   # replace 0 with the API PID
Ev 'A3-db-connections' {
  Get-NetTCPConnection -OwningProcess $apiPid -State Established -ErrorAction SilentlyContinue |
    Where-Object RemotePort -eq 5432 | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort
}
```
- **Capture:** the listener table, the chosen PID, and the local source ports of its connections to 5432 (used in B2).
- **Pass:** one clear API PID and at least one established connection to PostgreSQL.
- **Unverified if:** more than one node process listens on a candidate port, or no connection is established (the pool may be idle; re-check after the API serves a page, without logging in).

### A4. NODE_ENV: actual and declared

**4a. Machine and user environment** 🟢 `OS-ONLY`
```powershell
Ev 'A4a' {
  "Machine: " + [Environment]::GetEnvironmentVariable('NODE_ENV','Machine')
  "User:    " + [Environment]::GetEnvironmentVariable('NODE_ENV','User')
}
```

**4b. Service-level environment, variable names only** 🛡 `OS-ONLY` (skip if the API is not a Windows service)
```powershell
$svc = '<SERVICE_NAME>'
Ev 'A4b' {
  foreach ($k in "HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Environment","HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Parameters") {
    if (Test-Path $k) {
      (Get-ItemProperty $k).PSObject.Properties | Where-Object Name -match 'Environment' |
        ForEach-Object { $_.Value } | ForEach-Object { ($_ -split '=')[0] }
    }
  }
}
```
Prints names only, so you can see whether `NODE_ENV`, `DATABASE_URL` or `PLATFORM_DATABASE_URL` are set at service level (which overrides `.env`, because dotenv never overrides an existing variable).

**4c. Declared value** 🟡 `READS FILE` (prints one line)
```powershell
Ev 'A4c' { Select-String -Path "$S\.env" -Pattern '^\s*NODE_ENV\s*=' | ForEach-Object { $_.Line } }
```

**4d. Actual value at the API's last start** 🟡 `READS FILE`
```powershell
Ev 'A4d' {
  Select-String -Path "$S\logs\combined.log" -Pattern 'Environment: ' | Select-Object -Last 3 | ForEach-Object { $_.Line }
}
```
The API logs `📦 Environment: <value>` at startup. In production the logger writes **JSON lines** (`{"…"}`, with ISO timestamps); outside production it writes coloured text with only `HH:mm:ss`. A line that starts with `{` therefore also supports `production`, but is not proof by itself. (Emoji may print garbled in 5.1; the text is still matched.)

- **Capture:** Machine, User, service names, `.env` line, and the last startup `Environment:` lines with timestamps and whether they start with `{`.
- **Pass:** the startup line says `production` and no machine or service value contradicts it.
- **Fail:** `development`, unset, or anything else.
- **Unverified if:** the log is missing, rotated, or has no date (dev format). A declared `.env` value is not proof of the running value.

### A5. Startup RLS line 🟡 `READS FILE`
```powershell
Ev 'A5' {
  Select-String -Path "$S\logs\combined.log","$S\logs\error.log","$S\logs\exceptions.log" `
    -Pattern 'Database roles:|Row-level security is NOT|Refusing to start' |
    Select-Object -Last 8 | ForEach-Object { "$($_.Filename): $($_.Line)" }
}
```
All three logs are searched: a refused production start is thrown at startup and may be in `error.log` or `exceptions.log` rather than `combined.log`.
- **Capture:** the matching lines with file names and timestamps (role names only; truncated to 300 characters).
- **Pass:** the most recent line is `✅ Database roles: runtime="trivo_runtime" platform="trivo_platform" — RLS enforced, tables FORCEd`.
- **Fail (draft P5-0: STOP):** the `⚠️ Row-level security is NOT being enforced` warning is the most recent line, a `Refusing to start` follows it, the roles named are not `trivo_runtime` and `trivo_platform`, or no line exists.
- **Unverified if:** the logs can't be read. A log line is history; B2 and B5 confirm it live.

### A6. Declared connection settings, redacted 🟡 `READS FILE`
```powershell
Ev 'A6' {
  Select-String -Path "$S\.env" -Pattern '^\s*(DATABASE_URL|PLATFORM_DATABASE_URL|OWNER_DATABASE_URL|BACKUP_DATABASE_URL|PORT|HOST|REDIS_URL)\s*=' |
   ForEach-Object {
     $n,$v = $_.Line -split '=',2
     $v = $v.Trim().Trim('"')
     if ($v -match '^postgres(ql)?://([^:/@]+)(:[^@]*)?@([^:/?]+)(:(\d+))?/([^?]+)') {
       "{0}: role={1} host={2} port={3} db={4}" -f $n.Trim(),$Matches[2],$Matches[4],$(if($Matches[6]){$Matches[6]}else{'5432'}),$Matches[7]
     } elseif ($n.Trim() -in 'PORT','HOST') { "{0}={1}" -f $n.Trim(),$v }
     else { "{0}: (not printed)" -f $n.Trim() }
   }
}
```
Prints role, host, port and database name for URLs, the plain value of `PORT`/`HOST`, and nothing else. Passwords, query strings and other URLs are never output.
- **Pass:** `DATABASE_URL` → `trivo_runtime`, `PLATFORM_DATABASE_URL` → `trivo_platform`, `OWNER_DATABASE_URL` → `trivo_owner` (if present), all distinct.
- **Fail:** the API URL names `postgres`, `trivo_owner`, the old dev role `sea_erp`, or any owner/superuser; or the platform URL is missing or equals the runtime one.
- **Unverified:** declared, not actual. B2 is the proof.

### A7. Disk space 🟢 `OS-ONLY`
```powershell
Ev 'A7' {
  Get-PSDrive -PSProvider FileSystem |
    Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
}
```
Data directory size (path from A1; 🛡 may need elevation; read-only but slow):
```powershell
$dataDir = '<DATA_DIR>'
Ev 'A7-datadir' { [math]::Round(((Get-ChildItem $dataDir -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB), 2) }
```
- **Pass (draft P5-3 rule):** free space on the intended restore drive ≥ 2× the database size plus margin (the database size comes from B-session1).
- **Unverified:** if the data directory can't be read, rely on the database size query.

### A8. Backup-file metadata (names, sizes, dates only) 🟢 `FILE-META`
```powershell
Ev 'A8' {
  Get-ChildItem 'C:\db-backups' -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName,Length,LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 40
}
```
Do not open or hash any file.
- **Pass (information only):** facts recorded. The files dated 2026-09-21 and 2026-09-26 do not satisfy P5-1 (draft).
- **Unverified:** the validity and source database of every file.

### A9. Co-tenancy hints (HRMS and Schemes) 🟢 `OS-ONLY`
```powershell
Ev 'A9' {
  Get-Service | Where-Object { $_.DisplayName -match 'hrms|scheme|payroll' } | Select-Object Name,DisplayName,Status
  Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 80,443,3000,3001,5000,5432,8080 |
    Select-Object LocalAddress,LocalPort,OwningProcess
}
```
- **Pass:** each application on the host is listed with its database, or marked unverified. The authoritative answer is B-session1 plus the applications' administrators.

---

## PART B: PostgreSQL checks (all read-only; all need a database credential)

**Approval gate 🟡 (owner):** the owner approves Part B as a whole. The best login is the superuser (B2 needs superuser or `pg_monitor`; `data_directory` needs superuser or `pg_read_all_settings`). Record whose credential is used. Credentials are never pasted into chat or evidence.

### What "read-only" means here (and what it does not)
Four layers, none of which is the whole guarantee:
1. **Explicit `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`** wraps every section. PostgreSQL rejects `INSERT`/`UPDATE`/`DELETE`/DDL/sequence writes inside it. This is the primary control.
2. **`PGOPTIONS='-c default_transaction_read_only=on'`** only sets a *default*. A session or statement can override it (`SET TRANSACTION READ WRITE`), so it is **not** a guarantee and is not relied on. It is set only as an extra, inside the helper, and restored in `finally`.
3. **A keyword tripwire** in the helper refuses SQL text containing write/session keywords or any psql meta-command other than `\echo`. It is a heuristic against typos, **not** a security boundary.
4. **The SQL is fixed and reviewed here.** Only `SELECT`, `SHOW` and the functions `version()`, `pg_database_size()`, `has_database_privilege()`, `pg_backend_pid()` are used; none writes.

Residual facts: a read-only transaction still permits writes to temporary tables (none are used); a superuser *could* override the read-only setting with hand-typed SQL (so do not type ad-hoc SQL in these sessions); and **connecting is observable**: it appears in the server log and `pg_stat_activity`.

### Credentials in Part B
`psql` prompts for the password on the console (it reads it from the console, not from the piped SQL), so no password is on a command line, in an environment variable, or in a file. Do **not** work around a failed prompt with `PGPASSWORD`, `.pgpass` or a connection string. If `psql` cannot prompt, stop and report. The helper refuses to run if `PGPASSWORD`/`PGPASSFILE` is already set. Note: a `pgpass.conf` that already exists under `%APPDATA%\postgresql\` would be used silently; the setup reports whether one exists (it is not read).

### Part B setup
```powershell
$PG     = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$PgHost = '<HOST>'      # from A1/A6 (never name a variable $host; it is reserved)
$PgPort = '<PORT>'
$PgUser = '<LOGIN>'
$AdminDb = 'postgres'
$TrivoDb = '<TRIVO_DB>' # from A6/B4

Ev 'B-setup' {
  "psql.exe present: " + (Test-Path $PG)
  "PGPASSWORD set:  " + [bool]$env:PGPASSWORD
  "PGPASSFILE set:  " + [bool]$env:PGPASSFILE
  "pgpass.conf exists (not read): " + (Test-Path "$env:APPDATA\postgresql\pgpass.conf")
}

function Invoke-RoPsql {
  param([string]$Db, [string[]]$Sections)
  if ($env:PGPASSWORD -or $env:PGPASSFILE) { throw 'PGPASSWORD/PGPASSFILE is set; unset it first.' }
  $deny = '\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|VACUUM|REINDEX|CLUSTER|REFRESH|LOCK|NOTIFY|LISTEN|COMMIT|BEGIN|SAVEPOINT|PREPARE|EXECUTE|DISCARD|IMPORT|COMMENT)\b'
  foreach ($s in $Sections) {
    if ($s -match $deny)          { throw "Refused: section contains a non-read keyword ($($Matches[1]))." }
    if ($s -match '\\(?!echo\b)') { throw 'Refused: psql meta-command other than \echo.' }
  }
  $script = ($Sections | ForEach-Object { "BEGIN TRANSACTION READ ONLY;`n$_`nROLLBACK;" }) -join "`n"
  $oldOpt = $env:PGOPTIONS; $oldTmo = $env:PGCONNECT_TIMEOUT
  try {
    $env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=15000'
    $env:PGCONNECT_TIMEOUT = '5'
    $script | & $PG -X -q -A -P pager=off -h $PgHost -p $PgPort -U $PgUser -d $Db
  }
  finally {
    if ($null -eq $oldOpt) { Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue } else { $env:PGOPTIONS = $oldOpt }
    if ($null -eq $oldTmo) { Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue } else { $env:PGCONNECT_TIMEOUT = $oldTmo }
  }
}
```
`ON_ERROR_STOP` is deliberately off: each section is its own transaction, so a privilege error in one section is shown and the next section still runs. Each `psql` session prompts for the password once. Part B uses **two** sessions.

### B-session 1: cluster-wide checks (B1–B4) 🟡🔑 `DB-READ`, connected to `$AdminDb`
In the here-strings below the closing `'@` must be at column 0.
```powershell
$Sess1 = @()
$Sess1 += @'
\echo === B1 identity
SELECT version();
SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser;
SHOW listen_addresses;
SHOW ssl;
'@
$Sess1 += @'
\echo === B1 data_directory (needs superuser or pg_read_all_settings)
SHOW data_directory;
'@
$Sess1 += @'
\echo === B3 roles
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolconnlimit
FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;
'@
$Sess1 += @'
\echo === B3 per-role and per-database settings
SELECT r.rolname, coalesce(d.datname, '(all)') AS db, s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase ORDER BY 1, 2;
'@
$Sess1 += @'
\echo === B4 databases
SELECT d.datname, r.rolname AS owner, pg_size_pretty(pg_database_size(d.oid)) AS size, d.datallowconn
FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE NOT d.datistemplate ORDER BY d.datname;
'@
$Sess1 += @'
\echo === B4 who can connect
SELECT datname,
       has_database_privilege('trivo_runtime',  datname, 'CONNECT') AS runtime_connect,
       has_database_privilege('trivo_platform', datname, 'CONNECT') AS platform_connect
FROM pg_database WHERE NOT datistemplate;
'@
$Sess1 += @'
\echo === B2 actual connections (no query text)
SELECT pid, usename, datname, application_name, client_addr, client_port, state
FROM pg_stat_activity WHERE datname IS NOT NULL AND pid <> pg_backend_pid() ORDER BY datname, usename;
'@
Ev 'B-session1' { Invoke-RoPsql -Db $AdminDb -Sections $Sess1 }
```
Expected evidence and criteria, per section:
- **B1:** PostgreSQL 18 (the draft's expectation) and `data_directory` matching A1. Unverified for any setting your login can't read (say which).
- **B2 (actual API role):** match each `client_port` to the local ports captured in A3. **Pass:** the API's rows are `trivo_runtime` (and `trivo_platform` for operator paths) in the TRIVO database. **Fail (draft: STOP):** `postgres`, `trivo_owner`, `sea_erp` or any superuser/owner; or both API clients on the same role. **Unverified:** NULL columns (your login can't see other users), or no port match (re-run after the API serves a page, without logging in).
- **B3:** **Pass:** `trivo_owner`, `trivo_runtime`, `trivo_platform` exist; `trivo_runtime` is not superuser and has no BYPASSRLS; `trivo_platform` has BYPASSRLS and is not superuser; `trivo_backup` present or recorded as absent. **Fail:** a missing `trivo_*` role, or `trivo_runtime` with `rolsuper`/`rolbypassrls`. Roles that are neither `trivo_*` nor `postgres` are co-tenancy evidence.
- **B4:** **Pass:** TRIVO's database is named (cross-check B2 and A6) with its size (feeds A7/P5-3). Flag every other database, and any non-TRIVO database the `trivo_*` roles can connect to, for DEC-2.

### B-session 2: inside the TRIVO database (B5–B7a) 🟡🔑 `DB-READ`, connected to `$TrivoDb`
```powershell
$Sess2 = @()
$Sess2 += @'
\echo === B5 FORCE RLS counts
SELECT count(*) FILTER (WHERE c.relrowsecurity)      AS rls_on,
       count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced,
       count(*) FILTER (WHERE NOT c.relforcerowsecurity) AS unforced,
       count(*)                                      AS tenant_tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relkind = 'r' AND c.relname IN (SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation');
'@
$Sess2 += @'
\echo === B5 table owners
SELECT tableowner, count(*) FROM pg_tables WHERE schemaname = 'public' GROUP BY 1;
'@
$Sess2 += @'
\echo === B5 policies, composite FKs, size
SELECT (SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation') AS tenant_isolation_policies,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) = 2 AND connamespace = 'public'::regnamespace) AS two_column_fks,
       pg_size_pretty(pg_database_size(current_database())) AS db_size;
'@
$Sess2 += @'
\echo === B6 companies (identifiers only)
SELECT code, name, "isActive", "starterPackageVersion", "createdAt" FROM companies ORDER BY "createdAt";
'@
$Sess2 += @'
\echo === B7a prisma migration ledger (counts)
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)     AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)                         AS rolled_back
FROM _prisma_migrations;
'@
$Sess2 += @'
\echo === B7a prisma migration ledger (names)
SELECT 'MIG:' || migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1;
'@
$out2 = Ev 'B-session2' { Invoke-RoPsql -Db $TrivoDb -Sections $Sess2 }
```
- **B5 pass:** `unforced = 0`; `rls_forced = tenant_tables`; tables owned by `trivo_owner`, not `trivo_runtime` or `postgres`; policies ≥ 80 and two-column FKs ≥ 58 (thresholds from the draft/CLAUDE.md, measured on a different stack: guidance, and two-column FKs also counts non-tenant FKs). **Fail:** any unforced table, or the runtime role owning tables. **Unverified:** zero `tenant_isolation` policies means an unmigrated or non-TRIVO database; say so.
- **B6 pass:** the existing client's company code is named (a new code must not collide, including look-alike folding 0→O, 1/L→I, 5→S, 8→B; draft P.2). Only code, name, flags: never query a company-scoped table. **Unverified:** zero rows from a non-superuser, non-platform login is not "no companies".
- **B7a pass:** `unfinished = 0`, `rolled_back = 0`, and the name comparison below shows no difference.

**B7a: compare the ledger to the repository** 🟢 `OS-ONLY` (no database access; uses `$out2` already in memory)
```powershell
Ev 'B7a-compare' {
  $applied = $out2 | Where-Object { $_ -match '^MIG:' } | ForEach-Object { $_.Substring(4).Trim() }
  $local   = Get-ChildItem "$S\prisma\migrations" -Directory | ForEach-Object { $_.Name }
  "applied in database : $(@($applied).Count)"
  "migration folders   : $(@($local).Count)"
  $diff = Compare-Object -ReferenceObject $local -DifferenceObject $applied
  if ($diff) { $diff | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" } } else { 'NO DIFFERENCE' }
}
```
`=>` = in the database but not in the repo (fail); `<=` = in the repo but not applied (pending: **record, do not apply**). The repository currently has 112 migrations; the latest is `20261017100000_user_table_layouts`. This compares **names only**; it does not detect a modified already-applied migration (checksum drift), which only `prisma migrate status` reports (B7b).

### B7b. Optional: `prisma migrate status` 🟡🔑 `DB-READ` — needs a **separate** owner approval acknowledging the exposure below
**Unavoidable credential exposure.** Prisma reads its connection string from the `DATABASE_URL` environment variable, so the owner password must exist in the environment of the PowerShell process and its child processes (`prisma.cmd`, `node`) for the seconds the command runs. Consequences:
- It is **not** on any command line, so it does not appear in process listings or command-line audit events, and nothing writes it to a file.
- It *is* readable, during that window, by the same user's processes and by an administrator or debugger inspecting those processes' environment or memory, and could land in a crash dump.
- The .NET string holding the password cannot be zeroed; `$null` only drops the reference. It lingers in memory until garbage collection or process exit. **Close the PowerShell window afterwards.**
- Prisma also loads `server\.env` into its own process (secrets are in it; none are printed), and may echo the connection string in an error. The filter below masks `scheme://user:pass@`, but review the evidence file anyway.
- B7a already answers "what is applied and what is pending" with no credential in the environment. Use B7b only if checksum drift matters.

```powershell
cd $S
Ev 'B7b' {
  $env:CHECKPOINT_DISABLE = '1'                      # no update/telemetry network call
  try {
    $sec = Read-Host -AsSecureString 'trivo_owner password'
    $pw  = [pscredential]::new('x', $sec).GetNetworkCredential().Password
    $env:DATABASE_URL = "postgresql://trivo_owner:$([uri]::EscapeDataString($pw))@$($PgHost):$($PgPort)/$($TrivoDb)?schema=public"
    & 'C:\ERP\ERP\node_modules\.bin\prisma.cmd' migrate status 2>&1 |
      ForEach-Object { "$_" -replace 'postgres(ql)?://[^@\s]+@','postgresql://***@' }
  }
  finally {
    Remove-Item Env:DATABASE_URL, Env:CHECKPOINT_DISABLE -ErrorAction SilentlyContinue
    $pw = $null; $sec = $null
  }
}
```
This calls the hoisted CLI directly (no `npx`, so nothing can be downloaded), and only ever runs the `status` subcommand. If `prisma.cmd` is missing at that path, stop and report; do not install it.
- **Pass:** "Database schema is up to date!" with 112 migrations. **Fail:** a failed migration, or an applied migration missing from the repo. **Record, do not act on:** pending migrations.

---

## PART C: Items with no safe command (written answers)

| Item | Who | Evidence |
|---|---|---|
| Does HRMS or Schemes use this cluster? | Their administrator, plus B-session1 findings | Written statement. **Unverified** until given. |
| Who holds the PostgreSQL superuser credential; does `trivo_backup` exist? | Owner | Name and role only. Never the password. |
| Is any scheduled backup running (A2 tasks, A8 dates)? | Operator | Task name and last-run date, or "none found". |
| Are HRMS and Schemes backed up before any cluster-level change? | Owner | Written confirmation (draft P.5). |

---

## Approval and permission matrix

| Step | Owner approval | DB credential | Elevated Windows | Notes |
|---|---|---|---|---|
| 0a, 0b, A1, A2, A3, A7, A8, A9 | No | No | A3 / A7-datadir may | OS-only or file metadata |
| A4a | No | No | No | One variable |
| A4b | No | No | **Yes** | Names only |
| A4c, A4d, A5, A6 | **Yes** (read `.env`/logs) | No | No | Filtered and truncated |
| B-setup | **Yes** (Part B gate) | No | No | Checks that tools and credentials-in-environment are absent |
| B-session1 (B1–B4) | **Yes** | **Yes** (superuser / `pg_monitor` for B2, B1 data dir) | No | Read-only transactions |
| B-session2 (B5–B7a) | **Yes** | **Yes** | No | Read-only transactions |
| B7a-compare | No | No | No | In-memory comparison |
| B7b | **Yes, separate** | **Yes** (owner) | No | Credential in environment, see exposure notes |

---

## Evidence record and verdict

`Ev` saves one UTF-8 file per step in `$E`. For each step also note: who ran it, the time, and any `UNVERIFIED: reason`. Nothing goes back into the repo (including `environment-inventory.md`) until a separate instruction says so. `DECISIONS.md` is not touched; DEC-2 is the owner's entry.

**P5-0 verdict (draft's own rule):**
- **PASS** needs all of:
  - A5, B2, B3 and B5 show the API connecting as `trivo_runtime` (platform as `trivo_platform`), neither superuser nor owner.
  - B5: `unforced = 0`, tables owned by `trivo_owner`.
  - A4: `NODE_ENV=production`.
  - B6: the existing company code is known.
  - B7a/B7b: current, or the pending list is recorded.
  - A7/B4: disk and database size recorded.
- **STOP** if the RLS-not-enforced warning is the latest startup line, the API role is a superuser or owner, or any tenant table is unforced. Provisioning would then create a company in a database with no tenant isolation.
- Anything not established is **UNVERIFIED** with the reason. It is never marked pass.

## Cleanup
The helper restores `PGOPTIONS`/`PGCONNECT_TIMEOUT` itself, and B7b removes `DATABASE_URL`/`CHECKPOINT_DISABLE` in `finally`. After Part B, close the PowerShell window and confirm nothing remains:
```powershell
Ev 'Z-cleanup' { 'DATABASE_URL set: ' + [bool]$env:DATABASE_URL; 'PGOPTIONS set: ' + [bool]$env:PGOPTIONS; 'PGPASSWORD set: ' + [bool]$env:PGPASSWORD }
```
Expected: all `False`.

## Limits of this checklist
- A4's "actual" `NODE_ENV` comes from the startup log line (and the JSON-versus-text format as supporting evidence). No command reads a live process's environment.
- The B5 thresholds (≥ 80 policies, ≥ 58 two-column FKs) come from the repo's docs, not this server; a lower count is something to investigate, not an automatic fail.
- B6's quoted column names follow `schema.prisma` field names; Prisma's mapped column names were not checked. If a section errors, the error is shown and the other sections still run.
- None of these commands has been dry-run on any machine. In particular, `psql` reading the password from the console while its stdin is piped is expected behaviour on Windows but is **unverified** here.
