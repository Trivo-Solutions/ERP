# TRIVO Gap Analysis for the GATI Migration (Phase 2)

Date: 2026-10-14. Method: **repository inspection only** (`server/prisma/schema.prisma`, migrations, `sales.service.ts`, `tagging.service.ts`, `finance.service.ts`, `shared/numberSequence.ts`, `gstr3bFilingProtection.ts`, the tag-history migration). The TRIVO PostgreSQL database was **not** connected to or queried; nothing in this file says anything about what data it holds, whether Vasavi is a provisioned company, or whether migrations are applied there. Nothing was changed, installed, or run. Tags: **[C]** read in code, **[H]** reasoned, **[U]** unknown. "G" numbers are gaps; "D" numbers are owner decisions (see `DECISIONS.md`). Evidence on the GATI side is in `gati-branch-location-findings.md`.

## 1. Bottom line

TRIVO can **hold** the migrated facts (tags, branches, invoices, returns, memos, transfers, parties, journals, balances) but cannot **receive** them through its existing services without corrupting them. Every service re-derives what GATI already decided (numbers, prices, tax, ledger entries, balances, dates, tag numbers). There is **no** source-id column, no import batch, no historical-load path, no movement-history table that can be loaded, and no way to mark a past GST period as already filed except by running the whole snapshot→file pipeline. Four schema additions and one purpose-built, reviewed historical loader are the minimum; each needs approval (§8). **No code was written.**

## 2. What TRIVO already has that matches GATI concepts (verified)

| GATI concept | TRIVO entity | Fit | Evidence |
|---|---|---|---|
| Tag (one physical piece) | `JewelryTag` | Good, but one row per piece (`@@unique([companyId, tagNumber])`) vs GATI's chain of instances; `branchId` required, status `IN_STOCK/ON_APPROVAL/TRANSFERRED/SOLD/RETIRED` | schema.prisma:2998-3106 |
| Material rows | `JewelryTagMaterial` (code, type, pieces, weight, cost/sale rate+amount) | Good | schema |
| Branch | `Branch` (`branchCode`, `isHeadOffice`, `gstRegistrationId`) | Good; HO is a real row, not NULL | schema.prisma:2895 |
| Branch transfer | `BranchTransfer` + `BranchTransferItem.receivedAt` (null = in transit) | Concept fits, **mechanics differ** (§4) | schema.prisma:3108-3156; tagging.service.ts:1411-1538 |
| Sale / lines / tax | `SalesInvoice`, `InvoiceItem` (per-line `hsnCodeId`, `taxRate`, cgst/sgst/igst, `materialBreakdown`), `TaxInvoice` | Good fit for what GATI stores, per-line tax must be derived | schema.prisma:3714-3880 |
| Sale return | `SalesReturn`/`SalesReturnItem` (requires original `invoiceId` + `invoiceItemId`) | Fits: GATI `OriginalSaleId` resolves 153/153 | schema.prisma:4133 |
| Approval / memo | `MemoOut`/`MemoItem` (needs `returnDeadline`) | Fits; deadline has no source | schema.prisma:2832-2893 |
| Purchase return | `PurchaseReturn` | Only for **GRN-sourced tags** (per CLAUDE.md D3 and `createPurchaseReturn`); GATI tags have no GRN | schema.prisma:1208 |
| Party | `Client`, `Supplier` | Good; no source key; `Client.currentBalance` / `Supplier.currentDue` are single net numbers | schema.prisma:2351, 1121 |
| Ledger | `Account`, `JournalEntry` (multi-line, `referenceType/Id` free text), `JournalLine` | Fits a *grouped* GATI journal; `Account.balance` is mutated by `postJournalEntry` | finance.service.ts:27-128 |
| Retag | `TagRetag` (old/new tag, `@@unique` both) | Possible home for the 278 `I` hops | schema.prisma:4942 |
| Tag history | `TagHistory`, **trigger-only** (`tag_history_capture`), append-only | Cannot hold GATI history (§G3) | schema.prisma:4808; migration 20261004120000 |
| Isolation | RLS, composite FKs, `tenantTransaction`, `assertOwnedByCompany` | Reusable; any loader must run in tenant context | CLAUDE.md §11 |

## 3. Existing source-id / idempotency mechanisms — **none usable**

- [C] No column named or meaning source system, external id, legacy id, import batch or migrated-from exists on any model (grep of schema.prisma: the only "legacy" hits are unrelated comments about legacy GST registrations / null rows).
- [C] Existing idempotency is **per-feature**, not generic: `JewelryTag.grnItemId @unique`, `CustomerAdvanceApplication` idempotency migration, `EInvoiceRecord.idempotencyKey`, unique `(companyId, <number>)` constraints on every document. None of them is a source-key guard, and the number uniqueness actively **blocks** replays that try to reuse a number.
- [C] The only bulk helpers in `server/scripts/` are provisioning, permission backfills and backup/restore. There is no ETL, CSV import or opening-balance loader in `server/src` (a grep of `server/src` for opening balance / bulk import / csv import found no importer; I listed `server/scripts/` by filename and did not open every script).

