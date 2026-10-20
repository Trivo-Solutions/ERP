# TRIVO ERP — Production deployment runbook

Audience: the person deploying TRIVO for the first real client. Every step below was exercised on the staging stack
(see `ops/staging/README.md`) **except the Docker Compose wrappers** — Docker was not available in the environment
where this was verified, so `docker-compose.prod.yml`'s `db-bootstrap` / `migrate` services are written but not run.
Run the same commands by hand (they are the plain `psql` / `prisma` invocations inside them) if Compose misbehaves.

## 0. What you are deploying

```
 browser ──HTTPS──▶ TLS proxy ──▶ nginx (client container: SPA + /api + /socket.io) ──▶ API (node) ──▶ PostgreSQL
                                                                                        │──▶ Redis (optional cache)
 operator (you) ──── on the server, loopback only ────────────────▶ API :3001 /api/v1/platform/*
```

* **One database, many companies.** Every company-owned row carries a `companyId`; PostgreSQL row-level security is
  the enforcement, not just application filters.
* **Three database identities** (never reuse one for another):
  | role | used by | can |
  |---|---|---|
  | `trivo_owner` | `prisma migrate deploy` + `db-secure.sql` only | DDL. Never the API. |
  | `trivo_runtime` | the API (`DATABASE_URL`) | DML under RLS only. Owns nothing, no BYPASSRLS. |
  | `trivo_platform` | the API's operator paths (`PLATFORM_DATABASE_URL`) | DML with BYPASSRLS: provisioning, platform audit. |
  | `trivo_backup` (optional) | `scripts/backup.sh` | read-only, BYPASSRLS. |
  The API **refuses to start** in production if `DATABASE_URL` is a superuser / table owner / BYPASSRLS role.

## 1. Before you start — decisions and secrets

1. A host (2 vCPU / 4 GB is comfortable for a few dozen concurrent users per the baseline in CLAUDE.md §12) with
   Docker + Compose v2, a DNS name, and a **TLS-terminating proxy in front of the client container** (Caddy, Cloudflare,
   nginx + certbot, a cloud LB…). The client container only speaks HTTP on :80.
2. Generate secrets (keep them in your secrets manager, not in the repo):
   ```
   openssl rand -base64 48   # JWT_SECRET
   openssl rand -base64 48   # JWT_REFRESH_SECRET
   openssl rand -base64 48   # TRIVO_PLATFORM_API_KEY  (operator key, ≥32 chars)
   openssl rand -base64 24   # POSTGRES_PASSWORD, OWNER_PW, RUNTIME_PW, PLATFORM_PW, BACKUP_PW (five different ones)
   ```
3. Root `.env` (used **only** by Compose for interpolation — keep it out of git):
   ```
   POSTGRES_PASSWORD=…        # the container's superuser (user "postgres"); used only by the one-time bootstrap
   OWNER_PW=…  RUNTIME_PW=…  PLATFORM_PW=…  BACKUP_PW=…
   TRIVO_DB=trivo
   OWNER_DATABASE_URL=postgresql://trivo_owner:<OWNER_PW>@postgres:5432/trivo?schema=public
   VITE_API_URL=                # leave empty: the SPA calls its own origin (nginx proxies /api and /socket.io)
   ```
4. `cp server/.env.production.template server/.env.production` and fill it in: `CLIENT_URL` (the public https URL),
   `DATABASE_URL` (runtime role), `PLATFORM_DATABASE_URL` (platform role), the three secrets above, and
   **`TRUST_PROXY`** = the number of proxies between the internet and the API (nginx alone = 1; TLS proxy + nginx = 2).
   Without it every user of every company shares one rate-limit bucket. Size `API_RATE_LIMIT_MAX` /
   `AUTH_RATE_LIMIT_MAX` for your busiest shop — all counters in one shop share one public IP.
   If Postgres is not on the same private network add `sslmode=require` (or `verify-full&sslrootcert=…`) to all URLs.

