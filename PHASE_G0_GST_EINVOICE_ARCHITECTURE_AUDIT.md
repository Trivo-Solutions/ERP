# PHASE G0 — GST & e-Invoice Architecture Audit

**Scope:** read-only architecture audit. No source, schema, migration, permission, route, frontend, or data changes were made while producing this report. This is the only file created in this pass.
**Date:** 2026-09-29 · **Branch:** `main` (working tree unchanged; existing uncommitted printer-agent files predate this audit and are unrelated)
**Prior phase status:** J1–J4 (company isolation, RBAC, universal edit/delete/restore) is complete and frozen — this audit treats it as the baseline and does not re-litigate it.

---

## 1. Executive Summary

**Is TRIVO structurally ready for GST/e-Invoice?** Partially, and unevenly. The *accounting and tax-calculation* backbone is genuinely mature — GST is centrally calculated per line from an HSN-rate master, snapshotted at sale time, posted to dedicated output/input GST ledger accounts, reversed correctly on returns/voids, and reported via HSN-wise summaries that are the right shape for GSTR-1/3B prep. The *multi-tenant/RLS/audit* framework this would need to plug into is solid and battle-tested (J1–J4, Phase 5 RLS, composite FKs). But the *company/GST-registration identity model* is the opposite of ready: `Company` has exactly one nullable `gstin` and one `stateCode` field, `Branch` has none at all, so **one Company = one implicit GST identity today, with no way to represent multiple GSTINs or multi-state branches**. Compounding this, the printed tax invoice **hardcodes the seller's legal name as "SEA Jewelry Pvt. Ltd." for every tenant** — a live, severe multi-tenant bug independent of GST readiness. `TaxInvoice` already carries the full e-invoice column set (`irn`, `ackNumber`, `qrCodeData`, `ewbNumber`, etc.) but every one of them is write-never — pure dormant schema.

**What already exists:** HSN/GST-rate master with per-line snapshot; place-of-supply resolution via `StateMaster`; CGST/SGST/IGST posted to their own ledger accounts on both sales and purchase sides, with correct reversal on void/return; HSN-wise GST summary reports (sales and purchase); the entire J1–J4 tenant-isolation/RLS/composite-FK/audit framework, ready to extend to new GST entities; atomic, concurrency-safe document numbering; a two-company test-fixture harness.

**What is missing:** any multi-GSTIN/multi-registration model; PAN/legal-name/trade-name/structured-address fields on `Company`; a formal GST Credit Note document (ledger reversal exists, the statutory document does not); GST financial-year-aware (Apr–Mar) invoice numbering (today it's calendar-year); any outbound HTTP client, retry/timeout wrapper, job queue, or idempotency-key infrastructure anywhere in the codebase; any QR-image library (QR only exists as a printer-hardware TSPL command); any DB-level credential encryption; and any RBAC permission for GST/e-invoice actions.

**What requires rework:** the invoice snapshot model (buyer/seller data is a live join, not a point-in-time snapshot — both a GST-audit problem and, for the seller side, an active bug); the memo-conversion tax path (`convertMemoToInvoice`) duplicates flat-rate tax math instead of reusing `priceInvoice()`; invoice numbering's calendar-year vs financial-year mismatch; the dual, competing `irn`/`ewbNumber` locations (`TaxInvoice` vs the never-written `ExportDocument`) that need a single owner decided before any e-invoice code is written.

**Major risks:** (1) the hardcoded seller identity is a correctness bug today, not just a GST gap — it should be treated as its own fix, independent of this phase's timeline; (2) there is zero idempotency infrastructure anywhere, which is precisely the missing piece for safe IRN generation against a real IRP (a network failure after a successful IRN creation must not double-generate); (3) the company/GSTIN model conflates "one company" with "one tax identity," which will need a real schema decision (new `CompanyGstRegistration` entity vs. widening `Company`) before e-invoice work can start, not as a side effect of it.

**Do not claim production-ready** for GST/e-Invoice — this is a foundation-and-gap assessment, not a go-live determination.

---

## 2. Current Architecture

- **Backend:** `server/` — Node/Express/TypeScript, Prisma ORM, Zod-validated env config (`server/src/config/env.ts`). Modules under `server/src/modules/{sales,procurement,finance,tagging,masters,platform,auth,...}`, each with a `*.service.ts` (business logic, always behind `tenantQuery`/`tenantTransaction`) and `*.router.ts` (HTTP + `requirePermission` gates).
- **Frontend:** `client/` — React 18 + TypeScript + MUI v5, page-per-module under `client/src/pages/*`.
- **Database:** PostgreSQL, `server/prisma/schema.prisma` (2600+ lines, 90+ models), 60+ migrations under `server/prisma/migrations/`, three DB roles (`trivo_owner`, `trivo_runtime`, `trivo_platform`) with FORCE RLS on every tenant table (`server/prisma/production-rls-roles.sql`, `db-secure.sql`).
- **Tenant isolation:** `server/src/shared/tenantContext.ts` (`tenantQuery`/`tenantBatch`/`tenantTransaction`/`runAsPlatform`), `set_config('app.tenant_company_id', …, true)` scoped to each transaction, composite FKs (`@@unique([id, companyId])` + FK pairs) on 58 relations, `npm run audit:tenant` static guard.
- **RBAC:** `server/src/shared/permissionCatalog.ts` — flat `resource:action` permission strings, checked via `requirePermission()` at the router layer; roles are `String[]` on a `Role` row, no enum.
- **Finance:** double-entry `Account`/`JournalEntry`/`JournalLine`/`CostCenter`, `server/src/modules/finance/finance.service.ts`, ledger-account codes centralized in `server/src/shared/ledgerAccounts.ts`.
- **Invoice/sales:** `server/src/modules/sales/sales.service.ts` (the single largest, most GST-relevant file — `createInvoice`, `priceInvoice`, `amendInvoice`, `voidInvoice`, `convertMemoToInvoice`, `createSalesReturn`, `reverseInvoicePayment`, `generatePackingList`).
- **Printing:** entirely client-side — `client/src/utils/printInvoice.ts` builds an HTML string and calls the browser's native `window.print()`; a completely separate local pipe, `printer-agent/` (loopback-only Express service on `127.0.0.1:9101`), handles thermal label/tag printing via raw TSPL commands (`server/src/shared/tsplGenerator.ts`). No server-side PDF engine exists anywhere.
- **External integrations:** none live. `minio`, `nodemailer` are dependencies but unwired (no actual upload/send call anywhere); `METAL_RATE_API_URL`/`SMS_API_KEY` env vars are declared but never referenced outside `env.ts`. No `axios`/`fetch`/job-queue library is a dependency at all.

---

## 3. Company & GST Registration Model

- `Company` (`schema.prisma:49-64`): `id, code, name, gstin String?, stateCode String?, address String?, defaultCurrency, starterPackageVersion, isActive, ...`. **One nullable `gstin`, one nullable `stateCode`, one free-text `address`. No PAN field. No legal-name/trade-name split. No PIN code field. No financial-year field.**
- Set only once, by a platform operator at provisioning (`server/src/modules/platform/platform.router.ts:53-59`, `provisioning.service.ts:37,115`), gated by `TRIVO_PLATFORM_API_KEY`. **No tenant-facing "Company GST settings" page or endpoint exists** to view or correct `gstin`/`stateCode`/`address` afterward (grep of `company`/`settings` modules and client pages: zero hits).
- `Branch` (`schema.prisma:1651-1681`): `id, companyId, branchCode, name, address, city, state (free text), phone, email, managerName, isHeadOffice, isActive`. **No `gstin`, no `stateCode`, no pincode field at all.** `SalesInvoice.branchId` is required and stamped from the authenticated tenant context (`schema.prisma:2330-2338`), so invoicing does carry branch identity — but `TaxInvoice` has no `branchId` of its own, and the GST engine (`sales.service.ts:378-379,394`) always reads `company.gstin`/`company.stateCode` off the single `Company` row, **never the invoice's branch** — branch is tracked but functionally invisible to GST math.
- **Answer to "can one Company have multiple GSTINs/registrations/states/branch-registrations today": No.** There is no `GstRegistration`/`CompanyGstin` child table (confirmed by a full `model` enumeration of `schema.prisma`). One `Company` row = one implicit GST identity, full stop. A company genuinely operating branches across GST states cannot represent that — it is architecturally flattened to "one home state everywhere."
- **Recommended future model** (design input, not implemented): promote GST registration to its own entity — `CompanyGstRegistration { id, companyId, gstin, legalName, tradeName, stateCode, address, isPrimary, isActive }`, unique on `(companyId, gstin)`, composite-FK'd the standard way (§17). `Branch` gains an optional FK to the registration it invoices under; a branch with no explicit link falls back to the company's primary/default registration, preserving today's single-GSTIN behavior for every company that doesn't need more. This also gives invoice-numbering (§9) a natural per-registration series key later, without disturbing single-GSTIN companies.

---

## 4. Customer GST Model

- `Client` (`schema.prisma:1110-1155`): `gstNumber String?`, `panNumber String?`, `dateOfBirth`, `form60Received Boolean` (Rule 114B declaration-on-file), `address, city, district, state (free text), pincode, country`. **Present:** GSTIN, PAN. **Absent:** legal-name/trade-name split (one `name` field only), an explicit registered/unregistered status flag (inferred at runtime from GSTIN presence, e.g. `panFromGstin()` in `server/src/shared/compliance.ts:31-34`, and client-side regex in `NewSalePage.tsx:26`), and any SEZ/export/deemed-export flag (a separate, entirely dormant `ExportDocument` model exists — schema.prisma:2528-2542 — but nothing marks a `Client` itself as SEZ/export).
- `Supplier` (`schema.prisma:606-640`): same shape — `gstNumber`, `panNumber`, free-text `state`/`pincode`, no legal/trade-name split, no registration-status flag.
- **Snapshot behavior — not snapshotted, a live join.** `SalesInvoice`/`InvoiceItem` have no customer-name/address/GSTIN columns of their own; `sales.router.ts:110-125` fetches the invoice with `include: { client: true }`, and `printInvoice.ts:233-239` renders straight from that live-joined `Client` row. **If a `Client`'s GSTIN/address is edited after a sale, re-printing that historical invoice later shows the new data, not what was true at the time of supply** — a genuine GST-compliance gap (a tax invoice is a point-in-time legal document; India's e-invoice/GST rules expect the recipient details to match what was declared at supply time).
- State resolution for GST purposes goes through `resolveStateCode()` (§17 detail) — the `Client.state` free text is fuzzily matched against `StateMaster.name`/`aliases`; an unresolved match falls back to treating the sale as inter-state, with the raw unresolved text landing directly in `TaxInvoice.placeOfSupply` (confirmed by a test asserting `placeOfSupply` can equal literal unresolved text).

