# P5-0 Operator Discovery Checklist

Status: **NOT EXECUTED.** This is a checklist for the operator. Nothing in it has been run against any machine or database.
Source: `phase3-design-draft.md` (rev 6) §P.1, §P.5; `DEPLOY.md`; `server/src/config/database.ts`; `server/scripts/deploy-db.ps1`; `server/.env.production.template`.
Audience: the operator who will run P5-0 on the hosted Windows server.

## How to read this

**Action tags**
- `OS-ONLY`: queries Windows state and changes nothing.
- `READS FILE`: reads a file's contents.
- `FILE-META`: reads only a file's name, size and dates.
- `DB-READ`: connects to PostgreSQL with a session forced read-only.
- Every command below changes nothing (apart from the empty evidence folder in A0). If you are ever about to run something that doesn't, stop.

**Rules for the whole run**
- Run in an elevated PowerShell only where a step says 🛡. Everything else works unelevated.
- Never paste a password into a command line. `psql` prompts for it, and the prompt isn't logged.
- Never run `Get-Content` on `.env` or `Get-ChildItem Env:` without the redaction filters shown. Never run `pm2 env`, `pm2 jlist`, `nssm dump` or `sc qc` output into the evidence file unfiltered.
- Save evidence under a folder outside the repo (A0).
- Do not run `prisma migrate deploy`, `migrate dev`, `migrate reset`, `db:secure`, `deploy-db.ps1`, `backup.sh`, `restore.sh` or `company:provision`. `deploy-db.ps1` runs `migrate deploy` right after `migrate status`.

**Approval and credential key**
- 🟢 = no approval needed (OS-only or file metadata).
- 🟡 = needs the owner's go-ahead before running (reads a config or log file that may hold secrets, or connects to a database).
- 🔑 = needs a database credential.
- 🛡 = needs elevated Windows permissions.

---

## PART A: OS, file and configuration checks (no database connection)

### A0. Setup 🟢 `OS-ONLY` (creates one empty folder)
```powershell
$E = "$env:USERPROFILE\p5-0-evidence"
New-Item -ItemType Directory -Force $E | Out-Null
$S = "C:\ERP\ERP\server"   # adjust if the deployed checkout is elsewhere
Get-Date -Format o; hostname; [Environment]::OSVersion.VersionString
```
- **Capture:** timestamp, hostname, OS version.
- **Pass:** the host is the intended hosted server.
- **Fail:** wrong host. Stop.

