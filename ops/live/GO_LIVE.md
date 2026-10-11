# TRIVO live deployment — runbook (OSSP, first production tenant)

Host `trivo-e2e` (151.185.58.77). Two fully separate stacks:

| | staging (project `trivo`, `/opt/trivo`) | **production** (project `trivoprod`, `/opt/trivo-prod`) |
|---|---|---|
| database | `trivo` (STAGE1, ISOTEST — test data) | `trivo_prod` (OSSP only) |
| containers | `trivo_*` | `trivoprod_*` (own Postgres + Redis + volumes) |
| loopback ports | web 8080, api 3001 | web 8180, api 3101 |
| DB roles / secrets | its own | its own, freshly generated (never shared) |

Nothing in staging is modified by anything below.

## First login for the OSSP administrator (no reusable password is ever sent)
1. Provisioning generated a one-time temporary password, stored only in `/root/ossp-first-login.txt` (root, mode 600) on the server.
2. The operator reads it over SSH and passes it to the administrator through a private one-to-one channel (in person / phone), never email, chat groups or tickets.
3. The administrator signs in at the production URL with **Company Code `OSSP`**, their e-mail, and the temporary password, then immediately opens **Change Password** (key icon in the sidebar). The new password must be 12+ characters; every other session is signed out.
4. The operator then shreds the file: `shred -u /root/ossp-first-login.txt`.

## Cutover (only after every release check passes)
```
ssh trivo-e2e /opt/trivo-prod/ops/live/cutover.sh     # saves nginx site -> /root/nginx-rollback/, switches, verifies, auto-rolls-back on any failure
ssh trivo-e2e /opt/trivo-prod/ops/live/rollback.sh    # manual rollback at any time (restores the saved site, staging back on the hostname)
```
`cutover.sh` checks: prod containers healthy; `nginx -t`; HTTPS SPA 200; `/health` ok; a login probe that is proven (by the prod server's own log) to have reached the PRODUCTION API; `/api/v1/platform` still 404.
After cutover staging is reachable only by name once DNS exists (below) or by SSH tunnel: `ssh -L 8080:127.0.0.1:8080 trivo-e2e` then http://localhost:8080.

### DNS action (optional but recommended): staging by name
Add to the `trivosolutions.in` zone (Google Cloud DNS): `A  staging  151.185.58.77  TTL 300`. Then on the server:
`CERTBOT_EMAIL=<ops mailbox> /opt/trivo-prod/ops/live/enable-staging-host.sh`.
The production hostname `erp.trivosolutions.in` already resolves to this server — no DNS change is needed for the cutover.

## Backups
* `trivoprod-backup.timer` — daily 02:15 IST → `/var/backups/trivo-prod` (dir 700, files 600): dump (pg_dump as read-only `trivo_backup`), `.sha256`, and an AES-256 encrypted copy `.dump.enc`. 14 days local retention.
* Restore test (any time, never touches `trivo_prod`): `/opt/trivo-prod/ops/live/restore-test.sh` — restores into a scratch DB, checks row counts, RLS forced, policies, composite FKs, journal balance, tenant isolation as the runtime role, then drops the scratch DB.
* **Encryption key** `/root/.trivo-backup.key` (fingerprint = first 16 hex of its sha256; `4c396b56a11044c6` at creation). Without it the encrypted copies are unreadable, so the key must exist **off this server**: the operator copies it once with `scp trivo-e2e:/root/.trivo-backup.key <safe place>` into a password manager / offline vault, and verifies with `sha256sum`. Never email it. Local plain dumps stay on the host regardless.
* A backup is only "operational" after the **first unattended 02:15 run** is inspected: `journalctl -u trivoprod-backup.service -n 20` and `ls -l /var/backups/trivo-prod`.

### Off-site plan (proposal — nothing is uploaded until approved)
* Data: only the **already-encrypted** `.dump.enc` (AES-256, key never leaves the operator's vault). Size now ≈ 1 MB/night; expect < 1 GB for the first year.
* Destination options (prices checked from the vendors' pages): **Backblaze B2** — first 10 GB free, then $6.95/TB/month, no minimum duration, API calls free → **₹0/month** at this size. **Cloudflare R2** — first 10 GB-month free, then $0.015/GB-month, no egress fee → **₹0/month** at this size. Either needs an account in the owner's name (card/KYC) — that is the approval needed.
* Controls: private bucket; an application key scoped to that one bucket with write+list only (no delete); bucket versioning/object-lock or lifecycle (30 daily / 12 monthly); upload by `rclone` over TLS from the nightly job; a weekly job that downloads the newest object, decrypts it with the vault key and runs `restore-test.sh` against it.

## Known limits / findings
* No email provider: invitation links and the temporary password are delivered by the operator/administrator by hand, privately.
* Starter role `SALES_MANAGER` is powerful (`user:manage`, `role:*`, `system:config`, `rate:update`) and is the only starter role that can tag. Do **not** give it to counter staff: create custom roles in Roles & Permissions. A person can now grant only permissions they hold themselves (privilege-escalation guard, this release).
* `STORE_MANAGER` cannot tag (no `tag:*`).
* Server `tsc -p tsconfig.json` reports 5 type errors, all in `gstr3bGstnWire.test.ts` (test fixture object literals typed as `0` for `taxableValue`); the production build config (`tsconfig.build.json`) excludes tests and compiles clean, so they do not affect the release.
* Photography `imageProcessor` size-targeting test can exceed its 20 s timeout when the machine is under heavy parallel load; it passes alone.

## OSSP onboarding checklist (nothing below is pre-filled — OSSP supplies the values)
1. Administrator signs in, changes the temporary password.
2. Company details: legal name (set), **GSTIN**, PAN, state, address, phone; GST registration(s) and which branch bills under which.
3. Branches: the real shop(s) (a "Head Office" branch exists as a placeholder) — rename/complete.
4. Roles & permissions: create custom roles (e.g. counter staff, tagging operator, accountant) — do not hand out SALES_MANAGER broadly.
5. Staff: for each person — name, e-mail, employee ID, phone, department, role, branch access. Invite from Users; hand each person their one-time link privately.
6. Masters: confirm karats/purities (silver 925/999 exist), categories, stock types, stone types, collections; add what OSSP needs.
7. **Today's metal rates** (Designs → Rates) — tagging and selling are blocked without them. Needs `rate:update`.
8. **Making-charge master** (per karat/category) — required for GRN-sourced pieces to become sellable.
9. Suppliers and customers/dealers (with GSTIN where registered); HSN/GST rates (7113 @ 3% is seeded).
10. Payment setup: banks/UPI providers/POS terminals per branch.
11. Printers: install the printer agent on each counter PC, add the label printer under Hardware, print a test tag.
12. Opening data: **take a backup first** (`systemctl start trivoprod-backup.service`), then enter opening stock as real tags (inward/GRN or New Tag), opening customer/supplier balances via the normal screens or reviewed import. Nothing is fabricated for OSSP by the operator.
