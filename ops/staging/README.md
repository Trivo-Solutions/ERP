# Staging harness (Phase 6 verification)

Reproduces the production-readiness pass described in CLAUDE.md §12. These are **operator/QA scripts**, not part of the app
or the test suite. They need a running stack; nothing here touches your dev database.

## Layout of a staging directory (`TRIVO_STAGING_DIR`, default `ops/staging/.staging/`)
```
staging.env      DATABASE_URL (trivo_runtime) / PLATFORM_DATABASE_URL / OWNER_DATABASE_URL / JWT_* / TRIVO_PLATFORM_API_KEY /
                 TRUST_PROXY=1 / API_RATE_LIMIT_MAX + AUTH_RATE_LIMIT_MAX raised (a load test would trip the real limits)
harness/         written by the scripts: VASAVI.json, SHREE.json (company login details), results, screenshots
```
`make-env.js` builds `staging.env` from a `roles.json` ({runtime, platform, owner} passwords) — adapt to your setup.

## Bring-up (once)
1. PostgreSQL with the three roles: `prisma/production-rls-roles.sql` (superuser), then as owner
   `prisma migrate deploy` + `npm run db:secure`. (Staging also used TLS-only `pg_hba` entries for the app roles.)
2. `cd server && npm run build` and start `node dist/index.js` with `staging.env` loaded (NODE_ENV=production).
3. `cd client && npm run build`, then `node ops/staging/frontdoor.js` (stand-in for `client/nginx.conf`: SPA + `/api` +
   `/socket.io` proxy on :8080).

## Run
```
node provision-http.js VASAVI "Vasavi Gold & Diamonds" owner@vasavi.example "Owner"   # via the real operator API
node load.js VASAVI 19700 4950 4900        # bulk data: tags clients invoices (adds to what exists)
node provision-http.js SHREE  "Shree Silver Palace" admin@shree.example "Admin"       # AFTER VASAVI is heavy
node load.js SHREE 20000 5000 5000
node isolation-http.js      # ~200 checks: HTTP + IDOR + forged FKs + WebSocket + suspension + DB-level RLS
node browser-acceptance.js  # ~140 checks in real Chromium (needs `npx playwright install chromium`)
node perf.js                # latency + concurrency + write-path baseline
```
Backup/restore drill: `server/scripts/backup.sh` then `server/scripts/restore.sh` (see DEPLOY.md §7).
`isolation-http.js` registers a **fresh** second company on every run so "a new company starts empty" stays testable.