## 2. Start the data services

```
docker compose -f docker-compose.prod.yml up -d postgres redis
```

## 3. Create the database roles and the database (once)

```
docker compose -f docker-compose.prod.yml --profile setup run --rm db-bootstrap
```
(= `psql … -f server/prisma/production-rls-roles.sql` as the superuser; creates the roles, per-role timeouts —
`statement_timeout` 30 s, `idle_in_transaction_session_timeout` 15 s, `lock_timeout` 10 s for the runtime role — and the
`trivo` database owned by `trivo_owner`.)

## 4. Migrate and secure (every deploy)

```
docker compose -f docker-compose.prod.yml --profile deploy run --rm migrate
```
(= as **trivo_owner**: `prisma migrate deploy`, then `prisma/db-secure.sql` — grants exactly what each role needs and
FORCEs row-level security on every company-owned table. A new table is inaccessible to the API until this has run.)
**Run this before starting any new server version. The `server` image does not migrate on boot.**

## 5. Start the application

```
docker compose -f docker-compose.prod.yml up -d --build server client
docker compose -f docker-compose.prod.yml logs server | grep "Database roles"
#   ✅ Database roles: runtime="trivo_runtime" platform="trivo_platform" — RLS enforced, tables FORCEd
```
If that line is missing or the server exits with a role-safety error, **stop**: `DATABASE_URL` is pointing at the wrong role.

## 6. Register the first company (operator, on the server)

The operator API is deliberately not routed through nginx (`/api/v1/platform` returns 404 publicly). Call the API's
loopback port from the server:

```
curl -sS -X POST http://127.0.0.1:3001/api/v1/platform/companies \
  -H "x-trivo-platform-key: $TRIVO_PLATFORM_API_KEY" -H 'content-type: application/json' \
  -d '{ "code":"VASAVI", "name":"Vasavi Gold & Diamonds", "stateCode":"36", "gstin":"<real GSTIN>",
        "admin": { "email":"owner@vasavi.example", "name":"Owner Name" } }'
```
* `code` is what the client types at the login screen ("Company Code"). Choose it deliberately; it cannot collide.
* Omit `admin.password` and a strong one is generated and **returned once** in the response — hand it over securely and
  ask them to change it. (Supply `password` yourself if you prefer.)
* The company receives its own **copy** of Starter Package v1: 6 roles, chart of accounts, karats, categories, stock
  types, stone types/grades, material codes, tag + estimate print templates, config defaults, a head-office branch.
  Nothing is shared with, or later pushed from, any other company. CLI equivalent: `npm run company:provision`.
* Then the client, in the app: **Settings → Company** details, branches, users (invitations), metal rates, making
  charges, HSN/GST, hardware devices (scales / printers are *company-owned rows*, not environment variables).

## 6b. Registering the SECOND client

Same command with a different `code`. Nothing else changes: no redeploy, no config, and it cannot see the first
company's data. (Verified: after VASAVI held 20,000 tags / 5,000 customers / 5,000 invoices, a company provisioned
afterwards saw zero of it — over HTTP, WebSocket, browser and at the database.)

## 7. Backups — set up before the client enters real data

```
# nightly (cron / systemd timer / your scheduler), as the backup role:
BACKUP_DATABASE_URL='postgresql://trivo_backup:<BACKUP_PW>@<host>:5432/trivo?sslmode=require' \
  bash server/scripts/backup.sh /var/backups/trivo        # writes trivo_<ts>.dump + .sha256, verifies it is readable
```
* Copy dumps **off the host** (object storage with lifecycle rules); encrypt them — a dump holds **every** company.
* Retention: 14 daily / 8 weekly / 12 monthly.
* **Prove restores work — monthly, and once now.** `server/scripts/restore.sh` restores into a *new scratch database*,
  re-applies `db-secure.sql`, and verifies row counts vs the source, RLS/policies/composite-FKs, ledger balance, no
  cross-company reference, and that the runtime role sees exactly one company per context. It must exit 0.
  (The restore is deliberately **serial** and stops on the first error: with FORCEd RLS a parallel restore can enable RLS
  before foreign keys are validated and fail.)
