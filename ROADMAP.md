# ROADMAP.md — Wholesale + Retail Jewellery ERP (Vasavi)

> Companion to CLAUDE.md. CLAUDE.md = how the agent works + current state.
> ROADMAP.md = the destination map: what we're building and in what order.
> Business confirmed to do: purchases, inward, retail + wholesale/memo sales, sale returns,
> purchase returns, exchange (old gold against new), repairs, dealer credit/outstanding,
> branch transfers, and reports (printed + Excel export) — including reports needed AT the
> point of sale, not just management reports.

---

## Legend
✅ Done · 🟡 Partial (exists, incomplete/buggy) · 🔴 Not built · 🧭 Design decision needed

---

## PHASE A — Fix the sell-side foundation ✅ DONE
Everything under Sales sits on `createInvoice`, which used to mis-price and mis-tax.
This phase was bug-fixes, not new features. **Exit criteria met**: one tag can be sold retail
and one via memo, each producing a correct price, correct CGST/SGST (in-state) tax, and a
tag-linked invoice line.

- ✅ **A1. GST-zero bug** — `currency` is now resolved once at the top of `createInvoice()`
  (`data.currency ?? 'INR'`) and reused for the tax-rate calc, the row write, and the
  `TaxInvoice` gate, so an omitted `currency` can no longer invoice as INR while taxing as 0.
  Both `createInvoice()` and `convertMemoToInvoice()` also now refuse to emit a `TaxInvoice`
  claiming zero GST on a taxable INR sale (throws instead).
