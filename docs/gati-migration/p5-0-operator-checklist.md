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
    $s = $s -replace '://[^/\s:]+:[^/\s]*@','://***@' `
            -replace '(?i)\bbearer\s+\S+','Bearer ***' `
            -replace '(?i)([\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["'']?\s*[=:]\s*)(?:"[^"]*"|''[^'']*''|\S+)','$1***'
    if ($s.Length -gt 300) { $s.Substring(0, 300) + ' ...[truncated]' } else { $s }
  })
  $out | Out-File -FilePath (Join-Path $E "$Id.txt") -Encoding utf8
  $out
}
```
Every step below is run as `Ev '<ID>' { ... }`. `Ev` also applies three regex masks to each output line before it is shown or saved: `://user:pass@` credentials in a URI (including `%`-encoded passwords and passwords containing `@`), `Bearer <token>`, and `password|passwd|secret|token|api_key` assignments written with `=` or `:` (including JSON `"key": "value"`, quoted multi-word values and names such as `AWS_SECRET_ACCESS_KEY`). **This is a best-effort backstop, not a guarantee, and not a substitute for the filtered commands.** Regex masking cannot recognise every secret. Known gaps, which are *not* masked: a secret separated from its name by a space only (`password hunter2`); a bare key or token with no name in front of it (for example `sk-…`); a value on the line after its name (output is masked one line at a time); and any secret under a name the pattern does not list. Read every evidence file yourself before it leaves the host. In PowerShell 5.1, a native command's stderr can appear wrapped as `NativeCommandError`; that is cosmetic and is still captured.

---

## PART A: OS, file and configuration checks (no database connection)

### A1. PostgreSQL service and listening address 🟢 `OS-ONLY`
```powershell
Ev 'A1' {
  Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'postgres|pgsql' } |
    Select-Object Name,State,StartName,ProcessId,
      @{n='DataDir';e={ if ($_.PathName -match '-D\s+"([^"]+)"') { $Matches[1] } elseif ($_.PathName -match '-D\s+(\S+)') { $Matches[1] } else { '(no -D found)' } }}
  Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,OwningProcess
}
```
- **Capture:** service name(s), state, the account it runs as, the data directory (`-D` in `PathName`), and the listen addresses. The service command line (`PathName`) is never selected or written; only the `-D` data-directory path is extracted from it in memory.
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
        ForEach-Object { $_.Value } | Where-Object { "$_" -match '=' } | ForEach-Object { ($_ -split '=')[0] }
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

