# TRIVO — production backup restore verification: runbook

**Status: PREPARED, NOT EXECUTED.** Nothing here has been run against production. Every step below that touches
production waits for explicit approval.

## What this does

1. On the production host, takes ONE PostgreSQL snapshot of `trivo_prod` (as the read-only `trivo_backup` role) and, from that
   same snapshot, writes a per-table row-count manifest and a `pg_dump` (client + server both PostgreSQL 16).
2. Publishes the result as ONE directory `bundle-<utc>-<random>` under `/var/backups/trivo-prod-verify/` by a single atomic
   `rename(2)`. Nothing exists under a `bundle-*` name until all four files are written and verified.
3. A bundle is exactly four files, directory mode 700, files mode 600, owner root:

   | file | meaning |
   |---|---|
   | `trivo_snap.dump` | `pg_dump -Fc` of the whole database, taken with `--snapshot=<exported snapshot>` |
   | `manifest.tsv` | counts only (no row data): database, server version, snapshot id, table list with exact row counts, RLS/FK catalog counts |
   | `SNAPSHOT_OK` | the **success marker**: ties the dump to the manifest (same snapshot id, database, version, table count, both SHA-256s) |
   | `SHA256SUMS` | SHA-256 of the three files above |

4. On this machine, `restore-manifest.sh` verifies the bundle with no database at all, then restores into a NEW scratch
   database on the local PostgreSQL 18 instance and verifies row counts, RLS, composite FKs, journal balance, cross-company
   integrity and tenant isolation through the real `trivo_runtime` role. `server/scripts/restore.sh` is not touched.

## Blockers / assumptions that could not be confirmed offline (must be checked by the first read-only pre-flight)