**G1 — source identity (needs a schema change).** Every migrated row needs a durable `(sourceSystem, sourceTable, sourceKey)` so reruns are idempotent and reconciliation can join both sides. Prefer one **side table** (`migration_source_map`: companyId, entity, targetId, sourceSystem, sourceDb, sourceTable, sourceKey, batchId, importedAt; unique on `(companyId, sourceSystem, sourceDb, sourceTable, sourceKey)`) over adding columns to 15 models, so no existing service or RLS contract changes. Must carry `companyId`, RLS and a composite FK like every tenant table (CLAUDE.md §11).

## 4. Where TRIVO and GATI genuinely differ (design mismatches)

1. **Tag identity.** GATI: 35,384 physical pieces behind 59,839 rows (clone per branch hop). TRIVO: one row per piece, mutated in place. Importing 59,839 rows as tags would **count every transferred piece 1–11 times** and put `V` and `I` rows into stock reports. Import **one tag per `JewelCode`** from the chain tip (D14).
2. **Transfer mechanics.** TRIVO `createTransfer` flips `IN_STOCK→TRANSFERRED` immediately and keeps the **source** `branchId` until `receiveTransfer` sets the destination (tagging.service.ts:1442, 1518). GATI keeps `V` on the source row and creates the destination row only at receipt. They agree on the in-transit state only if the 212 are deliberately imported as `TRANSFERRED` + a `DISPATCHED` transfer with item `receivedAt = null` (D15).
3. **No transfer journal in TRIVO; ₹3.3 B of inter-branch journals in GATI** (BJWSL 783 rows, BJWPH 741). Importing them yields inter-branch balances TRIVO would never produce itself (D18).
4. **Deletes.** GATI deletes documents physically; nothing is "cancelled". TRIVO voids (`VOID`). So no imported document ever needs a void/cancelled state, and the 147k-row `Delete_Log` has nothing to map onto.
5. **HO is NULL in GATI, a row in TRIVO** (D13).
6. **GST.** GATI stores GST as document-level add/less lines; TRIVO stores it per line (`InvoiceItem.cgstAmount` etc.). Per-line tax must be **allocated**, and the allocation must sum back to GATI's document totals exactly (D20).

## 5. Why replaying history through TRIVO's services does not work

Verified in `sales.service.ts` unless noted. `createInvoice` (l.286):
- generates the number itself: `nextDocumentNumber(... 'INV' ..., gstFinancialYear(invoiceDate))` (l.353) → `INV-2025-000001`. The printed/filed GATI number (`JewelTransPrefix`+`JewelTransNo`) cannot be supplied (**G5**).
- re-prices (`priceInvoice`, l.314/629) from live rates and tagged MC/VA; an imported invoice must keep GATI's totals to the paisa (also `shared/pricingEngine.ts`, offers, discount-approval gate `settleApprovals` l.560).
- refuses if the tag is not `IN_STOCK` (l.423) — a historical sold tag is `SOLD`, so a chronological replay would have to create the tag, sell it, and later transfer/return it in exact order, including for tags that went through four branches.
- applies *today's* business rules to old data: `assertClientActive` (l.369), `checkCreditLimit` (l.386), `assertPanIfRequired` (l.394), `assertCashLimit` (l.1525); any one of them can reject a legitimate 2025 sale.
- posts its own journal (`postAutoJournalEntry`, l.542) and increments `Client.currentBalance` (l.565): replaying while also importing GATI journals/balances **double-posts**; replaying instead of importing them yields TRIVO's chart and amounts, not GATI's.
- writes `createdAt = now()` (no parameter); `TagHistory` stamps import time (trigger), and audit entries are stamped with the importer (G4).

`createTag` (tagging.service.ts:540): always generates `tagNumber` via `nextTagNumber` (l.654), so the physical barcode `JewelCode` is lost (**G2**); status defaults to `IN_STOCK`; `createdAt` is now. `createSalesReturn`, `applyPayment`, `createPurchaseReturn`, `receiveTransfer` have the same shape (own numbers, own journals, own balance mutation). **Conclusion: services are for live trading; history needs a separate loader (G8/D17).**

## 6. Gaps (each needs an approved change; none implemented)