### B5 expected tenant-table inventory (defined independently of the database) — put this above `$Sess2`
The 134 names below were derived **from `server/prisma/schema.prisma` at the checklist's repo HEAD** (every model that declares a `companyId` field, using its `@@map` table name), **not** from the database and not from `pg_policies`. Re-derive it if the repo has moved. The six platform tables (`companies`, `users`, `hsn_codes`, `state_master`, `platform_audit_logs`, `_prisma_migrations`) are the only `public` tables allowed to be outside it.
```powershell
$ExpectedTenantTables = @(
  'accounts', 'approval_history', 'artisans', 'audit_logs', 'bom_items',
  'bom_processes', 'branch_payment_providers', 'branch_transfer_items', 'branch_transfers', 'branches',
  'category_sub_categories', 'client_notifications', 'clients', 'collections', 'company_gst_aato_histories',
  'company_gst_aatos', 'company_gst_registrations', 'company_invitations', 'company_users', 'consumable_transactions',
  'consumables', 'cost_centers', 'cost_estimates', 'credit_note_items', 'credit_note_templates',
  'credit_notes', 'customer_advance_applications', 'customer_advance_payments', 'customer_advances', 'debit_note_items',
  'debit_note_templates', 'debit_notes', 'design_categories', 'design_files', 'designs',
  'discount_approvals', 'einvoice_records', 'estimate_templates', 'export_documents', 'goods_receipt_notes',
  'grn_item_component_rates', 'grn_items', 'gst2b_documents', 'gst2b_statements', 'gst_filing_attempts',
  'gst_filing_snapshots', 'gst_integration_configs', 'gst_integration_credentials', 'gst_integration_request_logs', 'gst_return_periods',
  'hallmarking_batches', 'hallmarking_items', 'hardware_devices', 'invoice_items', 'invoice_payments',
  'jewelry_tag_materials', 'jewelry_tags', 'job_cards', 'job_processes', 'journal_entries',
  'journal_lines', 'karat_master', 'karigar_ledger', 'making_charges', 'material_codes',
  'material_reservations', 'memo_items', 'memo_outs', 'metal_rates', 'metal_stock_movements',
  'metal_stocks', 'number_sequences', 'offer_rules', 'offers', 'old_gold_exchanges',
  'order_items', 'payment_providers', 'photography_capture_commands', 'photography_stations', 'po_item_categories',
  'po_item_components', 'po_items', 'pos_terminals', 'pr_items', 'price_masters',
  'process_tolerances', 'product_categories', 'purchase_lots', 'purchase_orders', 'purchase_requisitions',
  'purchase_return_items', 'purchase_returns', 'qc_checkpoints', 'rcm_liabilities', 'repair_cases',
  'repair_jobs', 'repair_transactions', 'repair_transfer_items', 'repair_transfers', 'roles',
  'sales_debit_note_items', 'sales_debit_notes', 'sales_invoices', 'sales_orders', 'sales_return_items',
  'sales_returns', 'self_invoices', 'setting_types', 'sizes', 'station_credentials',
  'stock_audit_items', 'stock_audits', 'stock_types', 'stone_grades', 'stone_lot_splits',
  'stone_lots', 'stone_types', 'sub_categories', 'subcontractor_invoices', 'supplier_payments',
  'suppliers', 'system_configs', 'tag_estimate_items', 'tag_estimates', 'tag_history',
  'tag_images', 'tag_retags', 'tag_templates', 'tax_invoice_templates', 'tax_invoices',
  'user_branch_access', 'user_table_layouts', 'vendor_component_rates', 'wip_tracking'
)
$PlatformTables = @('companies','users','hsn_codes','state_master','platform_audit_logs','_prisma_migrations')
$ev = ($ExpectedTenantTables | ForEach-Object { "('$_')" }) -join ','
$pv = ($PlatformTables       | ForEach-Object { "('$_')" }) -join ','
"expected tenant tables: $($ExpectedTenantTables.Count) (expect 134)"
```
The required policy (from migrations `20260923130000`/`20260923150000` onward): exactly one policy named `tenant_isolation`, `PERMISSIVE`, command `ALL`, role `public`, with `USING` and `WITH CHECK` both equal to `"companyId" = current_setting('app.tenant_company_id', true)` (compared after removing the `::text` cast PostgreSQL adds when it prints the expression).

