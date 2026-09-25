# TRIVO ERP — API Reference & System Documentation

> Companion to [CLAUDE.md](CLAUDE.md) (how the agent works + build history) and
> [ROADMAP.md](ROADMAP.md) (the phase-by-phase feature build log). This file is the flat
> reference: current setup, current feature scope, and every HTTP endpoint the backend exposes.
> If this file and ROADMAP.md ever disagree on what's *done*, ROADMAP.md is the authority —
> update this file to match rather than the other way around.

---

## 1. Current Setup

### Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, MUI v5, React Query, React Router 7, Zustand, React Hook Form, Recharts |
| Backend | Node.js + Express 4 + TypeScript, Prisma ORM 5 |
| Database | PostgreSQL 16 |
| Cache / queue | Redis 7 (`ioredis`) |
| Object storage | MinIO (S3-compatible) |
| Realtime | Socket.io (WIP floor updates, scale readings) |
| Hardware | `serialport` (RS232 weighing scales), Web Serial API (browser-side scale reads), USB HID barcode/RFID (keyboard-emulation, no driver) |
| Auth | JWT access token (8h) + refresh token (30d) |
| Testing | Vitest (server only; one dedicated Postgres test DB, see below) |

Monorepo layout: npm workspaces, `server/` + `client/`, run together via the root `npm run dev`.

### Infrastructure (`docker-compose.yml`)

| Service | Image | Port(s) | Purpose |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | Primary database (`sea_erp_db`) |
| `redis` | `redis:7-alpine` | 6379 | Cache / session store |
| `minio` | `minio/minio` | 9000 (API), 9001 (console) | File storage, S3-compatible |

### Running it

```bash
docker-compose up -d              # postgres, redis, minio
npm install                       # root — installs both workspaces
cp .env.example server/.env       # then edit server/.env if needed

cd server
npm run db:generate               # Prisma client
npm run db:migrate                # apply migrations (dev DB)
npm run db:seed                   # roles, users, chart of accounts, HSN/karat/state masters, etc.

cd ..
npm run dev                       # concurrently runs server (3001) + client (5173)
```

- Frontend: http://localhost:5173 · Backend: http://localhost:3001 (mounted under `/api/v1`) · MinIO console: http://localhost:9001 · Prisma Studio: `npm run db:studio` (from `server/`)
- Default logins (post-seed): `admin@sea-erp.com` / `Admin@123` (Super Admin), `manager@sea-erp.com` / `Welcome@123` (Production Manager)
- **A user already logged in when the seed changes a role's permissions must log out and back in** — their JWT bakes in the permission list from login time; a plain 403 doesn't trigger the client's silent-refresh flow the way an expired token would.

### Tests

```bash
cd server
npm run test          # vitest run — one shared Postgres test DB (sea_erp_test), not the dev DB
```

`server/test/setup.ts` hard-refuses to run if `DATABASE_URL` doesn't contain `sea_erp_test` — tests can never accidentally land on `sea_erp_db`. Tests run with `fileParallelism: false` (they share one DB and would otherwise race). As of this writing: 5 test files, 127 tests, all passing.

### Key environment variables (`server/.env`, see `.env.example` for the full annotated list)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string for the **app role** (`trivo_runtime`: no ownership, no BYPASSRLS — RLS is enforced against it) |
| `PLATFORM_DATABASE_URL` | The **platform role** (`trivo_platform`, BYPASSRLS DML) — provisioning / operator / platform audit only. Required in production |
| `OWNER_DATABASE_URL` | The **owner role** (`trivo_owner`, DDL) — `prisma migrate deploy` + `npm run db:secure` only, never the API |
| `TRIVO_PLATFORM_API_KEY` | Operator key for `/platform/*` (≥32 chars). Unset = the platform API answers 404 |
| `TRUST_PROXY` | Reverse-proxy hops in front of the API (nginx = 1). **Required behind a proxy** — otherwise every client shares one rate-limit bucket. Unset when exposed directly |
| `API_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` | Per-IP requests / login attempts per 15 min (defaults 1000 / 20). A shop's counters share one public IP — size for the busiest office |
| `REDIS_URL` | Redis connection |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Token signing (**change in production**) |
| `MINIO_*` | Object storage credentials |
| ~~`COMPANY_STATE_CODE`, `GSTIN`, `COMPANY_NAME`, `COMPANY_ADDRESS`~~ | **Removed** — company identity (name, GSTIN, state, address) is per-company data on the `Company` row |
| ~~`SCALE_PORT`, `SCALE_BAUD_RATE`, `RFID_READER_PORT`~~ | **Removed** — devices are company-owned `HardwareDevice` rows; there is no process-wide device |

