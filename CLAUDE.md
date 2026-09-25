# CLAUDE.md — Jewellery ERP (pivoting to Wholesale + Retail)

> **Agent: read this file fully before writing any code, and follow it as the source of truth.**
> This describes an **existing, working system** and how we are extending it. It is NOT a greenfield build.
> Do not start over, do not scaffold a new project, do not delete existing modules. When a decision isn't
> covered here, ask before inventing one.

---

## 0. Situation

This repo (`p:\ERP`) is a **working jewellery ERP originally built for a manufacturing business** (~built
May 31, ~84 days old). It is a monorepo:

- `client/` — React 18 + TypeScript + MUI v5
- `server/` — Node / Express / TypeScript + Prisma
- Postgres + Redis + MinIO via `docker-compose.yml`
- 60+ Prisma models across 9 modules; 5 migrations applied (`init` -> `making_charges`)
- RBAC (35+ permissions, 6 roles), audit logging, RS232 scale + barcode/RFID integration

**The business is pivoting** from *manufacturing* to **wholesale + retail trading**: we buy finished
jewellery, hold it as stock, and sell it — over the counter (retail), to dealers (wholesale), and on
consignment (memo). **We are NOT manufacturing anymore.**

**Decision already made: REUSE AND EXTEND, do not rebuild.** The existing system's core is structurally
right for wholesale/retail. Manufacturing modules are cleanly separable and stay **dormant** (unused, not
deleted). We add two missing links to complete the buy->stock->sell loop.

---

## 1. What already works (do not rebuild these)

| Capability | Where | Status |
|---|---|---|
| **Physical item with status lifecycle** | `JewelryTag` (status: `IN_STOCK` / `ON_APPROVAL` / `TRANSFERRED` / `SOLD` / `RETIRED`; has `branchId`, `costPrice`, `sellingPrice`, `huid`, weights) | Solid. `jobCardId`/`designId` already optional — a tag needs no manufacturing lineage. |
| **Dealer consignment / memo flow** | `MemoOut` / `MemoItem` -> `convertMemoToInvoice` (`sales.service.ts`) | Fully working, tag-aware end to end: memo-out -> `ON_APPROVAL`, return -> `IN_STOCK`, convert -> `SOLD` + links `tagId`. **This is our wholesale/consignment flow. It already exists.** |
| **Billing + tax document** | `SalesInvoice`, `TaxInvoice` (`gstin`, `placeOfSupply`, `cgst`/`sgst`/`igst`/`cess`, e-invoice fields `irn`/`ackNumber`/`ewbNumber`) | Structurally sound foundation. |
| **Party master** | `Client` (typed, carries GSTIN), `Supplier` | Reuse. |
| **Procurement** | `PurchaseOrder`, `GoodsReceiptNote` (`procurement.service.ts`) | Reuse. Gap #1 (finished-goods intake) closed — see section 3. |
| **Branch + transfers** | `Branch`, `BranchTransfer` | Reuse. |
| **Finance** | `Account` / `JournalEntry` / `JournalLine` / `CostCenter` (double-entry) | Exists but currently **dormant** — not yet wired to sales (see §4.1, current objective). |
| **RBAC, audit, hardware** | across server | Channel-agnostic, reuse as-is. |

---

## 2. Manufacturing modules — leave DORMANT, do not touch

These are pure manufacturing and are cleanly separable. **Do not delete them, do not build on them, do not
wire new sell-side code into them.** They simply go unused.

- `JobCard` / `JobProcess` / `WipTracking` / `QcCheckpoint` (`manufacturing.service.ts`)
- `Artisan` / `KarigarLedger` / `ProcessTolerance` / `SubcontractorInvoice` (`outsourcing.service.ts`)
- `Design` / `BomItem` / `BomProcess` / `CostEstimate` (Module 1)
- `SalesOrder` / `OrderItem` — note: this is a **production order** (auto-reserves stock against BOM, feeds a
  JobCard). **It is NOT a retail/wholesale sale.** Do not use it for counter or dealer selling.

The only threads linking manufacturing to the sell-side are two **optional** FKs (`JewelryTag.jobCardId`,
`JewelryTag.designId`) and one mandatory one we will loosen (`HallmarkingItem.jobCardId`). Nothing in
tagging, the memo sales path, or finance depends on manufacturing logic.

---

## 3. The pivot: two missing links (the whole objective)

The buy->stock->sell loop had two gaps. Closing them = the business runs on retail + wholesale. Both were
**extensions of patterns already in the codebase**, not new architecture. **Both are now DONE.**

```
  [GAP #1: intake]  DONE                              [GAP #2: retail sale]  DONE
        |                                                     |
 buy finished piece --> JewelryTag (IN_STOCK) --+-- retail direct invoice --> SOLD
   (PO / GRN)            cost, huid, branch      |   (createInvoice, tag-aware)
                                                 +-- wholesale via memo --> SOLD   (already works)
```

**Gap #1 — Finished-goods intake. DONE.**
Migration `20260823172545_add_finished_goods_intake` (adds `GoodsReceiptNote.branchId`,
`JewelryTag.grnItemId` unique). New function `tagging.service.ts: createTagFromGrnItem()` — a
`FINISHED_GOODS` PO/GRN line (one line = one piece, via the `FINISHED_GOODS_MATERIAL_TYPE` constant in
`shared/constants.ts`) now auto-creates a `JewelryTag` at `IN_STOCK`, carrying `costPrice` (= PO line
`totalAmount`), `grossWeight` (defaults to `GrnItem.acceptedWeight`), `netWeight` (= gross - stoneWeight),
and `grnItemId` linking back to the GRN item. Double-tagging guarded by a unique constraint +
count-checked transaction. Tests: `tagging.service.test.ts` (5 tests, incl. a concurrency race test).

**Gap #2 — Tag-aware direct invoicing. DONE.**
Migration `20260823173718_tag_aware_invoice_items` (adds `InvoiceItem.tagId`, nullable + unique).
`createInvoice()` now mirrors `convertMemoToInvoice()`'s validate -> flip -> link pattern, with one
deliberate divergence: the flip is a count-checked conditional `updateMany` (`WHERE status = 'IN_STOCK'`),
not a blind one, because a direct sale has no prior reservation step to lean on (see "Known follow-ups"
below). `tagId` is optional per line — tagged and free-text lines coexist in the same invoice. Tests:
`sales.service.test.ts` (6 tests, incl. all-or-nothing rollback and a concurrency race test).