* This is a nightly logical backup: RPO up to 24 h. If that is not acceptable, add WAL archiving / PITR
  (pgBackRest, WAL-G, or your managed provider) *in addition*.

## 8. Go-live checklist (all must be true)

- [ ] Server log shows `RLS enforced, tables FORCEd`; `psql` as `trivo_runtime` cannot `ALTER`/`CREATE`/`DROP`.
- [ ] HTTPS end-to-end; `TRUST_PROXY` set to the real hop count; `curl https://<host>/api/v1/platform/companies` → 404.
- [ ] Postgres not reachable from the internet (compose binds 127.0.0.1); if remote, TLS required in `pg_hba.conf`.
- [ ] First company registered, admin password changed, and a **second, throw-away company** registered to confirm it sees
      nothing of the first (then suspend it: `PATCH /platform/companies/:id/status {"isActive":false}`).
- [ ] Backup taken **and restored into a scratch DB with `restore.sh` exiting 0**; backups are copied off-host.
- [ ] Rate limits sized for the client's shop; JWT/refresh/operator secrets are unique and stored in a secrets manager.
- [ ] Printer agent installed on each counter PC that prints labels (`printer-agent/README.md`) and a label printed.
- [ ] Someone owns monitoring: API `/health`, disk, Postgres `log_min_duration_statement` output, failed-login volume.

## 9. Upgrading

1. Take a backup. 2. `git pull` / new image. 3. `--profile deploy run --rm migrate` (owner). 4. `up -d --build server client`.
5. Smoke: log in to two companies and open Sales / Tagging / Finance. A migration that adds a company-owned table must
   include its RLS policy (see the latest migrations); `db-secure.sql` then FORCEs it and grants the runtime role.

### 9a. Release notes — offers, live pricing, per-report permissions (migrations 20261012100000 → 20261014120000)

Six migrations, applied in name order by `prisma migrate deploy` (all additive; none drops or rewrites business data):
`20261012100000_offers`, `20261012120000_estimate_offer_snapshot`, `20261013100000_discount_approvals`,
`20261013120000_estimate_approval`, `20261014100000_split_report_permissions` (data-only: adds the per-report
strings to every role that held `report:view` / `report:financial_view`; FORCE RLS lifted around the UPDATE and restored),
`20261014120000_supplier_payment_reversal`. The two new tables (`offers`/`offer_rules`, `discount_approvals`) are only
reachable by the API after `db-secure.sql` has run — always run it right after `migrate deploy` (the `migrate` service in step 3 runs both).

**Check what is pending without applying anything** (read-only; never use `prisma migrate dev` or `migrate reset`):
`DATABASE_URL=<owner url> npx prisma migrate status` from `server/` (Prisma never overrides an already-set `DATABASE_URL`
with `server/.env`). Under Compose: `docker compose -f docker-compose.prod.yml --profile deploy run --rm --no-deps migrate npx prisma migrate status`.

**Permissions** (Starter Package v1 only reaches companies provisioned from now on; existing roles are never rewritten):
- *New company:* nothing to do. Its roles already carry `rate:update`, `discount:approve` (store manager) and the per-report strings.
  `offer:*` and `payment:reverse` are SUPER_ADMIN-only until that company grants them in the Role Editor.
- *Existing company:* (1) the report split is handled by the migration; (2) run the `rate:update` backfill from a repo checkout
  with `PLATFORM_DATABASE_URL` set: `cd server && npx ts-node scripts/backfillRateUpdatePermission.ts` (dry run), then add `--apply`;
  (3) grant `discount:approve` to the store-manager role and `offer:view/create/edit/delete` to whoever manages offers, in the
  Role Editor (no script). Every affected user must log in again to pick up a changed role.