- ✅ **A2. Price-mode ambiguity** — resolved by wiring up the existing (previously-ignored)
  `rateType` field instead of adding a new one: `'FIXED'` → `unitPrice = goldRate` directly
  (a flat, already-decided price, e.g. a tag's own `sellingPrice`); `'PER_GRAM'` (default) →
  the original `netGoldWeight * goldRate + makingCharge + stoneValue`. No schema change.
- ✅ **A3. Memo path tag-link** — `convertMemoToInvoice` now sets `InvoiceItem.tagId` on each
  created line, so the memo-conversion path is tag-linked end to end, matching the retail path.

Covered by tests in `sales.service.test.ts`: currency-omitted vs explicit-INR parity, non-INR
zero-tax with no `TaxInvoice` emitted, `FIXED`-rate pricing (incl. a zero-`netGoldWeight` case),
`PER_GRAM` regression, and the memo-path `tagId` link.

---

## PHASE B — Correct GST + point-of-sale essentials — ✅ DONE (B1–B4)
These make a real sale legally correct and usable at the counter.

- ✅ **B1. HSN + GST rate master** — new `HsnCode` table (seeded with 7113/3%, the prior hardcoded
  rate). `InvoiceItem` carries `hsnCodeId` + a `taxRate` snapshot copied at sale time. Each line
  can optionally specify `hsnCode` (defaults to 7113); `createInvoice` sums per-line tax, scaled
  proportionally by any invoice-level discount — reduces to the old flat formula when every line
  shares one rate. `convertMemoToInvoice` stamps the default HSN on its lines too.
- ✅ **B2. Place-of-supply fix** — `Client.state` (free text, e.g. "Gujarat") vs `COMPANY_STATE_CODE`
  (numeric, e.g. "24") never matched, so every sale priced as inter-state IGST regardless of the
  client's real state. New `StateMaster` table (all 36 GST state/UT codes + common aliases) and a
  `resolveStateCode()` helper resolve the free text to a code before comparing. No confident match
  (blank/unrecognized — the common case for a lightweight walk-in retail `Client`) still falls back
  to inter-state, same as before. `TaxInvoice.placeOfSupply` now stores the resolved code when
  found. Stays single company-wide `COMPANY_STATE_CODE` (not per-branch) — `SalesInvoice` has no
  `branchId` and this codebase uses one GSTIN; branch/multi-GSTIN awareness is a later decision.
- ✅ **B3. Invoice print** — `client/src/utils/printInvoice.ts`: opens a formatted A4 tax invoice
  (company header/GSTIN, bill-to, HSN/category per line, CGST+SGST or IGST breakdown, category
  summary) in a new window for print/save-as-PDF, wired to a Print button on the invoice detail
  drawer and the New Sale success screen. Thermal-width layout not done — A4 only so far.
- ✅ **B4. Counter stock/price lookup** — new standalone `StockLookupPage.tsx`
  (`/tagging/lookup`, "Stock Lookup" in the Jewelry Tagging nav group), read-only, no billing
  side effects. Reuses `GET /tagging/tags/search` rather than a new endpoint — `searchTags()`
  now searches every status when the status filter is omitted or `'ALL'` (previously always
  defaulted to `IN_STOCK`), so scanning an already-SOLD or ON_APPROVAL piece shows a clear
  answer instead of "not found"; every existing caller (New Sale, Memo Out, Branch Transfers)
  explicitly passes `'IN_STOCK'` already, so their behavior is unchanged. A single match
  (the common scan case) jumps straight to a detail view — status, price, weights, HUID,
  approval/transfer history — deliberately without `costPrice` or any mutating action (no
  edit/retire): this is a counter-facing lookup, not the admin `TagsPage`/`TagDrawer` it borrows
  its detail layout from. No new scan hardware hook — a USB barcode/RFID scanner emulates
  keyboard input (same assumption `HardwarePage.tsx`'s scanner card already makes), so a plain
  autofocused text field is enough.

**Exit criteria:** a clerk can look up a piece, bill it, and hand the customer a correct printed GST invoice — met.

**Also done this pass, not originally numbered but serves the same "usable at the counter" goal:**
full-page New Sale flow (tabs: Sale Details / Items / Charges & Payment, replacing a popup),
per-invoice category summary (reuses `ProductCategory`), Shipping/Other Charges as a proper taxable
add-on, VA% (wastage-on-making-charge) per line, quick-add-client inline, and split payment across
multiple modes (cash/card/UPI/etc. in one sale, each with its own auto-numbered transaction). Also
fixed an app-wide horizontal-scroll issue across ~30 pages while doing the layout work.

---

## PHASE C — Daily pricing (core to a jeweller) — ✅ DONE (C1–C4)
- ✅ **C1. Metal/purity master** — new `KaratMaster` table (24K/99.99%, 22K/91.6%, 18K/75.0%,
  14K/58.5%, 10K/41.7%, 925/92.5%, SILVER/92.5%, PT/95.0%), seeded directly in its migration
  like `HsnCode`. `karat`/`metalKarat` columns stay free text everywhere (no schema-wide FK) —
  `shared/karatMaster.ts: isValidKarat()` validates at the one place a piece's karat actually
  gets fixed for its lifetime: `createTag` / `createTagFromGrnItem`. `GET/POST/PATCH
  /masters/karats` added; `NewTagPage.tsx` and `MetalRates.tsx` now fetch the list from there
  instead of two separately hardcoded (and already-drifted — 10K/925 vs SILVER/PT) JS arrays.
- ✅ **C2. Daily gold/metal rate → auto price** — `shared/metalRate.ts: resolveMetalRate()`
  looks up the latest `MetalRate` row with `date <= <given date>` for a karat+currency (handles
  gaps/weekends). Wired date-aware on both ends, per business steer (rate timing isn't a single
  "today" constant): `createTagFromGrnItem` suggests `sellingPrice` from the rate as of the
  GRN's `receivedDate` when not hand-priced; `createInvoice` resolves an omitted PER_GRAM
  `goldRate` from the rate as of `invoiceDate` for that line's karat — an explicit `goldRate`
  always wins (clerk override). `NewSalePage.tsx` auto-fills `goldRate` when a tag is picked
  (reusing the existing `/designs/rates/latest` the Metal Rates screen already shows), still
  editable. FIXED-rate lines are unaffected — they always require an explicit price.
- ✅ **C3. Making charges / wastage** — `createInvoice` now pulls the `MakingCharge` master
  (already had full CRUD in `masters.router.ts`, previously read by nothing) for a PER_GRAM line
  missing an explicit `makingCharge`/`wastagePercent`, matched by the line's resolved category
  (+ tag's `makeType`, when tagged), most-recently-effective row wins. `makingChargeType` is
  respected (`PER_GRAM` scales by `netGoldWeight`, anything else is flat — same split
  `design.service.ts`'s dormant BOM-process costing already uses), and the master's
  `saleWastagePercent` (until now unread anywhere) feeds the existing VA% markup formula.
  Explicit values always win, independently per field. FIXED-rate lines are unaffected — they
  never read making charge. `NewSalePage.tsx` auto-fills both fields when a tag is picked
  (reusing the master NewTagPage.tsx already reads for tagging), still editable; `wastagePercent`
  is always sent explicitly from the browser (0% is a legitimate deliberate value there, unlike
  an unset `goldRate`/`makingCharge`) — the server-side fallback exists for other callers.
  Separately fixed while in this area: `createTag`'s materials table (`NewTagPage.tsx`) had no
  route from a metal rate to a METAL row's Cost Rate at all (only an unrelated, usually-unseeded
  MakingCharge-by-material-code match) — a METAL row now auto-fills Cost Rate from today's
  `MetalRate` for the tag's karat when no such master mapping exists, recomputing on karat change.
- ✅ **C4. Stone valuation** — resolved the FK decision from CLAUDE.md §8 in favor of the additive
  option: nullable `JewelryTagMaterial.stoneTypeId` → `StoneType`, leaving `materialCodeId` (the
  generic catalogue, still used elsewhere incl. dormant manufacturing BOM) untouched. A non-METAL
  material row on `createTag` with a `stoneTypeId` but no explicit `saleAmount` resolves the
  most-recently-effective active `PriceMaster` row for that stone type whose weight range (if any)
  contains the row's weight — `shared/priceMaster.ts: resolvePriceMaster()` — and stamps
  `saleRate`/`saleAmount` (`pricePerCarat × weight`), which rolls into the tag's `sellingPrice`
  through the existing materials-total reduce, same as a hand-entered amount would. An explicit
  `saleAmount` always wins; no matching row leaves it unset (unpriced), same as before. Server-side
  only — `createTagFromGrnItem` (finished-goods, no materials breakdown) is unaffected, and no
  stoneTypeId picker exists in `NewTagPage.tsx` yet (a later UI pass, not required to close the
  FK gap itself).
- ✅ **C3-refresh (2026-09-02). Making charge/VA by karat, not just category.** C3 already matched
  `MakingCharge` by category; the schema had also carried a `materialCodeId` FK from day one but
  nothing ever queried it, and the two lookup sites had drifted to opposite, non-overlapping
  logic — `sales.service.ts`/`NewSalePage.tsx` matched category-only, `NewTagPage.tsx` matched
  materialCodeId-only. Neither could express "22K gold carries less wastage than 18K" (the actual
  ask), and materialCodeId was a poor fit to fix that with directly: it points at the generic
  `MaterialCode` BOM catalogue, which finished-goods-intake tags (`createTagFromGrnItem`, the main
  flow now) never populate at all. Added a plain `karat` column (KaratMaster.code convention, same
  as `JewelryTag.metalKarat`/`InvoiceItem.karat`) to both `MakingCharge` and `MaterialCode` instead
  — `materialCodeId` on `MakingCharge` keeps its original, narrower job (a flat-rate lookup for
  non-metal generic material rows, e.g. clasps/findings; unrelated to wastage). `findMakingCharge`
  (`sales.service.ts`, mirrored client-side in `NewSalePage.tsx` and `NewTagPage.tsx`) now does
  most-specific-match-wins across karat + category + makeType: a master row only matches when
  every field IT has pinned (non-null) agrees with the line, and among matches the row pinning the
  most dimensions wins — so a karat+category row beats a category-only wildcard row, which beats
  an any/any row. `createInvoice` defaults a tagged line's karat from the tag's own `metalKarat`
  when the line omits it, same fallback shape `categoryId` already had. On the buy side,
  `NewTagPage.tsx`'s Materials tab now drives the tag's own `metalKarat` automatically — each
  `MaterialCode` picked for a METAL row can declare its own karat, and the tag's overall karat is
  recomputed as whichever karat carries the most total METAL weight across rows (a mixed G18+G22
  piece resolves to whichever is heavier), still a plain editable field afterward, not locked. The
  Masters UI's Making Charges tab gained a Karat column/field; Material Codes was promoted from
  the shared `GenericMasterSection` to its own `MaterialCodesTab` (needed a live Karat dropdown,
  which `GenericMasterSection`'s static-options `fields` prop can't do) with the same Karat field.
  New tests in `sales.service.test.ts` (`karat specificity` describe block): karat+category beats
  a category-only wildcard, falls back to the wildcard when no karat-specific row exists, and an
  explicit line-level karat overrides the tag's own metalKarat for resolution.

---

## PHASE D — Returns & exchange (business confirmed all yes) — ✅ DONE (D1–D4)
- ✅ **D1. Sale return (retail)** — new `SalesReturn`/`SalesReturnItem` models; `createSalesReturn()`
  in `sales.service.ts` (validate → guarded/count-checked tag flip → link, same shape
  `createInvoice`'s own tag flip already uses). Reuses the **existing** `JewelryTag`
  (`SOLD` → `IN_STOCK`, same tag number/HUID/history — not a new tag; confirmed with the user)
  rather than minting a fresh one. Original `SalesInvoice`/`InvoiceItem` rows are never mutated —
  a return is a new record referencing the sale, not an edit to it. Credits
  `client.currentBalance` by the tax-inclusive amount actually paid for that line (`totalPrice`
  grossed up by its own snapshotted `taxRate`), symmetric to `createInvoice`'s debit — not a
  formal GST credit-note (no `TaxInvoice` reversal document; sales doesn't do GST-compliant credit
  notes yet, same open gap as F1's finance-journal wiring). Only tagged lines are returnable
  (free-text lines have no physical item to take back). **Schema note:** dropped the `@unique` on
  `InvoiceItem.tagId` — a returned tag must be resellable, i.e. able to appear on a second
  `InvoiceItem` later; the `IN_STOCK` gate `createInvoice` already enforces, not DB-level
  uniqueness, is what actually prevents double-selling a currently-SOLD tag. `POST /sales/returns`
  + `GET /sales/returns?invoiceId=`; UI lives in `SalesInvoices.tsx`'s existing invoice detail
  drawer (checkbox-select tagged lines, optional reason, shows return history alongside payments).
- ✅ **D2. Sale return (wholesale/memo)** — no new code: `createSalesReturn()` (D1) is
  channel-agnostic — it only reads the resulting `SalesInvoice`/`InvoiceItem`/`JewelryTag` chain,
  never how it got created, so a `convertMemoToInvoice`-sold piece returns through the exact same
  function and the exact same UI (memo-converted invoices already appear in the normal Sales
  Invoices list, no separate screen). Proven, not assumed: a new test drives
  `createMemoOut` → `convertMemoToInvoice` → `createSalesReturn` end to end and confirms the tag
  flips back to `IN_STOCK`, the client balance nets to zero, and — same "never rewrite history"
  rule as D1 — the original `MemoOut` stays `CONVERTED` rather than being reopened.
- ✅ **D3. Purchase return** — new `PurchaseReturn`/`PurchaseReturnItem` models;
  `createPurchaseReturn()` in `procurement.service.ts` (validate → guarded/count-checked flip →
  link, same shape as D1's `createSalesReturn`). Scoped to tagged finished-goods pieces only
  (`JewelryTag.grnItemId` set) — the live post-pivot business path; raw material only ever fed the
  dormant manufacturing modules. Flips the tag to `RETIRED` (reusing CLAUDE.md's canonical status,
  matching "leaves stock" exactly) rather than inventing a new status. All items in one return must
  share a supplier (rejected otherwise — one return note per vendor). Deliberately does **not**
  touch `Supplier.currentDue`, `PoItem.receivedQty`/`receivedWt`, or the original GRN row:
  procurement never wired `currentDue` as a live balance in the first place (no `supplier.update`
  call exists anywhere in that module), so there's no existing debit to reverse — crediting it now
  would produce a wrong number, not a correct one. That gap is real but belongs with Phase F
  (finance/dealer credit), not half-solved here. `amount` defaults to the tag's `costPrice` (what
  we paid — the buy-side mirror of D1 defaulting to what the customer paid).
  `POST/GET /procurement/returns` + `GET /procurement/suppliers/:id/returnable-tags` (`po:approve`
  / `po:view`). New page `PurchaseReturns.tsx` (Procurement nav group): pick a supplier, its
  `IN_STOCK` GRN-sourced tags load as checkboxes, optional reason, submit; past returns listed
  below.
- ✅ **D4. Exchange / old gold** — new `OldGoldExchange` model. `createOldGoldExchange()` in
  `sales.service.ts`: values the piece as `netWeight × today's MetalRate for its karat` (reusing
  C1/C2's `isValidKarat()`/`resolveMetalRate()`), minus an optional deduction % (melting
  loss/wastage — defaults to 0). Design decisions confirmed with the user: (1) it credits the
  customer's own `Client.currentBalance` (the same field a sale debits and D1's `createSalesReturn`
  credits) as a **standing store credit** — deliberately **not** tied to a specific invoice, so
  "redeemable against any future purchase" falls out of the existing balance mechanism for free,
  no new voucher/redemption tracking needed; (2) it **also** adds the melted-down weight to the
  Metal Vault (`MetalStock`, via the existing `addMetalStock()` from `inventory.service.ts`,
  `sourceType: 'CUSTOMER_SUPPLIED'`) so the metal itself is tracked, not just the financial side.
  `addMetalStock()` gained an optional `tx` param (same pattern as `NumberGen.payment()`) so this
  call participates in the same transaction as the client credit — no orphaned Metal Vault row if
  the rest fails. v1 boundary, stated explicitly: this makes the credit *exist*; it does not
  auto-apply against a specific invoice's `balanceDue` at sale time (a UI/policy choice for later).
  `POST/GET /sales/exchanges` (`invoice:create`/`sales:view`). New page `OldGoldExchange.tsx`
  (Sales & Export nav group): client, description, karat, weights, deduction %, a live valuation
  preview; past exchanges listed below.

---

## PHASE E — Branch operations (4 showrooms) — ✅ DONE (E1–E3)
- ✅ **E1. Branch transfer** — this entry was stale (verified 2026-08-25): the full lifecycle is
  already built, not just the model. `tagging.service.ts`: `createTransfer` (guarded — only
  `IN_STOCK` tags at the source branch) → `submitTransfer` (`DRAFT`→`PENDING_APPROVAL`) →
  `approveTransfer` (→`DISPATCHED`, flips tags to `TRANSFERRED` — in transit, branch not yet
  moved) → `receiveTransfer` (→`RECEIVED`, flips tags to `IN_STOCK` **and** moves `branchId` to
  the destination) → `cancelTransfer`. All status-guarded, the tag-mutating steps transactional.
  Full router (`branch:transfer`/`branch:approve` — approve is a separate permission from
  create/receive) and a complete `BranchTransfersPage.tsx` UI (list, create, detail drawer with
  submit/approve/receive/cancel actions gated by status and permission). **Known gaps, not
  blocking, logged for later**: `receiveTransfer` doesn't check the calling user's own branch
  against the transfer's destination (anyone with `branch:transfer` can receive any transfer, not
  just ones addressed to their branch); there's no "reject with reason" for a pending approval,
  only a generic cancel.
- ✅ **E2. Inter-branch stock visibility** — no schema change needed (`JewelryTag.branchId` +
  `.status` already carried everything required). `getBranchStockSummary()` in
  `tagging.service.ts`: one `jewelryTag.groupBy(['branchId','status'])` call, per branch giving
  `IN_STOCK` count/selling-value/cost-value/gross-weight plus lightweight `ON_APPROVAL`/
  `TRANSFERRED` counts for context. Deliberately excludes `SOLD`/`RETIRED` — closed history, not
  "stock." `GET /tagging/branches/stock-summary` (`tag:view`). New page
  `BranchStockSummary.tsx` (Jewelry Tagging nav group): a network-total card plus a per-branch
  table — one screen for all branches, instead of switching Tags & Inventory's branch filter
  one at a time.
- ✅ **E3. Stock audit / physical verification** — new `StockAudit`/`StockAuditItem` models.
  Confirmed with the user: **one branch per audit** (matches walking one showroom), and
  **report-only** — closing an audit never mutates `JewelryTag.status`/`branchId`; a
  missing/unexpected finding is a fact recorded for a person to act on later via tools that
  already exist (`retireTag`, a branch transfer), not an automatic side effect. `startStockAudit`
  snapshots every current `IN_STOCK` tag at the branch as "expected" (rejects if that branch
  already has one `IN_PROGRESS`); `scanAuditItem` marks an expected tag found (idempotent on
  re-scan) or, if the scanned tag wasn't expected there (wrong branch / not `IN_STOCK`), creates
  a `found`-but-not-`expected` row instead of erroring — that's the "unexpected" case in the
  report; `completeStockAudit` just closes it. `POST /tagging/audits`,
  `POST /tagging/audits/:id/scan`, `POST /tagging/audits/:id/complete` (`stock:adjust`);
  `GET /tagging/audits`, `GET /tagging/audits/:id` (`stock:view`). New page `StockAudit.tsx`
  (Jewelry Tagging nav group): list of past/active audits, a start-audit picker, and — for an
  in-progress one — the same scan-friendly autofocused input `StockLookupPage.tsx` (B4) uses,
  auto-scanning on a single match, with a live expected/found/missing/unexpected readout and a
  completed-audit discrepancy report.

---

## PHASE F — Finance & dealer credit (business confirmed dealer credit = yes)
- ✅ **F1. Wire sales → double-entry ledger** — went wider than the original one-liner (CLAUDE.md
  §4.1): every money-moving action now posts a balanced `JournalEntry` alongside the
  `client.currentBalance`/tag-status side effects it already had, not just `createInvoice`. New
  `finance.service.ts: postAutoJournalEntry(tx, ...)` — account-code-keyed (`shared/ledgerAccounts.ts:
  LEDGER_ACCOUNT`), zero-value lines dropped, created *and* posted in one shot inside the caller's
  own transaction (unlike financeRouter's manual `/journals`, which stays create-then-review-then-post
  via separate `journal:create`/`journal:post` permissions — these are the ledger side-effect of an
  already-decided event, not discretionary bookkeeping). `createJournalEntry`/`postJournalEntry`
  gained an optional `tx` param (same `tx ?? prisma` pattern as `addMetalStock`) so they can
  participate in the caller's transaction instead of opening their own.
  - `createInvoice`: one compound entry — Dr Accounts Receivable (totalAmount) / Cr Sales Revenue
    (taxableAmount) + Cr CGST/SGST or IGST (taxAmount) + Dr Cost of Goods / Cr Inventory (sum of
    tagged lines' own immutable `costPrice` — free-text lines contribute nothing, nothing physical
    was sold).
  - `applyPayment` (shared by `createInvoice`'s inline payments and `recordPayment`): Dr Cash in
    Hand or Bank Account (`cashOrBankAccount(mode)` — CASH hits the till, everything else clears
    through the bank, matching the two accounts actually seeded) / Cr Accounts Receivable. Forex
    gain/loss stays recorded-but-unjournaled (same class of deferred boundary as D1/D3's notes).
  - `createSalesReturn`: exact reversal, scoped to the returned lines only — revenue/tax split
    backed out of whatever amount is actually refunded (default or override), same-state/
    inter-state read off the original invoice's own `TaxInvoice` (not re-resolved), COGS/Inventory
    reversed at the returned tag's own `costPrice`.
  - `createOldGoldExchange`: Dr Inventory (the metal received) / Cr Accounts Receivable (the store
    credit — a negative receivable), valued at exactly what was credited to the client.
  - `createTagFromGrnItem` (the buy-side, closing the loop CLAUDE.md §3 opened): Dr Inventory / Cr
    Accounts Payable at the piece's own `costPrice` — without this, Inventory would only ever be
    credited (at sale) and never debited (at intake), making the account meaningless. This also
    resolves the "belongs with Phase F" deferral D3 flagged.
  - `createPurchaseReturn`: Dr Accounts Payable / Cr Inventory — reverse of the intake entry.
    (`Supplier.currentDue` itself is still untouched, per D3's original note — that's a separate,
    still-open control gap, not this ledger.)
  - New migration `20260825130000_seed_ledger_accounts` seeds the 10 specific chart-of-accounts
    rows these entries depend on directly (`ON CONFLICT (code) DO NOTHING`) — same "seed it in a
    migration, not just `prisma/seed.ts`" precedent as `DEFAULT_HSN_CODE`/`KaratMaster`, since the
    dedicated test DB only ever runs `prisma migrate deploy`, never `seedChartOfAccounts()`.
  - Tests (`sales.service.test.ts`, `tagging.service.test.ts`, `procurement.service.test.ts`, new
    shared `src/test/ledger.ts` helper) assert the posted `JournalEntry`/`JournalLine` rows
    directly — balanced totals, correct account/amount per line, the free-text-line/non-INR/full-
    reversal edge cases — not just that `client.currentBalance` moved.
- ✅ **F2. Payments / receipts** — the missing piece was a standalone receipt not tied to one
  invoice (an advance, or a payment against a client's general outstanding balance).
  `InvoicePayment.invoiceId` is now optional; a `clientId` column was added directly on every row
  (backfilled from the owning invoice for existing rows) so both invoice-scoped and standalone
  payments query uniformly for a client statement (F4) without a conditional join. New
  `recordClientPayment()` reuses the same PMT- numbering and Cash/Bank-vs-Accounts-Receivable
  ledger entry `applyPayment` posts (F1) — just with no invoice to update
  `paidAmount`/`balanceDue`/`status` on. New `listClientPayments()` returns every payment for a
  client, either kind. `POST/GET /sales/clients/:clientId/payments`. UI: a "Record Payment" action
  on the Clients page (Orders → Clients) opens a small dialog (amount, mode, date, reference,
  notes) and refreshes the client's balance on save. New migration
  `20260825140000_add_on_account_client_payments`. Tests in `sales.service.test.ts` cover the
  no-invoiceId case, the ledger entry, the positive-amount guard, and both payment kinds showing
  up together in `listClientPayments`.
- ✅ **F3. Dealer outstanding / credit tracking** — two independent pieces, both reusing the
  existing `Client.creditLimit`/`currentBalance` fields (no schema change):
  - **Credit-limit enforcement.** New `checkCreditLimit()` in `sales.service.ts`, called at the top
    of both `createInvoice`'s and `convertMemoToInvoice`'s transactions, before any tag is touched
    — a sale that would push `currentBalance` over a set `creditLimit` is rejected outright (no
    partial/half-applied sale). No `creditLimit` set (the common case — a lightweight walk-in
    retail `Client`) means unlimited, unchanged from before this check existed. Deliberately a
    *soft* policy guardrail, not a race-proof invariant like the tag-flip guards elsewhere in this
    file: it reads-then-compares within the transaction without row-locking, so two genuinely
    concurrent sales to the same dealer could both pass before either commits — acceptable, since
    over-extending a dealer by one racing sale is a policy nudge to catch, not data corruption like
    double-selling one physical tag.
  - **Aging report.** New `getDealerAging()` in `finance.service.ts`: every client with
    `balanceDue > 0` on any invoice, bucketed by age from `dueDate` (falling back to `invoiceDate`
    when unset) into 0–30/31–60/61–90/90+ day buckets, plus an `overLimit` flag for anyone
    currently past their own `creditLimit` — the audit view for the enforcement above, not a live
    re-check. `GET /finance/reports/dealer-aging` (`report:view`). New page `DealerAging.tsx`
    (Finance nav group): one row per client, bucket columns, credit limit vs. total outstanding,
    over-limit rows highlighted.
  - Tests: `sales.service.test.ts` (allowed-within-limit, rejected-over-limit on both the direct
    and memo-conversion paths, inventory/tag left untouched on rejection) and new
    `finance.service.test.ts` (bucket assignment, the `overLimit` flag, unlimited clients
    unaffected, paid invoices excluded, sort order).
- ✅ **F4. Customer & dealer ledger** — no schema change: exactly four tables ever move
  `Client.currentBalance` (grepped, not assumed) — `SalesInvoice` (debit, incl. memo-converted
  sales), `InvoicePayment` (credit — covers both invoice-scoped and F2's standalone on-account
  payments, same table), `SalesReturn` (credit), `OldGoldExchange` (credit) — so the statement is
  pure read-side aggregation, same shape as E2/F3. New `getClientLedger(clientId, from?, to?)` in
  `finance.service.ts`: merges all four sources chronologically into one running balance; always
  computed from full history first so an `openingBalance` before a `from` cutoff is correct, then
  sliced to the requested range. With no range given, `closingBalance` equals
  `client.currentBalance` — a built-in consistency check. `GET
  /finance/reports/client-ledger/:clientId` (`report:view`, optional `from`/`to`). New page
  `ClientLedger.tsx` (Finance nav group): client picker + date-range filter, running-balance
  table, opening/closing summary, browser-print action. A "Statement" icon on the Clients page
  deep-links straight to a client's ledger. Tests in `finance.service.test.ts`: chronological
  merge across all four sources, full-history closing balance vs. `currentBalance`, a date-range
  slice with a non-zero opening balance, and an empty ledger for a client with no activity.

---

## PHASE G — Repairs & hallmarking — ✅ DONE (G1–G2)
- ✅ **G1. Repair job intake** — extended the existing manufacturing-era `RepairJob`/
  `RepairTransaction` system (`quality.service.ts`) rather than building a parallel one:
  `clientName`(free text)/`originalJobCardId` stay untouched for the old QC-failure/rework flow;
  new optional `clientId` → `Client` and `tagId` → `JewelryTag` let a customer-brought-in piece
  be tracked against a real party and a real piece. New `receivedDate` (defaults now, the "in")
  and `deliveredDate` (nullable, the "out", stamped by new `deliverRepairJob()` — `PATCH
  /quality/repairs/:id/status` branches to it specifically for `DELIVERED` so the date isn't
  missed on a plain status change) give explicit in/out tracking beyond the generic status
  string. New `updateRepairJob()` lets `repairCost`/`clientId`/`tagId` be filled in after intake
  (a repair's cost is usually quoted after inspection, not known upfront). New `billRepairJob()`
  — "charge" — reuses `createInvoice()` verbatim: one free-text `FIXED`-rate line for
  `repairCost`, no `tagId` on the invoice line (repair labor isn't a physical stock item, even
  when the repair itself references one). New unique `RepairJob.invoiceId`, set once billed,
  makes billing idempotent — rejected outright on a second attempt, same as a missing client or
  an unset/zero cost. `POST /quality/repairs/:id/bill` gated on `invoice:create` (matching every
  other cross-module invoice-creating endpoint — returns, exchanges — not `repair:manage`),
  which surfaced a real RBAC gap: `PRODUCTION_MANAGER` was the only role with `repair:manage`
  and had no `invoice:create`, so nobody could actually reach the new endpoint. Fixed in
  `seed.ts` (added `invoice:create` to `PRODUCTION_MANAGER`, both `create` and `update` — same
  `update: {}`-was-a-no-op lesson as the `masters:view` fix) and re-seeded the dev DB — **a user
  already logged in needs to log out and back in**, same caveat as that earlier fix. `RepairJobs.tsx`
  gained an optional client Autocomplete, a search-as-you-type tag picker (reusing
  `/tagging/tags/search`, same as Stock Lookup), an editable repair-cost cell, a "Mark Delivered"
  action, and a "Bill Customer" action (disabled until a client + cost are set; replaced by the
  resulting invoice number once billed). Tests in new `quality.service.test.ts`: client/tag
  linkage independent of any JobCard, delivery stamps `deliveredDate` (and rejects a second
  delivery), billing creates a correctly-linked untagged invoice line, and billing is rejected
  with no client, no cost, or an already-billed repair.
- ✅ **G2. Hallmarking for bought-in goods** — `HallmarkingItem.jobCardId` is now optional;
  new optional `tagId` → `JewelryTag` is the bought-in alternative (CLAUDE.md §4.2, resolved in
  favor of "add a tagId alternative" over a bare optional-with-nothing-else). No DB constraint
  ties the two together (matches every other optional-FK pair in this schema) — `createHallmarkingBatch()`
  rejects an item with neither at the app layer. `HallmarkingPage.tsx`'s item rows gained a Tag
  Number field alongside the existing Job Card ID field (resolved to a real `tagId` via the same
  `/tagging/tags/search` lookup on submit, rather than an async Autocomplete per field-array row);
  a caption clarifies "either, not both." Tests: a tag-only item is accepted, an item with
  neither `jobCardId` nor `tagId` is rejected.

---

## PHASE H — Management reports (printed + Excel export) — ✅ DONE
Point-of-sale prints are in Phase B. These are management/period reports. Two of the seven bullets
turned out to already be fully covered by earlier phases, so this phase only needed five new reports:
- ✅ **Dealer ledger / outstanding** — already done: F3's Dealer Aging + F4's Client Ledger. No new work.
- ✅ **Profit / margin** — already done: the existing P&L Statement (`PnLStatement.tsx` /
  `getProfitAndLoss`, Phase F1) already nets real Sales Revenue against Cost of Goods off the
  ledger for any date range — that is margin reporting, just not labeled "Phase H." No new work.
- ✅ **Sales register (retail + wholesale), by date/salesperson** — new `getSalesRegister()` in
  `sales.service.ts`, `GET /sales/reports/register`. Retail and wholesale sit in the same table
  (`invoiceType` is just a label on the row) so "both" needed no branching — filters by date range
  and `salesPersonId` directly. Branch filtering is deliberately approximate: `SalesInvoice` has no
  `branchId` of its own (CLAUDE.md's B2 note — one GSTIN, no per-branch billing entity), so a
  branch filter can only mean "has at least one line tagged to that branch"; left out of the UI
  filter (though the service supports it) rather than shipping a filter whose results would be
  silently incomplete for a free-text-only invoice. New `SalesRegister.tsx` (Reports nav group).
- ✅ **Stock on hand, by branch/category** — new `getStockOnHand()` in `tagging.service.ts`, `GET
  /tagging/reports/stock-on-hand`. Sits alongside E2's `getBranchStockSummary` rather than
  replacing it: E2 is network-visibility (counts `ON_APPROVAL`/`TRANSFERRED` too), this is strictly
  "what's sellable right now" (`IN_STOCK` only), sliced by branch **and** category, which E2
  doesn't do. New `StockOnHand.tsx`.
- ✅ **Dead stock / ageing** — new `getDeadStock()` in `tagging.service.ts`, `GET
  /tagging/reports/dead-stock`. Buckets `IN_STOCK` tags by days since `updatedAt` (0-90/91-180/
  181-365/365+) — `updatedAt` is a proxy for "time in current status," not `createdAt`: a tag
  returned (D1) and put back `IN_STOCK` keeps its original `createdAt`, which would overstate its
  age after a resale attempt; documented as the same class of approximation as F3's
  `dueDate ?? invoiceDate` anchor. New `DeadStock.tsx`.
- ✅ **Daily sales summary (day-book)** — new `getDayBook(date)` in `finance.service.ts`, `GET
  /finance/reports/day-book`. Same four sources as F4's Client Ledger (`SalesInvoice`,
  `InvoicePayment`, `SalesReturn`, `OldGoldExchange`) but summed company-wide for one day instead
  of itemized per client; payments are broken out by mode (the actual cash/bank movement, for till
  reconciliation) and kept separate from returns/exchanges (accounting credits, not same-day cash
  paid out). New `DayBook.tsx`.
- ✅ **GST return-ready reports (for filing)** — scoped to an HSN-wise summary (taxable value +
  CGST/SGST/IGST by HSN and rate), the table a GSTR-1 filing actually needs assembled from — not a
  full GSTR-1 JSON export with buyer-GSTIN-wise B2B/B2C breakup, which is a materially bigger,
  separate undertaking. New `getGstSummary(from, to)` in `finance.service.ts`, `GET
  /finance/reports/gst-summary`. Per-line tax is approximated as `totalPrice * taxRate` (skipping
  `createInvoice`'s invoice-level discount-scaling and `otherCharges`, neither attributable to one
  HSN line) — a prep aid, not a submission-ready export, and the UI says so via a banner rather
  than implying a finished filing. Intra/inter-state classification itself is **not** approximated
  — read exactly off each invoice's own `TaxInvoice.igst` (one invoice has one place of supply).
  Non-INR sales are excluded (A1: they never get a `TaxInvoice`, so they'd show as a meaningless
  zero-tax row). New `GstSummary.tsx`.
- ✅ **Every report printable and Excel-exportable** — "Excel-exportable" satisfied by a new shared
  `client/src/utils/exportToCsv.ts` (plain CSV, which Excel opens natively) rather than adding an
  `xlsx`/`exceljs` dependency for formatting no one asked for; every new report page gets an
  Export CSV button. "Printable" reuses the same lightweight `window.print()` pattern F4's
  `ClientLedger.tsx` already established (these are internal reports, not the legal tax-invoice
  document B3 built a bespoke formatted print for).

No schema changes anywhere in this phase — five new functions, all pure read-side aggregation over
tables that already existed, same shape as E2/F3/F4. Tests: 3 new cases for `getSalesRegister`
(date range + totals, per-type breakdown, salesperson filter) in `sales.service.test.ts`; 4 for
`getStockOnHand`/`getDeadStock` (branch x category slicing, category filter, ageing bucket
assignment via a raw-SQL-backdated `updatedAt`, non-`IN_STOCK` exclusion) in
`tagging.service.test.ts`; 2 for `getDayBook` (same-day rollup across all four sources incl.
per-mode payments, date-range exclusion) and 3 for `getGstSummary` (intra-state CGST+SGST split,
inter-state IGST, distinct HSN/rate grouping) in `finance.service.test.ts`.

---

## PHASE I — Store-operations gap pass (2026-09-25) — ✅ DONE (I1, I2, I4, I5; I3 deliberately not started)

Found by walking the retail store loop (inward → tag → print → estimate → sale → tax invoice → accounts) against
the *code* rather than the docs. Each item has its own migration where the schema moved, and its own test file.

- **I1 — Finished-goods inward, on screen. DONE.** Gap #1's `createTagFromGrnItem` existed only as an API route: nothing in
  the UI could create a tag from a GRN, and `API.md` wrongly said a GRN line "auto-creates" one. Now: the PO form has a
  `FINISHED PIECE` line type (one line = one piece, quantity forced to 1 and enforced server-side); `createGRN` takes the
  receiving `branchId` (required when the PO has a finished-goods line — the column existed since Gap #1 but nothing set it);
  the GRN page lists each finished line with a **Tag** button → dialog → `POST /tagging/tags/from-grn-item` (branch defaults to
  the GRN's), then **Print label** through the print agent. The "Finished pieces" column shows which lines are still untagged,
  which is the worklist the old workflow-gap note asked for. No schema change. Tests: `procurement.intake.test.ts` (6).
  *Found on the way:* `POST /procurement/orders` and `/grn` passed JSON date strings straight to code that calls
  `getFullYear()` — a 500 over real HTTP; now parsed by the new `shared/parseDate.ts` (the sales router's local copy moved there).
- **I2 — Purchase GST + supplier payments. DONE.** Migrations `20260925090000_purchase_input_gst`, `20260925100000_supplier_payments`.
  *Input GST:* `PoItem.hsnCodeId` + `taxRate` snapshot (HSN master rate if the supplier has a GSTIN; 0 for an unregistered
  supplier or a non-INR PO; or the rate typed off the bill). Intake now books Dr Inventory (bare cost — `costPrice` stays
  GST-free) + Dr Input CGST/SGST **or** IGST (new ITC accounts 1401–1403, seeded for existing companies by the migration and
  into the Starter Package chart) / Cr Payable (goods + GST). Supplier state = the GSTIN's first two digits, else the free-text
  state; same fallback as sales (unresolved → IGST). The tax is stamped on `GrnItem` once, so a **purchase return reverses it
  exactly** (pro-rata on an overridden amount). New `getPurchaseGstSummary` (+ Reports → *Purchase GST (ITC)*): HSN-wise net of
  returns, and bill-wise with the supplier's GSTIN for matching against GSTR-2B. The PO approval limit still applies to the goods
  value, not to the GST now inside `totalAmount`.
  *Supplier payments:* `SupplierPayment` (RLS + composite FK); `recordSupplierPayment` = Dr Payable / Cr Cash-or-Bank;
  `POST/GET /procurement/suppliers/:id/payments` (`journal:create` — the accountant — to record). **`Supplier.currentDue` is now a
  live payable** (intake adds goods + GST; a return and a payment reduce it; negative = an advance) — this supersedes D3's "never
  wired" note; the migration backfills it for suppliers still at 0. `getSupplierLedger` + Finance → *Supplier Ledger*; Pay and
  Statement buttons on the Suppliers page. Tests: `procurement.inputGst.test.ts` (11), `procurement.supplierPayment.test.ts` (8).
- **I3 — GST credit note on a sales return. NOT STARTED** (no go-ahead given). `createSalesReturn` still credits the client
  tax-inclusive with no `TaxInvoice` counterpart and no GST-payable reversal, so the sales GST summary overstates tax after a return.
- **I4 — PAN and cash limits. DONE.** Migration `20260925110000_client_form60` (`Client.form60Received`). `shared/compliance.ts`:
  **Rule 114B** — a sale above ₹2,00,000 (invoice total incl. GST, INR) needs the client's PAN, a Form 60 on file, or a GSTIN (which
  embeds the PAN); enforced in `createInvoice` and `convertMemoToInvoice`. **Sec 269ST** — cash from one client on one IST calendar
  day must stay under ₹2,00,000, summed across every CASH payment (invoice-linked, standalone, and earlier splits of the same
  sale); enforced in `applyPayment` and `recordClientPayment`, inside the sale's transaction, so a refused payment rolls the whole
  sale back. Client PAN is validated and upper-cased; the client create/update endpoints now **whitelist** their fields (the body
  used to be spread into the row, so `currentBalance` could be typed in). UI: PAN + Form 60 on the Client form, a PAN / Form 60
  dialog on the Clients page and inline on the billing screen when it blocks, and a cash warning on the payment splits.
  **Not done:** TCS on cash sales of jewellery — confirm the position with your CA. Thresholds are constants (`CASH_RECEIPT_LIMIT`,
  `PAN_REQUIRED_ABOVE`). Existing tests that billed over ₹2L to PAN-less test clients were given a PAN. Tests: `sales.compliance.test.ts` (16).
- **I5 — Estimate → invoice. DONE.** Migration `20260925120000_estimate_to_billing`. `TagEstimate` gains `status` (OPEN → SENT →
  INVOICED), `customerName/customerPhone`, `invoiceId`. Estimation page: **Send to Billing** (saves + sends, with an optional
  customer name/phone) and a send icon on each past estimate. Billing screen (Items tab): **Bill an estimate** — search by estimate
  number, item name, tag number, HUID, customer name or phone (`GET /sales/estimates`, sale-side data only, `invoice:create`);
  picking one asks for the **sales person** (pre-filled with the estimator), then adds the piece as a line whose material rows and
  MC/VA can be edited (**Edit rates / rows**: change a rate, delete a row, add a row), next to any other lines. It goes to the server
  as a FIXED line at the edited total; `createInvoice({ estimateIds })` marks each estimate INVOICED in the same transaction
  (count-checked, so two counters cannot bill it twice; refused if the estimate's piece is not on the invoice or it was never sent).
  The saved quote itself is never changed. *Also fixed:* the New Sale screen never sent `branchId`, which `createInvoice` has required
  since the multi-tenant work — it now has a Branch field (auto-filled when there is one branch; `GET /sales/branches`).
  Tests: `sales.estimateBilling.test.ts` (13).

- **I5b — Full customer details at "Send to billing". DONE (2026-09-27).** Migration `20260927100000_estimate_customer_details` (`clients.dateOfBirth`; `tag_estimates.customerDob/customerAddress/customerPan/salesPersonId`). The Send-to-billing dialog now asks for **name, mobile, date of birth, address, PAN and the sales employee** — name, mobile and sales employee are required, DOB/address/PAN optional (validated when given: 10-digit mobile, PAN shape, DOB not in the future; the sales employee must be an active member of the company). `GET /estimation/staff` feeds the picker under `estimation:view` (an estimator need not hold `invoice:create`). On the billing screen, loading the estimate pre-selects the recorded sales employee and adopts the customer as the bill's customer: matched to an existing client by mobile number (only blank PAN/address/DOB are filled — never overwritten), otherwise a RETAIL client is created; a customer already chosen on the bill is kept. Clients get a Date of Birth field, and the printed tax invoice's Bill To now shows mobile, DOB and PAN (Sales Executive was already there). Tests: `sales.estimateBilling.test.ts` (customer-details block), `http.storeOps.test.ts`.
- **I6 — Purchase lots (bags). DONE.** Migrations `20260925130000_purchase_lots` + `20260925140000_lot_categories`. Suppliers bill finished
  jewellery *as a bag*: one invoice line, one amount, and — category by category — what is inside (rings, necklaces, ...), not piece by
  piece. **PO:** line Type *FINISHED LOT (bag of pieces)* takes the bag's gross weight, its ONE amount before GST, and a grid of
  **category rows** (`PoItemCategory`): Category (from the master), Karat (each row's own), Gross / Stone / Net — enter any two — and an
  *optional* piece count (give it if the invoice does, else only weights are tracked). The rows must add up to the bag's gross (±0.5%);
  the bag is one unit (`quantity 1`, unit BAG) with `netWeight` = Σ rows and `totalAmount` = the exact invoice amount.
  **GRN:** a bag line is received whole and once; receiving it opens a
  `PurchaseLot` and **books the whole bill then** — Dr Inventory + input GST / Cr Payable, `Supplier.currentDue` up by goods + GST, tax
  stamped on the GRN line (same columns a single finished piece uses, so the purchase-GST register reads it unchanged). **Tagging:**
  New Tag has a *Purchase lot* picker (also reached from the GRN page's *Tag pieces*, `?lotId=`); `createTag({ purchaseLotId })` takes
  the lot's row lock, checks (open; the piece's category is one the bag holds, with that row's karat; the row's piece count if it stated
  one; row and bag weight within the invoice + 0.5%). The final piece — the one that completes the piece count (only if every row gave
  one) or brings tagged net up to the bag's — closes the lot. New Tag narrows its Category list to the bag's categories and shows what is
  left per category. **Cost is entered once, on the PO:** each category row optionally carries *metal cost ₹/g, making ₹/g, VA %*
  (`PoItemCategory.costRate/mcRate/vaPercent`, migration `20260925150000_lot_category_cost_rates`; the PO form totals them against the
  invoice amount as a sanity check). New Tag pre-fills each METAL row's Cost Rate and the MC & VA tab's cost side from the piece's category
  row — once per row, so an edit sticks — falling back to the bag's average ₹/g when the PO carried no rate. **The tag's `costPrice` is
  whatever those tabs build (editable per tag, before and after saving);** with nothing entered at all it falls back to the piece's share
  of what is left of the bag by net weight (`suggestedCost`). The bag reports `costVariance` = invoice amount − Σ tag costs. *Note:* the
  ledger keeps the invoice amount (Dr Inventory at GRN), so a non-zero variance stays in Inventory until someone books an adjustment —
  none is posted automatically. **Manufacturer:** `POST /tagging/manufacturers/from-supplier` finds (GSTIN, else name) or creates once a
  Client of type MANUFACTURER from the PO's supplier; the New Tag screen (bag chosen) and the GRN page's single-piece Tag dialog
  pre-select it (still an ordinary dropdown). Tagging books **no** journal (already booked at receipt). Tagged totals are read live from
  the tags, never stored as counters. **Closing** (`POST /tagging/lots/:id/close`)
  stops further tagging and is report-only — leftover pieces/weight/cost stay visible on the lot as its variance, never auto-written-off.
  Purchase return, the supplier ledger and the purchase-GST summary all read a lot-cut tag through its lot's GRN line. Tests:
  `purchaseLot.test.ts` (27, incl. multi-category bags, optional counts, per-row karat, a concurrency race and wrong-company probes) and
  `http.purchaseLots.test.ts` (5, over real HTTP), `manufacturerForSupplier.test.ts` (4). *Not built:* a lot list/management page (the API
  `GET /tagging/lots[/:id]` exists; the picker on New Tag and the GRN page cover the flow), and editing a piece's weights after tagging
  does not re-split the lot (its cost stays as allocated).

- **I7 — old gold & store credit as payment modes on the bill (2026-09-27). DONE.** No migration. New Sale's payment splits gain
  two modes beside Cash/Card/UPI/Bank/Cheque. **`OLD_GOLD`**: the counter enters the customer's old piece (description, karat, gross/
  stone weight, deduction %); `createInvoice` values it exactly like a standalone exchange (net × the day's MetalRate × (1 − deduction),
  now shared as `valueOldGold`/`bookOldGoldExchange`, so the two paths cannot drift) — books an `OldGoldExchange`, adds the melted
  weight to the Metal Vault, posts Dr Inventory / Cr AR, credits `Client.currentBalance` — then settles the bill with that credit. Metal
  worth more than what is still due pays the bill off and the surplus stays as credit on the account. **`STORE_CREDIT`**: spends credit
  already on the account (a negative `currentBalance`, left by a sales return or an earlier exchange), capped by
  `GET /sales/clients/:id/credit`; refused above what is available or above what is still due. Both write an `InvoicePayment`
  (`mode` `OLD_GOLD`/`STORE_CREDIT`) that moves the invoice's paid/due/status but posts **no journal and leaves the client balance
  alone** — the credit was booked when it arose and the sale's debit already nets it (`applyPayment(..., {fromCredit:true})`). So these
  rows are not receipts: the client ledger (F4) and the day book skip them (`CREDIT_SETTLEMENT_MODES`), or the credit would count
  twice. Everything is in the invoice's one transaction — a failing later split rolls back the exchange and vault entry too.
  `recordPayment`/`recordClientPayment` refuse these modes (nothing to draw on outside a bill); credit modes are rupee invoices only.
  The New Sale payment-mode picker became a native select (CLAUDE.md §10). Concurrency: the INV number taken at the top of
  `createInvoice` locks the company's invoice-number row, so two bills cannot read the same credit; nothing else spends credit.
  Tests: `sales.service.test.ts` "old gold & store credit as payment modes" (14). *Not done:* the memo/wholesale path
  (`convertMemoToInvoice`) takes no payments and so no credit modes; credit cannot yet be applied to an *older* unpaid invoice;
  old-gold GST treatment (purchase from an unregistered person) is not modelled — confirm with a CA.

- **I8 — edit an issued invoice + invoice-list date filters (2026-09-27). DONE.** No migration. `PUT /sales/invoices/:id`
  (`amendInvoice`, permission **`invoice:edit`** — SUPER_ADMIN via `*`, assignable to any role later; deliberately not `invoice:create`) lets an
  admin change *anything*: lines, rates, discount, GST/HSN, customer, dates, notes — even after payments or returns (the business's call,
  overriding the older "never rewrite history" rule; history is kept differently, below). The body is the whole new bill; a line with its
  InvoiceItem `id` is updated in place, one without is added, one left out is removed. **In one transaction:** tags taken off go back to
  `IN_STOCK`, tags added flip to `SOLD` (count-checked like `createInvoice`); the GST record (`TaxInvoice`) is rewritten and same-/inter-state
  re-resolved from the customer; the original journal entries are **never edited** — one `SalesInvoiceAmendment` entry is posted for the *difference*
  (receivable, revenue, CGST/SGST/IGST, round-off, COGS/inventory); `Client.currentBalance` moves by the change in total (a changed customer gives the
  whole bill back and the new one takes it); paid/due/status are re-derived from the payments, which are untouched (a bill cut below what was paid
  shows a negative due = credit); PAN / credit-limit checks apply only where the edit worsens the customer's position. The audit log
  (`sales_invoices`, action `AMEND`) keeps the full before/after including lines, and an optional reason. **Locks:** a *returned* line cannot be
  changed or removed (the return already reversed it); the customer cannot change once a payment or return exists; currency and branch are fixed.
  Amendments of one invoice are serialised with `SELECT … FOR UPDATE`. To share the maths, `createInvoice`'s pricing block became
  `priceInvoice()` (behaviour unchanged — all existing sales tests pass untouched). **UI:** the New Sale screen doubles as the editor at
  `/sales/invoices/:id/edit` (payments block replaced by a warning + reason box; returned lines dimmed/locked; a FIXED/estimate-priced line shows
  a "Flat price" chip); an **Edit** icon column in the invoice table and an **Edit** button in the invoice drawer, both shown only with
  `invoice:edit`. Also: the invoice list gained From/To date filters (`GET /sales/invoices?from&to`) and moved onto `DataTable` (column
  filters, drag-reorder, resize) with ~20 optional columns (sales executive, branch, qty, gross/net/stone wt, subtotal, discount, GST split, paid-by, notes …) hidden until chosen from the right-click column menu (`DataTable` gained `defaultHidden`). Tests: `sales.service.test.ts` "amendInvoice" (10), `http.contract.test.ts` (PUT + date range). *Not done:*
  amending a memo-converted (wholesale) invoice is allowed but untested against memo state; no "view amendment history" screen yet (it is in the
  audit log); the UI edit flow was not exercised in a browser in this pass.

> The old "GRN → tag is a manual, unflagged step" workflow gap is closed by I1: it stays a deliberate manual step, but the GRN page now
> shows each untagged finished piece with a Tag button.

---

## How to use this roadmap
1. **Phase A first, always** — it's the foundation fix; nothing new until the sale prices/taxes correctly.
   (Done — see above.)
2. Then broadly A → H, but **B (correct GST + POS print) and C (daily pricing) are the true
   "can we actually trade" milestones** — prioritise them over D–H.
3. Per feature: use GATI's live DB as a **reference for how to structure that one feature** when you
   build it (as done for the sale flow) — NOT as a checklist to replicate wholesale.
4. Only build what Vasavi actually does. (All confirmed yes here, so most of D–G is in scope.)
5. Plan-first, one feature at a time, migration + test + review — same discipline as Gaps #1–2.

---

## PHASE M — Multi-company SaaS (TRIVO) — ✅ DONE (M1–M6)

Not a jewellery-feature phase: turning the single-company system into isolated companies. Full write-up in CLAUDE.md §11
(architecture) and §12 (production-readiness verification, open items). Summary:
M1 masters per company · M2 identity/membership + invitations · M3 provisioning + versioned Starter Package (copied, not
shared) · M4 runtime isolation (WebSocket rooms, hardware, Redis/object keys) · M5 database RLS enforced with a non-owner,
non-bypass runtime role + composite foreign keys · M6 staging verification (two heavy companies, real HTTP/WebSocket/
browser, backup→restore drill, performance baseline). Runbook: DEPLOY.md.

## Branch transfers — page + verified receiving (2026-09-27)

- **New Transfer is a page** (`/tagging/transfers/new`, `NewBranchTransferPage.tsx`): "Jewelry Detail" (branches, remarks, category overview, summary) and "Items Detail" (tag grid) in vertical tabs; the old dialog is gone. No "Term Detail" tab — a transfer carries no payment terms (decided with the user).
- **Branch Receives** (`/tagging/receives`, `BranchReceivesPage.tsx` → `BranchReceiveDetailPage.tsx`): the receiving branch's inbox of dispatched transfers. The detail page has the same two tabs and item table; pieces are ticked off (checkbox or scan tag number/HUID + Enter) and **only verified pieces are received**.
- **Schema:** `branch_transfer_items.receivedAt` (migration `20260927140000_transfer_item_received`, existing RECEIVED transfers backfilled). `receiveTransfer(id, ctx, userId, tagIds?)` flips only the verified tags `TRANSFERRED → IN_STOCK` at the destination (count-checked, all-or-nothing); unverified pieces stay `TRANSFERRED`; the transfer is `PARTIALLY_RECEIVED` until the last piece is in, then `RECEIVED`. Tests: `branchTransfer.receive.test.ts`.
- **Not done:** there is no write-off / "lost in transit" action for a piece that never arrives — it stays in transit, and the transfer stays Partly Received, until it turns up. The migration was applied to the real role-split `trivo_rlstest` (FORCE RLS) and `npm run test:rls` passed (717 tests, 1 skipped).
