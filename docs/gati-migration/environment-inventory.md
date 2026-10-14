# Environment Inventory (Phase 1 discovery, 2026-10-14)

Status legend: **Confirmed** (observed directly), **Hypothesis**, **Unresolved**. All checks were read-only.

## Host
- Confirmed: Windows Server 2022 Standard; hostname `vasavi-server` (OS user `vasavi-server\administrator`). SQL Server reports `@@SERVERNAME` = `WIN-MU7KCSDRKTP\SQL22` in some sessions and `Vasavi-server\SQL22` in others (stale server name after rename; cosmetic).
- Confirmed: TRIVO repo and GATI both live on this server. TRIVO repo: `C:\ERP\ERP`, branch `main`, HEAD `99e752b`. Working tree has pre-existing unrelated changes (`docker-compose.prod.yml`, `package-lock.json`, untracked `Caddyfile`, `GATI_MIGRATION.md`). Not touched.

## GATI (SJE Plus by Gatisofttech)
- Confirmed: Application is a .NET/DevExpress desktop client at `C:\Program Files\Gatisofttech\SJE Plus` (DevExpress v26.1 DLLs). Data/support files under `D:\GATISOFTTECH` (`SJEP DATA`, `SJEP BACKUP`, `SJEP IMAGE`, `SJEP REPORT`, `AUDIT REPORTS`, `DATA_Old`, `VENDORS`, etc.).
- Confirmed: **Database engine is Microsoft SQL Server 2022 (16.0.1000.6, Developer Edition), named instance `SQL22`** (`.\SQL22`, TCP 50130, service `MSSQL$SQL22`, running). Not MySQL.
- Confirmed: Access method used: `sqlcmd -S .\SQL22 -E` (Windows integrated auth as the logged-in administrator), plus read-only ADO.NET with `ApplicationIntent=ReadOnly`. Only `SELECT` against catalog views and aggregate counts. No credentials were read from GATI config files or stored.
- Other SQL Server instances present (not GATI): default `MSSQLSERVER` (no user DBs), `SQLEXPRESS` (`SmartOfficedb`, compat 100 - purpose Unresolved), Windows Internal Database.

### GATI databases on `.\SQL22`
| Database | Role (inferred) | Tables | Views | Procs | FKs | Recovery | Evidence |
|---|---|---|---|---|---|---|---|
| `VASDSJEP` | Main business data, company code `VASD` (Vasavi Gold and Diamonds Pvt Ltd), live | 1154 | 143 | 1792 | 1812 | SIMPLE | MDF ~2.9 GB, written 2026-10-14; Inward rows dated through 2026-10-14 |
| `VASSSJEP` | Second company `VASS` ("Z_VASAVI GOLD AND DIAMONDS PRIVATE LIMITED"), appears retired | 1154 | 143 | 1790 | 1812 | SIMPLE | Last Inward 2025-12-05; 3,440 tags |
| `SJEPlus` | Master login/company registry | 17 | 0 | 2 | 0 | FULL | `Company` (3 rows), `SPM_Users` (2 rows) |
| `VASDLog` | Audit/logging (`JewelInward_Log` 312k, `Delete_Log` 147k) | 10 | 0 | 7 | 0 | FULL | - |
| `VASSLog` | Log for VASS | - | - | - | - | SIMPLE | not inspected |

Hypothesis: `VASDSJEP` and `VASSSJEP` are separate per-company databases with identical schema, one per financial-year company set. `SJEPlus.Company` has 3 rows: `VASD0001` (FY 2025-10-15..2026-03-31), `VASD0002` (FY 2026-04-01..2027-03-31, current), `VASS0001`. Unresolved: whether FY rollover keeps the same database (the `VASD` tables carry data from 2025-11 to 2026-10, spanning both years, so evidence suggests one DB with FY-wise company codes).

### Backups available (not opened)
- `D:\GATISOFTTECH\SJEP BACKUP\` many timestamped GATI backups (from 2025-11), last written 2026-10-14. Format Unresolved.
- `C:\db-backups\` holds `vasavi_jewelry_db` (nightly, 2026-10-14 01:00) and a TRIVO pg dump from 2026-09-26.

## TRIVO
- Confirmed: PostgreSQL 18 service `postgresql-x64-18`, listening 5432 on all interfaces (0.0.0.0 and ::). Prisma `provider = "postgresql"`.
- Unresolved: which Postgres database(s) hold TRIVO's live and test data, and whether Vasavi is already a provisioned company there. Not queried (no credentials read from `.env`).

## Not done / blockers
- GATI has no read-only login confirmed; discovery ran under the Windows administrator account. A dedicated read-only SQL login (or restored backup copy) should be used for any later extraction.
- A staging environment has not been designated.