### 9b. Production release record — commit 643c22fd844f4252c706695e779829e5cdd99e30 (2026-10-13)

**Status: deployed and healthy** on the live stack (`/opt/trivo-prod`, project `trivoprod`, host `trivo-e2e`).

- **When** (from container/migration records): migration finished 2026-10-12 20:05:51 UTC; server and client containers recreated
  20:06:31–20:06:32 UTC (= 2026-10-13 01:36 IST).
- **Previous source:** `f0289f4` (verified identical to the host tree before the release). **Released:** `643c22f` — Delete Bill
  (`invoice:delete`), saved table layouts (`UserTableLayout`), Entry By column on tag list / stock book / dead stock, test-only changes.
  30 files (12 added, 18 modified), copied from a `git archive` of the commit; `.env` and `server/.env.production` untouched.
  The host has no git checkout — after the copy the deployed `server/src`, `server/prisma` and `client/src` matched the commit (717 files).
- **Images now live:** server `sha256:712ab40d4d5477a8ed1289038d16095ab5fdc386e6280720842b6903499e7f62`,
  client `sha256:8fcc68362d4983cfd5f86668527c0fec0a7d84685a64b33e1b74ebce45109232`,
  migrate `sha256:042e38e0eb9fc2bcabf864c2f0a7f5ad1bd861d6267a0ee34b42291d50b86925`.
- **Migration:** `20261017100000_user_table_layouts` applied (one new table, RLS + FORCE RLS; no existing rows touched);
  `prisma migrate status` → 112 migrations, "Database schema is up to date". `db-secure.sql` re-run by the `migrate` service.
- **Verified:** `ops/live/run-verify.sh` (throwaway database, new images) **73/73** passed; public HTTPS checks passed
  (SPA 200, `/health` ok, bad login 401, `/api/v1/platform` 404, new routes 401 unauthenticated); all `trivoprod_*` containers
  healthy; no server errors in the log.
- **Outstanding — authenticated production checks (need an OSSP login; not yet run):**
  (1) Delete Bill is refused (403) for a user without `invoice:delete`; (2) a saved table layout persists after a page reload.
  `invoice:delete` is granted to no starter role — delegate it in the Role Editor (users log in again).
- **Rollback material (kept; do not clean up):**
  images `trivoprod-server:pre-643c22f` (`sha256:93029d62a0ccf6a61e01b05a6abb780757a19db21241e1ba089a15f3b3838c2b`),
  `trivoprod-client:pre-643c22f` (`sha256:0c6f9d1a17958c43bf89e43a346946c621676020de05e52c6621a11a33132d80`),
  `trivoprod-migrate:pre-643c22f` (`sha256:5393079471eb9b4d920681a23b6d4164ce0774a311d2c26108519907369f2cbd`);
  source archive `/root/release-rollback/src-pre-643c22f.tgz` (the 18 replaced files, = `f0289f4` versions;
  sha256 `9e23486e2bd957742a782b41284e8aad47659dc3f6f9372395b90b64aafd317f`).
  To roll back: restore the archive over `/opt/trivo-prod`, retag the `pre-643c22f` images to `latest`, `up -d` without `--build`.
  The new table can stay (old code ignores it). `ops/live/rollback.sh` only switches nginx to staging — it is not an application rollback.
- **Pre-deployment backup:** `/var/backups/trivo-prod/trivo_20261012T195844Z.dump` (taken 2026-10-13 01:28 IST),
  sha256 `631f9e7ae04646dacfa3ad74b0c9691504da05cd633db81b835fbd3792c0c182` (`.dump.sha256` verified OK) and an AES-256
  copy `trivo_20261012T195844Z.dump.enc` alongside.

### 9c. Live production release procedure (host `trivo-e2e`) — verified syntax