---

## 5. HSN/SAC

- `HsnCode` (`schema.prisma:1972-1984`): `code String @unique, description String?, gstRate Decimal(5,4), isActive`. Generic in shape, but **currently seeded with exactly one row**: `7113` (jewellery of precious metal), 3% (`server/prisma/seed.ts:140-149`; also hard-inserted by migration `20260823184530_add_hsn_gst_rate`). `DEFAULT_HSN_CODE = '7113'` (`server/src/shared/constants.ts:13`).
- **No UOM field, no separate CGST/SGST split-rate field (one flat `gstRate` only), no SAC-equivalent model or field anywhere** (grep for `sac` across `server/src`: no matches). Making-charge/job-work "services" are taxed using the same jewellery HSN rate as the goods line — there is no services-tax-code concept at all.
- **Global, not company-scoped**, and **has no admin/CRUD route** — `masters.router.ts:13` states explicitly "(HsnCode/StateMaster are read-only platform reference data and have no route here at all.)" Adding a second HSN (bullion 7114, precious stones 71xx) today requires a manual migration/seed edit, not an in-app action.
- `InvoiceItem.hsnCodeId`/`taxRate` are **snapshotted per line at sale time** (`schema.prisma:2420-2424` comment: "a later change to the HSN master must not silently reprice past invoices" — same immutability precedent as `JewelryTag.costPrice`). Same snapshot discipline on the purchase side (`PoItem.taxRate`, `GrnItem.taxableValue/inputCgst/inputSgst/inputIgst`).

---

## 6. Tax Calculation

**Single source of truth on the sale side: `priceInvoice()`, `server/src/modules/sales/sales.service.ts:498-691`.** `createInvoice()` (line 231) and `amendInvoice()` (line 708) both call this one function and use its output verbatim — not duplicated math.