---

## 2. Feature Scope

### The business model

Originally built for **jewellery manufacturing**; pivoted to **wholesale + retail trading**
(buy finished pieces → hold as stock → sell over the counter, to dealers, or on consignment).
The manufacturing modules were **not deleted** — they're structurally separable and now sit
**dormant**. See [CLAUDE.md](CLAUDE.md) §0–§2 for the full rationale.

### Module status (current)

| # | Module | Status | Notes |
|---|---|---|---|
| — | **Jewelry Tagging & Branches** | 🟢 Live — core | `JewelryTag` status lifecycle, branch transfers (full DRAFT→RECEIVED lifecycle), stock audits, stock-on-hand/dead-stock reports |
| — | **Sales, Wholesaling & Export** | 🟢 Live — core | Direct retail invoicing, dealer memo-out→convert, sales/purchase returns, old-gold exchange, on-account payments |
| — | **Integrated Financial Accounting** | 🟢 Live — core | Every money-moving action posts a real double-entry `JournalEntry`; Trial Balance, P&L, Dealer Aging, Client Ledger, Day Book, GST summary all read off it |
| — | **Procurement (buy-side intake)** | 🟢 Live | PO/GRN; a `FINISHED_GOODS` GRN line auto-creates a `JewelryTag`; purchase returns |
| — | **Quality — Hallmarking & Repairs** | 🟢 Live | Both now work for purchased goods (tag-based), not just manufactured ones (job-card-based) |
| — | **Masters** | 🟢 Live | HSN/GST rates, karat/purity, state codes, stone types, price master, making charges, categories |
| — | **Auth / RBAC / Hardware / Reports (mgmt)** | 🟢 Live | Channel-agnostic — 6 roles, 35+ permissions, audit log, scale/barcode/RFID integration |
| 3 | **Inventory & Diamond Assortment** | 🟡 Partially dormant | Metal vault (`MetalStock`) still live (old-gold exchange feeds it); stone lots/consumables are manufacturing-era, unused post-pivot |
| 4 | **Order Management & Reservation** | 🟡 Partially dormant | `Client` master (party record) is live and reused everywhere; `SalesOrder`/`OrderItem`/`MaterialReservation` (a *production* order) are dormant — **never used for retail/wholesale selling** |
| 1 | **Product Design & CAD/BOM Vault** | 🔴 Dormant | `Design`/`BomItem`/`CostEstimate` untouched. **Exception:** `MetalRate` (`POST/GET /designs/rates*`) is live — it feeds C1/C2's sell-side daily pricing |
| 5 | **In-House Manufacturing & WIP** | 🔴 Dormant | `JobCard`/`JobProcess`/`WipTracking`/`QcCheckpoint` — untouched |
| 6 | **Outsourcing & Job Work Control** | 🔴 Dormant | `Artisan`/`KarigarLedger`/`SubcontractorInvoice` — untouched |

### Phase build log (summary — see ROADMAP.md for full detail)

