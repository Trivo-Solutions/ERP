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

## 10. Suspending / offboarding a company

`PATCH /api/v1/platform/companies/:id/status {"isActive": false}` (on loopback). Logins fail, existing tokens stop working
on their next request, refresh tokens are refused, and live sockets are disconnected immediately. Data is retained.
There is intentionally **no delete** endpoint (never delete business history) — export/erase is a manual, deliberate
operator procedure.