### A1. PostgreSQL service and listening address 🟢 `OS-ONLY`
```powershell
Get-Service | Where-Object { $_.Name -match 'postgres|pgsql' } | Select-Object Name,Status,StartType,DisplayName
Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'postgres|pgsql' } | Select-Object Name,State,StartName,ProcessId,PathName
Get-NetTCPConnection -State Listen -LocalPort 5432 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess
```
- **Capture:** service name(s), state, the account it runs as, the data directory (`-D` in `PathName`), and the listen addresses.
- **Pass:** exactly one PostgreSQL 18 service is Running, and the listen address is documented.
- **Finding (draft P.1 #4):** `0.0.0.0` or `::` means the database is exposed on all interfaces. Record it and report it to the owner. It is not a P5-0 fail.
- **Also:** if more than one PostgreSQL service or port appears, note which one serves TRIVO. That decides the HRMS/Schemes question later.
- **Unverified if:** no service matches. The database may be on another host or run as a non-service process.

### A2. How the API runs (process manager, working directory) 🟢 `OS-ONLY`
```powershell
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath   # do NOT select CommandLine (may carry URLs/keys)
Get-Service | Where-Object { $_.Name -match 'trivo|erp|api|node|nssm|pm2|w3svc|caddy' } | Select-Object Name,Status,StartType
Get-Command pm2,nssm,docker,psql,pg_dump,pg_restore,caddy -ErrorAction SilentlyContinue | Select-Object Name,Source
Get-WebAppPoolState -ErrorAction SilentlyContinue   # only if the IIS module is present
Get-ScheduledTask | Where-Object { $_.TaskName -match 'trivo|erp|backup|pg_dump|node' } | Select-Object TaskName,State,TaskPath
```
- **Capture:** the node PID(s) (needed for A3 and B2), the process manager, which tools are on PATH, and any scheduled tasks mentioning backups.
- **Pass:** you can name how the API is started and which PID is the API. A scheduled backup task, if one exists, is recorded for P5-1.
- **Unverified if:** several node processes can't be told apart. Keep the PIDs. Don't guess.

### A3. The API's actual database connections (OS side) 🟢 `OS-ONLY` (🛡 may be needed to see another account's process)
Replace `<API_PID>` with the PID from A2.
```powershell
Get-NetTCPConnection -OwningProcess <API_PID> -State Established -ErrorAction SilentlyContinue |
  Where-Object RemotePort -eq 5432 | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort
Get-NetTCPConnection -OwningProcess <API_PID> -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort
```
- **Capture:** the local source ports of the API's connections to 5432, and the API's listening port.
- **Pass:** at least one established connection to PostgreSQL. B2 uses these ports to prove which role the API connects as.
- **Unverified if:** none are established. The API may be idle (the pool is lazy) or down.

### A4. NODE_ENV: actual and declared

**4a. Machine and user environment, one variable only** 🟢 `OS-ONLY`
```powershell
"Machine: " + [Environment]::GetEnvironmentVariable('NODE_ENV','Machine')
"User:    " + [Environment]::GetEnvironmentVariable('NODE_ENV','User')
"Session: " + $env:NODE_ENV
```

**4b. Service-level environment, variable names only, never values** 🛡 `OS-ONLY`
```powershell
$svc = '<SERVICE_NAME>'
foreach ($k in "HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Environment","HKLM:\SYSTEM\CurrentControlSet\Services\$svc\Parameters") {
  if (Test-Path $k) { (Get-ItemProperty $k).PSObject.Properties | Where-Object Name -match 'Environment' | ForEach-Object { $_.Value -split "`n" | ForEach-Object { ($_ -split '=')[0] } } }
}
```
This tells you whether `NODE_ENV`, `DATABASE_URL` or `PLATFORM_DATABASE_URL` are set at service level. A service-level or machine-level value overrides `.env`, because dotenv never overrides an existing variable.

**4c. Declared value in the file** 🟡 `READS FILE` (the file holds secrets; the filter prints one line)
```powershell
Select-String -Path "$S\.env" -Pattern '^\s*NODE_ENV\s*=' | ForEach-Object { $_.Line }
```

**4d. Actual value at the API's last start** 🟡 `READS FILE` (print only these lines)
```powershell
Select-String -Path "$S\logs\combined.log" -Pattern 'Environment:' | Select-Object -Last 3 | ForEach-Object { $_.Line }
```
The API writes `📦 Environment: <value>` at startup. The `logs\` folder is relative to the API's working directory, so confirm that from A2.

- **Capture:** Machine, User, Service and `.env` values, plus the last startup `Environment:` line with its timestamp.
- **Pass:** the startup log line says `production`, and no machine or service value contradicts it.
- **Fail:** `development`, unset, or anything else.
- **Unverified if:** the log is missing or rotated. A declared `.env` value is not proof of the running value.

### A5. Startup RLS line in the API log 🟡 `READS FILE`
```powershell
Select-String -Path "$S\logs\combined.log" -Pattern 'Database roles:|Row-level security is NOT|Refusing to start' |
  Select-Object -Last 5 | ForEach-Object { $_.Line }