| Phase | Focus | Status |
|---|---|---|
| A | Fix the sell-side foundation (GST-zero bug, price-mode ambiguity, memo tag-link) | ✅ Done |
| B | Correct GST + point-of-sale essentials (HSN rate master, place-of-supply, invoice print, counter stock lookup) | ✅ Done |
| C | Daily pricing (karat master, metal-rate auto-price, making charges/wastage, stone valuation) | ✅ Done |
| D | Returns & exchange (sale return, purchase return, old-gold exchange) | ✅ Done |
| E | Branch operations (transfers, inter-branch visibility, stock audit) | ✅ Done |
| F | Finance & dealer credit (ledger wiring, standalone payments, credit limits, dealer aging, client ledger) | ✅ Done |
| G | Repairs & hallmarking (customer repair intake + billing, bought-in-goods hallmarking) | ✅ Done |
| H | Management reports (sales register, stock-on-hand, dead stock, day-book, GST summary — 2 of 7 already covered by F3/F4/F1) | ✅ Done |
| I | Store-operations gap pass (GRN→tag on screen, purchase GST + supplier payments, PAN/cash limits, estimate→invoice; GST credit note not started) | ✅ Done (I3 open) |

### Two documented, deliberate control gaps (not bugs — see CLAUDE.md §8)

- `createInvoice()`'s `InvoiceItem.tagId` is optional, so an untagged free-text line still bypasses inventory entirely (needed for making-charge adjustments, gift-wrap fees, etc.) — an off-book sale through this endpoint is technically possible.
- `convertMemoToInvoice()`'s tag flip is a blind `updateMany` (no count check), safe only because `createMemoOut()` already reserves the tag (`IN_STOCK`→`ON_APPROVAL`) before conversion can happen.

---

## 3. API Reference