| # | assumption | how it is checked | if false |
|---|---|---|---|
| 1 | `/opt/trivo-prod/.env` has exactly one `BACKUP_PW=` line (plain or quoted value) | pre-flight (count only, value never printed) + `host_run.sh` | refuses |
| 2 | Docker network `trivoprod_default`, DB host `postgres:5432`, image `postgres:16-alpine` present locally (all taken from `ops/live/backup-prod.sh`, which uses them nightly) | `preflight_host.sh` + `host_run.sh` (`--pull never`; the network must exist and a member must answer to `postgres`) | refuses |
| 3 | `trivo_backup` really is read-only, BYPASSRLS, not superuser, can SELECT every table and sequence in `public` (as `production-rls-roles.sql` / `db-secure.sql` define) | SQL guards inside the snapshot transaction | refuses, nothing written |
| 4 | Production server is PostgreSQL 16 | SQL guard `server_major_version_is_expected` + client-tool major check | refuses |
| 5 | The host has ≥ 2× database size + 100 MB free under `/var/backups` | `run.sh` preflight | refuses |
| 6 | Local disk holding `C:\trivo-staging\prod-restore-test\` is encrypted (BitLocker) | **cannot be checked from here** — see "Local handling" | the bundle is the full customer database in the clear; do not proceed until you accept that or enable BitLocker |
| 7 | SSH route `ssh trivo-e2e` (root@151.185.58.77, key in `~/.ssh`) works and the host key is already in `known_hosts` (it is) | first ssh command | stop |

## Production sequence (all `ssh`/`scp` use the existing approved alias `trivo-e2e`; `StrictHostKeyChecking=yes` so an unknown host key aborts)

Run from Git Bash on this machine in `P:\ERP\ops\backup-verify`. Hashes below are the reviewed ones; **compare them with the report
before pasting.**

```bash
cd /p/ERP/ops/backup-verify
H_RUN=1ee41cdc88250fb0f1fdba6db2a9313e225bfe99176fa0e952fa5def069fc436
H_SQL=71eba5c3d6e2fcdc4f4c5a3c4d5950c900c1fe8cedeffb52423170b82da0aadc
H_POST=7cebf2aacaa26a8958ee442ab59a075e16a04374b25bab21df855949809b5f32
H_HOST=2aa7eb74786dba75312b49d08779d689967f7b8827088c9c8d67086c33c0fd49
H_MC=2bc25351804b360288d629a359650651d640ce6e95b97261eb859ee981c786d9
H_PRE=8fd580e5a9f545c7266ac7f03decf6239822d922e898fbdc905c4078914f5aea
# 0. LOCAL, no production contact: the files on this machine are the reviewed ones
printf '%s  run.sh\n%s  snapshot_dump.sql\n%s  bundle_postcheck.sh\n%s  host_run.sh\n%s  manifest_check.sh\n%s  preflight_host.sh\n' $H_RUN $H_SQL $H_POST $H_HOST $H_MC $H_PRE | sha256sum -c -
SSH="ssh -o StrictHostKeyChecking=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=8 trivo-e2e"
SCP="scp -o StrictHostKeyChecking=yes"
```

**Step 1 — read-only pre-flight on the host (changes nothing).** Pick a time outside 01:45–03:30 IST (nightly backup is 02:15 IST).

```bash
$SSH 'bash -s' < preflight_host.sh
```
`preflight_host.sh` is piped over ssh (nothing is uploaded) and is **fail-fast**: it stops at the FIRST problem with `PREFLIGHT FAILED: <reason>` and a
non-zero status (ssh passes that status through, so chain the next step with `&&` or stop when you see the message). It only ends with `PREFLIGHT OK`
when all of these held: running as root; not within 01:45–03:30 IST; `trivoprod-backup.service` not active and no backup/`pg_dump` process; image
`postgres:16-alpine` present locally; network `trivoprod_default` exists and a container on it answers to `postgres`; exactly one non-empty
`BACKUP_PW=` line (count only — the value is never printed); `/var/backups/trivo-prod-verify` does not exist yet; ≥ 1 GB free under `/var/backups`.
It also prints which containers share that network (see "Network" below). If anything is not `PREFLIGHT OK`, **do not continue**.

**Network — what is and is not isolated (corrected).** The snapshot container is attached to `trivoprod_default` because that is the only way
to reach the database by name. **That is not isolation:** any container on a Docker network can reach every other container on it. This was
checked locally (a container started with the production flags on a local compose network resolved and received an HTTP reply from a non-database
container on that network; with `--network none` it could not even resolve the name — see REPORT.md, "Hardening addendum"). What limits the
exposure is the rest of the configuration: the only secret it holds is the read-only `trivo_backup` password; all capabilities are dropped; the
root filesystem is read-only; no ports are published; only `/scripts` (read-only) and the output directory are mounted; and the SQL guards refuse
any role/database other than `trivo_backup`/`trivo_prod`. The post-run `pg_restore -l` listing runs with `--network none`.

**Step 2 — create ONLY the dedicated output directory (700, root) and its `scripts` subdirectory.**

```bash
$SSH 'set -e; test ! -e /var/backups/trivo-prod-verify; install -d -m 700 -o root -g root /var/backups/trivo-prod-verify /var/backups/trivo-prod-verify/scripts; ls -ld /var/backups/trivo-prod-verify'
```

**Step 3 — upload the reviewed scripts.**

```bash
$SCP run.sh snapshot_dump.sql bundle_postcheck.sh manifest_check.sh host_run.sh trivo-e2e:/var/backups/trivo-prod-verify/scripts/
```

**Step 4 — verify their full SHA-256 ON THE HOST before anything runs** (hashes are typed from this console, not read from an uploaded file).

```bash
$SSH "cd /var/backups/trivo-prod-verify/scripts && printf '%s  run.sh\n%s  snapshot_dump.sql\n%s  bundle_postcheck.sh\n%s  host_run.sh\n%s  manifest_check.sh\n' $H_RUN $H_SQL $H_POST $H_HOST $H_MC | sha256sum -c - && chmod 600 run.sh snapshot_dump.sql manifest_check.sh && chmod 700 bundle_postcheck.sh host_run.sh && ls -l"
```
All five must say `OK`. Anything else: stop; do not run.

**Step 5 — run (the approved PostgreSQL 16 container, attached to the production compose network — see "Network" above: it can reach every member of that network, not only the database).**

```bash
$SSH "timeout 1800 bash /var/backups/trivo-prod-verify/scripts/host_run.sh $H_RUN $H_SQL $H_POST $H_MC"
```
`host_run.sh` itself: re-checks the four script hashes (each argument must be a 64-hex hash), refuses ANY test-override variable in production
(an empty network override included — it would silently drop `--network`), refuses near the nightly window or while a backup runs, refuses unless
the network exists and the DB host name resolves to a container on it, refuses if a stale `.tmp-*` directory exists, refuses a non-700
directory, reads `BACKUP_PW` without printing it (passed to the container by variable *name*, never on a command line), runs
`docker run --rm --pull never --network trivoprod_default --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp
--memory 1g -v …/scripts:/scripts:ro -v /var/backups/trivo-prod-verify:/out postgres:16-alpine sh /scripts/run.sh`, and afterwards runs
`bundle_postcheck.sh` (real directory not a symlink, modes 700/600 root, exactly four regular files, SHA-256s, STRICT marker and manifest
structure, marker↔file hashes, and the dump header + table list checked against a real `pg_restore -l` listing that `host_run.sh` produces with the
same pinned image, `--network none`, since the host has no `pg_restore`; with no listing the check fails — it is never skipped).
Expected last lines: `POSTCHECK OK …`, `VERIFIED_BUNDLE /var/backups/trivo-prod-verify/bundle-…`, the three `SHA256SUMS` lines.

**Step 6 — independent look at the finished bundle (read-only), and note its name.**

```bash
BUNDLE=$($SSH 'ls -1dt /var/backups/trivo-prod-verify/bundle-* | head -1' | xargs basename); echo "$BUNDLE"
$SSH "T=\$(mktemp) && docker run --rm --pull never --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp -v /var/backups/trivo-prod-verify/$BUNDLE:/b:ro postgres:16-alpine pg_restore -l /b/trivo_snap.dump | tr -d '\\r' > \$T && bash /var/backups/trivo-prod-verify/scripts/bundle_postcheck.sh /var/backups/trivo-prod-verify/$BUNDLE trivo_prod \$T; rm -f \$T; ls -l /var/backups/trivo-prod-verify/$BUNDLE; cat /var/backups/trivo-prod-verify/$BUNDLE/SNAPSHOT_OK; cat /var/backups/trivo-prod-verify/$BUNDLE/SHA256SUMS; sha256sum /var/backups/trivo-prod-verify/$BUNDLE/SHA256SUMS"
```

**Step 7 — transfer (SSH/SCP only; binary-safe; never through any web service).**

```bash
mkdir -p /c/trivo-staging/prod-restore-test
# restrict the local folder to this Windows user only (customer data):
powershell -NoProfile -Command 'icacls C:\trivo-staging\prod-restore-test /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"'
$SCP -r trivo-e2e:/var/backups/trivo-prod-verify/$BUNDLE /c/trivo-staging/prod-restore-test/
```
(PowerShell equivalent of the copy: `scp -o StrictHostKeyChecking=yes -r trivo-e2e:/var/backups/trivo-prod-verify/<BUNDLE> C:\trivo-staging\prod-restore-test\`)

**Step 8 — verify the transferred bundle locally, still with no database.**

```bash
cd /c/trivo-staging/prod-restore-test/$BUNDLE && sha256sum -c SHA256SUMS && sha256sum SHA256SUMS      # the last hash must equal the one printed in step 6
cd /p/ERP/ops/backup-verify && PG_BIN="/c/Program Files/PostgreSQL/18/bin" bash restore-manifest.sh --verify-only /c/trivo-staging/prod-restore-test/$BUNDLE
```

**Step 9 — restore + verify into a NEW scratch database on the local PostgreSQL 18 instance** (takes ~5 minutes for a database of this size).

```bash
cd /p/ERP/ops/backup-verify
. ./local_restore_env.sh            # builds the connection settings from files on this machine; prints nothing secret
bash restore-manifest.sh /c/trivo-staging/prod-restore-test/$BUNDLE trivo_prodverify_$(date -u +%Y%m%d)
```
Success ends with `RESTORE VERIFIED into trivo_prodverify_…` and exit code 0. Failure ends with `RESTORE VERIFICATION FAILED` / `FAILED (exit N): scratch database … was KEPT` and a non-zero exit code. **Nothing is ever dropped by these scripts.**

## Failure recovery and evidence preservation

The production side is read-only against the database, so there is never anything to roll back in PostgreSQL. State is only files:

| what you see | meaning | what to do |
|---|---|---|
| `host_run.sh` printed `REFUSING: …` | a pre-check failed before any container ran | nothing was created; fix the cause, re-run |
| container exit ≠ 0, no `bundle-*`, no `.tmp-*` | an ordinary failure; the run removed only its OWN staging directory | read the printed reason (and `run-*.log`), fix, re-run |
| a `.tmp-<id>` directory exists (run killed: SIGKILL, host reboot, OOM, connection drop) | **interrupted run.** It may hold a partial dump of customer data. New runs REFUSE to start while it exists; nothing is deleted automatically | `ls -la /var/backups/trivo-prod-verify/.tmp-*`; `docker ps` (no container still running?); then either keep it as evidence, or abandon it deliberately: `rm -rf /var/backups/trivo-prod-verify/.tmp-<id>`. There is **no resume**: a snapshot cannot be resumed; the next run is a new snapshot. |
| a `bundle-*` directory exists but `host_run.sh`/post-check reported a failure | published but **UNVERIFIED** | do not transfer it; keep it; investigate; a new run creates a new bundle beside it |
| any `bundle-*` that passed post-check | complete and final | never modified or deleted by these scripts; every re-run makes a different bundle |

* Existing bundles, `.tmp-*` directories, the `scripts/` copy, `run-*.log` and the nightly `/var/backups/trivo-prod` are never touched.
* Removing the bundle from the production host after a successful transfer is a deliberate manual decision (it is a full copy of customer data on the host):
  `rm -rf /var/backups/trivo-prod-verify/<bundle>` — only after you confirm the local copy verified.
* A killed run can leave a database session of `trivo_backup` that only ends when the server notices the dead connection (seconds); the role is limited to 3 connections and a run needs 2, so the next run waits up to 20 s for other sessions of the role to disappear and then refuses.
* Local: a failed restore keeps its scratch database (`trivo_prodverify_*`) for investigation. Drop it yourself when finished:
  `psql "$ADMIN_DATABASE_URL" -c 'DROP DATABASE "trivo_prodverify_…"'`.

## Local handling of the bundle

The bundle is the **entire production database, all companies, including password hashes**. Keep it only in the access-restricted folder from step 7,
confirm disk encryption (blocker 6: `manage-bde -status C:` in an elevated shell), do not copy it to any cloud/chat/ticket/web service, and delete the local copy when the verification is signed off.

## Test suite (all local, disposable)

`tests/t1_production_side.sh` (docker, PG16 test server), `t2_bundle_and_manifest.sh`, `t3_restore.sh` (local PG18), `t4_postcheck_linux.sh`
(real Linux perms via WSL2, root), `t5_host_run.sh`. See the report for the last results. `tests/env.sh` documents the two test clusters.

**Hardening pass additions:** `tests/t6_hardening_nodb.sh` (no database: `local_restore_env.sh` fail-closed cases, strict marker/dump-header
validation against real `pg_restore -l` output, cross-company scan parsing, policy/flag normalisation), `tests/t7_preflight.sh`
(`preflight_host.sh`, local). `t4_postcheck_linux.sh` now takes the bundle AND a `pg_restore -l` listing of it as arguments and also covers
symlinked bundle directories; `t3_restore.sh` also covers wrong-role credentials, count-neutral RLS/policy tampering and a missing runtime grant
(`ONLY_H=1` runs just the refusal section, no restore).