| # | Gap | Evidence | Needed | Risk if ignored |
|---|---|---|---|---|
| G1 | No source id / idempotency / batch | §3 | Side table + batch table (migration, RLS, composite FK) | Reruns duplicate; reconciliation impossible |
| G2 | Tag number cannot be supplied | tagging.service.ts:654 | Loader sets `tagNumber = JewelCode`; reserve/adjust `TAG:` sequences so new tags cannot collide | Physical barcodes stop matching the system |
| G3 | No loadable movement history | `TagHistory` is trigger-only, "UPDATE/DELETE revoked" | New append-only `tag_movement_history` (import + future) **or** a documented trigger exception; decision on what to keep (hops, dates, documents, branches) | Chain history (the evidence for location) is lost the day GATI is retired |
| G4 | Actor / timestamp fidelity | `createdAt @default(now())`, trigger stamps now; `createAuditEntry` requires a member user | One import user per batch; keep GATI `EntryBy/EntryDate` in the history table (G3), not in `createdAt` | History shows everything created on import day by one person |
| G5 | Document numbers | numberSequence.ts:87 | Loader writes GATI numbers verbatim; sequences advanced past them; unique `(companyId, number)` collision check up front (a GATI `BT/S001/26-27/0034` style number is not a TRIVO format) | Invoices already reported to GST get new numbers |
| G6 | Purchase return for non-GRN tags | `PurchaseReturn` is GRN-linked | Decide: import 117 documents as history-only, or relax | 513 tags stay sold-looking |
| G7 | No GST credit note on `createSalesReturn` (known I3 gap, CLAUDE.md) | CLAUDE.md I3 | Historical returns import their GATI GST effect directly; I3 is separate | Returns understate GST reversal |
| G8 | No historical journal / opening-balance loader | finance.service.ts:98 only auto-posts | Reviewed loader that writes `JournalEntry/JournalLine` + `Account.balance` + `Client.currentBalance` + `Supplier.currentDue` consistently, **without** calling postAutoJournalEntry | Double-posting or balances that don't tie |
| G9 | GST period status for past periods | `assertGstr3bPeriodMutable` blocks only when a `FILED/LOCKED` row exists; a fresh company has none | Decide how historical periods are represented (see §7) | Past GSTR-1/3B regenerate from imported data and silently disagree with what was filed |
| G10 | Branch GST registration | `Branch.gstRegistrationId`, `resolveSellerRegistration` (sales.service.ts:938) | Create registrations before documents; verify which branch used which GSTIN | Wrong seller GSTIN on 8,180 invoices |
| G11 | Rollback | no batch id on any row | G1 batch table + per-batch delete ordering; **rollback of an import must remain possible only before go-live** (post-live rows depend on imported tags) | No safe undo |
| G12 | Users | `salesPersonId` and `createdById` are `User` FKs (global identity) | Map 190 sales-persons and GATI users to TRIVO users or snapshot text | Sales-person reports blank |

## 7. GST period locks and backdating

- [C] `assertGstr3bPeriodMutable(tx, companyId, {gstRegistrationId, documentDate, ...})` throws `GSTR3B_FILED_PERIOD_IMMUTABLE` only if a `GstReturnPeriod` row for that company + registration + `GSTR3B` + month is `FILED`/`LOCKED`; with no row it passes (gstr3bFilingProtection.ts:147-165). It is called from `createInvoice` (l.467), `amendInvoice`, `voidInvoice`, `createSalesReturn` (l.1978), `convertMemoToInvoice`, GRN intake (tagging.service.ts:1028), credit/debit notes, purchase lots.
- **Today there is nothing to block a backdated import**, and nothing that records that Nov-2025 to Sep-2026 were already filed from GATI. So after import TRIVO's GSTR-1/3B reports would *recompute* those months from imported documents. If TRIVO's computation differs from what was filed, the owner sees a "filing" they never made.
- Options (D20): (a) import as history and mark each historical period `FILED` through a controlled one-time path (no snapshot, no GSTN submission) so TRIVO treats them as closed; (b) import and leave periods open with a banner; (c) import only from the first open period. (a) needs a new, approved, audited operation — the existing `fileGstr3bReturnPeriod` demands a snapshot and attempt.
- [U] Whether GSTR-2B/e-invoice (IRN) history exists in GATI is not investigated (`EInvoiceDetail`, `SALEEWAYBILL` tables exist). TRIVO `voidInvoice` refuses a bill with an IRN; imported invoices with IRNs must not be editable.

## 8. Items that need an approved change before any import code exists

1. Migration: `migration_batches`, `migration_source_map` (G1), `tag_movement_history` (G3). Each with `companyId`, RLS, `FORCE ROW LEVEL SECURITY`, composite FK, `db-secure.sql` grants, schema-guard registration (CLAUDE.md §11) and RLS tests.
2. A historical loader (new module, no change to sales/tagging services) honoring: tenant wrappers only, `assertOwnedByCompany` on every id it resolves, transactional batches, count checks, idempotent by G1, no `postAutoJournalEntry`, no balance mutation except by explicit set. Needs the production-RLS posture decision: run as `trivo_runtime` through `tenantTransaction` (safe, slower) — never `platformPrisma`/BYPASSRLS unless the owner approves that exact exception.
3. A one-off, audited "mark historical GST period filed" operation (D20).
4. Number-sequence advance past imported numbers (G5), and branch/GST registration setup (G10) — configuration, not code.
5. Optional: relax `PurchaseReturn` for non-GRN tags (G6) — only if D21 says to.

## 9. Not verified

- Live TRIVO database: contents, applied migrations, whether a Vasavi company exists, which DB is staging (D27). No connection was made.
- `npm run test:rls` / `audit:tenant` were **not** run (nothing changed).
- Whether `Account.balance` is used by any screen besides trial balance (trial balance itself recomputes from posted lines, finance.service.ts:130-156) — relevant to how G8 sets balances.