---

## 4. Secondary fixes (after the two links, in this order)

1. **Wire finance into sales.** `createInvoice()` currently increments `client.currentBalance` directly and
   posts **no `JournalEntry`**. Make it post a proper double-entry journal. (Latent bookkeeping correctness
   issue regardless of channel — fix while you're in the sales code.)
2. **Loosen `HallmarkingItem.jobCardId` to optional** (or add a `tagId` alternative) so purchased finished
   goods can be hallmarked, not just manufactured ones.
3. **GST by HSN, per line.** Today the rate is hardcoded (`taxRate = currency === 'INR' ? 0.03 : 0`), computed
   once at invoice level, with a thin same-state check against `COMPANY_STATE_CODE`. Move the rate into an
   **HSN/category rate table**, add per-line HSN/rate on `InvoiceItem`, and make place-of-supply
   branch-state aware. Livable at 3% short-term; required before any mixed-rate cart.

---

## 5. Retail vs wholesale — how they map onto THIS system

Same inventory (`JewelryTag`), same billing (`SalesInvoice`/`TaxInvoice`), same party table (`Client`).
They differ only by path and customer:

| | Retail (walk-in) | Wholesale (dealer) |
|---|---|---|
| Customer | `Client`, lightweight (name + mobile) | `Client` with GSTIN, code, terms |
| Sell path | **Direct** `createInvoice` (Gap #2) | **Memo** `MemoOut -> convertMemoToInvoice` (done), or direct invoice |
| Pricing | MRP / retail | Dealer / volume |
| GST | Usually B2C | B2B, registered |
| Payment | Immediate | May be on credit |

There is **no separate wholesale module to build.** Wholesale = memo path (done) + dealer-typed `Client` +
dealer pricing.

---

## 6. Hard rules for the agent

- Reuse and extend. Everything in section 1 stays. Build only the two links in section 3 and the fixes in section 4.
- When adding tag-aware selling, **copy the `convertMemoToInvoice` pattern** — same status flips, same
  linkage. Consistency with the working memo path matters more than cleverness.
- Every stock change goes **through a service that flips `JewelryTag.status` and is transactional**
  (validate -> flip -> link, all-or-nothing). A half-finished sale must be impossible.
- Each change behind its **own Prisma migration**, with a **test** proving the status transition + linkage
  (and, for sales, the journal entry). Stop after each step for review.
- Keep `costPrice` on the tag immutable by sales; selling writes price to the invoice line, never back to
  the tag's cost.
- **Do NOT rebuild, re-scaffold, or start a fresh project.** This is a working codebase.
- **Do NOT delete or modify the manufacturing modules** in section 2, and do not wire new sell-side code into
  `JobCard`, `SalesOrder`, `Design`, `BOM`, `Karigar`, or outsourcing.
- **Do NOT use `SalesOrder` for retail/wholesale selling** — it's a production order.
- Never `DELETE` a tag, invoice, memo, or their history — status-change + new records only.
- Never hardcode a GST rate once section 4.3 is done.
- Do not add manufacturing, CAD/BOM, export, courier, or loyalty features unless explicitly asked.

---

## 7. Current objective

Gaps #1 and #2 (section 3) are **DONE**. ROADMAP.md's **Phase A — fix the sell-side foundation** is now
**DONE** too:

1. **A1 — GST-zero bug. DONE.** `currency` is now resolved once (`data.currency ?? 'INR'`) at the top of
   `createInvoice()` and reused for the tax-rate calc, the invoice row write, and the `TaxInvoice` gate,
   so the two divergent reads that caused an omitted `currency` to invoice as INR but tax as 0 can no
   longer disagree. Both `createInvoice()` and `convertMemoToInvoice()` now also refuse (throw) to emit a
   `TaxInvoice` on a taxable INR sale with `taxAmount <= 0`, as a belt-and-suspenders invariant.
2. **A2 — Price-mode ambiguity. DONE.** `createInvoice()` now branches per line on the existing
   `rateType` field (previously ignored): `'FIXED'` → `unitPrice = goldRate` directly (a flat, already-
   decided price, e.g. a tag's own `sellingPrice`); anything else (`'PER_GRAM'`, the default) → the
   original `netGoldWeight * goldRate + makingCharge + stoneValue`. No schema change — `rateType` already
   existed on both the input type and `InvoiceItem`, it just wasn't wired to the math.
3. **A3 — Memo path tag-link. DONE.** `convertMemoToInvoice()`'s line-item builder now sets
   `tagId: lineItem.tagId` on each created `InvoiceItem`, so the memo-conversion path is genuinely
   tag-linked end to end (previously only the separate `jewelryTag.updateMany` flip left any trace — the
   `InvoiceItem` row itself carried no `tagId`).

All three covered by tests in `sales.service.test.ts` (currency-omitted vs explicit-INR parity, non-INR
zero-tax with no `TaxInvoice`, `FIXED`-rate pricing incl. a zero-`netGoldWeight` case, `PER_GRAM`
regression, and the memo-path `tagId` link).

**Phase B is in progress** (B1, B2 done; B3, B4 remain):

4. **B1 — HSN + GST rate master. DONE.** New `HsnCode` table (seeded with 7113/3%, the prior
   hardcoded rate). `InvoiceItem` carries `hsnCodeId` + a `taxRate` snapshot copied at sale time —
   like `costPrice` on `JewelryTag`, a later HSN-rate change must not silently reprice a past
   invoice. Each line optionally specifies `hsnCode` (defaults to 7113 when omitted); `createInvoice`
   sums per-line tax, scaled proportionally by any invoice-level discount, reducing to the exact old
   flat formula when every line shares one rate. `convertMemoToInvoice` stamps the default HSN on
   its lines too (still single-rate on that path).
5. **B2 — Place-of-supply fix. DONE.** `Client.state` (free text, e.g. `"Gujarat"`) vs
   `COMPANY_STATE_CODE` (numeric, e.g. `"24"`) never matched, so every sale priced as inter-state
   IGST regardless of the client's real state. New `StateMaster` table (all 36 GST state/UT codes +
   common aliases) and `resolveStateCode()` (`server/src/shared/stateMaster.ts`) resolve the free
   text before comparing. No confident match (blank/unrecognized — the common case for a
   lightweight walk-in retail `Client`) still falls back to inter-state, matching prior behavior.
   `TaxInvoice.placeOfSupply` now stores the resolved code when found. Deliberately stays
   single company-wide `COMPANY_STATE_CODE`, not per-branch — `SalesInvoice` has no `branchId` and
   this codebase uses one GSTIN; branch/multi-GSTIN awareness is a later decision if it's ever needed.

Both covered by tests in `sales.service.test.ts` (default/mixed/unknown HSN cases; same-state by
canonical name and by alias, different-state, and unresolved-state place-of-supply cases).

**Phase B is now fully done** (B1–B4). B3 added a printable A4 tax invoice; B4 added a standalone
counter stock/price lookup screen (`StockLookupPage.tsx`, `/tagging/lookup`) outside the billing
flow — read-only, searches a tag across every status (not just `IN_STOCK`) so an already-sold or
on-approval piece still shows a clear answer, and deliberately omits `costPrice` and any
edit/retire action.

**Phase C — Daily pricing is also fully done** (C1 karat/purity master, C2 daily-rate auto-price,
C3 making-charge/wastage wiring, C4 stone valuation via `PriceMaster` — see ROADMAP.md for the
full writeup of each). Along the way, `createTag`'s materials table in `NewTagPage.tsx` also
picked up a metal-rate auto-fill for a METAL row's Cost Rate, which had no route to today's rate
at all before (see ROADMAP.md's C3 entry).

**Phase D — Returns & exchange is now fully done (D1–D4).** D1–D3: new `SalesReturn`/
`SalesReturnItem`/`PurchaseReturn`/`PurchaseReturnItem` models; `createSalesReturn()` reuses the
same tag (flips `SOLD` → `IN_STOCK`) and never mutates the original `SalesInvoice`/`InvoiceItem`
(or `MemoOut`, for a memo-converted sale — D2 needed zero new code, proven channel-agnostic by a
new test, not assumed); `createPurchaseReturn()` mirrors it on the buy side (`RETIRED`, GRN-sourced
tags only), deliberately not touching `Supplier.currentDue` (*superseded by Phase I2 — it is now a live payable*) since procurement never wired that as
a live balance to begin with. `InvoiceItem.tagId` relaxed from `@unique` to a plain indexed FK
since a returned tag must be resellable. D4 (old gold exchange): new `OldGoldExchange` model —
values a piece via C1/C2's karat/rate infra, credits `Client.currentBalance` as a standing store
credit (not tied to a specific invoice — "redeemable later" falls out of the existing balance
mechanism for free), and also adds the melted weight to the Metal Vault (`MetalStock`) via
`addMetalStock()`, which gained an optional transaction-client param so that write can't orphan
if the rest of the exchange fails. See ROADMAP.md's D1–D4 entries for the full writeup of each.

**Phase E — Branch operations is now fully done (E1–E3).** E1 turned out to already be fully
built — ROADMAP.md's "flow not built" note was stale, corrected after verifying the actual
`tagging.service.ts` code (full `createTransfer → submitTransfer → approveTransfer →
receiveTransfer` lifecycle, guarded and transactional). E2 (inter-branch stock visibility) needed
no schema change — pure `groupBy` aggregation. E3 (stock audit): new `StockAudit`/`StockAuditItem`
models, one branch per audit, report-only (closing an audit never mutates a tag's status/branch —
a finding is a fact for a person to act on later, not an automatic side effect). See ROADMAP.md's
E1–E3 entries for the full writeup of each.

**Phase F is underway — F1 (wire sales → double-entry ledger) is done, done wider than section 4.1's
original one-line scope.** Every money-moving action — `createInvoice`, `applyPayment`/
`recordPayment`, `createSalesReturn`, `createOldGoldExchange`, and (buy-side) `createTagFromGrnItem`/
`createPurchaseReturn` — now posts a balanced `JournalEntry` via new `finance.service.ts:
postAutoJournalEntry(tx, ...)`, not just a `client.currentBalance` bump. Went beyond "sales" on
purpose: without the buy-side intake entry (Dr Inventory / Cr Accounts Payable on
`createTagFromGrnItem`), Inventory would only ever be credited at sale and never debited at
intake — a correct-looking sales ledger sitting on a meaningless Inventory balance. Account-code
lookups go through new `shared/ledgerAccounts.ts: LEDGER_ACCOUNT`; a new migration
(`20260825130000_seed_ledger_accounts`) seeds the 10 specific accounts these entries depend on
directly, same "seed it in a migration" precedent as `DEFAULT_HSN_CODE`/`KaratMaster`, since the
test DB never runs `prisma/seed.ts`'s full `seedChartOfAccounts()`. See ROADMAP.md's F1 entry for
the full per-function writeup and test coverage.

**F2 (standalone payments/receipts) is also done.** `InvoicePayment.invoiceId` is now optional and
a `clientId` column lives directly on every row (backfilled for existing rows), so a payment can
be recorded against a client with no invoice yet — an advance, or a payment against their general
outstanding balance. New `recordClientPayment()`/`listClientPayments()` in `sales.service.ts`,
`POST/GET /sales/clients/:clientId/payments`, and a "Record Payment" action on the Clients page.
Reuses `applyPayment`'s exact ledger entry (F1) and PMT- numbering — see ROADMAP.md's F2 entry.

**Also fixed in this pass — an unrelated but real RBAC gap, found while testing:** no seeded role
except `SUPER_ADMIN` (`'*'`) ever had `masters:view`, so every `/masters/*` GET (karats, HSN,
categories, stone types, price master, making charges) 403'd for every other role — every
karat/category/stone-type dropdown fed by that router was silently empty for anyone not logged in
as the admin account. Root cause was two-fold: `masters:view` was simply missing from the
operational roles' permission lists in `prisma/seed.ts`, *and* every role's `upsert` used
`update: {}` — a no-op on conflict — so even fixing the list in source would never have reached an
already-seeded database on a re-run. Fixed both: added `masters:view` to `SALES_MANAGER`,
`STORE_MANAGER`, `PRODUCTION_MANAGER`, `ACCOUNTANT`, and changed every role's `update` to mirror
its `create` so a re-seed now actually syncs permission changes going forward. Re-ran the seed
against the dev DB and verified `/masters/karats` returns 200 for the `manager@sea-erp.com`
(`PRODUCTION_MANAGER`) account. **A user already logged in when this ran needs to log out and back
in** — their cached JWT still carries the old (pre-fix) permission list baked in at login time;
a plain 403 doesn't trigger the client's silent-refresh-on-401 flow the way an expired token would.

**F3 (dealer outstanding / credit tracking) is also done.** `checkCreditLimit()` in
`sales.service.ts` blocks a sale (direct or memo-converted) that would push a client's
`currentBalance` past their own `Client.creditLimit` — checked before any tag is touched, no
schema change, no limit set means unlimited (unchanged default). New `getDealerAging()` in
`finance.service.ts` + `GET /finance/reports/dealer-aging` + `DealerAging.tsx` page (Finance nav
group) age every outstanding balance into 0–30/31–60/61–90/90+ day buckets and flag anyone
currently over their limit. See ROADMAP.md's F3 entry.

**F4 (per-party customer/dealer ledger) is also done.** New `getClientLedger()` in
`finance.service.ts` merges the exactly-four tables that ever move `Client.currentBalance` —
`SalesInvoice` (debit), `InvoicePayment` (credit, both invoice-scoped and F2's standalone
on-account rows), `SalesReturn` (credit), `OldGoldExchange` (credit) — into one chronological,
running-balance statement, computed from full history first so a `from`-cutoff `openingBalance`
is correct even when the display range is narrower. No schema change — pure read-side
aggregation, same shape as E2/F3. `GET /finance/reports/client-ledger/:clientId` (`report:view`,
optional `from`/`to`); new `ClientLedger.tsx` page (Finance nav group) with a client picker,
date-range filter, and a "Statement" deep-link from the Clients page. See ROADMAP.md's F4 entry
for the full writeup and test coverage.

**Phase G — Repairs & hallmarking is now fully done (G1–G2).** G1 extended the existing
manufacturing-era `RepairJob`/`RepairTransaction` system rather than rebuilding it: optional
`clientId`/`tagId` link a customer's repair to a real party and piece (the old free-text
`clientName`/`originalJobCardId` stay for the QC-failure/rework flow); `receivedDate`/
`deliveredDate` give explicit in/out tracking; new `billRepairJob()` charges the customer by
reusing `createInvoice()` verbatim (one free-text `FIXED`-rate line, no tag on the invoice line),
gated idempotent by a new unique `RepairJob.invoiceId`. This surfaced a real RBAC gap —
`PRODUCTION_MANAGER` (the only role with `repair:manage`) had no `invoice:create`, so nobody
could reach the new billing endpoint — fixed in `seed.ts` and re-seeded (same "a logged-in user
needs to log out and back in" caveat as the earlier `masters:view` fix). G2 loosened
`HallmarkingItem.jobCardId` to optional and added a `tagId` alternative (CLAUDE.md §4.2, now
resolved) so a purchased finished-goods piece can be hallmarked without any JobCard. See
ROADMAP.md's G1–G2 entries for the full writeup and test coverage.

**Phase H — Management reports is now fully done.** Two of its seven original bullets turned out
to already be satisfied by earlier phases (Dealer ledger/outstanding → F3+F4; Profit/margin → the
existing P&L Statement from F1) — no new work there. The five genuinely new reports are all pure
read-side aggregation, no schema changes, same shape as E2/F3/F4: `getSalesRegister()` (sales
module — retail+wholesale together, date+salesperson filters), `getStockOnHand()` and
`getDeadStock()` (tagging module — `IN_STOCK` sliced by branch×category, and bucketed by days
since `updatedAt` respectively), `getDayBook()` and `getGstSummary()` (finance module — one day's
company-wide rollup, and an HSN-wise GST prep summary explicitly flagged as prep-not-filing-ready
in the UI). A new shared `exportToCsv.ts` gives every report page an Excel-opening CSV export
without adding an `xlsx` dependency. See ROADMAP.md's Phase H entry for the full per-report
writeup and test coverage.

**Also done (2026-09-02) — C3 refined so Making Charge/VA varies by karat, not just category.**
`MakingCharge` gained a `karat` column (same free-string convention as `JewelryTag.metalKarat`),
matched most-specific-wins alongside category + makeType — e.g. 22K necklaces can now carry a
different VA% than 18K bangles, which category alone couldn't express. `MaterialCode` also gained
a `karat` column so `NewTagPage.tsx`'s Materials tab can auto-derive a tag's overall `metalKarat`
from whichever METAL row carries the most weight (still manually overridable). See ROADMAP.md's
Phase C entry ("C3-refresh") for the full writeup and test coverage.

**Phase I — Store-operations gap pass (2026-09-25).** Walking the retail loop against the *code* found the docs had run ahead of it.
Done, each with its own migration/tests (full write-up in ROADMAP.md's Phase I): **I1** finished-goods inward now works on screen — the
GRN page has the receiving branch, a per-line **Tag** action and label print (Gap #1's `createTagFromGrnItem` had been API-only, `API.md`
wrongly said a GRN auto-creates the tag, and the PO/GRN routes 500'd on JSON dates until `shared/parseDate.ts`). **I2** purchase GST
(input tax credit, accounts 1401–1403, exact reversal on a purchase return, ITC report) and **supplier payments** — and
`Supplier.currentDue` is now a *live payable* (this supersedes the older "never wired" notes on D3/F1 below). **I4** PAN (Rule 114B,
above ₹2,00,000) and the Sec 269ST cash ceiling (₹2,00,000 per client per day), enforced in `shared/compliance.ts` inside the sale's
transaction; the client create/update endpoints now whitelist their fields. **I5** estimate → invoice: an estimator sends a quote to
billing, the biller finds it by number / item / customer name, is asked for the sales person, can re-price or add/delete its rows, and
the estimate is marked INVOICED exactly once (`createInvoice({ estimateIds })`); this also fixed the New Sale screen never sending its
required `branchId`. **I3 (GST credit note on a sales return) is NOT started** — no go-ahead was given; `createSalesReturn` still books
no GST reversal. TCS on cash jewellery sales is not implemented (confirm with a CA). Verified: the full suite on `sea_erp_test` and on the
real role-split `trivo_rlstest` (`npm run test:rls`), and the data steps of the new migrations were exercised as `trivo_owner` under
FORCE RLS. **A migration that touches tenant rows must lift FORCE RLS around its statement** (see 20260925090000 / 100000) — once
`db-secure.sql` has run, even the owner running `migrate deploy` is filtered by the policy and would insert/update nothing (or fail).

**I6 — purchase lots (bags), 2026-09-25.** A supplier invoice that bills finished pieces *as a bag* is entered as one PO line of
Type `FINISHED_LOT` (`FINISHED_LOT_MATERIAL_TYPE`: gross weight, ONE amount, and a grid of category rows — category, karat, gross/stone/net,
optional piece count — `PoItemCategory`). Receiving it on a GRN opens a `PurchaseLot` and
books the whole bill *then* (Dr Inventory + input GST / Cr Payable; `Supplier.currentDue`); the pieces are then tagged one at a time from New
Tag with the lot chosen (`createTag({ purchaseLotId })`, `shared/purchaseLot.ts`), the piece must be in a category the bag holds and within that row's weight/count — no journal at tagging. Cost rates (metal ₹/g, MC ₹/g, VA %)
are entered ONCE per category row on the PO and pre-filled on each tag's Materials / MC & VA tabs (editable per tag); the tag's `costPrice` is
what those build, falling back to its share of the bag's remaining cost by net weight when nothing is entered. The bag reports the gap to the
invoice as `costVariance` — the ledger keeps the invoice amount, so a gap stays in Inventory until adjusted (nothing is auto-posted). The tag
screens pre-select the PO's supplier as Manufacturer (`manufacturerForSupplier`: a Client, found or created once). Tagged totals are live sums
over its tags, never counters; closing a lot is report-only. Migrations `20260925130000_purchase_lots`, `20260925140000_lot_categories`,
`20260925150000_lot_category_cost_rates`; tests `purchaseLot.test.ts`. See ROADMAP.md's I6 entry.

**Next:** nothing left on the roadmap's A–H phase list — CLAUDE.md §4.2 (hallmarking optional FK)
was resolved by G2. Remaining open items are the two documented control gaps in §8
(`createInvoice()`'s optional `tagId` still allows an off-book untagged line; `convertMemoToInvoice()`'s
blind tag-flip `updateMany`) and whatever the user raises next — check in before assuming further
scope.

See `ROADMAP.md` for the full phase breakdown (C–H: pricing, returns/exchange, branches, finance/credit,
repairs, reports). See `API.md` for the full HTTP API reference, current module/feature-scope
status, and setup instructions. See `UI_DESIGN_GUIDE.md` before building or reworking any
frontend screen — keyboard-first field conventions, compact grid-based forms, table overflow
handling, and the `getValues()`-vs-`watch()` pitfall, all with reference implementations to copy.

---

## 8. Known follow-ups / control gaps

Two things were deferred deliberately while closing gaps #1/#2. Both are intentional tradeoffs, not bugs
— but both are things a future change could trip over, so they're recorded here rather than left implicit.

- **`createInvoice()` is not yet a hard inventory gate.** `InvoiceItem.tagId` is optional, so a line with
  no `tagId` still bypasses inventory entirely (no lookup, no status flip) — exactly like before gap #2.
  This was the explicit choice for v1 (see section 3, gap #2) to keep non-inventory lines — making-charge
  adjustments, gift-wrap fees, historical entries — legal. It means off-book sales through this endpoint
  are still possible; nothing currently forces every line to carry a tag. If that needs closing later,
  it's a policy change (e.g. require `tagId` for certain `invoiceType`s), not a schema change.
- **`convertMemoToInvoice()`'s tag flip is still a blind `updateMany`** (no `status` predicate, no count
  check) — unlike `createInvoice()`'s guarded version. It's safe *today* only because the memo lifecycle
  already serializes tag possession before this function runs: `createMemoOut()` requires `IN_STOCK` and
  immediately flips to `ON_APPROVAL`, so nothing else can be holding the tag by the time you convert. If
  the memo flow ever changes (e.g. a tag could reach `convertMemoToInvoice` without going through that
  reservation step first), this function would need the same count-checked guard `createInvoice()` has.

Two more were found during the master-data discovery pass (2026-08-23) and logged here as roadmap items —
**both closed by Phase C (2026-08-25):**

- ~~No metal-rate-driven pricing path.~~ **Closed by C1/C2/C3.** `KaratMaster` fixes the karat list;
  `shared/metalRate.ts: resolveMetalRate()` wires `MetalRate` into both `createTagFromGrnItem`
  (GRN-date rate) and `createInvoice` (invoice-date rate, PER_GRAM lines); `MakingCharge` is now
  read by `createInvoice` too. See ROADMAP.md Phase C for the full writeup.
- ~~Stone-pricing FK gap.~~ **Closed by C4.** Went with the additive option: nullable
  `JewelryTagMaterial.stoneTypeId` → `StoneType`, `materialCodeId` untouched. `createTag` resolves
  an unset stone-row `saleAmount` from `PriceMaster` by weight (`shared/priceMaster.ts:
  resolvePriceMaster()`). Not yet wired: a `stoneTypeId` picker in `NewTagPage.tsx`, and
  `createTagFromGrnItem` (no materials breakdown on that path).

---

## 9. Glossary (this codebase's real names)

- **`JewelryTag`** — the physical piece; the item-with-status. Our inventory unit.
- **`MemoOut` / `MemoItem`** — dealer consignment; our working wholesale/consignment flow.
- **`convertMemoToInvoice`** — the reference pattern for tag-aware selling (validate -> flip to `SOLD` -> link).
- **`SalesInvoice` / `TaxInvoice`** — billing + GST document.
- **`Client`** — customer or dealer (party). **`Supplier`** — vendor.
- **`PurchaseOrder` / `GoodsReceiptNote`** — procurement / intake.
- **`SalesOrder`** — a *production* order (manufacturing). **Not** a retail/wholesale sale.
- **Dormant modules** — manufacturing/outsourcing/design/BOM: present, unused, untouched.

---

## 10. Frontend UX convention: keyboard-first fields

This app is operated mostly by keyboard — billing counter and back-office data entry, fast repeated
transactions. Every dropdown/select field, wherever it's created or already exists in the client, must be
changeable **while focused, without first opening it**. Arrow keys (and type-ahead) must move the
selection on a focused-but-closed field, same as a native `<select>` — never require a click or
Enter/Space to open the menu before the value can change. Don't build or leave in place a custom picker
that traps keyboard users into a click-first flow.

When adding a new field (dropdown or otherwise) or touching an existing one, check it's reachable and
operable by keyboard from a plain focus state — tab to it, act on it, tab away — not just usable by mouse.

---

## 11. Company isolation (TRIVO is multi-company — nothing client-owned is shared)

**The rule:** every client-owned record must be unambiguously associated with exactly one company —
directly via `companyId`, or through a strictly company-owned parent. Only explicitly approved
platform records may exist outside a company: `Company`, `User` (global login identity),
`RoleTemplate`, `HsnCode`, `StateMaster` (statutory reference data, read-only to every company), and
`PlatformAuditLog` (TRIVO platform events — see phase 2 below). This is enforced by
`src/test/tenantIsolation.masters.test.ts` ("schema guard") — a new model with no `companyId` fails
CI unless it is added to that allow-list with a reason. Nothing a client can create or edit may be
visible to another client, including "insignificant" text (a collection name, a note, a filename).

**Status of the full-isolation plan** (phase order agreed with the user):
1. **Masters per company — DONE.** `DesignCategory`, `KaratMaster`, `ProductCategory`, `SubCategory`,
   `Collection`, `MaterialCode`, `StockType`, `StoneType`, `StoneGrade` all carry `companyId`, unique on
   `(companyId, code)`, with RLS. Migration `20260924020000_masters_tenant_scope` copies every old global
   row to every existing company and repoints tenant rows at their own company's copy (verified on a
   scratch DB with two companies). Every master id a request supplies (tag category/stock type/
   sub-category/collection/material code/stone grade, invoice-line category, design category, making
   charge, price master, stone grade/sub-category parents) is checked with
   `assertOwnedByCompany`/`assertOwnedIfPresent`/`assertAllOwned` (`middleware/tenant.ts`) — a wrong-
   company id is a 404. Masters router PATCHes use a field whitelist, never `req.body` as-is. A new
   company's starter masters (karats + design categories) come from `shared/starterMasters.ts:
   seedStarterMasters()` — **copy, never reference**. Also: `SystemConfig` is company-scoped
   (`20260924010000_system_config_tenant_scope`).
2. **Identity & membership — DONE.** `User` = global login identity only (email, password hash, name).
   `CompanyUser` = the person inside one company: `employeeId` (unique **per company**), `department`,
   `phone`, `username`, role, branch access, `lastLoginAt` (per company — `User.lastLogin` is platform-only
   and never returned to a company). Migration `20260924030000_phase2_identity_isolation` (one transaction;
   verified on a scratch DB) moves employee data onto the unambiguous membership and **aborts rather than
   guesses** if a multi-company user carries employee data or a branch grant already crosses companies.
   - `UserBranchAccess.companyId` + **composite FKs** `(companyUserId, companyId)` and `(branchId, companyId)`
     — the database itself refuses a grant linking one company's member to another's branch. Grants go through
     `company.service.ts` (`POST/DELETE /company/users/:id/branch-access`), which also verifies ownership.
   - `AuditLog.companyId` is NOT NULL. `createAuditEntry(...)` takes a **required** `companyId` and refuses (throws)
     if the acting user is not a member of that company. **Platform events** (operator actions; legacy rows that
     could not be attributed) use the separate `PlatformAuditLog` table via `createPlatformAuditEntry()` — it has
     no `companyId`, no company route reads it, and `production-rls-roles.sql` withholds it from the tenant role.
   - **No silent attach-by-email.** `createCompanyUser`/`POST /auth/users` are gone. A membership only comes from
     a `CompanyInvitation` the recipient accepts (`POST /auth/invitations/accept`, public): one-time token (only its
     SHA-256 is stored; returned once to the inviting admin — no email provider wired yet), 7-day expiry, single-use
     race-safe. New email → login created; existing login → must supply that login's password, then it is linked
     (global name/password untouched). Every failure is the same generic 400, and invite creation never consults
     the global User table, so nothing reveals whether an email has an account anywhere.
   - Auth: login is company-first (`companyCode` selects, membership + password authorise); a failed lookup still
     spends one bcrypt compare (no timing oracle); credential endpoints are rate-limited per route (the old
     app-level `/api/auth` limiter never matched `/api/v1/auth`). Removed unused `optionalAuth` (skipped the
     membership re-check) and the unused `auditLog()` middleware (wrote rows with no company).
   - Tests: `src/test/tenantIsolation.identity.test.ts` (52) — also covered by the schema guard in the masters suite.
   - **Known/accepted:** the password is on the global `User`, so one person in several companies has one
     password; a branch-access change only reaches an already-issued JWT at its next refresh/expiry.
3. **Company provisioning + Starter Package — DONE.** A new company is created by `provisionCompany()`
   (`modules/platform/provisioning.service.ts`), one transaction, steps `company → roles → branch → accounts →
   starterPackage → admin → verify → audit`; any failure (or a failed `verify`) rolls the whole company back —
   there is no half-provisioned company. Entry points: `npm run company:provision` (operator CLI) and
   `POST /platform/companies` (operator API, `x-trivo-platform-key`; disabled/404 unless
   `TRIVO_PLATFORM_API_KEY` is set). **Registration is operator-controlled** — there is no public sign-up.
   - **Starter Package** (`modules/platform/starterPackage/`) = a versioned, **code-defined**, validated
     definition (`v1.ts`): roles + permissions, chart of accounts, karats, design/product categories, stock types,
     stone types/grades, material codes, tag + estimate templates, and pricing/general config keys. It is
     **COPIED** into the new company by `applyStarterPackage()` — never referenced, never shared, never
     auto-propagated to existing companies (a later v2 only affects companies provisioned after it). The applied
     version is stored on `Company.starterPackageVersion`.
   - What it may NEVER contain (enforced by `validate.ts`, and by a test): another company's operational data;
     config keys matching `DEVICE|SCALE|PORT|KEY|TOKEN|SECRET|PASSWORD|URL|HOST|EMAIL|PHONE|ADDRESS|GSTIN|PAN|
     ACCOUNT_NO|IFSC|UPI|WEBHOOK|SMTP…` (a company's own identity/credentials are its own to enter). Uncertain
     ex-SEA data was classified **company-specific** (it stayed with SEA, it is not in the package).
   - Admin: a **new** email becomes an active member at once (operator-supplied password, or a generated one shown
     ONCE); an email that **already has a login** anywhere is never attached silently — it gets a one-time
     INVITATION instead (same rule as phase 2).
   - Platform events go to `PlatformAuditLog` (no companyId; no company route reads it).
   - The dev seed builds SEA **from the Starter Package**, then adds SEA-only demo data separately.
4. **Runtime isolation — DONE.** Nothing process-wide is shared between companies:
   - WebSocket: every room is `company:<companyId>:…` (`role:`/`user:`/`factory:floor` rooms are gone);
     `emit.*` requires a companyId; the socket's company comes from its verified JWT + a membership check;
     suspending a company disconnects its sockets (`disconnectCompany`).
   - Hardware: devices are company-owned `HardwareDevice` rows only; the env `SCALE_PORT`/`RFID_READER_PORT`
     fallback was removed; readings and events carry the company.
   - Redis: every key is `trivo:<companyId>:…` via `cache.forCompany(companyId)`.
   - Object storage: keys are `companies/<companyId>/…` (`shared/objectKey.ts`) and `design_files.filePath`
     has a DB CHECK for the prefix.
   - Refresh tokens carry the companyId; invitation tokens are `<companyId>.<secret>`; `authenticate` also
     requires the company to be active. Document numbers/sequences are per company.
5. **RLS enforced at the database — DONE.** Three DB identities (`prisma/production-rls-roles.sql`):
   `trivo_owner` (DDL: migrations + `db-secure.sql` only), `trivo_runtime` (the API; owns nothing, no BYPASSRLS,
   tables are `FORCE ROW LEVEL SECURITY`), `trivo_platform` (BYPASSRLS, DML only: provisioning, operator,
   platform audit). Every company query goes through `tenantQuery`/`tenantBatch`/`tenantTransaction`
   (`shared/tenantContext.ts`) which `set_config('app.tenant_company_id', …, true)` **inside the same
   transaction as the query** (no request-long transactions; no live Prisma client stored in AsyncLocalStorage).
   `runAsPlatform` is the only door to the BYPASSRLS client. The API **refuses to start** in production if
   `DATABASE_URL` is a superuser / table owner / BYPASSRLS role (`assertDatabaseRoleSafety`).
   - `npm run audit:tenant` (`tools/tenantAudit.ts`) fails CI on any bare company-model Prisma call.
   - After **every** deploy run `npm run db:secure` as the owner (re-applies grants, FORCE RLS, append-only
     `audit_logs`, platform-table restrictions).
   - Postgres omits key details from unique-violation errors on RLS tables — conflict handling resolves them with
     a company-scoped lookup, never by parsing `meta.target`.
   - Tests: the everyday suite runs on a single-role DB (RLS inert; `withForcedRls` simulates it). The
     **real** role split is `npm run test:rls` (DB `trivo_rlstest`, `TRIVO_TEST_ENV_FILE`) — run it before any
     release: it proves RLS with the real non-owner/non-bypass role. Fixtures use `platformPrisma as prisma`.
6. **Composite foreign keys — DONE (58 relations).** Foreign-key checks bypass RLS, so the high-risk relations
   are `("fkId","companyId") → parent("id","companyId")`: the database itself refuses a child pointing at another
   company's parent (tags→category/stock type/branch/manufacturer, invoices/memos→client/branch, members and
   invitations→role, POs→supplier, price/making-charge masters, …). Parents carry `@@unique([id, companyId])`.
   **Gotchas:** on a nested create under a composite relation do NOT pass `companyId` (Prisma fills it from the
   parent; it is invisible to tsc when spread); optional composite relations need `onDelete: Restrict` (a
   referenced master can't be deleted from under its rows). Plain FKs remain on dormant manufacturing
   internals (e.g. `designs.categoryId`) — those still rely on `assertOwnedByCompany`. Tests:
   `src/test/compositeFk.test.ts`.

**When you add code that takes a foreign id from a request** (a category, a client, a branch, ...):
verify it belongs to the caller's company before using it (`assertOwnedByCompany`) — and if the new column is
a high-risk reference, make its relation composite. Postgres FK checks do not consult RLS, so on a plain FK a
forged id passes the database.

**When you add a new company-owned model:** add `companyId` + an index, a `tenant_isolation` RLS policy and
`FORCE ROW LEVEL SECURITY` (see the latest migrations for the SQL), `@@unique([id, companyId])` if anything will
reference it, register it in `db-secure.sql` if it needs special grants, and access it only through the tenant
wrappers. The schema guard, `audit:tenant` and the RLS suite will fail until you do.

`prisma/rls-coverage-report.md` is a stale generated snapshot (predates system_configs and the nine
masters; its header also contains an unrendered `${entries.length}`) — regenerate before relying on it.

---

## 12. Production readiness (Phase 6) — what was verified, and what is still open

Verified on a staging stack that mirrors production topology (PostgreSQL 18 with TLS-only app roles and the three-role
split, API in `NODE_ENV=production`, the built SPA behind a same-origin proxy, real HTTP + WebSocket + a real browser).
Harness: `ops/staging/` (see its README). Runbook: `DEPLOY.md`. **"Tests pass" is not the bar** — the staging pass found
bugs the unit/integration suites could not, all fixed and regression-tested (see below).

**Data set:** two companies (VASAVI, SHREE SILVER PALACE), each ≈ 20,000 tags / 5,000 customers / 5,000 invoices
(+ payments, tax invoices, double-entry journals); SHREE was registered **after** VASAVI was heavy.

**Isolation (all against the real stack):** `ops/staging/isolation-http.js` — 200+ checks: every list/report/dashboard/
master/audit/template endpoint for a freshly registered company shows nothing of VASAVI; ~40 IDOR probes (GET/PATCH/PUT/
DELETE with the other company's ids → 404, other company's rows byte-identical afterwards); forged foreign keys and
spoofed `companyId` in body/query/header; identity/invitation non-disclosure; audit; WebSocket (two SUPER_ADMINs — the case
a shared role room would leak — real `memo:alert` over HTTP reaches only its own company); suspension cuts tokens *and*
live sockets; and **database-level RLS independent of every app filter** (all 80+ company tables: SELECT/UPDATE as the
other tenant → 0 rows, no tenant context → 0 rows, INSERT into another company rejected by policy; even the BYPASSRLS
platform role cannot point a row at another company's parent — composite FK).
Browser (`browser-acceptance.js`, Chromium, two isolated profiles + cross-tab): 140 checks — login/guard, 58 screens per
company with zero 5xx / console errors / other-company text, customer created through the UI, realtime frames, logout,
company switch in one tab, cross-tab logout/login, suspended company bounced.

**Backup/restore (real):** `scripts/backup.sh` (as `trivo_backup`) → `scripts/restore.sh` into a scratch DB: 88/88 tables
row-identical, 82 policies + 61 composite FKs intact, every journal balances, zero cross-company references, runtime role
sees exactly its own company per context, and an API booted on the restored DB logs VASAVI in.

**Performance baseline** (one dev machine running API + Postgres + load generator; no internet latency; Redis absent):
| | p50 | note |
|---|---|---|
| paged tag list / search / invoice list / journals | 10–30 ms | |
| trial balance / P&L / balance sheet / day-book / dashboard | 5–15 ms | |
| dealer aging (5k clients) | 61 ms | |
| GST summary, 1 year | ~270 ms | |
| sales register, 1 year (1.9 MB) | ~360 ms | unpaginated |
| dead-stock report (3.1 MB) | ~500 ms | unpaginated |
| `GET /orders/clients` (all 5k, 2.2 MB) | ~150 ms | unpaginated |
30 concurrent readers, both companies, mixed: 89 req/s, 0 errors, p95 ≈ 0.8 s. Writes: `POST /sales/invoices` (validate → tag
flip → journal → payment) ≈ 20 invoices/s **per company** (serialised on that company's document-number row; p95 ≈ 1.3 s at
10-way concurrency on ONE company) and two companies in parallel double the total — no cross-company contention. API
RSS ≈ 470 MB after the run; DB 80 MB, 99.99 % cache hit, no deadlocks. **Known scaling item:** the three unpaginated lists
above grow linearly — paginate before a company passes ~20k customers / ~50k invoices/year.

**Defects found only by this pass (all fixed, regression-tested — `src/test/http.contract.test.ts`):**
1. `POST /sales/invoices` with `payments[].paymentDate` (the UI's bill-and-collect) → 500: JSON dates were never coerced.
2. Missing / non-string ids reached Prisma as-is (500, and `{"not":""}` would have been read as a *filter*): new
   `middleware/inputGuard.ts` (id-named body fields must be strings, `…Ids` string lists, no nested query objects) +
   `assertOwnedByCompany` type-checks.
3. `tag.manufacturerId` had no app-level ownership check (only the composite FK, as a 500).
4. Behind nginx every client shared one rate-limit bucket (no `trust proxy`) — one company's failed logins could lock out
   another: new `TRUST_PROXY`, and `API_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` are configurable.
5. Browser: a logout→login as another company in one tab kept the **previous company's WebSocket** (module singleton) —
   now bound to the session (`client/src/api/socketRegistry.ts`), closed on logout/login/cross-tab change, and observable
   (the LIVE badge could not see a socket created after first render).
6. Browser: an expired/suspended session froze in the app shell — the refresh call's own 401 re-entered the interceptor and
   awaited itself; never settled, so `logout()` never ran.
7. `restore.sh`/`backup.sh` had never been run: libpq rejects Prisma URL params; FORCE-RLS breaks parallel restores and
   makes an *owner*-side row count read 0; `pg_dump` needs a BYPASSRLS read-only role → `trivo_backup`; restore now serial,
   `--exit-on-error`, verified as the backup role.
8. The production build shipped compiled tests (`tsconfig.build.json` now excludes them); nginx now blocks
   `/api/v1/platform` and sets the body limit; login/UI branding said "SEA".

**Still open (do not claim production-ready without these):**
- **No live Redis and no live MinIO/S3 in the verification environment.** Cache keys (`trivo:<companyId>:…`) and object keys
  (`companies/<companyId>/…`, DB CHECK on `design_files.filePath`) are verified at the builder/constraint level and by tests
  only; nothing in the app currently stores files in object storage. Re-run the isolation suite against a real Redis before
  enabling caching.
- `docker-compose.prod.yml`'s new `db-bootstrap` / `migrate` services are unexecuted (no Docker available here); the plain
  commands inside them were run.
- Printer: agent + per-company TSPL verified; a physical label was **not** printed (the TSC printer was offline).
- No email provider: invitation tokens are returned to the inviting admin (no self-service password reset by email).
- Registration is operator-only by design; a public sign-up would need e-mail verification + abuse controls first.
- No PITR (nightly logical backup only); no monitoring/alerting stack; no load test beyond one machine / 30 users.
- A person in several companies has one password (global `User`); stolen-JWT window = access-token lifetime (8 h default).