### B-session 2: inside the TRIVO database (B5–B7a) 🟡🔑 `DB-READ`, connected to `$TrivoDb`
```powershell
$Sess2 = @()
$Sess2 += @"
\echo === B5 RLS inventory: expected vs actual (only problems are listed; SUMMARY rows always)
WITH expected(t) AS (VALUES $ev),
platform(t)  AS (VALUES $pv),
want(q) AS (VALUES ('("companyId" = current_setting(''app.tenant_company_id'', true))')),
tbl AS (
  SELECT c.relname AS t, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
),
pol AS (
  SELECT tablename AS t,
         count(*) AS n,
         count(*) FILTER (WHERE policyname = 'tenant_isolation' AND permissive = 'PERMISSIVE' AND cmd = 'ALL'
                            AND roles = '{public}'
                            AND replace(qual, '::text', '') = (SELECT q FROM want)
                            AND replace(with_check, '::text', '') = (SELECT q FROM want)) AS good
  FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename
)
SELECT 'PROBLEM' AS kind, e.t AS name,
       concat_ws(', ',
         CASE WHEN tb.t IS NULL THEN 'table missing' END,
         CASE WHEN tb.t IS NOT NULL AND NOT tb.rls_on THEN 'RLS not enabled' END,
         CASE WHEN tb.t IS NOT NULL AND NOT tb.rls_forced THEN 'FORCE RLS off' END,
         CASE WHEN tb.t IS NOT NULL AND coalesce(p.good, 0) <> 1 THEN 'policy missing or expression not recognised — investigate' END,
         CASE WHEN coalesce(p.n, 0) > 1 THEN 'more than one policy' END) AS detail
FROM expected e LEFT JOIN tbl tb ON tb.t = e.t LEFT JOIN pol p ON p.t = e.t
WHERE tb.t IS NULL OR NOT tb.rls_on OR NOT tb.rls_forced OR coalesce(p.n, 0) <> 1 OR coalesce(p.good, 0) <> 1
UNION ALL
SELECT 'UNEXPECTED_TABLE', tb.t, 'in public but in neither the expected tenant list nor the platform list'
FROM tbl tb WHERE tb.t NOT IN (SELECT t FROM expected) AND tb.t NOT IN (SELECT t FROM platform)
UNION ALL
SELECT 'UNEXPECTED_POLICY', p.t, 'policy on a table outside the expected tenant list'
FROM pol p WHERE p.t NOT IN (SELECT t FROM expected)
UNION ALL
SELECT 'SUMMARY', 'expected_tenant_tables', count(*)::text FROM expected
UNION ALL
SELECT 'SUMMARY', 'present_in_database', count(*)::text FROM expected e JOIN tbl tb ON tb.t = e.t
UNION ALL
SELECT 'SUMMARY', 'rls_on_and_forced', count(*)::text FROM expected e JOIN tbl tb ON tb.t = e.t WHERE tb.rls_on AND tb.rls_forced
UNION ALL
SELECT 'SUMMARY', 'with_required_policy', count(*)::text FROM expected e JOIN pol p ON p.t = e.t WHERE p.n = 1 AND p.good = 1
ORDER BY 1, 2;
"@
$Sess2 += @'
\echo === B5 policy diagnostic: every public policy on a table whose RLS flags or policy shape the inventory would flag (read-only; no rows after this line = nothing to show)
WITH want(q) AS (VALUES ('("companyId" = current_setting(''app.tenant_company_id'', true))')),
tbl AS (
  SELECT c.relname AS t, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
),
pol AS (
  SELECT tablename AS t,
         count(*) AS n,
         count(*) FILTER (WHERE policyname = 'tenant_isolation' AND permissive = 'PERMISSIVE' AND cmd = 'ALL'
                            AND roles = '{public}'
                            AND replace(qual, '::text', '') = (SELECT q FROM want)
                            AND replace(with_check, '::text', '') = (SELECT q FROM want)) AS good
  FROM pg_policies WHERE schemaname = 'public' GROUP BY tablename
),
flagged AS (
  SELECT tb.t FROM tbl tb JOIN pol p ON p.t = tb.t
  WHERE NOT tb.rls_on OR NOT tb.rls_forced OR p.n <> 1 OR p.good <> 1
)
SELECT pp.tablename, pp.policyname, pp.permissive, pp.cmd, pp.roles::text AS roles, pp.qual, pp.with_check
FROM pg_policies pp JOIN flagged f ON f.t = pp.tablename
WHERE pp.schemaname = 'public'
ORDER BY pp.tablename, pp.policyname;
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
- **B5 pass:** the inventory query returns **no** `PROBLEM`, `UNEXPECTED_TABLE` or `UNEXPECTED_POLICY` rows, and its `SUMMARY` rows read `expected_tenant_tables` = `present_in_database` = `rls_on_and_forced` = `with_required_policy` = 134; tables owned by `trivo_owner`, not `trivo_runtime` or `postgres`; two-column FKs ≥ 58 (a guidance figure from the draft/CLAUDE.md, measured on a different stack, and it also counts non-tenant FKs). **Structural STOP:** any `PROBLEM` row whose detail says `table missing`, `RLS not enabled` or `FORCE RLS off`, or the runtime role owning tables. **Investigate (neither pass nor automatic fail):** a `PROBLEM` row whose detail says `policy missing or expression not recognised — investigate` or `more than one policy`; an `UNEXPECTED_TABLE`/`UNEXPECTED_POLICY` row (a newer migration than the repo list, or a stray table); or a count other than 134. For these, read the policy diagnostic section: it prints each policy's `policyname`, `permissive`, `cmd`, `roles`, `qual` and `with_check` exactly as PostgreSQL shows them. A recognised-but-differently-printed expression is not proof of a hole, and an unrecognised one is not proof of safety; decide from the printed expression, and record the item as **Unverified** until you have. **Unverified, never pass:** if the inventory returned **zero `SUMMARY` rows**, treat B5 as Unverified: a psql error (permissions, a failed section, a dropped connection) can yield no result rows at all, so silence is not a clean result. The same goes for a missing `=== B5 policy diagnostic` header line: the diagnostic did not run, so its absence of rows says nothing. The exact printed form of the policy expression on the live server (compared after dropping `::text`) is itself unverified.
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
$oldDbUrl = $env:DATABASE_URL; $oldCheckpoint = $env:CHECKPOINT_DISABLE    # remember, restore in finally
Push-Location $S -ErrorAction Stop
try {
Ev 'B7b' {
  try {
    $env:CHECKPOINT_DISABLE = '1'                    # no update/telemetry network call
    $sec = Read-Host -AsSecureString 'trivo_owner password'
    $pw  = [pscredential]::new('x', $sec).GetNetworkCredential().Password
    $env:DATABASE_URL = "postgresql://trivo_owner:$([uri]::EscapeDataString($pw))@$($PgHost):$($PgPort)/$($TrivoDb)?schema=public"
    & 'C:\ERP\ERP\node_modules\.bin\prisma.cmd' migrate status 2>&1 |
      ForEach-Object { "$_" -replace 'postgres(ql)?://[^@\s]+@','postgresql://***@' }
  }
  finally {
    if ($null -eq $oldDbUrl)      { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }      else { $env:DATABASE_URL = $oldDbUrl }
    if ($null -eq $oldCheckpoint) { Remove-Item Env:CHECKPOINT_DISABLE -ErrorAction SilentlyContinue } else { $env:CHECKPOINT_DISABLE = $oldCheckpoint }
    $pw = $null; $sec = $null
  }
}
} finally { Pop-Location }
```
Whatever `DATABASE_URL` / `CHECKPOINT_DISABLE` held before (including nothing) is put back, and the working directory is restored, even if the command fails or is interrupted.
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
  - B5: the RLS inventory was actually returned (its four `SUMMARY` rows are present) and shows no `PROBLEM` rows, all 134 expected tables RLS-on, FORCEd and policy-correct; tables owned by `trivo_owner`. Zero `SUMMARY` rows, or any unresolved `policy missing or expression not recognised — investigate` row, is not a pass.
  - A4: `NODE_ENV=production`.
  - B6: the existing company code is known.
  - B7a/B7b: current, or the pending list is recorded.
  - A7/B4: disk and database size recorded.