All paths are relative to `/api/v1`. Every router (except `/auth`'s `login`/`refresh`) requires a
valid JWT (`Authorization: Bearer <token>`); most routes additionally require one or more RBAC
permissions via `requirePermission(...)`, noted per row. `*` on a permission or `<module>:*`
matches via `SUPER_ADMIN`'s `'*'` wildcard.

### Request validation (all routes)

Before any handler runs, `middleware/inputGuard.ts` rejects with `400`: an id-named body field (`id`, `…Id`) that is not a string/null; a `…Ids` field that is not a list of strings; and nested objects in the query string (`?status[not]=x`). Dates arrive as ISO strings and are coerced per route; a missing or unparsable required date is a `400`. A foreign id that belongs to another company is a `404` (never `403`).

### Auth — `/auth`

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/login` | public (rate-limited) | `{ companyCode, identifier (email or company username), password }` → access + refresh token. The company code only *selects* the company; the caller must also be an active member of it. Any failure is the same generic 401 |
| POST | `/refresh` | public | Exchange a refresh token for a new access token |
| GET | `/me` | authenticated | The caller's membership in their own company (employee id, department, phone, role, last login *here*) |
| POST | `/change-password` | authenticated | Change own password |
| GET | `/users` | `user:manage` | List members of the caller's own company (never a global user scan) |
| PATCH | `/users/:companyUserId` | `user:manage` | Edit a member's company-specific details: `employeeId` (unique per company), `department`, `phone`, `username`, `roleId`, `allBranches`, `isActive`. Strict body — unknown fields rejected |
| POST | `/invitations` | `user:manage` | Invite an email into this company (role, branches, employee details). Returns a **one-time `token`** (no email provider yet — hand it to the invitee); only its hash is stored. Identical response whether or not the email already has a login elsewhere |
| GET | `/invitations` | `user:manage` | This company's invitations (PENDING / ACCEPTED / REVOKED / computed EXPIRED) |
| DELETE | `/invitations/:id` | `user:manage` | Revoke a pending invitation |
| POST | `/invitations/accept` | **public** (rate-limited) | `{ token, name, password }` — the invitee accepts. New email → login created; existing login → its password must match, then it is linked. Every failure returns the same `400 Invalid or expired invitation` |

> **Removed:** `POST /auth/users` (create a user from an email). It silently attached whichever global user already owned the email to the calling company. A membership now only ever comes from an accepted invitation (or the seed).

### Company — `/company`

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/users/:companyUserId/branch-access` | `user:manage` | Grant a member access to a branch. Both must belong to the caller's company (404 otherwise) |
| DELETE | `/users/:companyUserId/branch-access/:branchId` | `user:manage` | Revoke a branch grant |

### Platform (operator) — `/platform`

Not part of any company's API. Not reachable with a company JWT; sees company *identity* metadata only, never
business data. Every route needs the `x-trivo-platform-key: <TRIVO_PLATFORM_API_KEY>` header (constant-time
compare, rate-limited, wrong/missing key = the same generic 401; **404 for everything when the key is unset**).

| Method | Path | Description |
|---|---|---|
| POST | `/companies` | Register a company: `{ code, name, gstin?, stateCode?, address?, defaultCurrency?, admin: { email, name, password? }, branch?, starterPackageVersion? }`. One transaction: company + roles + head-office branch + chart of accounts + **its own copy of the Starter Package** + admin (a new email → active member, with the supplied password or a generated one returned once; an email that already has a login → a one-time invitation token instead, never a silent attach) + verification + platform audit. Any failure rolls everything back. Returns 201 |
| GET | `/companies` | List companies (id, code, name, isActive, starterPackageVersion, createdAt) |
| PATCH | `/companies/:id/status` | `{ isActive }` — suspend/re-activate. A suspended company cannot log in, its existing tokens stop working, and its live sockets are disconnected |
| GET | `/starter-packages` | Registered Starter Package versions and what each contains |

CLI equivalent: `npm run company:provision -- --code VASAVI --name "Vasavi Jewellers" --admin-email … --admin-name …`.

### Product Design — `/designs` (mostly dormant — see note)

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/rates` | `system:config` | Upsert a `MetalRate` — **live**: feeds C1/C2 sell-side pricing |
| GET | `/rates/latest` | `design:view` | Metal rates from the last 30 days |
| GET | `/` | `design:view` | List designs *(dormant)* |
| POST | `/` | `design:create` | Create a design *(dormant)* |
| GET | `/:id` | `design:view` | Get a design *(dormant)* |
| PATCH | `/:id` | `design:edit` | Update a design *(dormant)* |
| PUT | `/:id/bom` | `bom:manage` | Save BOM items/processes *(dormant)* |
| POST | `/:id/estimate` | `cost:estimate` | Generate a cost estimate *(dormant)* |

### Procurement — `/procurement` (live — buy-side intake)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/requisitions` | `po:view` | List purchase requisitions |
| POST | `/requisitions` | `po:create` | Create a requisition |
| GET | `/requisitions/:id` | `po:view` | Get a requisition |
| POST | `/requisitions/:id/submit` | `po:create` | Submit for approval |
| POST | `/requisitions/:id/approve` | `po:approve` | Approve |
| POST | `/requisitions/:id/reject` | `po:approve` | Reject |
| POST | `/requisitions/:id/convert` | `po:create` | Convert PR → PO |
| GET | `/suppliers` | `po:view` | List suppliers |
| POST | `/suppliers` | `po:create` | Create a supplier |
| GET | `/orders` | `po:view` | List purchase orders |
| GET | `/orders/:id` | `po:view` | Get a PO (incl. GRNs, approval history) |
| POST | `/orders` | `po:create` | Create a PO |
| PATCH | `/orders/:id/status` | `po:approve` | Set PO status |
| POST | `/orders/:id/submit` | `po:create` | Submit PO for approval |
| POST | `/orders/:id/approve` | `po:approve` | Approve PO |
| POST | `/orders/:id/reject` | `po:approve` | Reject PO |
| GET | `/grn` | `grn:create` | List goods receipt notes |
| POST | `/grn` | `grn:create` | Create a GRN. `branchId` (receiving branch) is required when it has a `FINISHED_GOODS` or `FINISHED_LOT` line. Tagging is a separate step: `POST /tagging/tags/from-grn-item` (Gap #1), or — for a `FINISHED_LOT` line, which is received whole and opens a purchase lot — `POST /tagging/tags` with `purchaseLotId` |
| PATCH | `/grn/:id/verify` | `grn:verify` | Verify/approve a GRN |
| GET | `/suppliers/performance` | `po:view` | Supplier performance stats |
| GET | `/suppliers/:id/returnable-tags` | `po:view` | Tags eligible for purchase return (D3) |
| GET | `/suppliers/:id/payments` | `po:view` | List payments made to a supplier |
| POST | `/suppliers/:id/payments` | `journal:create` | Pay a supplier — Dr Payable / Cr Cash-or-Bank, reduces `Supplier.currentDue` (I2) |
| GET | `/returns` | `po:view` | List purchase returns |
| POST | `/returns` | `po:approve` | Create a purchase return — flips tag to `RETIRED` (D3) |

### Estimation — `/estimation` (live — counter price quotes)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/tags/search` | `estimation:view` | Find a piece to quote |
| GET | `/tags/:tagId` | `estimation:view` | The piece + its materials (sale side only — no cost) |
| GET | `/tags/:tagId/estimates` | `estimation:view` | Estimates saved for a piece |
| POST | `/tags/:tagId/estimates` | `estimation:manage` | Save an estimate; `sendToBilling: true` (+ `customerName` / `customerPhone`) also hands it to billing |
| GET | `/estimates/:id` | `estimation:view` | One estimate |
| POST | `/estimates/:id/send-to-billing` | `estimation:manage` | Hand a saved estimate to the billing counter (I5) |
| GET/POST/PUT | `/templates…` | `estimateTemplate:view` / `manage` | Print templates |

### Inventory — `/inventory` (metal vault live; stones/consumables dormant)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/metals` | `stock:view` | Metal vault stock (filterable by karat/location) |
| POST | `/metals` | `stock:adjust` | Add metal stock |
| PATCH | `/metals/:id/adjust` | `stock:adjust` | Adjust a metal stock row |
| GET | `/stones` | `stone:manage` | List stone lots *(dormant)* |
| POST | `/stones` | `stone:manage` | Create a stone lot *(dormant)* |
| POST | `/stones/:id/split` | `stone:split` | Split a stone lot *(dormant)* |
| GET | `/consumables` | `consumable:manage` | List consumables *(dormant)* |
| POST | `/consumables/transaction` | `consumable:manage` | Record a consumable transaction *(dormant)* |

### Orders — `/orders` (Client master live; SalesOrder dormant)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/reservations` | `reservation:manage` | List material reservations *(dormant)* |
| PATCH | `/reservations/:id/release` | `reservation:manage` | Release a reservation *(dormant)* |
| GET | `/clients` | `order:view` | List clients — **live**, the party master used everywhere |
| POST | `/clients` | `order:create` | Create a client — **live** |
| GET | `/` | `order:view` | List sales orders *(dormant — a production order, not a retail/wholesale sale)* |
| GET | `/:id` | `order:view` | Get a sales order *(dormant)* |
| POST | `/` | `order:create` | Create a sales order *(dormant)* |
| PATCH | `/:id/status` | `order:approve` | Update sales order status *(dormant)* |

### Manufacturing — `/manufacturing` (fully dormant)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/floor` | `job:view` | Factory floor status |
| GET | `/jobs` | `job:view` | List job cards |
| GET | `/jobs/:id` | `job:view` | Get a job card |
| POST | `/jobs` | `job:create` | Create a job card |
| POST | `/jobs/:id/wip` | `wip:update` | Record a WIP entry |
| POST | `/jobs/:id/advance` | `job:update` | Advance to the next process |
| POST | `/jobs/:id/qc` | `qc:inspect` | Submit a QC checkpoint |

### Outsourcing — `/outsourcing` (fully dormant)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/artisans` | `karigar:view` | List artisans |
| POST | `/artisans` | `karigar:issue` | Create an artisan |
| GET | `/artisans/:id/ledger` | `karigar:view` | Artisan metal ledger |
| POST | `/issue` | `karigar:issue` | Issue material to an artisan |
| POST | `/return` | `karigar:return` | Record return from an artisan |
| POST | `/invoices` | `subcon:invoice` | Generate a subcontractor invoice |
| GET | `/invoices` | `subcon:invoice` | List subcontractor invoices |

### Quality — `/quality` (live — G1 repairs, G2 hallmarking)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/hallmarking` | `hallmark:manage` | List hallmarking batches |
| POST | `/hallmarking` | `hallmark:manage` | Create a batch — each item needs a `jobCardId` **or** a `tagId` (G2) |
| PATCH | `/hallmarking/:id/receive` | `hallmark:manage` | Record HUIDs returned from the hallmarking center |
| GET | `/repairs` | `repair:manage` | List repair jobs |
| POST | `/repairs` | `repair:manage` | Create a repair job — optional `clientId`/`tagId` (G1) |
| PATCH | `/repairs/:id` | `repair:manage` | Update cost/client/tag/notes before billing (G1) |
| PATCH | `/repairs/:id/status` | `repair:manage` | Change status — `DELIVERED` stamps `deliveredDate` (G1) |
| POST | `/repairs/:id/transactions` | `repair:manage` | Record a metal-addition/scrap-recovery transaction |
| POST | `/repairs/:id/bill` | `invoice:create` | Charge the customer — creates a `SalesInvoice` (G1) |

### Sales — `/sales` (live — core sell-side)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/reports/register` | `report:view` | Sales register — invoices in a date range (H1) |
| GET | `/memos` | `memo:manage` | List dealer memo-outs |
| POST | `/memos` | `memo:manage` | Create a memo-out (flips tags to `ON_APPROVAL`) |
| POST | `/memos/check-alerts` | `memo:manage` | Send overdue-memo alerts |
| POST | `/memos/:id/return` | `memo:manage` | Return memo items (flips tags back to `IN_STOCK`) |
| POST | `/memos/:id/convert` | `memo:manage` | Convert a memo to an invoice — the wholesale sale path |
| GET | `/invoices` | `sales:view` | List invoices |
| GET | `/invoices/:id` | `sales:view` | Get an invoice (items, tax, payments, export docs) |
| GET | `/staff` | `invoice:create` | Salesperson picker for the New Sale form |
| GET | `/branches` | `invoice:create` | Branches the caller may bill from (the invoice needs one) |
| GET | `/estimates?q=` | `invoice:create` | Estimates sent to billing, searchable by number / item / tag / customer name — sale-side data only (I5) |
| POST | `/invoices` | `invoice:create` | Create a direct invoice — tag-aware (Gap #2) |
| POST | `/invoices/:id/payment` | `invoice:create` | Record a payment against an invoice |
| GET | `/invoices/:id/packing-list` | `export:doc` | Generate a packing list |
| GET | `/clients/:clientId/payments` | `sales:view` | List a client's payments, invoice-scoped + standalone (F2) |
| POST | `/clients/:clientId/payments` | `invoice:create` | Record an on-account payment (F2) |
| GET | `/returns` | `sales:view` | List sales returns (D1) |
| POST | `/returns` | `invoice:create` | Create a sales return — flips tag back to `IN_STOCK` |
| GET | `/exchanges` | `sales:view` | List old-gold exchanges (D4) |
| POST | `/exchanges` | `invoice:create` | Create an old-gold exchange — credits client balance + Metal Vault |

### Finance — `/finance` (live — F1–F4, H4–H5)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/accounts` | `finance:view` | Chart of accounts |
| GET | `/journals` | `finance:view` | List journal entries |
| POST | `/journals` | `journal:create` | Create a manual (discretionary) journal entry |
| POST | `/journals/:id/post` | `journal:post` | Post a draft journal entry |
| GET | `/reports/trial-balance` | `report:view` | Trial balance as of a date |
| GET | `/reports/pnl` | `report:view` | P&L for a period — this **is** the "profit/margin" report (Phase H) |
| GET | `/reports/balance-sheet` | `report:view` | Balance sheet as of a date |
| GET | `/reports/cost-centers` | `report:view` | Cost-center profitability |
| GET | `/reports/dealer-aging` | `report:view` | Outstanding balances aged into buckets, over-limit flag (F3) |
| GET | `/reports/client-ledger/:clientId` | `report:view` | One client's full statement, running balance (F4) |
| GET | `/reports/supplier-ledger/:supplierId` | `report:view` | One supplier's statement — purchases, returns, payments, running payable (I2) |
| GET | `/reports/purchase-gst-summary` | `report:view` | Input tax credit: HSN-wise net of returns + bill-wise, for a period (I2) |
| GET | `/reports/day-book` | `report:view` | One day's company-wide sales/payments/returns/exchanges (H4) |
| GET | `/reports/gst-summary` | `report:view` | HSN-wise GST summary for a period, filing prep (H5) |
| GET | `/cost-centers` | `finance:view` | List cost centers |

### Settings — `/settings`

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/roles` | `role:manage` | List roles |
| POST | `/roles` | `role:manage` | Create a role |
| GET | `/config` | `system:config` | List system config entries |
| PUT | `/config/:key` | `system:config` | Upsert a config entry |
| GET | `/design-categories` | authenticated | List design categories |
| POST | `/design-categories` | `system:config` | Create a design category |
| GET | `/process-tolerances` | `karigar:view` | List process tolerances |
| PUT | `/process-tolerances/:processName` | `system:config` | Upsert a tolerance |
| GET | `/audit-logs` | `audit:view` | Audit log (filterable by table) |

### Hardware — `/hardware`

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/devices` | `hardware:manage` | List registered hardware devices + connected scales |
| POST | `/devices` | `hardware:manage` | Register a device |
| GET | `/scales/:deviceId/read` | `wip:update` | Last reading from a scale |
| POST | `/scales/:deviceId/simulate` | `hardware:manage` | Simulate a scale reading (dev/testing) |
| POST | `/rfid/scan` | `job:view` | Look up a job card by RFID tag |
| POST | `/barcode/scan` | `job:view` | Look up a job card by barcode |

### Reports (legacy manufacturing dashboard) — `/reports`

Pre-dates the pivot; distinct from the per-module `/reports/*` sub-paths added under
`sales`/`tagging`/`finance` in Phases F–H. Kept for the dashboard and manufacturing-era screens
still in the UI; not the primary sell-side reporting surface (that's Section 3's Sales/Finance/
Tagging `/reports/*` rows above).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/dashboard` | `report:view` | Home dashboard KPIs |
| GET | `/wip-summary` | `report:view` | WIP-by-process/priority *(dormant data)* |
| GET | `/stock-summary` | `report:view` | Metal/stone/consumable stock *(mostly dormant data)* |
| GET | `/karigar-balances` | `report:view` | Artisans with an outstanding metal balance *(dormant)* |
| GET | `/aging-receivables` | `report:view` | Superseded by `finance/reports/dealer-aging` (F3) — kept for compatibility |

### Tagging — `/tagging` (live — core inventory module)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/branches` | `tag:view` | List active branches |
| GET | `/branches/stock-summary` | `tag:view` | Network-wide stock visibility, per branch (E2) |
| GET | `/reports/stock-on-hand` | `report:view` | `IN_STOCK` value by branch × category (H2) |
| GET | `/reports/dead-stock` | `report:view` | `IN_STOCK` ageing, bucketed by days (H3) |
| POST | `/branches` | `branch:manage` | Create a branch |
| PATCH | `/branches/:id` | `branch:manage` | Update a branch |
| GET | `/tags` | `tag:view` | List/filter tags (paginated) |
| GET | `/tags/search` | `tag:view` | Search by tag #, name, or HUID |
| GET | `/tags/:id` | `tag:view` | Get a tag |
| POST | `/tags` | `tag:create` | Create a tag (manual entry, with materials). Optional `purchaseLotId` cuts the piece from a purchase lot (checked against the bag's category rows and caps); its `costPrice` is what the tag builds — pre-filled from the PO's per-category cost rates — and falls back to its share of the bag's remaining cost by net weight when none is entered |
| PATCH | `/tags/:id/retire` | `tag:create` | Retire a tag |
| POST | `/tags/from-grn-item` | `tag:create` | Create a tag from a `FINISHED_GOODS` GRN item (Gap #1) |
| POST | `/manufacturers/from-supplier` | `tag:create` | Body `{ supplierId }` — the MANUFACTURER Client matching a PO's supplier (found by GSTIN, else name; created once from the supplier's details). Pre-selects the tag's Manufacturer (I6) |
| GET | `/lots` | `tag:view` | List purchase lots (bags) with tagged/remaining pieces, weight and cost; `?status=OPEN|CLOSED` (I6) |
| GET | `/lots/:id` | `tag:view` | One lot with its tags and remaining figures (I6) |
| POST | `/lots/:id/close` | `tag:create` | Close a lot — no more pieces can be tagged from it; report-only, body `{ note? }` (I6) |
| GET | `/transfers` | `tag:view` | List branch transfers |
| GET | `/transfers/:id` | `tag:view` | Get a transfer |
| POST | `/transfers` | `branch:transfer` | Create a transfer (`DRAFT`) |
| POST | `/transfers/:id/submit` | `branch:transfer` | Submit for approval |
| POST | `/transfers/:id/approve` | `branch:approve` | Approve (dispatches — tags → `TRANSFERRED`) |
| POST | `/transfers/:id/receive` | `branch:transfer` | Receive (tags → `IN_STOCK` at destination) |
| POST | `/transfers/:id/cancel` | `branch:transfer` | Cancel a transfer |
| GET | `/audits` | `stock:view` | List stock audits |
| GET | `/audits/:id` | `stock:view` | Get an audit (expected/found/missing) |
| POST | `/audits` | `stock:adjust` | Start a physical stock audit for a branch (E3) |
| POST | `/audits/:id/scan` | `stock:adjust` | Scan a tag into the audit |
| POST | `/audits/:id/complete` | `stock:adjust` | Close the audit (report-only — never mutates tags) |

### Masters — `/masters`

Every resource below follows the same `GET` (`masters:view`) / `POST`+`PATCH` (`masters:manage`)
shape; `price-master` and `making-charges` additionally support a soft-delete `DELETE`
(`isActive: false`).

| Resource | Path prefix | Feeds |
|---|---|---|
| Product categories | `/categories` | Tag/invoice line categorization |
| Sub-categories | `/subcategories` | — |
| Collections | `/collections` | — |
| Material codes | `/material-codes` | Tag materials, making-charge matching |
| Karat / purity | `/karats` | C1 — tag karat validation, `MetalRate` lookups |
| Stone types | `/stone-types` | C4 — `PriceMaster` stone valuation |
| Price master | `/price-master` | C4 — stone `saleAmount` auto-resolution |
| Making charges | `/making-charges` | C3 — invoice line making-charge/wastage auto-fill |

---

## RBAC quick reference

6 seeded roles (`server/prisma/seed.ts`), permission format `<resource>:<action>` (`*` = everything,
`<resource>:*` = every action on that resource):

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | `*` — everything |
| `PRODUCTION_MANAGER` | Manufacturing + procurement + hallmarking/repairs (incl. `invoice:create` for repair billing) + `masters:view`/`report:view` |
| `ACCOUNTANT` | Finance, journals, tax, `invoice:create`, `sales:view`, `masters:view` |
| `SALES_MANAGER` | Sales, memo, invoice creation, export docs, order view/create, `masters:view` |
| `FLOOR_WORKER` | `job:view`, `wip:update`, `karigar:view` only |
| `STORE_MANAGER` | Stock view/adjust, stone handling, consumables, GRN, `masters:view` |

Full permission constants: `server/src/middleware/rbac.ts` (`PERMISSIONS` object, ~35 entries).