- Per-line `taxRate` sourced from the `HsnCode` master, keyed by each item's HSN (default `7113`), copied onto `InvoiceItem.taxRate` (line 653).
- Per-line `taxAmount` computed at each line's own rate; invoice-level `discountAmount` spread proportionally across lines by value; `otherCharges` taxed separately at the default HSN rate (lines 663-673).
- CGST/SGST/IGST split happens once, inside `createInvoice`'s transaction (not in `priceInvoice`): same-state vs inter-state resolved from `Company.stateCode` (live read) vs `resolveStateCode(client.state)` (lines 378-388), written to a new `TaxInvoice` row.
- **One real duplication found:** `convertMemoToInvoice()` (line 1659) does **not** call `priceInvoice()` — it computes `taxAmount = subtotal * taxRate` at a single flat default-HSN rate only, with no per-line HSN, discount, or otherCharges handling, and re-derives the CGST/SGST/IGST split formula separately (lines 1774-1790). The code's own comment acknowledges this ("the memo path stays single-rate for now"). `createSalesReturn` independently re-derives its reversal from the invoice's own stored snapshot (correct behavior — a return must reverse what was actually charged, not today's rate, so this is not a bug).
- **Frontend is preview-only, not a second source of truth.** `client/src/pages/Sales/NewSalePage.tsx` computes GST client-side purely to drive the `SaleSummary` preview; `SaleSummary.tsx` is pure presentation (no computation); `buildBody()` never sends computed tax fields to the server — only raw line items and adjustments. The server's `priceInvoice()` authoritatively reprices and re-taxes at save time regardless of what the client showed.

---

## 7. Sales Invoice Readiness

| Required e-Invoice concept | Existing field/model | Status | Notes |
|---|---|---|---|
| Invoice number | `SalesInvoice.invoiceNumber`, unique per `(companyId, invoiceNumber)` | READY TO REUSE | Atomic, concurrency-safe generation (§9) |
| Invoice date | `SalesInvoice.invoiceDate` | READY TO REUSE | |
| Financial year | *(none)* | NEW COMPONENT | Numbering uses calendar year today (§9) |
| Document type (invoice/CN/DN/bill-of-supply) | `invoiceType` is a channel label ("RETAIL"/"WHOLESALE"), not a GST doc-type | NEEDS EXTENSION | No B2B/B2C/SEZ/export classification field |
| Original-invoice reference (return) | `SalesReturn.invoiceId` | READY TO REUSE | |
| Original-invoice reference (amendment) | *(none — same row edited in place)* | NEEDS REWORK | Only an audit-log before/after snapshot exists |
| Seller legal name/GSTIN/address | GSTIN: `TaxInvoice.gstin` (captured at invoice time). Legal name/address: **hardcoded string literal** in `printInvoice.ts:31-32` | NEEDS REWORK | Severe — see §8 |
| Buyer legal name/GSTIN/address | Live join to `Client` (name/gstNumber/address) | NEEDS REWORK | Not snapshotted — reflects current Client data, not point-of-sale data (§8) |
| Dispatch / ship-to info | *(none)* | NEW COMPONENT | No ship-to address model anywhere |
| Item HSN | `InvoiceItem.hsnCodeId` | READY TO REUSE | Snapshotted |
| Item qty / UOM | Qty yes; **no UOM field** | NEEDS EXTENSION | |
| Item rate / taxable value | `unitPrice`, `totalPrice` | READY TO REUSE | |
| Per-line discount | *(none — only invoice-level `discountAmount`, spread proportionally at calc time)* | NEEDS EXTENSION | |
| Per-line GST rate | `InvoiceItem.taxRate` | READY TO REUSE | Snapshotted |
| Per-line CGST/SGST/IGST amount | *(none — only invoice-level aggregate on `TaxInvoice`)* | NEEDS EXTENSION | e-invoice JSON schema wants per-line tax amounts |
| Totals / rounding | `subtotal, discountAmount, otherCharges, taxAmount, roundOff, totalAmount` | READY TO REUSE | |
| IRN / ack / signed QR / e-way bill fields | `TaxInvoice.isEInvoice/irn/ackNumber/ackDate/qrCodeData/ewbNumber/ewbValidUntil` | NEW COMPONENT (schema exists, logic doesn't) | Zero production writes anywhere; only a read-guard in `voidInvoice`. A **second**, competing `irn`/`ewbNumber` pair also exists, unused, on `ExportDocument` — ownership must be decided (§26) |

---

## 8. Invoice Snapshot / Immutability

**Buyer and seller data on a sales invoice is a live join, not a point-in-time snapshot — and the seller side is worse than that.**

- No columns for customer name/address/GSTIN/phone exist on `SalesInvoice`/`InvoiceItem`; the invoice-detail endpoint (`sales.router.ts:110-125`) does `include: { client: true }`, and `printInvoice.ts:233-239` renders straight from that live relation. **Editing a `Client`'s address or GSTIN after a sale changes what a re-print of that historical invoice shows.**
- **Seller side: not a live join at all — a hardcoded literal, confirmed by direct read of `client/src/utils/printInvoice.ts:31-33`:**
  ```ts
  const companyName = 'SEA Jewelry Pvt. Ltd.';
  const companyAddr = 'Jewelry Wholesale & Retail Division';
  const companyGstin = tax?.gstin ?? '—';
  ```
  Only the GSTIN is data-driven (captured from `Company.gstin` at invoice-creation time). **In this explicitly multi-tenant system, every printed invoice for every company shows "SEA Jewelry Pvt. Ltd." as the seller legal name and address**, regardless of which tenant actually issued it. This is a live, severe bug independent of GST/e-invoice readiness — flagged here because it directly blocks correct seller identity on any tax document, but it is not itself a GST architecture gap; it should be treated as its own defect.
- Net: neither side of the transaction is captured as it stood at the moment of supply — a real problem for GST/e-invoice compliance, where the invoice is a fixed legal record.

---

## 9. Invoice Numbering

- `server/src/shared/numberSequence.ts`: atomic and race-free via a single `INSERT ... ON CONFLICT (companyId, documentType, financialYear) DO UPDATE SET lastValue = lastValue + 1 RETURNING lastValue` (lines 54-60) — Postgres takes the row lock as part of the one statement; no app-level `SELECT...FOR UPDATE` + retry loop needed. Proven under load by a dedicated 50-way concurrency test.
- **Per-company only — not per-branch, not per-GSTIN.** The sequence key is `(companyId, documentType='INV', financialYear)`; `branchId` is not part of it. All branches of one company share one `INV-<year>-######` series.
- **"financialYear" is actually calendar year.** `createInvoice` passes `data.invoiceDate.getFullYear()` (Jan–Dec) as the sequence's year key — there is no Apr–Mar Indian GST fiscal-year logic anywhere in the codebase (confirmed by grep for `financialYear|fiscalYear|FY\b`: only this file). Under GST Rule 46(b), an invoice series must be unique/consecutive per financial year (Apr–Mar); resetting on Jan 1 instead is a real compliance mismatch, not a naming quibble.
- `convertMemoToInvoice` calls the same sequence with **no explicit year argument**, defaulting to the server's current date — self-consistent today, but reinforces that "financial year" here is really "today's calendar year."
- **Multi-GSTIN implication:** since numbering has no branch/GSTIN dimension and `Company` has only one GSTIN (§3), there is currently no way to maintain a separate invoice series per GST registration — a real requirement the moment a company has more than one GSTIN.

---

## 10. Returns / Credit Notes

- **CLAUDE.md's own wording ("createSalesReturn ... books no GST reversal") is stronger than the code.** The ledger-level GST reversal **is** implemented: `postAutoJournalEntry` inside `createSalesReturn` debits `CGST_PAYABLE`/`SGST_PAYABLE`/`IGST_PAYABLE` for the returned tax portion. What is genuinely missing — and what the code's own inline comment correctly scopes it as — is a **formal GST Credit Note document**: no credit-note number, no `TaxInvoice`-shaped counterpart with its own GSTIN/place-of-supply/ack fields for GSTR-1 CDNR reporting. **Ledger-level reversal: done. Statutory credit-note document: not done.**
- No `CreditNote`/`DebitNote` model exists anywhere (`schema.prisma` grep: zero matches). `SalesReturn`/`SalesReturnItem` is the only return-side model, with no credit-note-shaped fields.
- Original-invoice reference on a return: yes, via `SalesReturn.invoiceId` FK; no separate original-invoice-date stamp (reachable via the join).
- `voidInvoice` reverses stock/GST/COGS/client-balance in one compound reversing journal entry (mirroring `createInvoice`'s exactly, in reverse) and **explicitly refuses if `TaxInvoice.irn` is already set** — "this system has no GST e-invoice IRN-cancellation integration...cancel the IRN with the GST portal first" (a deliberate, correctly-scoped placeholder).
- **`amendInvoice` has no equivalent IRN guard** — it can rewrite header/lines/GST with no check on `taxDetails.irn`. Moot today only because IRN is never populated; becomes a real gap the moment e-invoicing goes live (post-IRN, only cancellation-within-24h or a formal credit/debit note is legal, never a silent amendment).
- TCS (Tax Collected at Source) on cash jewellery sales: confirmed not implemented anywhere (matches CLAUDE.md's own note).
- No purchase-side formal debit-note document either (`PurchaseReturn` has its own `returnNumber` but no GST debit-note shape) — same gap-shape as the sales side.

---

## 11. Purchase GST

**Matches CLAUDE.md's Phase I2 claim precisely — no discrepancy found.**

- ITC ledger accounts confirmed: `LEDGER_ACCOUNT.INPUT_CGST/INPUT_SGST/INPUT_IGST` = `1401`/`1402`/`1403` (`server/src/shared/ledgerAccounts.ts:12-14`).
- Supplier GSTIN (`Supplier.gstNumber`) drives `resolveSupplierStateCode()`/`splitInputGst()` (`server/src/shared/inputGst.ts`) to determine CGST+SGST vs IGST — same live-lookup-not-snapshot pattern as the sales side, one level removed (only the derived split, not the raw GSTIN, is persisted onto `GrnItem`).
- **Directly verified by this audit** (both intake paths actually post to the Input GST ledger accounts, not just stamp report fields):
  - Single-piece intake, `tagging.service.ts` `createTagFromGrnItem` — posts `Dr Inventory + Dr Input CGST/SGST/IGST / Cr Accounts Payable`.
  - Lot/bag intake, `procurement.service.ts:279-289` — identical journal shape: `{ INVENTORY: debit taxable }, { INPUT_CGST/SGST/IGST: debit gst.cgst/sgst/igst }, { ACCOUNTS_PAYABLE: credit taxable+gst.total }`.
- Purchase tax-invoice number/date captured: `GoodsReceiptNote.invoiceNumber`/`invoiceDate`, from the supplier's own bill.
- **`createPurchaseReturn` reverses ITC exactly as booked at intake** (not re-derived from current rates) — directly verified at `procurement.service.ts:888-898`: `{ ACCOUNTS_PAYABLE: debit }, { INVENTORY: credit }, { INPUT_CGST/SGST/IGST: credit }`, and `Supplier.currentDue` decremented by the same amount. `PurchaseReturnItem.cgst/sgst/igst` persists the reversed split per tag.
- Same gap as sales side: no formal GST debit-note document, only the ledger reversal.

---

## 12. Finance Integration

- Full tax-relevant chart: `CASH_IN_HAND/BANK_ACCOUNT` (1101/1102), `ACCOUNTS_RECEIVABLE` (1200), `INVENTORY` (1300), `INPUT_CGST/SGST/IGST` (1401-1403), `ACCOUNTS_PAYABLE` (2100), `CGST/SGST/IGST_PAYABLE` (2201-2203), `SALES_REVENUE` (4000), `COST_OF_GOODS` (5000), `ROUND_OFF` (6600) — all in `server/src/shared/ledgerAccounts.ts`, seeded per-company by `starterPackage/v1.ts`.
- **GST is posted to its own dedicated ledger accounts, never lumped into sales/COGS**, on both the sale side (`createInvoice`'s `postAutoJournalEntry`: separate lines for `ACCOUNTS_RECEIVABLE`, `SALES_REVENUE` at taxable value only, `CGST/SGST/IGST_PAYABLE`, `ROUND_OFF`, COGS/Inventory) and the purchase side (§11).
- **Void/reversal pattern is exclusively "post a new, exact inverse journal entry" — original entries are never edited or deleted.** Confirmed for `voidInvoice` (new `SalesInvoiceVoid`-tagged reversing entry) and `reverseInvoicePayment` (new inverse entry, original row flagged `reversedAt`/`reversedById`/`reversalReason`, never mutated). This is the mandatory pattern any future GST credit-note or IRN-cancellation flow must also follow — it must never touch history, only append a reversal.
- **Single company-wide, not per-GSTIN/per-branch.** `Account`/`JournalEntry`/`JournalLine`/`CostCenter` all carry only `companyId`, no `branchId`. `CostCenter` is a P&L department axis, not a GST-registration boundary. If multi-GSTIN support is added (§3), the chart of accounts and journal have no existing sub-ledger dimension to key GST liability by registration — this would need its own design.
- One confirmed-but-unread nuance: whether the *lot-level* GRN posting differs from the single-tag GRN posting was independently re-verified directly in this pass (§11) — both post identically to the Input GST accounts.

---

## 13. PDF / QR / Printing

- **A4 tax invoice is 100% client-side, no server PDF engine.** `client/src/utils/printInvoice.ts` builds a raw HTML string (A4 CSS), opens it in a new browser window, and relies on the browser's native `window.print()` / "Save as PDF." No puppeteer/pdfkit/jspdf/pdfmake/wkhtmltopdf dependency exists anywhere in the repo.
- **QR code generation exists only as a printer-hardware TSPL command, not a JS/image library.** `server/src/shared/tsplGenerator.ts:97-99` emits a raw `QRCODE ...` TSPL string that the thermal label printer itself rasterizes — there is no QR bitmap/SVG ever rendered in Node or the browser. Content is restricted to a fixed whitelist of tag fields (`tagNumber, name, metalKarat, ...`) or arbitrary `literalText` set in the tag-template designer. No `qrcode`/QR-image npm package exists anywhere (checked every `package.json`). Technically, the `literalText` path *could* carry an arbitrary payload (e.g. a signed e-invoice QR string) through this exact mechanism — but nothing today does that, and it only exists at print time on a physical label printer, never on-screen/as an image.
- Barcode: `jsbarcode` (client-side, on-screen preview) + the same TSPL-native `BARCODE` command server-side — confirms the "hardware renders the payload" house style.
- **Print-agent is a pure local raw-print pipe, unrelated to any external/tax integration.** Loopback-only bind (`127.0.0.1:9101`), no outbound HTTP calls of any kind, TSPL-only, thermal label printers only. Completely separate code path from the A4 invoice (which never touches the print-agent at all).

---

## 14. External API Architecture

- **No outbound HTTP client library is a dependency anywhere** — `axios`, `node-fetch`, `undici`, `got`, and Node's global `fetch` are all absent from `server/src`. Server dependencies are: `@prisma/client, bcryptjs, compression, cors, dotenv, express, express-async-errors, express-rate-limit, helmet, ioredis, jsonwebtoken, minio, morgan, multer, nodemailer, serialport, socket.io, winston, zod`.
- **No live external integration exists at all today** — every candidate is reserved-but-dormant config: `minio` (dependency present, zero `new Minio.Client()` calls, explicit code comment "not wired up yet"), `nodemailer` (dependency present, zero `sendMail` calls), `METAL_RATE_API_URL/KEY` and `SMS_API_KEY` (env vars declared, never referenced outside `env.ts`).
- **No reusable API-client pattern exists** (no base client class, retry/timeout wrapper, circuit breaker) — there's nothing to generalize from. The closest analogous "enforce one access pattern" precedents are local, non-HTTP: `cache.forCompany(companyId)` (Redis namespacing) and `objectKey.ts` (future MinIO key namespacing, written ahead of MinIO being wired up).
- **No background job/queue/scheduler/retry infrastructure of any kind** — no `bull`/`bullmq`/`agenda`/`node-cron` dependency, no `setInterval`-based retry loop, no job-queue table in the schema. Redis is used strictly as an optional, no-op-safe cache — no pub/sub, streams, or queue usage.
- **Conclusion: an IRP/e-invoice HTTP client would be first-of-its-kind infrastructure in this codebase** — there is no existing outbound-integration convention to extend, and none of the "not implemented yet" reserved integrations (MinIO, email, SMS, metal-rate API) provide a template either, since none of them are actually wired up to compare against.

---

## 15. Credential Security

- **Every current secret is environment-variable-only; there is no DB-level encryption anywhere.** All sensitive config flows through one Zod-validated schema (`server/src/config/env.ts`): `JWT_SECRET`/`JWT_REFRESH_SECRET` (min 32 chars enforced), `MINIO_ACCESS_KEY/SECRET_KEY`, `SMTP_USER/PASS`, `SMS_API_KEY`, `METAL_RATE_API_KEY`, `TRIVO_PLATFORM_API_KEY` (min 32 chars, explicitly "an operator credential, never a tenant one"). None have a database counterpart.
- No `pgcrypto` extension, no application-level `createCipheriv`/`createDecipheriv` or symmetric-encryption utility exists anywhere in `server/src` (confirmed by grep). `HardwareDevice` (the closest existing "external device config" table) stores only connection metadata (port, baud rate, IP), no credential field.
- `Company.gstin` is stored as a plain nullable string — appropriate, since a GSTIN is a public tax-identity string, not a secret.
- **Existing "credential at rest" precedents are all one-way or local-only, not a template for a reusable third-party API credential:** bcrypt password hashes (irreversible by design), SHA-256 invitation-token hashes (only the hash is ever stored; the raw token is shown once and discarded), JWT secrets (local HMAC keys the app never sends outbound). **None of these patterns fit a GSTIN/IRP API credential** (a client ID/secret or signing certificate the app must decrypt and actually use on outbound calls) — this would be genuinely new infrastructure (envelope encryption / KMS / a dedicated encrypted-credential table), not an extension of anything that exists today.
- Real `.env` files exist at the server/client/printer-agent roots (existence confirmed only — contents not read or reported, per this audit's own read-only/no-secret-disclosure rule).

---

## 16. RBAC

Full current catalog (`server/src/shared/permissionCatalog.ts`), sales/finance/tax-relevant subset:

- **Sales & Export:** `client:view/create/edit/deactivate/delete`, `sales:view/create`, `memo:manage`, `invoice:create/edit/void`, `payment:view/create/reverse`, `return:create`, `export:doc`
- **Finance:** `finance:view`, `journal:create/post`, `tax:manage`
- **General:** `report:view`, `report:financial_view` (J4-D1 split for sensitive financial/GST reports), `audit:view`
- **Masters:** `masters:view/create/edit/delete` — **HSN code master maintenance rides this generic permission, not a GST-specific one.**

**Specific confirmations:**
- `invoice:create`/`invoice:edit`/`invoice:void` are all enforced at their respective routes.
- `report:financial_view` gates every GST-adjacent report (`getGstSummary`, `getPurchaseGstSummary`, dealer aging, client/supplier ledger, day book, trial balance/P&L/balance sheet).
- **`tax:manage` is confirmed dead/unused** — it exists in the catalog and is seeded onto a default role, but zero routes anywhere check for it (`requirePermission('tax...` — zero matches across the entire server tree). It is grantable from the Role Editor UI but has no effect.
- No `gst:*`, `einvoice:*`, or credit-note-specific permission exists anywhere today.

**Implication:** a future GST/e-invoice phase adding `gst:manage`, `einvoice:generate`, `einvoice:cancel` (or reviving `tax:manage` for real enforcement) is entirely new ground — no existing enforcement to conflict with, and `tax:manage`'s dormancy means it could plausibly be repurposed or left alongside new, more specific strings (a decision for that phase, not this one).

---

## 17. Tenant Isolation

**Mechanics** (`server/src/shared/tenantContext.ts`): `TenantContext` is plain data (companyId, companyUserId, permissions, branchAccess) carried via `AsyncLocalStorage` — **never a live Prisma client or transaction handle**, specifically to avoid leaking one request's connection/queries onto another's. Every company-scoped operation goes through one of:
- `tenantQuery(companyId, op)` — single read/write, the common case.
- `tenantBatch(companyId, build)` — multiple independent ops in one BATCH transaction; `SET LOCAL app.tenant_company_id` is the first statement in the same transaction, by construction, so nothing can execute between the tenant-scope-set and the queries.
- `tenantTransaction(companyId, fn)` — the only form allowed real control flow (conditional writes); hard rule (enforced by review, not the compiler): no non-DB I/O may happen inside `fn`.
- `runAsPlatform(fn)` — the only door to the BYPASSRLS `platformPrisma` client; migrations/operator tooling only.

**Concrete new-table pattern** (from `20260925130000_purchase_lots`, directly transferable to any future GST entity):
```sql
CREATE TABLE "new_table" ("id" TEXT NOT NULL, "companyId" TEXT NOT NULL, ...);
CREATE UNIQUE INDEX "new_table_id_companyId_key" ON "new_table"("id", "companyId");
ALTER TABLE "new_table" ADD CONSTRAINT "..._companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ...;
ALTER TABLE "new_table" ADD CONSTRAINT "..._parentId_companyId_fkey" FOREIGN KEY ("parentId","companyId") REFERENCES "parent"("id","companyId") ...;
ALTER TABLE "new_table" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "new_table" USING ("companyId" = current_setting('app.tenant_company_id', true)) WITH CHECK (...);
```

**`npm run audit:tenant` — confirmed known blind spots** (matches CLAUDE.md's own claim exactly, verified by reading the tool's source): it AST-matches only `prisma.<model>.<op>(...)` plain-call shapes — it has **no visitor for tagged-template raw SQL** (`` prisma.$queryRaw`...` ``, this codebase's actual convention), and it does not recognize `platformPrisma` at all, so a stray `platformPrisma.<companyModel>.<op>()` outside `runAsPlatform()` passes with zero warning. Neither `audit:tenant` nor `test:rls` runs in CI (no CI workflow exists) — both are manual pre-release steps.

**Mapping future GST entities to the ownership model:**

| Future entity | Classification | Notes |
|---|---|---|
| `CompanyGstRegistration` | Company-owned | New entity per §3; needs `@@unique([id, companyId])` since it will be referenced by branches/invoices |
| `GSTINCredential` (IRP client ID/secret) | Company-owned, encrypted at rest | New infrastructure (§15) — no existing encryption pattern to reuse |
| `GSTConfiguration` (sandbox/prod toggle, retry policy, etc.) | Company-owned | Simple company-scoped config row, same shape as existing `SystemConfig` |
| `GSTTaxRate` / HSN rate table | **Global/reference**, same as today's `HsnCode` | Unless a future need for company-specific rate overrides arises |
| `GSTInvoiceSnapshot` (point-in-time buyer/seller data for the e-invoice payload) | Company-owned, child of `SalesInvoice` | Directly addresses §8's immutability gap |
| `EInvoice` (IRN, ack, signed invoice/QR, status) | Company-owned, child of `SalesInvoice`/`TaxInvoice` | Must consolidate with — not duplicate — the existing dormant `TaxInvoice` e-invoice columns and `ExportDocument.irn` (§26) |
| `EInvoiceAttempt` (per-call log, for idempotency/retry) | Company-owned | New — nothing like this exists today (§18) |
| `EWayBill` | Company-owned, child of `SalesInvoice` | |
| `GSTReconciliation` | Company-owned | Read-side aggregate, same shape as existing reports (§12) |

Every one of these follows the identical, already-proven pattern above — no new tenant-isolation mechanism needs to be invented, only applied.

---

## 18. Idempotency & Retry

**None found — a genuine, confirmed gap.** A targeted grep for `idempoten|externalRef|dedup|requestId` across the entire server tree turned up only *internal* idempotent-upsert business logic (starter-masters seeding, chart-of-accounts application, a repair-job unique-invoice-id guard) — nothing resembling an idempotency key, external-reference-id, or client-supplied dedup token for an **outbound** call. There is no job-queue/outbox table in the schema, and no code anywhere implements a "reserve intent → call external API → reconcile ambiguous failure" two-phase pattern.

**This is directly relevant to the canonical IRP risk scenario:** TRIVO sends "Generate IRN," the IRP creates it successfully, the network fails before TRIVO receives the response — TRIVO must not blindly regenerate. Nothing in the current codebase solves this today; it would need to be built from scratch (an `EInvoiceAttempt` log with a unique constraint on `(invoiceId, attemptSeq)` or similar, checked before every retry, plus a "query IRN status by invoice reference" reconciliation call to the IRP before ever re-generating).

The one *adjacent* pattern worth reusing is the **atomic-claim-then-act** idiom already proven in `reverseInvoicePayment` (a count-checked conditional `updateMany` before mutating) — a good model for "claim the right to attempt IRN generation" locally, but it does not by itself solve the external-ambiguous-failure problem, which needs its own design.

---

## 19. Concurrency

- **Invoice numbering is safely concurrent** via a single atomic `INSERT ... ON CONFLICT DO UPDATE` (§9) — proven by a dedicated 50-concurrent-caller test.
- **`SELECT ... FOR UPDATE` row locking is an established pattern** for read-then-write invoice mutations — confirmed present in `amendInvoice`, `voidInvoice`, and `reverseInvoicePayment` (all lock the same `sales_invoices` row before recomputing `paidAmount`/`balanceDue`), closing a previously-real lost-update race (J3.5 hardening, with a regression test that reproduced the bug when the fix was reverted).
- **IRN-generation risk under concurrency:** if two requests ever raced to generate an IRN for the same invoice (e.g. a retried request and a legitimate second attempt), today's codebase has no equivalent lock/claim pattern scoped to "IRN generation in flight for this invoice" — this would need the same atomic-claim idiom as payment reversal, applied to a new `EInvoiceAttempt`/status field, before any real IRP call is made.

---

## 20. Testing Readiness

- **Directly reusable fixture infrastructure:** `server/src/test/fixtures.ts` — `createTestTenant(suffix, permissions)` builds one full tenant (Company + Role + User + Branch + seeded chart of accounts + starter masters) in one call; parameterized by `suffix` so two calls yield two isolated companies. `server/src/test/e2e.twoCompany.test.ts` and `compositeFk.test.ts` already use this exact pattern — a future GST/e-invoice test suite needs zero new fixture code to get a two-company, two-GSTIN test setup.
- **Directly relevant existing suites:** `sales.service.test.ts` (createInvoice/amendInvoice/voidInvoice/reverseInvoicePayment/convertMemoToInvoice), `sales.compliance.test.ts` (PAN Rule 114B, Sec 269ST cash ceiling — already GST-compliance-adjacent), `finance.service.test.ts` (getGstSummary, getDealerAging, getClientLedger), `procurement.inputGst.test.ts`, `purchaseLot.test.ts`, `tenantIsolation.*.test.ts` (schema guard + phase 1-3 isolation), `rls.enforced.test.ts`, `compositeFk.test.ts`, `numberSequence.concurrency.test.ts`.
- **`npm run test:rls`** re-runs the identical vitest suite against a real, pre-provisioned, role-split Postgres database (`trivo_rlstest`, via `TRIVO_TEST_ENV_FILE`) using the actual non-owner/non-BYPASSRLS `trivo_runtime` role — as opposed to the everyday dev/test DB where RLS is inert and `withForcedRls` simulates FORCE RLS in a rolled-back transaction. CLAUDE.md's instruction to run this "before any release" is a real, working harness, not aspirational.
- **Nothing exists yet for testing an external HTTP integration** (no mock-server/nock/msw pattern found) — a future IRP sandbox integration test would need to introduce this tooling itself.

---

## 21. IRP Integration Mapping

Design input only — no connection, credential creation, or implementation. Categories reflect the generally-documented shape of India's e-invoice (IRP/NIC/GSP) and e-way-bill APIs; anything not independently verifiable against live, current official documentation in this session is marked **NEEDS EXTERNAL CONFIRMATION**.

| IRP capability | TRIVO existing support | Required future work |
|---|---|---|
| Authentication (client ID/secret + app-level key, token refresh) | None | New: credential store (§15, §17), token-refresh-aware HTTP client (§14) |
| GSTIN onboarding / registration check | `Company.gstin` exists as a field; no validation call | New: outbound "GSTIN details" lookup, likely via a GSP, not direct NIC |
| e-Invoice generation (submit invoice JSON, receive IRN) | `TaxInvoice` has the target columns (`irn`, `ackNumber`, `ackDate`); no generation code | New: payload builder from `SalesInvoice`/`InvoiceItem`/`TaxInvoice` (needs §8's snapshot fix first), HTTP call, idempotent retry (§18) |
| IRN retrieval / status query | None | New — needed specifically to resolve §18's ambiguous-failure case |
| IRN cancellation (within the statutory window) | `voidInvoice` already refuses to void once `irn` is set, with the correct message pointing at manual portal cancellation | Extend: a real in-app cancel call, replacing today's "go do it manually" guard |
| Signed invoice / signed QR | `TaxInvoice.qrCodeData` column exists, unused | New: QR **payload** generation is new (today's QR infra is TSPL-hardware-only, §13); rendering a *signed* QR (from the IRP's response) is a different problem than TRIVO generating its own QR content |
| e-Way Bill generation/status | `TaxInvoice.ewbNumber/ewbValidUntil` columns exist, unused; duplicate unused pair on `ExportDocument` | New, plus the ownership decision in §26 |
| API errors / rate limits / request IDs | No existing pattern anywhere in the codebase (§14) | New: error normalization, backoff, and correlation-ID logging — first-of-its-kind in this codebase |
| Multi-GSTIN support at the API layer | Not supported at the data-model layer either (§3) | Blocked on the `CompanyGstRegistration` decision — this is a prerequisite, not parallel work |

**NEEDS EXTERNAL CONFIRMATION for all of the above:** exact current IRP/GSP request/response JSON schema version, current sandbox vs. production endpoint behavior, current rate limits, and current e-way-bill API coupling rules (e-way bill can be requested at e-invoice time or separately) — none of this was verified against live external documentation in this read-only, code-only audit and must be confirmed from the current official specification before implementation.

---

## 22. Multi-Company SaaS Architecture

Recommended conceptual shape, given everything above:

```
TRIVO
 └─ Company (existing, J1-J4 isolation proven)
     └─ CompanyGstRegistration (NEW — §3; one-to-many, replacing today's single Company.gstin)
         └─ IRP Integration Layer (NEW — §14/§18, per-registration credentials)
             └─ IRN / e-Invoice / e-Way Bill (NEW — §17 table)
```

- **Credential isolation:** a `GSTINCredential` row keyed to `(companyId, gstRegistrationId)`, composite-FK'd the standard way (§17), encrypted at rest (§15 — new infrastructure). `runAsPlatform`/`platformPrisma` must never be the path by which a company's IRP credential is read for an outbound call — it should go through the same `tenantQuery`/`tenantTransaction` wrappers as everything else, decrypted only inside the request that needs it.
- **Data isolation:** every new entity in §17's table gets `companyId` + RLS + composite FKs exactly like the other 58 relations — no new mechanism to invent.
- **Retry/webhook isolation:** if the IRP or a GSP ever pushes a webhook (e.g. an async IRN-cancellation confirmation), it must be attributable to exactly one company before any DB write — likely via a signed reference ID embedded at request time, checked against `EInvoiceAttempt.companyId` before any `tenantQuery` write, never inferred from the payload alone.
- **Logs:** any structured logging of IRP requests/responses must not include the credential itself and must be filterable per company for support/debugging — no existing logging-redaction convention was found for this (winston is used generically; no field-redaction middleware exists today).

---

## 23. Security Threat Model

Facts about existing controls and required future controls — no fixes proposed.

| Risk | Existing control | Required future control |
|---|---|---|
| Cross-company credential access | None yet (no credential store exists) | Encrypt at rest, scope by composite FK + RLS like every other tenant entity (§17), never readable via `platformPrisma` outside `runAsPlatform` |
| Client-supplied GSTIN/tax manipulation | `assertOwnedByCompany`-style ownership checks exist for foreign IDs generally (J1-J4); GST *rate* is already server-snapshotted from HSN master, not client-supplied (§6) | Any client-supplied GSTIN on a *counterparty* (not the company's own) still needs format/checksum validation before an IRP call — not currently validated beyond a regex on the frontend |
| IRN spoofing / duplicate IRN | N/A — no IRN logic exists yet | New: IRN values must be treated as authoritative only from the IRP response, never accepted as client input |
| Unauthorized cancellation | `voidInvoice`'s IRN-guard shows the right instinct (refuse once IRN exists) | New: an actual cancel action needs its own permission (§16) and audit event, following the existing immutable-audit pattern (§17 of CLAUDE.md, unchanged) |
| Unauthorized invoice modification after IRN | **Gap found:** `amendInvoice` has no IRN guard today (unlike `voidInvoice`) | Add the same guard `voidInvoice` already has, before any e-invoice code goes live |
| Leaked API credentials | No credential store exists yet, so no exposure surface yet | Must not repeat the "hash it, never reverse it" pattern used elsewhere (§15) — this credential must be genuinely decryptable, which is a different, unaddressed risk class in this codebase |
| Sensitive data in logs | Generic winston logging, no field-redaction convention found | New: redact credential/PII fields in any IRP request/response logging |
| Platform-vs-company boundary | Proven solid (J1-J4, `runAsPlatform` is the only BYPASSRLS door, independently re-verified in the isolation sweep) | Extend the same discipline to any new GST entity — no new boundary concept needed |
| Signed-QR tampering | N/A — no signed QR exists yet | The QR payload TRIVO would render is the IRP's own signed response; TRIVO must not construct or approximate it itself |
| Webhook spoofing | N/A — no webhook infrastructure of any kind exists | If a webhook is ever added, must authenticate the sender and attribute to a company before any write (§22) |

---

## 24. Reusable Components

| Component | File/path | What it does today | Reuse for GST/e-invoice | Limitation |
|---|---|---|---|---|
| `Company` | `schema.prisma:49-64` | Company identity | Base for registration model | One GSTIN only — needs `CompanyGstRegistration` alongside it |
| `HsnCode` + `resolveMetalRate`-style snapshot discipline | `schema.prisma:1972-1984`, `sales.service.ts` `priceInvoice` | HSN rate lookup, per-line snapshot | Exactly the pattern a GST rate table needs | Single global row today; no SAC |
| `StateMaster` / `resolveStateCode()` | `server/src/shared/stateMaster.ts` | Free-text state → GST 2-digit code | Place-of-supply resolution, reusable as-is | Fuzzy match, silent fallback on no match |
| `TaxInvoice` | `schema.prisma:2640-2667` | GST amounts + dormant e-invoice columns | Natural home for e-invoice status, if consolidated with `ExportDocument` (§26) | Columns exist, zero logic |
| `postAutoJournalEntry` / `LEDGER_ACCOUNT` | `finance.service.ts`, `shared/ledgerAccounts.ts` | Centralized double-entry posting | GST credit-note/IRN-cancellation reversal must reuse this, never bypass it | None found |
| `tenantQuery`/`tenantTransaction`/composite-FK pattern | `shared/tenantContext.ts`, any recent migration | Full tenant isolation | Directly reusable for every new GST entity | None — this is the strongest asset in the whole audit |
| `createTestTenant` two-company fixture | `server/src/test/fixtures.ts` | Multi-company test setup | Directly reusable for GST/e-invoice tests | None |
| `numberSequence.ts` atomic sequence | `shared/numberSequence.ts` | Race-free document numbering | Reusable for a future credit-note/e-invoice sequence, once FY logic is added | Calendar-year only today (§9) |
| Immutable audit framework | (J1-J4, CLAUDE.md §6.6) | Company-isolated, tamper-proof audit log | Directly reusable for IRN generate/cancel events | None |
| `tsplGenerator.ts` QR emission | `server/src/shared/tsplGenerator.ts` | Printer-hardware QR command | Conceptually informative (structured-payload-to-external-renderer) but **not** infrastructure for a signed e-invoice QR (different problem, §13) | Hardware-only, whitelisted field set |

---

## 25. Required New Components

- `CompanyGstRegistration` (multi-GSTIN support) — §3, §17
- `GSTINCredential` store with real (decryptable) encryption at rest — §15, §17
- `GSTInvoiceSnapshot` (point-in-time buyer/seller capture) — §8, §17
- `EInvoice` / `EInvoiceAttempt` (IRN, ack, status, retry/idempotency log) — §17, §18
- `EWayBill` (or consolidate into the existing but unused `ExportDocument.ewbNumber` — §26 decision) — §17
- Formal GST Credit Note / Debit Note documents (sales and purchase) — §10, §11
- Outbound HTTP client with retry/timeout/idempotency-key support — §14, §18
- GST financial-year-aware (Apr–Mar) document numbering — §9
- Per-line CGST/SGST/IGST amount storage on `InvoiceItem` (today only invoice-level) — §7
- UOM and per-line discount fields on `InvoiceItem` — §7
- New RBAC permissions (`gst:manage`, `einvoice:generate`, `einvoice:cancel`, or similar) — §16
- Field-redaction logging convention for any IRP request/response — §23

---

## 26. Required Rework

- **`printInvoice.ts`'s hardcoded seller name/address** — must become genuinely tenant-driven (Company legal name/address), independent of and prior to any e-invoice work. This is a correctness bug, not a GST feature gap.
- **Invoice snapshot model** — buyer/seller data must be captured at invoice-creation time, not read live at print/report time, for both GST-audit correctness and e-invoice payload fidelity.
- **`convertMemoToInvoice`'s flat-rate tax duplication** — should call the same `priceInvoice()` used by `createInvoice`/`amendInvoice`, or the memo/wholesale path will diverge further as GST logic gets more sophisticated (multi-rate, per-line CGST/SGST/IGST, etc.).
- **`amendInvoice` needs the same IRN guard `voidInvoice` already has** before e-invoicing goes live.
- **The dual `irn`/`ewbNumber` location** (`TaxInvoice` vs. the never-written `ExportDocument`) must be resolved to one owner before any e-invoice code is written, to avoid building on top of an ambiguity.
- **Invoice numbering's calendar-year vs. financial-year mismatch** must be fixed as part of (not after) any GST-numbering-sensitive work, since GSTR-1 filing periods are financial-year-bound.

---

## 27. Proposed Future Implementation Phases

- **G1 — GST Master/Foundation.** `CompanyGstRegistration` model + migration; fix the hardcoded seller identity in `printInvoice.ts`; fix invoice-numbering financial-year logic; resolve the `TaxInvoice`/`ExportDocument` e-invoice-field ownership question; add per-line CGST/SGST/IGST + UOM + per-line discount to `InvoiceItem`.
- **G2 — Invoice Snapshot & GST Tax Engine hardening.** Point-in-time buyer/seller snapshot on invoice creation; unify `convertMemoToInvoice` onto `priceInvoice()`; add `amendInvoice`'s missing IRN guard; formal GST Credit Note / Debit Note documents (sales + purchase), reusing the existing "new reversing journal entry" discipline.
- **G3 — RBAC + Credential Infrastructure.** New GST/e-invoice permission strings; `GSTINCredential` store with real encryption at rest; outbound HTTP client with retry/timeout/idempotency-key support (first-of-its-kind in this codebase) — built and tested with a stub/sandbox endpoint, no real IRP calls yet.
- **G4 — IRP Sandbox Integration.** `EInvoice`/`EInvoiceAttempt` models; real sandbox authentication, e-invoice generation, IRN retrieval/status query, cancellation; the idempotent-retry design proven against sandbox specifically for the "ambiguous failure" case (§18).
- **G5 — Production IRP Integration.** Same code path as G4 against production credentials, per-registration; go-live gating on the Phase 6-style staging verification this codebase already has a precedent for (CLAUDE.md §12).
- **G6 — e-Way Bill.** `EWayBill` model + IRP/GSP e-way-bill API integration, reusing G3/G4's client and idempotency infrastructure.
- **G7 — GST Reporting/Reconciliation.** Extend the already-strong `getGstSummary`/`getPurchaseGstSummary` foundation toward true GSTR-1/GSTR-3B-shaped exports, plus IRN/e-way-bill reconciliation reporting.

---

## 28. Open Questions

- Should `CompanyGstRegistration` be introduced even for single-GSTIN companies (uniform model, more migration work now), or should `Company.gstin` remain the default/primary registration with the new table only for companies that need more than one (less migration work now, a permanent "is this company on the old or new model" branch later)? This is a business/product decision, not something the code alone answers.
- Which entity owns `irn`/`ewbNumber` going forward — `TaxInvoice` (already wired into `voidInvoice`'s guard) or a new dedicated `EInvoice` table, with `TaxInvoice`/`ExportDocument`'s existing columns deprecated? Needs a decision before G1's schema work.
- Is a GSP (GST Suvidha Provider) intermediary planned, or direct NIC/IRP integration? This materially changes the authentication/API shape in §21 and was not something this code-only audit could determine.
- What is the actual current IRP/e-invoice JSON schema version and endpoint behavior (sandbox vs. production, e-way-bill coupling rules, rate limits)? Explicitly out of scope for this read-only, code-focused audit — must be sourced from current official documentation before G4.
- Does the business want e-invoicing enabled per-branch (once multi-GSTIN exists) or company-wide only, and does invoice-numbering need to become per-registration as part of that, or can it stay per-company?

---

## 29. G0 Conclusion

`G0 AUDIT: COMPLETE — READY FOR HUMAN REVIEW`