This is the procedure the 9b release followed, written down so it is not re-derived. `ops/live/GO_LIVE.md` covers first go-live and
nginx cutover; this section is the **routine release**. Every command below was checked against `docker-compose.live.yml` and `ops/live/*`.

**Identity (verify, never assume)**

| | value |
|---|---|
| SSH alias / host | `trivo-e2e` → `151.185.58.77` (`ssh -G trivo-e2e` shows the resolved hostname; hostname on the box is `e2e-147-77`) |
| Directory | `/opt/trivo-prod` (no git checkout — releases are file copies) |
| Compose project | **`trivoprod`** (`name:` in the live file) |
| Compose file | **`docker-compose.live.yml`** — the only file that defines the live stack |
| Services | `trivoprod_server`, `trivoprod_client`, `trivoprod_postgres`, `trivoprod_redis` |
| Live DB volume | `trivoprod_pg_data` (mounted by `trivoprod_postgres`), database `trivo_prod` |
| Never touch | staging project `trivo` (`/opt/trivo`, `trivo_*` containers); host `e2e-server` / `151.185.58.59` |

> **WARNING — `docker-compose.prod.yml` is a different stack** (generic template: container names `trivo_postgres`/`trivo_server`/…, volume
> `postgres_data`). Never substitute it for the live file. Running it with `-p trivoprod` still resolves `postgres` to the live database
> container on `trivoprod_default` (so a read-only command can *appear* to work) but it silently **creates new, empty, unrelated volumes**
> (`trivoprod_postgres_data`); without `-p` it creates a `trivo-prod_*` network/volumes. Always type both flags:
> `DC="docker compose -p trivoprod -f docker-compose.live.yml"`.

**1. Preflight — read-only, before any change.** Stop if anything disagrees.
- Local: on the reviewed branch, `git status` understood, release commit **exists on the remote** (`git ls-remote <remote> <branch>` equals `git rev-parse HEAD`).
- Host/stack: `ssh -G trivo-e2e | grep -i '^hostname'`; `docker ps --format '{{.Names}} {{.Image}} {{.Status}}'` (all four `trivoprod_*` up; server `healthy`).
- Mounts: `docker inspect trivoprod_postgres --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}'` must show `trivoprod_pg_data`;
  `docker inspect trivoprod_postgres --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'` must end in `docker-compose.live.yml`.
  Do not conclude a volume is unused or stray from its *name* — `docker volume ls` has several similarly named volumes; ask Docker who mounts it
  (`docker ps -a --filter volume=<name>`).
- Current release: hash the files the release will replace on the host and on the commit the host is believed to run (`git show <prev>:<path> | tr -d '\r' | sha256sum` vs `tr -d '\r' < path | sha256sum` on the host). They must be identical; a mismatch means the host has changes you have not reviewed.
- Database target and migration state (read-only, as the superuser inside the postgres container; never print the password):
  `set -a; . ./.env; set +a; docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" trivoprod_postgres psql -U postgres -d trivo_prod -Atc 'select count(*), max(migration_name) from _prisma_migrations'`
  and compare with the release's `server/prisma/migrations/` directory. The `trivoprod-migrate` image is built from the host tree, so `migrate status` only
  sees a new migration **after** the release files are copied and the image is rebuilt (step 3) — run it again there, before applying.
- Health: `/health` through the loopback web port (8180) or `docker inspect` health of the server.
- Local release gates green (strict tenant audit, full suite, `npm run test:rls`, both builds) — see CLAUDE.md §11–12.

**2. Backup — before every migration, no exceptions.**
- Take it with the same steps as `ops/live/backup-prod.sh` (read-only `trivo_backup` dump via `server/scripts/backup.sh`, then the AES-256 `.enc` copy).
  **Do not run the script's final `find … -mtime +14 -delete` as part of a release** — the release procedure never deletes or rotates backups; the nightly timer owns retention.
