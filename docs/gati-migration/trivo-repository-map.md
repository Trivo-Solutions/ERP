# TRIVO Repository Map (Phase 1)

Source: `C:\ERP\ERP`, branch `main`, HEAD `99e752b`; `CLAUDE.md` plus code listing. Status: Confirmed for structure; CLAUDE.md claims are **not** independently re-verified in this pass unless stated.

## Layout
- `client/` React 18 + TS + MUI; `server/` Node/Express/TS + Prisma (`provider = "postgresql"`, PostgreSQL 18 locally); also `printer-agent/`, `camera-bridge/`, `ops/`, `docs/`.
- `server/prisma/schema.prisma`: 138 models; 111 entries in `prisma/migrations` (includes non-migration files); `db-secure.sql`, `production-rls-roles.sql`, `seed.ts`.
- `server/src/modules/`: auth, company, finance, gst, hardware, inventory, manufacturing, masters, offers, orders, outsourcing, paymentConfig, photography, platform, procurement, product-design, quality, reports, sales, settings, tagging.
- Existing docs convention: markdown at repo root (`PHASE_*.md`, `ROADMAP.md`, `API.md`), plus a small `docs/` folder. New work lives in `docs/gati-migration/`.

## Models relevant to migration (line numbers in schema.prisma)
`Company`, `Branch` (2890), `JewelryTag` (2993), `BranchTransfer` (3103), `Client` (2346), `Supplier` (1116), `PurchaseOrder` (1758), `GoodsReceiptNote` (1890), `PurchaseLot`, `SalesInvoice` (3709), `InvoiceItem` (3778), `TaxInvoice`, `SalesReturn` (4128) / `PurchaseReturn`, `MemoOut`/`MemoItem`, `OldGoldExchange`, `MetalStock` (2104), `RepairJob` (2770), `JournalEntry` (4542)/`JournalLine`/`Account`, `InvoicePayment`, `CustomerAdvancePayment`, `HsnCode`, `StateMaster`, `KaratMaster`, `StockAudit`, `AuditLog`.

## Architecture constraints that shape any migration (from CLAUDE.md, Confirmed as stated policy)
- Multi-company with RLS enforced at the DB (3 DB roles), composite FKs, tenant wrappers (`tenantQuery`/`tenantTransaction`); `npm run audit:tenant` and `npm run test:rls` before release. Any importer must go through tenant context and verify foreign ids per company.
- Every sale/payment/return/GRN posts a balanced `JournalEntry` automatically (`postAutoJournalEntry`) and updates `Client.currentBalance`/`Supplier.currentDue`. **Using the normal services for historical data would double-post accounting** - a direct historical-load path that bypasses auto-posting (or loads GATI balances as opening balances) is required. Decision pending.
- Tag status lifecycle: `IN_STOCK`/`ON_APPROVAL`/`TRANSFERRED`/`SOLD`/`RETIRED`. Tag `costPrice` is immutable by sales ops. `InvoiceItem.tagId` may reference a returned/resold tag (not unique).
- Document numbers are sequenced per company; business day is IST. Closed GST periods reject backdated documents (`GSTR3B_FILED_PERIOD_IMMUTABLE`, GSTR-1 equivalent) - **a historical import dated into a filed period will be blocked**.
- Migrations that touch tenant rows must lift FORCE RLS around the statement.
- Manufacturing modules are dormant; GATI also contains manufacturing/order/bag data (`Spm_MfgOrder`, `SPM_Bag*`).

## Not yet verified (Unresolved)
- Whether the running TRIVO database matches `schema.prisma` and contains a Vasavi company; nothing in Postgres was queried.
- No existing import/ETL tooling or `source_id`/external-reference columns were looked for in detail; no model was inspected field-by-field (Phase 2 mapping work).