- **STOP** if the RLS-not-enforced warning is the latest startup line, the API role is a superuser or owner, or any expected tenant table is **missing, has RLS disabled, or has FORCE RLS disabled**. Provisioning would then create a company in a database with no tenant isolation.
- **INVESTIGATE** (not pass, and not an automatic STOP) a policy whose expression is not recognised (`policy missing or expression not recognised — investigate`), a table with more than one policy, or an unexpected table/policy: read the diagnostic output and resolve it to a recorded STOP or a recorded safe finding before the verdict. Until then B5 is **UNVERIFIED**.
- Anything not established is **UNVERIFIED** with the reason. It is never marked pass.

## Cleanup
The helper restores `PGOPTIONS`/`PGCONNECT_TIMEOUT` to their prior values, and B7b restores `DATABASE_URL`/`CHECKPOINT_DISABLE` and the working directory, all in `finally`. After Part B, close the PowerShell window and confirm nothing remains (a `True` only means the variable was already set before the run; compare with what you saw in B-setup):
```powershell
Ev 'Z-cleanup' { 'DATABASE_URL set: ' + [bool]$env:DATABASE_URL; 'PGOPTIONS set: ' + [bool]$env:PGOPTIONS; 'PGPASSWORD set: ' + [bool]$env:PGPASSWORD }
```
Expected: all `False`.

**Evidence leak scan** (before any evidence file leaves the host; prints file name and line number only, never the matching text):
```powershell
Get-ChildItem $E -Filter *.txt | Select-String -Pattern '://[^/\s:]+:(?!\*\*\*@)[^/\s]*@','(?i)\bbearer\s+(?!\*\*\*)\S','(?i)(password|passwd|secret|token|api[_-]?key)[\w-]*["'']?\s*[=:]\s*["'']?(?!\*\*\*)[^\s"'']' |
  Select-Object Filename,LineNumber
```
The patterns mirror the masks above and skip text that is already `***`. No output means no match for those patterns, **not** that the files are clean: the scan shares the masks' blind spots (space-separated secrets, bare keys, values on a following line). It is a heuristic, not proof; you still read every file.

## Limits of this checklist
- A4's "actual" `NODE_ENV` comes from the startup log line (and the JSON-versus-text format as supporting evidence). No command reads a live process's environment.
- The two-column-FK figure (≥ 58) comes from the repo's docs, not this server; a lower count is something to investigate, not an automatic fail. The 134-table inventory was derived from `schema.prisma` and checked against migrations by static reading only; it was never compared with a real database.
- B6's quoted column names follow `schema.prisma` field names; Prisma's mapped column names were not checked. If a section errors, the error is shown and the other sections still run.
- None of these commands has been dry-run on any machine. In particular, `psql` reading the password from the console while its stdin is piped is expected behaviour on Windows but is **unverified** here. The same applies to `Read-Host -AsSecureString` inside the `Ev` script block, to `psql` behaviour on the hosted server (version, TLS, `pg_hba.conf`), and to every target-host fact (paths, service names, log format). Only PowerShell 5.1 *syntax* of the code blocks was checked, by parsing without executing.