- Verify: non-zero size, `sha256sum -c <dump>.sha256` → `OK`, and `pg_restore -l <dump>` (readable; ~140 tables of data, ~134 policies). Record path, UTC timestamp, size, SHA-256.
- Verify it **restores**: `ops/live/restore-test.sh <dump>` restores into a **new scratch database** (never over `trivo_prod`), re-applies `db-secure.sql`, compares row counts
  with the live database and checks RLS, policies, composite FKs, journal balance and tenant isolation, then drops the scratch database. Exit 0 is required.
  It needs the host's `.env`; from a workstation it can be streamed without copying: `ssh trivo-e2e 'bash -s -- <dump>' < <(tr -d '\r' < ops/live/restore-test.sh)`.
  **The source comparison must use `trivo_backup` / `$BACKUP_PW`** (the read-only role `server/scripts/restore.sh` documents). `trivo_platform` cannot be used:
  `db-secure.sql` REVOKEs it from `_prisma_migrations`, so the comparison dies with `permission denied for table _prisma_migrations`. Fix the wrapper, never the grants.
- Never print passwords or copy production secrets into local files.

**3. Release the files.** The host builds its images from its own tree, so the reviewed files must be on the host first (the running containers are unaffected until step 5).
- Build the file set from the **remotely verified** commit: `git archive <commit>` (or `git diff --name-status <previous-commit> <commit>`), and copy **only** the files that
  commit changed. Never copy `.env`, `server/.env.production`, or files that differ on the host on purpose (e.g. `client/nginx.conf`, `docker-compose.live.yml`) unless
  the release itself reviewed them. Keep a rollback copy first: `tar czf /root/release-rollback/src-pre-<commit>.tgz <the replaced files>`.
- Verify: after the copy, hash the copied files against the commit — all must be **byte-identical**; `.env` and `server/.env.production` untouched.
- **Pitfall — `git archive` on a Windows workstation applies `core.autocrlf` and writes CRLF.** Extracted that way, every file differs from the commit (and a `.sh` fails with
  `set: pipefail: invalid option`). Always archive with line-ending conversion off:
  `git -c core.autocrlf=false -c core.eol=lf archive <commit> <paths> | ssh trivo-e2e 'tar -x -C /opt/trivo-prod -f -'`, then compare
  `git show <commit>:<path> | sha256sum` against `sha256sum <path>` on the host for every copied file (raw, no CR stripping). If a first extraction was CRLF, re-extract before migrating.
  (Some older host files still carry CRLF from earlier releases; they are semantically identical — compare those with CRs stripped.)

**4. Migrate** — the compose `migrate` service (profile `deploy`) builds from the host tree and runs, in order, `prisma migrate deploy` (applies pending migrations
as `trivo_owner`) and then `prisma db execute --file prisma/db-secure.sql` (re-applies grants, FORCE RLS and the append-only audit table, which a new table needs before the runtime role can use it):
```
cd /opt/trivo-prod; DC="docker compose -p trivoprod -f docker-compose.live.yml"
$DC --profile deploy build migrate
$DC --profile deploy run --rm --no-deps migrate npx prisma migrate status     # read-only: exactly the expected migration(s) pending
$DC --profile deploy run --rm migrate                                         # applies them, then db-secure.sql
$DC --profile deploy run --rm --no-deps migrate npx prisma migrate status     # "Database schema is up to date"
```
Never `migrate reset`, `migrate dev`, `db push`, a seed, or ad-hoc SQL writes against production. A migration that touches existing tenant rows must lift FORCE RLS around its statement (CLAUDE.md §7, Phase I).

**5. Deploy.** Keep rollback images, then rebuild only the application services:
```
docker tag trivoprod-server:latest trivoprod-server:pre-<commit> ; docker tag trivoprod-client:latest trivoprod-client:pre-<commit>
$DC up -d --build server client
```
Do not pass `postgres`/`redis`; do not recreate them.