```
- **Capture:** the last matching lines, with timestamps. These lines contain role names only.
- **Pass:** the most recent line is `✅ Database roles: runtime="trivo_runtime" platform="trivo_platform" — RLS enforced, tables FORCEd`.
- **Fail (draft P5-0: STOP):** the `⚠️ Row-level security is NOT being enforced` line is the most recent; the roles named are not `trivo_runtime` and `trivo_platform`; or the line is absent.
- **Unverified if:** the log can't be read or has no startup section. A log line is history, so B2/B5 must confirm it live.

### A6. Declared connection settings, redacted 🟡 `READS FILE`
```powershell
Select-String -Path "$S\.env" -Pattern '^\s*(DATABASE_URL|PLATFORM_DATABASE_URL|OWNER_DATABASE_URL|BACKUP_DATABASE_URL|PORT|HOST|REDIS_URL)\s*=' |
 ForEach-Object {
   $n,$v = $_.Line -split '=',2
   $v = $v.Trim().Trim('"')
   if ($v -match '^postgres(ql)?://([^:/@]+)(:[^@]*)?@([^:/?]+)(:(\d+))?/([^?]+)') {
     "{0}: role={1} host={2} port={3} db={4}" -f $n.Trim(),$Matches[2],$Matches[4],$(if($Matches[6]){$Matches[6]}else{'5432'}),$Matches[7]
   } else { "{0}: (non-URL value, not printed)" -f $n.Trim() }
 }