**6. Verify.** `docker ps` (server `healthy`); image IDs (`docker images | grep trivoprod`) differ from the `pre-*` tags; `docker logs --since 10m trivoprod_server` has no errors and no passwords/tokens;
`prisma migrate status` is up to date; `ops/live/run-verify.sh` (throwaway database, the new images) passes; loopback `/health`; the public SPA and `/api/v1/platform` (must be 404); then the release's feature acceptance
using a test account — never create real customer bills or move stock to prove a deploy.

**Stop conditions.** Any identity mismatch; release commit not on the remote; host files differ from the believed previous release; backup or restore verification not clean; unexpected pending migrations;
migration or build failure; unhealthy container. On a stop: change nothing further, keep the logs, report.

**Rollback boundary.** Application rollback = restore the saved source files, retag the `pre-<commit>` images to `latest`, `up -d` **without** `--build`. Additive migrations (new columns/tables) stay — old code ignores them.
Do **not** restore a backup over production as a routine application rollback, and never improvise a destructive database rollback; data restoration is an incident decision for the owner, using the
verified backup into a scratch database first. `ops/live/rollback.sh` only switches nginx to staging — it is not an application rollback.

### 9d. Production release record — Sales Employee management, commit 7d723a1 (2026-10-20)

**Status: deployed; see the open items.** Live stack `/opt/trivo-prod`, project `trivoprod`, file `docker-compose.live.yml`, host `trivo-e2e` (`e2e-147-77`).

- **Released:** `a009ca3` (Sales Employee management: direct employee creation with a one-time temporary password, 72 h expiry, forced first-login change, branch-scoped
  management, existing-member mark/unmark, searchable active-employee billing selector) and `7d723a1` (this runbook + the `restore-test.sh` fix), over `c3d4b10`.
  20 files copied from `git archive` of `7d723a1` (13 modified, 7 added), byte-identical to the commit. Branch `feature/sales-employee-management` on the `personal` remote.
  `client/nginx.conf` and `docker-compose.live.yml` (access-log redaction, bounded client logs) were **not** part of the release and were left untouched.
- **Live logging configuration (recorded after the release; preserved in git by commit `b68ec71`):** the production host's `client/nginx.conf` uses the `trivo_redacted`
  access-log format (customer-search query strings on `/api/v1/estimation/customers` and `/api/v1/sales/estimates`, and `token=` parameters, are logged as `?[redacted]`), and the production
  Compose file applies `json-file` rotation (`max-size: 10m`, `max-file: 5`) to the `client` service. Both were live on the host but **uncommitted in the repository** until that commit, so a
  deployment built from a clean checkout of an earlier commit would have lost them. The reviewed Compose file sets **no** such limits on the `server`, `postgres` or `redis` services, and this
  record does not claim that all production logging is bounded or that all sensitive logging is redacted: nginx's error log is unchanged, and the API's own access-log redaction covers only
  `/estimation/customers`.
- **Backup (taken immediately before):** `/var/backups/trivo-prod/trivo_20261020T020840Z.dump` (07:38 IST), 4,297,803 bytes, sha256
  `3a7f743b3014d9b7d0435026d720ccbd501f95fdda2fb9d316e620def043b824` (`.sha256` verified OK, `pg_restore -l` readable), plus `.dump.enc`. No backup was deleted.
- **Restore test:** corrected `ops/live/restore-test.sh` (source role `trivo_backup`) → exit 0: row counts identical in all 140 tables, RLS enabled + forced, 134 tenant_isolation
  policies, 166 composite FKs, journals balance, no cross-company references, runtime role fail-closed and sees only its own company. Scratch database dropped.
- **Migration:** `20261019100000_sales_employee_management` (additive: `users.mustChangePassword`, `company_users.designation`, `company_users.isSalesEmployee`; no row touched) applied by the
  `migrate` service (`migrate deploy`, then `db-secure.sql`); `migrate status` → 114 migrations, "Database schema is up to date".
- **Images now live:** server `sha256:0eb41094035897a2ec65a19ef1c06b2696d853fd09e3b52acaa5a620f3740e0b`, client `sha256:6c6a0789fe2b3134557227af607d32001a246a37060ed198bc8bf4bdb5f8e0a0`,
  migrate `566c97a86eb1` (abbreviated image ID only; the full digest was not recorded in the local release evidence). Containers started 2026-10-20 02:22:30 UTC; 0 restarts; server healthy; `/health` 200 on 3101 and 8180; `/api/v1/platform` 404.
- **Source verification (two separate checks):** (1) the 20 release files copied from `git archive` of `7d723a1` were hash-verified byte-identical to the commit after the line-ending
  correction described in §9c; (2) a separate comparison of the host's `server/src`, `server/prisma` and `client/src` against the commit was made with CRs normalised (not byte-level), and it
  reported differences only in test files — 4 test files that are not shipped to the host, plus one further test file. The individual files in those exceptions are not itemised in this record.
  Check (2) is not a byte-identical guarantee for the whole host tree.
- **Production smoke checks (limited, unauthenticated):** running images contain the compiled `salesEmployees` module, the schema columns and the client bundle with the route;
  unauthenticated `/sales-employees*` and `/sales/staff` → 401; no server errors in the log.
- **Automated acceptance (throwaway database, not production):** `accept.mjs` against a throwaway database with the new images, 48/48: manager vs cashier vs unauthenticated access, creation, one-time temporary password
  never re-readable, duplicate email/code and concurrent-create race, forced password change (403 `PASSWORD_CHANGE_REQUIRED` everywhere except `/auth/me`), search/filter, edit,
  deactivate/reactivate, reissue, mark/unmark, billing selector, role-escalation and cross-company refusals. The 72-hour expiry is covered by the automated test
  `http.salesEmployees.test.ts` ("an unused temporary password expires after 72 hours"), not run live.
- **Open item — `ops/live/run-verify.sh` 72/73:** the check "search finds silver tags by name and by number" fails. It fails identically on the previous images (`pre-7d723a1`), so the failure
  reproduces on the previous images and is not shown to be introduced by this release. **The cause is not yet determined** (it could be the test, the harness or the search endpoint) and has not been
  investigated further here; it remains open for a separate follow-up.
- **Not verified on production:** authenticated browser/API flows with a real production login (no authorized test account); real billing, returns/credit notes, Epson printing and fixed-price costing
  were covered by the automated suites and the throwaway-database estimate→bill checks only.
- **Rollback material (kept):** images `trivoprod-{server,client,migrate}:pre-7d723a1` (server `sha256:a1ca1c73a99fddc1ccb5914dd03f781b66e9db91f0a4a846d24bbeecbd5e9988`,
  client `sha256:73a3e3d1224ef1b53521020412932a8ce14902b2a2e141bc0d2d1749c571bb9e`), source archive `/root/release-rollback/src-pre-7d723a1.tgz` (the 13 replaced files, sha256
  `c7c5cbc35ef4da39c2c37d804d9601e1f46a39e06ff1c318e87bcd4708ed8d1e`). Roll back per §9c. The new columns can stay (old code ignores them).
- **Left alone on purpose:** the empty `trivoprod_postgres_data` volume created by an earlier mistaken `docker-compose.prod.yml` run (never mounted; remove only on explicit decision).

## 10. Suspending / offboarding a company

`PATCH /api/v1/platform/companies/:id/status {"isActive": false}` (on loopback). Logins fail, existing tokens stop working
on their next request, refresh tokens are refused, and live sockets are disconnected immediately. Data is retained.
There is intentionally **no delete** endpoint (never delete business history) — export/erase is a manual, deliberate
operator procedure.