```
This prints role, host, port and database name only. Passwords and query strings are never output.
- **Capture:** the declared role per URL, the database name, and host/port.
- **Pass:** `DATABASE_URL` → `trivo_runtime`, `PLATFORM_DATABASE_URL` → `trivo_platform`, `OWNER_DATABASE_URL` → `trivo_owner` (if present), and the roles are distinct.
- **Fail:** the API URL names `postgres`, `trivo_owner`, the old dev role `sea_erp`, or any owner/superuser; or the platform URL is missing or equals the runtime one.
- **Unverified:** this is declared, not actual. B2 is the proof.

### A7. Disk space 🟢 `OS-ONLY`
```powershell
Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
```
Data directory size (path from A1; 🛡 may need elevation; read-only but slow):
```powershell
(Get-ChildItem '<DATA_DIR>' -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB
```
- **Capture:** free space on the data, backup and API drives, and the data directory size.
- **Pass (draft P5-3 rule):** free space on the intended restore drive ≥ 2× the database size plus margin. Record the numbers; B4/B5 give the database size.
- **Unverified:** if the data directory can't be read, use B4's `pg_database_size` instead.

### A8. Backup-file metadata (names, sizes and dates only) 🟢 `FILE-META`
```powershell
Get-ChildItem 'C:\db-backups' -Recurse -Force | Select-Object FullName,Length,CreationTime,LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 40
Get-ChildItem 'C:\db-backups' -Recurse -Filter *.sha256 | Select-Object FullName,Length,LastWriteTime
```
Do not open or hash any file.
- **Capture:** the newest backup with its date, whether `.dump` + `.sha256` pairs exist, sizes, and any other backup folders (top level of the A7 drives for `*.dump`, `*.backup`, `*.sql`).
- **Pass (information only):** the facts are recorded. P5-0 does not require a backup to exist.
- **Expected (draft P5-1):** the files dated 2026-09-26 and 2026-09-21 do not satisfy P5-1.
- **Unverified:** the validity and source database of every file.

### A9. Co-tenancy hints (HRMS and Schemes) 🟢 `OS-ONLY`
```powershell
Get-Service | Where-Object { $_.DisplayName -match 'hrms|scheme|hr|payroll' } | Select-Object Name,DisplayName,Status
Get-Process | Where-Object { $_.ProcessName -match 'hrms|scheme|node|java|dotnet|w3wp|php' } | Select-Object ProcessName,Id,Path
Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 80,443,3000,3001,5000,5432,8080 | Select-Object LocalAddress,LocalPort,OwningProcess
```
Process names and paths only. The authoritative answer comes from B3/B4 and from whoever administers those systems.
- **Pass:** each application on the host is listed with the database it uses, or marked unverified.
- **Unverified:** whether HRMS and Schemes use this cluster (neither is in the repository, draft P.1 #9).

---

## PART B: PostgreSQL checks (all read-only; all need database credentials)

**Approval gate 🟡:** the owner approves Part B as a whole before anything runs. For B2 the best login is the superuser (or a role with `pg_monitor`). Record whose credential is used and how it was handed over. Credentials are never pasted into chat or evidence.

**Make the session read-only (run once per PowerShell window):**
```powershell
$env:PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=15000'
$env:PGCONNECT_TIMEOUT = '5'
# Never set PGPASSWORD. psql prompts. -X skips psqlrc; ON_ERROR_STOP halts on the first error.
$DB   = 'postgres'     # change to the TRIVO database name from B2/B4 for B5/B6
$PSQL = @('-X','-v','ON_ERROR_STOP=1','-h','<HOST>','-p','<PORT>','-U','<LOGIN>','-d',$DB,'-A','-t','-P','pager=off')
```
`HOST`, `PORT` and the database name come from A1/A6. `PGOPTIONS` makes PostgreSQL reject any write in the session. It is a safety net, not a substitute for reading each query. Every query below is a `SELECT` or `SHOW`. If the cluster requires TLS, set `$env:PGSSLMODE='require'`.

### B1. Server identity and settings 🟡🔑 `DB-READ`
```powershell
psql @PSQL -c "SELECT version();"
psql @PSQL -c "SHOW data_directory;" -c "SHOW listen_addresses;" -c "SHOW port;" -c "SHOW ssl;" -c "SHOW max_connections;"
psql @PSQL -c "SELECT current_user, session_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS i_am_superuser;"
```
- **Capture:** PostgreSQL version, `data_directory` (cross-check A1), `listen_addresses`, `ssl`, and who you connected as. `data_directory` needs superuser or `pg_read_all_settings`.
- **Pass:** PostgreSQL 18 (the draft's expectation), and `data_directory` matches A1.
- **Unverified:** any setting your login can't read. Say which.

### B2. The actual API database role 🟡🔑 `DB-READ` (needs superuser or `pg_monitor`/`pg_read_all_stats`)
```powershell
psql @PSQL -c "SELECT pid, usename, datname, application_name, client_addr, client_port, state, backend_start FROM pg_stat_activity WHERE datname IS NOT NULL AND pid <> pg_backend_pid() ORDER BY datname, usename;"
```
Match each `client_port` against the local source ports captured in A3. A match shows which role and database the running API process connects as. The `query` column is deliberately left out.
- **Capture:** one row per API-owned connection (port match), plus the other connections grouped by `datname`/`usename`.
- **Pass:** the API's connections show `trivo_runtime` (and `trivo_platform` for operator paths) in the TRIVO database.
- **Fail (draft: STOP):** `postgres`, `trivo_owner`, `sea_erp`, or any other superuser or table-owner role; or both API clients use the same role.
- **Unverified:** if your login can't see other users' rows (they show as NULL), or no API connection is open. Re-run after the API serves a request (loading the login page is enough; do not log in).
- **Extra signal:** `datname` shows which database the API actually uses (evidence for B4 and the DEC-2 option (a)/(b) discussion).

### B3. Roles, attributes and per-role settings 🟡🔑 `DB-READ`
```powershell
psql @PSQL -c "SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;"
psql @PSQL -c "SELECT r.rolname, coalesce(d.datname,'(all)') AS db, s.setconfig FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase ORDER BY 1,2;"
```
Catalog reads only. `pg_authid` (password hashes) is deliberately not queried.
- **Capture:** the full role list with attributes, and the per-role settings (including `statement_timeout`, which the role script re-issues per draft P.4).
- **Pass:**
  - `trivo_owner`, `trivo_runtime`, `trivo_platform` exist.
  - `trivo_runtime`: not superuser, no BYPASSRLS.
  - `trivo_platform`: BYPASSRLS, not superuser.
  - `trivo_backup` present, or recorded as absent (draft P5-1).
- **Fail:** a missing `trivo_*` role, or `trivo_runtime` with `rolsuper` or `rolbypassrls`.
- **For the owner:** any role that isn't `trivo_*` or `postgres` is probably an HRMS/Schemes login (co-tenancy evidence).

### B4. Databases (names, owner, size, who can connect) 🟡🔑 `DB-READ`
```powershell
psql @PSQL -c "SELECT d.datname, r.rolname AS owner, pg_size_pretty(pg_database_size(d.oid)) AS size, d.datallowconn, d.datistemplate FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba ORDER BY d.datname;"
psql @PSQL -c "SELECT datname, has_database_privilege('trivo_runtime', datname, 'CONNECT') AS runtime_connect, has_database_privilege('trivo_platform', datname, 'CONNECT') AS platform_connect FROM pg_database WHERE NOT datistemplate;"
```
- **Capture:** all database names, owners and sizes, and which ones the `trivo_*` roles can connect to.
- **Pass:** you can name TRIVO's database (cross-check B2's `datname` and A6's `db=`) and its size (feeds A7 / P5-3).
- **Flag for DEC-2:** other databases on the cluster (HRMS/Schemes would appear here), and any non-TRIVO database where the `trivo_*` roles have CONNECT.
- **Unverified:** the `has_database_privilege` query fails if the roles don't exist (see B3).

### B5. FORCE RLS state, ownership, policy and FK counts (inside the TRIVO database) 🟡🔑 `DB-READ`
Set `$DB` to the TRIVO database name first, then rebuild `$PSQL` (re-run the `$PSQL = @(...)` line from the setup block).
```powershell
psql @PSQL -c "SELECT count(*) FILTER (WHERE c.relrowsecurity) AS rls_on, count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced, count(*) AS tenant_tables FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' WHERE c.relkind='r' AND c.relname IN (SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation');"
psql @PSQL -c "SELECT count(*) AS unforced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' WHERE c.relkind='r' AND c.relname IN (SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation') AND NOT c.relforcerowsecurity;"
psql @PSQL -c "SELECT tableowner, count(*) FROM pg_tables WHERE schemaname='public' GROUP BY 1;"
psql @PSQL -c "SELECT count(*) AS tenant_isolation_policies FROM pg_policies WHERE policyname='tenant_isolation';"
psql @PSQL -c "SELECT count(*) AS composite_fks FROM pg_constraint WHERE contype='f' AND cardinality(conkey)=2 AND connamespace='public'::regnamespace;"
psql @PSQL -c "SELECT pg_size_pretty(pg_database_size(current_database())) AS size;"
```
These mirror the checks `assertDatabaseRoleSafety()` runs. They read catalogs only, not table rows. Row-count restore proofs belong to P5-2.
- **Capture:** the counts above, the table owner(s), and the database size.
- **Pass:** `unforced = 0`; `rls_forced = tenant_tables`; tables owned by `trivo_owner`, not by `trivo_runtime` or `postgres`; policies ≥ 80 and composite FKs ≥ 58 (thresholds from the draft's P5-2 and CLAUDE.md §11, measured on a different stack: treat as a guide).
- **Fail:** any `unforced`, or the runtime role owning tables. Either means tenant isolation isn't enforced here.
- **Unverified:** zero `tenant_isolation` policies means an unmigrated or non-TRIVO database. Say that, not "pass".

### B6. Existing company code(s) 🟡🔑 `DB-READ`
`companies` is not a tenant table, but `trivo_runtime` may see nothing without a tenant context. Use a platform or superuser login.
```powershell
psql @PSQL -c "SELECT code, name, \"isActive\", \"starterPackageVersion\", \"createdAt\" FROM companies ORDER BY \"createdAt\";"
```
Do not query any company-scoped table (customers, invoices, tags, users).
- **Capture:** each code, active flag, starter package version and creation date.
- **Pass:** you can name the existing client's company code. Record it for the owner's DEC-2 choice (a new code must not collide, including look-alike folding 0→O, 1/L→I, 5→S, 8→B; draft P.2).
- **Unverified:** zero rows as `trivo_runtime` is not "no companies". If the query errors on column names, run `\d companies` (read-only) first.

### B7. Prisma migration status (read-only) 🟡🔑 `DB-READ` (owner credential; Node/npx on the host)
`prisma migrate status` only reads `_prisma_migrations`. Do **not** use `deploy-db.ps1`, `migrate dev` or `migrate reset`. This prompts for the password so it never appears in history:
```powershell
cd $S
$pw = Read-Host -AsSecureString "trivo_owner password"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
$env:DATABASE_URL = "postgresql://trivo_owner:" + [Uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) + "@<HOST>:<PORT>/<TRIVO_DB>?schema=public"
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
npx prisma migrate status 2>&1 | ForEach-Object { $_ -replace 'postgres(ql)?://[^@\s]+@','postgresql://***@' }
Remove-Item Env:DATABASE_URL
```
- **Capture:** the redacted output: `NNN migrations found` and either `Database schema is up to date!` or the list of unapplied/failed migrations. The repository currently has 112 migrations; the latest is `20261017100000_user_table_layouts`.
- **Pass:** "Database schema is up to date!" with 112 migrations.
- **Fail:** a failed migration, or an applied migration missing from the repo.
- **Record, don't act on:** pending migrations. Do not apply them.
- **Unverified:** `npx`/Node missing or the owner password unavailable. Read-only fallback with a superuser: `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;` and `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;`.
- **Safety:** the `-replace` filter strips credentials from any connection string Prisma prints. Review the file before it leaves the host.

---

## PART C: Items with no safe command (written answers)

| Item | Who | Evidence |
|---|---|---|
| Does HRMS or Schemes use this cluster? | Their administrator, plus B3/B4 findings | Written statement. **Unverified** until given. |
| Who holds the PostgreSQL superuser credential; does `trivo_backup` exist? | Owner | Name and role only. Never the password. |
| Is any scheduled backup running (A2 task list, A8 file dates)? | Operator | Task name and last-run date, or "none found". |
| Are HRMS and Schemes backed up before any cluster-level change? | Owner | Written confirmation (draft P.5). |

---

## Evidence record and verdict

For each check record: `ID | command run | tag | who ran it | time | redacted output (or "UNVERIFIED: reason")`. Keep it in the evidence folder. Nothing goes back into the repo (including `environment-inventory.md`) until a separate instruction says so. `DECISIONS.md` is not touched; DEC-2 is the owner's entry.

**P5-0 verdict (draft's own rule):**
- **PASS** needs all of:
  - A5, B2, B3 and B5 show the API connecting as `trivo_runtime` (platform as `trivo_platform`), neither a superuser nor an owner.
  - B5: `unforced = 0` and tables owned by `trivo_owner`.
  - A4: `NODE_ENV=production`.
  - B6: the existing company code is known.
  - B7: current, or its pending list recorded.
  - A7/B5: disk and database size recorded.
- **STOP** if the RLS-not-enforced warning is the latest startup line, the API role is a superuser or owner, or any tenant table is unforced. Provisioning would then create a company in a database with no tenant isolation.
- Anything not established is marked UNVERIFIED with the reason. It is never marked pass.

## Limits of this checklist
- A4's "actual" `NODE_ENV` comes from the startup log line. No command here reads a live process's environment, because that needs tooling that could expose secrets.
- The B5 thresholds (≥ 80 policies, ≥ 58 composite FKs) come from the repo's docs, not from this server. A lower count is something to investigate, not an automatic fail.
- B6's column quoting follows `schema.prisma` field names (`code`, `isActive`, `createdAt`, `starterPackageVersion`). Prisma's mapped column names were not checked.
- None of these commands has been dry-run on any machine. Review them before running.
