# PHASE G2 — GST Documents & Invoice Lifecycle: Technical Design

**Scope:** design only. No `schema.prisma`, migration, service, router, frontend, permission, or seed-data change was
made while producing this document. This is the only file created in this pass.
**Date:** 2026-09-29 · **Branch:** `main`
**Prior phases:** G0 (`PHASE_G0_GST_EINVOICE_ARCHITECTURE_AUDIT.md`) and G1 (GST foundation — `CompanyGstRegistration`,
`TaxInvoiceTemplate`, per-line CGST/SGST/IGST, FY-aware numbering, seller/buyer invoice snapshot, `convertMemoToInvoice`
unified onto `priceInvoice()`) are **frozen** and treated as given. This document does not re-audit or re-litigate
either — it inspects only what G2 needs to build on, and cites G0/G1 by section where useful.

Every finding below that describes "current behavior" was independently re-verified against the live source in this
pass (file:line citations throughout), not assumed from G0's earlier text — G1 shipped between G0 and this pass and
changed several things G0 flagged as gaps (see §1).

---

## 1. Executive Summary

**What G1 already closed, so G2 does not need to:** the invoice snapshot problem (`TaxInvoice.sellerLegalName`/
`buyerName`/etc., `schema.prisma:2764-2789`, computed by `resolveSellerRegistration()`/`buyerSnapshot()` in
`sales.service.ts:711-750`), the hardcoded seller-identity bug, `convertMemoToInvoice`'s flat-rate tax duplication
(it now calls `priceInvoice()`, `sales.service.ts:1832`), calendar-year vs financial-year numbering
(`numberSequence.ts:42-46`), and `amendInvoice`'s missing IRN guard (`sales.service.ts:847-849`, mirrors
`voidInvoice`'s at line 1045-1047). G0's proposed phase list (§27) named all of these for "G2" before G1 absorbed
them — this document does not repeat that work.

**What is still open, and is G2's actual scope:** there is no formal GST Credit Note or Debit Note document anywhere
in the schema (confirmed: `grep -i "model CreditNote\|model DebitNote"` → zero matches). The GST *reversal* on a sales
return is real and correct (`createSalesReturn` posts the exact inverse of `createInvoice`'s journal,
`sales.service.ts:1549-1561`) and the same is true on the purchase side (`createPurchaseReturn`,
`procurement.service.ts:888-898`) — but neither produces a numbered, GSTIN-bearing, place-of-supply-bearing
*statutory document* a GSTR-1 CDNR schedule or a supplier's GSTR-2B reconciliation would recognize. `provisionCompany()`
still never creates a `CompanyGstRegistration` (confirmed: zero matches for `CompanyGstRegistration`/`gstRegistration`
in `provisioning.service.ts`) — a real, still-open gap G0 §11 named and G1 did not close. Invoice numbering is
company-wide, not per-GST-registration (`numberSequence.ts:48-52`), which is already a latent mismatch for a
multi-GSTIN company today and must not be compounded by how G2's new document types are numbered.

**Design posture:** every new document reuses an existing pattern rather than inventing one — `CreditNote`/`DebitNote`
mirror `SalesReturn`/`PurchaseReturn`'s shape plus `TaxInvoice`'s seller/buyer snapshot columns; their print templates
mirror `TaxInvoiceTemplate`'s Json-layout-plus-server-side-whitelist pattern exactly; their numbering reuses
`nextDocumentNumber()`; their accounting reuses `postAutoJournalEntry()`/`LEDGER_ACCOUNT` with no new GL accounts.
The one real design decision this document makes and defends is **Sales Return ≠ Credit Note**: a Credit Note is
introduced as a separate, optional statutory document that either *wraps* an existing `SalesReturn` (posting no new
journal entry — the return already posted the correct one) or stands alone for a value-only adjustment that never
touched physical stock (posting its own journal, reusing the identical account codes). This resolves CLAUDE.md's I3
gap without disturbing `SalesReturn`'s existing, tested behavior.

---

## 2. Current G1 Integration Points (facts this design is built on)

| Area | Current state | File:line |
|---|---|---|
| Seller identity resolution | `resolveSellerRegistration(tx, companyId, branchId)` — branch's `gstRegistrationId`, else company's primary active registration, else legacy `Company.gstin/stateCode/name/address` fallback | `sales.service.ts:711-736` |
| Buyer snapshot | `buyerSnapshot(client, resolvedStateCode)` — pure function, captured at document-creation time | `sales.service.ts:741-750` |
| Per-line GST split | `allocateLineTax(items, discountScale, isSameState)` — CGST/SGST/IGST per line, rounds independently | `sales.service.ts:756-771` |
| Central tax engine | `priceInvoice()` — HSN batch resolution, metal-rate resolution, making-charge resolution, discount spreading, round-off; used verbatim by `createInvoice`/`amendInvoice`/`convertMemoToInvoice` | `sales.service.ts:511-704` |
| GST record | `TaxInvoice` — one row per `SalesInvoice` (`@unique` on `invoiceId`), carries the snapshot + `irn`/`ackNumber`/`qrCodeData`/`ewbNumber` (all dormant) | `schema.prisma:2734-2795` |
| Numbering | `nextDocumentNumber(companyId, documentType, prefix, tx, year)` — atomic, FY-aware (`gstFinancialYear()`), company-wide only | `shared/numberSequence.ts:42-96` |
| Print templates | `TaxInvoiceTemplate` (Json `layout`, branch-override-else-company-default-else-built-in resolution) + `taxInvoiceBoundFields.ts`'s server-enforced whitelist | `schema.prisma:205-224`, `taxInvoiceTemplate.service.ts`, `taxInvoiceBoundFields.ts` |
| Sales-return GST reversal | `createSalesReturn` — reverses `revenuePortion`/`taxPortion` per line from the invoice's own stored `taxRate`/`taxDetails`, never re-derives from today's rate | `sales.service.ts:1446-1574` |
| Purchase-return ITC reversal | `createPurchaseReturn` — reverses `GrnItem.inputCgst/Sgst/Igst` pro-rata by the return amount, never re-derives | `procurement.service.ts:797-906` |
| Void | `voidInvoice` — whole-invoice reversal, refuses if any payment/return exists or `taxDetails.irn` is set | `sales.service.ts:1026-1113` |
| Amend | `amendInvoice` — refuses if `taxDetails.irn` is set; locks any line already covered by a `SalesReturn` | `sales.service.ts:788-1008`, lock at 860-869 |
| Payment reversal | `reverseInvoicePayment` — flags the original row, posts an exact inverse journal, has its own OLD_GOLD-specific reversal branch | `sales.service.ts:1226-1385` |
| Ledger accounts | `LEDGER_ACCOUNT` — 12 codes, no Credit/Debit-Note-specific account | `shared/ledgerAccounts.ts` |
| Provisioning | `provisionCompany()` — company → roles → branch → accounts → starterPackage → admin → verify → audit. **No `CompanyGstRegistration` step exists.** | `platform/provisioning.service.ts` (grep confirmed no match) |
| Tenant-facing GST registration CRUD | `createGstRegistration`/`updateGstRegistration` — GSTIN format validation, one-`isPrimary`-per-company invariant enforced in a transaction | `company/company.service.ts:97-146` |
| Permissions | `invoice:create/edit/void`, `payment:view/create/reverse`, `return:create`, `gst:registration_view/create/edit/manage`, `taxInvoiceTemplate:view/create/edit` — **no `return:edit`/`return:void`, no credit/debit-note permission of any kind** | `shared/permissionCatalog.ts:132-172` |
| GST reporting | `getGstSummary`/`getPurchaseGstSummary` — HSN×rate grouped, already exclude `VOID` invoices (J3.5 fix) | `finance.service.ts:517-620` |

---

## 3. Credit Note Design

### 3.1 Identity & original-document relationship

`CreditNote` is a new, company-owned model. It **always** references exactly one `SalesInvoice` (`invoiceId`,
required) — G2 does not support an invoice-less/free-standing credit note. It optionally references one
`SalesReturn` (`salesReturnId`, nullable) when it wraps a physical return.

- `creditNoteNumber`, `financialYear`: from `nextDocumentNumber()` (see §8).
- `creditNoteDate`: defaults to now, editable at creation only (never after issuance — see §3.6).
- Seller identity: **not re-resolved.** Copied straight from the parent invoice's own `TaxInvoice` row
  (`sellerRegistrationId`, `sellerLegalName`, …, `gstin`, `placeOfSupply`) — a Credit Note corrects what was charged,
  so it must describe the same seller/place-of-supply the original invoice did, even if the branch's registration or
  the company's registration table has changed since. This mirrors `createSalesReturn`'s existing "reverse what was
  actually charged, not today's rate" rule (`sales.service.ts:1467-1473`), extended to the seller side.
- Buyer identity: same — copied from the invoice's own `TaxInvoice` buyer-snapshot columns, never re-resolved from
  the live `Client` row.
- Original-invoice reference fields stored directly on `CreditNote` (not just the FK) for print/report convenience
  and so the document is self-contained if the invoice is ever amended later: `originalInvoiceNumber`,
  `originalInvoiceDate`.

### 3.2 What G2 supports

| Case | Supported? | Mechanism |
|---|---|---|
| Full invoice credit | Yes | All lines selected, no `amount` overrides (defaults to each line's full tax-inclusive value, same default `createSalesReturn` already uses at `sales.service.ts:1482`) |
| Partial invoice credit | Yes | Subset of lines, or an `amount` override per line (same shape as `createSalesReturn`'s `items: Array<{invoiceItemId, amount?}>`) |
| Item-level credit | Yes | One `CreditNoteItem` per selected `InvoiceItem`, same granularity as `SalesReturnItem` |
| Value-only adjustment (no physical return) | Yes, as a distinct path — see §3.4 | A single `CreditNoteItem` with `invoiceItemId: null`, a manually entered taxable value, and an HSN resolved fresh (same per-line HSN/GST-rate lookup `priceInvoice()` already does) |
| Multiple Credit Notes against one invoice | Yes | Many `CreditNote` rows per `invoiceId`; guarded against over-crediting (§3.7) |

### 3.3 Reason model

Free-text alone is not enough for a document GSTR-1's CDNR schedule expects a reason code for. `CreditNote` carries
**both**: `reasonCode` (a constrained string, validated server-side against a fixed whitelist constant — the same
"free-text convention, service-layer-validated" pattern the codebase already uses for `MakingCharge.karat`/
`JewelryTag.metalKarat`, not a Prisma enum) and `reasonNotes` (optional free text for internal context). Proposed
whitelist (`shared/gstDocumentReasons.ts`):

```
SALES_RETURN            — goods returned (auto-set when salesReturnId is present)
POST_SALE_DISCOUNT      — price reduced after issuance
DEFICIENCY_IN_SERVICE   — e.g. a repair/service charge waived after billing
CORRECTION_IN_INVOICE   — a genuine invoicing error (wrong rate/qty/party) corrected after issuance
CHANGE_IN_POS           — place-of-supply was wrong on the original invoice
OTHER                   — reasonNotes required when this is chosen
```

**COMPLIANCE CONFIRMATION REQUIRED** (§17): the exact reason-code vocabulary GSTR-1's CDNR schedule expects (and
whether it differs for B2B vs B2C notes) must be confirmed against current GST return-filing documentation before
this list is finalized — the six above are a reasonable software-level default, not sourced from a filing spec.

### 3.4 Sales Return ≠ GST Credit Note — the actual relationship

**Do not equate them.** `SalesReturn` stays exactly as it is (§6.11 "Hard rules" line: "preserve existing
sales-return behaviour unless G2 specifically requires an extension" — it does not; `SalesReturn` needs zero
schema/behavior change). Two creation paths:

**Path A — Credit Note wrapping a physical return (the common case).** `createSalesReturn()` gains one new optional
parameter, `issueCreditNote?: boolean` (default `false` — existing callers/behavior unchanged unless they opt in).
When `true`, in the **same transaction**, after the `SalesReturn` + its journal entry are created exactly as today:
- Create one `CreditNote` (`salesReturnId` set) + one `CreditNoteItem` per `SalesReturnItem`, copying
  `revenuePortion`/`taxPortion`/`amount` straight from the already-computed `resolvedItems` (no recomputation, no
  second tax-split derivation).
- **Post no new journal entry.** `CreditNote.journalEntryId` points at the `JournalEntry` the return's own
  `postAutoJournalEntry()` call already created (looked up by `referenceType: 'SalesReturn', referenceId: salesReturn.id`
  inside the same transaction). A Credit Note in this path is the *statutory paperwork* for a reversal the ledger
  already reflects correctly — posting a second entry would double-count it.
- Same-state/inter-state is inherited from `taxDetails` exactly as `createSalesReturn` already resolves it
  (`sales.service.ts:1473`), never re-resolved.

**Path B — standalone Credit Note (value-only adjustment, no physical return).** A new function,
`createStandaloneCreditNote()`, for a correction that never touched inventory — a post-sale discount, a billing
error, a waived service charge. Requires `invoiceId` + one or more lines, each either referencing an existing
`InvoiceItem` (partial value against a real line, `tagId` untouched — no stock movement) or a free `taxableValue`
with an HSN (defaults to the invoice's own default-HSN pattern). This path **does** post its own journal — see §7.

**Historical-return backfill note (not implemented in G2, a documented capability):** because `SalesReturn` predates
`CreditNote`, a company may want to retroactively issue a formal Credit Note for an old, already-reversed
`SalesReturn`. Path A's transaction naturally supports this if invoked with an existing `salesReturnId` and no new
`SalesReturn` creation — but G2 does not build a dedicated "backfill" endpoint; it is a documented, deferred
extension (§24), not required for the buy→stock→sell loop's own correctness today.

### 3.5 Tax

Each `CreditNoteItem` carries the same tax-snapshot shape `InvoiceItem`/`SalesReturnItem` already use:
`hsnCodeId`, `taxRate` (copied from the original line, **never re-looked-up** — a later HSN-rate change must not
reprice a historical credit note, same immutability rule as everywhere else in this codebase), `taxableValue`,
`cgstAmount`/`sgstAmount`/`igstAmount`, `lineTotalTax`. UOM (`InvoiceItem.uom`, G1 Part D) is copied through for
print/GSTR-1 line consistency. `CreditNote` header totals (`taxableAmount`, `cgst`, `sgst`, `igst`, `totalTax`,
`totalAmount`) are the sum of its items — computed, not independently entered.

### 3.6 Immutability

A `CreditNote`, once created, is **not editable** — the same "documents are a fixed legal record" posture as
`TaxInvoice`. Only a `status` transition exists: `ISSUED` (the only state on creation) → `CANCELLED`, and only for a
**standalone** (Path B) Credit Note with no other document referencing it, which reverses its own journal entry
exactly like `voidInvoice` reverses `createInvoice`'s. **A return-linked (Path A) Credit Note cannot be cancelled
in-app** — cancelling it would have to also unwind the `SalesReturn` it wraps, and `SalesReturn` is explicitly
append-only (CLAUDE.md J3 Decision 5: "no un-return capability was built... corrected by selling it again"). This is
the same precedent applied consistently to the new document, not a new rule invented for it.

### 3.7 Over-crediting guard

Before creating any `CreditNote` (either path), sum **both** (a) every prior `SalesReturnItem.amount` for the
touched `InvoiceItem`s that has no `CreditNote` yet, and (b) every prior `CreditNoteItem.totalValue` for the same
lines — the combined total must not exceed the original `InvoiceItem.totalPrice` (tax-inclusive). Both are counted
because a company may have `SalesReturn` history that predates G2 and has no Credit Note attached yet; the guard
must not let a first retroactive Credit Note plus a second one together exceed what was actually charged. This is a
live aggregate check at creation time (same "computed, not cached" pattern as `getDealerAging`/`checkCreditLimit`),
not a stored running counter.

---

## 4. Debit Note Design

Structurally the mirror of §3, on the purchase side, with three necessary differences from the sales side:

1. **No "original invoice" model exists to reference.** TRIVO has no `PurchaseInvoice` model — the supplier's own
   bill is represented by `GoodsReceiptNote.invoiceNumber`/`invoiceDate` (confirmed: `schema.prisma:902-934`, no
   `PurchaseInvoice` model anywhere). `DebitNote.originalGrnId` (→ `GoodsReceiptNote`) plus stored
   `originalSupplierInvoiceNumber`/`originalSupplierInvoiceDate` (copied from the GRN at creation time) is the
   correct reference — not an invented `PurchaseInvoice` FK.
2. **No IRN concept applies.** E-invoicing is a *supplier's outward-document* obligation under Indian GST — TRIVO is
   the buyer on this side. `DebitNote` therefore carries none of `TaxInvoice`'s `irn`/`ackNumber`/`qrCodeData`
   columns; only `ewbNumber`-equivalent fields are plausible (inbound e-way bill reference) and are left out of G2's
   schema as not required for this phase (§24).
3. **No purchase-side amend/void exists to guard.** Procurement has no `voidGrn`/`amendGrn`. There is therefore no
   lifecycle guard to extend on this side (unlike `voidInvoice`/`amendInvoice` on the sales side, §5) — `DebitNote`
   creation only needs to check the GRN/tag's own current state, exactly as `createPurchaseReturn` already does.

### 4.1 Supported cases

Same shape as Credit Note §3.2: full/partial/item-level, against tags sourced from a GRN line
(`JewelryTag.grnItemId` or `.purchaseLot.grnItemId`, same `sourceOf()` resolution `createPurchaseReturn` already
uses, `procurement.service.ts:819`), plus a **standalone, no-physical-return** case — e.g. the supplier agrees to a
price reduction without taking goods back (a real, common scenario: a quality deduction, a rate renegotiation).

- **Path A** — `createPurchaseReturn()` gains `issueDebitNote?: boolean`, mirroring §3.4 Path A exactly: the
  `DebitNote` wraps the existing `PurchaseReturn`, no new journal, `journalEntryId` points at the return's own entry
  (`referenceType: 'PurchaseReturn'`).
- **Path B** — new `createStandaloneDebitNote()`: requires a `grnId` + supplier (derived from the GRN's PO), a
  taxable-value adjustment, and posts its own journal (§7) — no tag/stock interaction, `Supplier.currentDue` moves.

### 4.2 Reason model

Same `reasonCode` pattern as §3.3, purchase-flavored: `PURCHASE_RETURN` (auto-set when `purchaseReturnId` is
present), `PRICE_VARIANCE`, `SHORT_SUPPLY`, `QUALITY_DEDUCTION`, `CORRECTION_IN_GRN`, `OTHER`.

### 4.3 Immutability & cancellation

Identical posture to §3.6: issued, not editable; only a standalone Debit Note may be cancelled (reverses its own
journal); a return-linked one cannot (mirrors `PurchaseReturn`'s own append-only posture, which G2 does not change).

---

## 5. Invoice / GST Document Lifecycle

### 5.1 Before an IRN exists (today's only reachable state — IRN is always null in G2)

| Action | Allowed? | Current/extended guard |
|---|---|---|
| Amend (`amendInvoice`) | Yes | Blocked once any `SalesReturn` **or** `CreditNote` touches a line (extend the existing lock at `sales.service.ts:860-869` to also check `CreditNoteItem`) |
| Void (`voidInvoice`) | Yes, only if untouched | Blocked if any payment, `SalesReturn`, **or** `CreditNote` exists (extend the existing checks at `sales.service.ts:1039-1044`) |
| Return (`createSalesReturn`) | Yes | Blocked only if invoice is `VOID` (existing, `sales.service.ts:1465`) |
| Credit Note | Yes | Blocked only if invoice is `VOID`; **not** blocked by an existing payment or a prior partial return (over-crediting guard, §3.7, is the real limit) |
| Paid (`recordPayment`) | Yes | Unaffected by G2 |

### 5.2 After an IRN exists (a future state, once G3/G4 build real IRP integration)

The design decided here, for when that day comes:

- **Amend: forbidden** — already enforced (`sales.service.ts:847-849`).
- **Void: forbidden** — already enforced (`sales.service.ts:1045-1047`), and the guard's own message already points
  at the correct alternative.
- **Credit Note: the intended, legal correction path.** Deliberately **not gated by `TaxInvoice.irn`** — unlike
  amend/void, issuing a Credit Note is the statutorily correct way to correct a post-IRN invoice. G2's `CreditNote`
  model carries its own dormant `irn`/`ackNumber`/`qrCodeData` columns (§10) so that when e-invoicing for CDNR
  documents is eventually wired up (above the applicability threshold, itself a **COMPLIANCE CONFIRMATION
  REQUIRED** item), no new columns are needed — only the generation logic.
- **A full, 100%-value Credit Note is the closest in-system equivalent to "cancelling" a post-IRN invoice.** The
  invoice itself stays `ISSUED`/whatever its status was (never flips to `VOID` after IRN — `voidInvoice` already
  refuses this); its economic effect is zeroed by the Credit Note. This is a **design principle to carry forward**,
  not new code proposed in G2 (no IRN exists yet to exercise it against).

### 5.3 Ambiguous cases (Part 4's required table)

| Condition | Amend | Void | Return | Credit Note |
|---|---|---|---|---|
| Invoice has payments | Blocked only if customer changes (existing) | **Blocked** (existing) | Allowed (existing) | Allowed |
| Invoice has a return | Blocked on touched lines only (existing) | **Blocked** (existing) | Allowed on untouched lines | Allowed (over-crediting guard applies) |
| Invoice has a Credit Note | **Blocked on touched lines (NEW — extend existing lock)** | **Blocked (NEW — extend existing check)** | Allowed on untouched lines | Allowed on remaining creditable value |
| Invoice has IRN | Blocked (existing) | Blocked (existing) | Allowed (unaffected today — IRN is always null) | **Allowed — the intended path** |
| Invoice has an e-way bill | *(dormant field, always null today; no logic references it — same posture as IRN once populated, not implemented)* | | | |
| Invoice already VOID | N/A | Already rejects re-void (existing) | **Blocked** (existing, `sales.service.ts:1465`) | **Blocked (NEW check needed on the standalone path — Path A inherits it via the SalesReturn check)** |
| Credit Note partially used | N/A | N/A | N/A | **The existing CN is never edited; only a new CN may be issued for the remainder (§3.6)** |
| Customer balance changed since | N/A | N/A | Unaffected — return computes its own delta, never reads `currentBalance` (existing) | Unaffected — same reasoning (§3.7 note) |

---

## 6. Unified GST Calculation Engine

**Current state, precisely (re-verified, not assumed from G0):** `priceInvoice()` is already the single source of
truth for `createInvoice`/`amendInvoice`/`convertMemoToInvoice` (`sales.service.ts:511-704`, called at lines 255,
811, 1832). G0's finding that `convertMemoToInvoice` diverges is **stale** — G1 fixed it. The one real duplication
left is small and structural, not a second formula: the same three-line same-state/inter-state split —

```ts
cgstAmt = isSameState ? taxAmount / 2 : 0;
sgstAmt = isSameState ? taxAmount / 2 : 0;
igstAmt = isSameState ? 0 : taxAmount;
```

— appears independently at `sales.service.ts:366-368` (`createInvoice`), `918-920` (`amendInvoice`), and `1856-1858`
(`convertMemoToInvoice`). It is not wrong (all three copies are identical and correct), but it is copy-pasted, and
G2 adds two more legitimate callers (`createStandaloneCreditNote`, `createStandaloneDebitNote`).

**Proposed extraction (pure refactor, zero behavior change, zero migration risk):**

```ts
// shared/gstSplit.ts (or inline in sales.service.ts, exported)
export function splitGst(taxAmount: number, isSameState: boolean): { cgst: number; sgst: number; igst: number } {
  return isSameState
    ? { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0 }
    : { cgst: 0, sgst: 0, igst: taxAmount };
}
```

Used by all five callers (the three existing ones, unchanged output, plus the two new standalone GST-document
functions). This is the **entire** "unified engine" change G2 needs — `priceInvoice()`, `allocateLineTax()`,
`resolveSellerRegistration()`, and `buyerSnapshot()` are already correctly centralized and are reused as-is by every
new function in this document, never reimplemented. **No second GST calculation engine is introduced.**

**Target reuse map (Part 5's required diagram, actual):**

```
                       priceInvoice()  ──┬── createInvoice()
splitGst()             (full re-price)   ├── amendInvoice()
allocateLineTax()                        └── convertMemoToInvoice()
resolveSellerRegistration()
buyerSnapshot()        (snapshot-inherit,
                         no re-price)    ──┬── createSalesReturn()            [existing]
                                           ├── createStandaloneCreditNote()   [NEW — fresh HSN lookup for its own line]
                                           ├── createPurchaseReturn()         [existing]
                                           └── createStandaloneDebitNote()    [NEW — fresh HSN lookup for its own line]

                        (pure snapshot-copy,
                         no calculation)  ──┬── CreditNote Path A (wraps SalesReturn)
                                            └── DebitNote Path A (wraps PurchaseReturn)
```

A return-linked Credit/Debit Note does no tax *calculation* at all — it copies numbers `createSalesReturn`/
`createPurchaseReturn` already computed. A standalone one uses `splitGst()` plus a fresh single-line HSN/rate lookup
(the same `hsnByCode`/`resolveMetalRate`-style lookup `priceInvoice()` already does for one line — not a new engine,
a narrower single-line invocation of the existing one).

---

## 7. Purchase GST Hardening

Confirmed current state (§2, re-verified against `procurement.service.ts:797-906` directly): ITC booking at intake
and its exact pro-rata reversal at return are both already correct and already match CLAUDE.md's Phase I2 claim. The
minimum G2 needs on the purchase side, to be structurally ready for Debit Notes (per the "do NOT implement GST
return filing" instruction, this is intake-readiness, not filing):

1. **`DebitNote`/`DebitNoteItem` models** (§4) — the actual new capability.
2. **`getPurchaseGstSummary()` must exclude Debit-Note-touched value the same way it already nets off
   `PurchaseReturnItem`** (`finance.service.ts:568-...`, the `add(..., sign: 1 | -1, ...)` pattern already exists for
   returns) — a **standalone** Debit Note (no `PurchaseReturn`) needs the identical netting treatment added, since it
   moves ITC that a return-linked one already gets via the existing return-netting code. This is additive to an
   existing function, not a new report.
3. **No change to `GrnItem`, `PoItem`, or intake booking itself** — Debit Notes read from GRN/PoItem's existing
   `taxRate`/`inputCgst/Sgst/Igst` snapshot exactly as `createPurchaseReturn` already does; nothing about how tax is
   booked at intake needs to change for G2.

**Explicitly not built in G2** (per the instruction): GSTR-2B reconciliation, GSTR-3B ITC-eligibility computation, or
any filing-shaped export beyond what `getPurchaseGstSummary` already produces (HSN×rate prep rows).

---

## 8. Accounting / Journal Design

**No new ledger account is required.** `CreditNote`/`DebitNote` reuse `LEDGER_ACCOUNT.SALES_REVENUE`/
`ACCOUNTS_RECEIVABLE`/`CGST_PAYABLE`/`SGST_PAYABLE`/`IGST_PAYABLE` (sales side) and `ACCOUNTS_PAYABLE`/`INVENTORY`/
`INPUT_CGST/SGST/IGST` (purchase side) — the exact same accounts `SalesReturn`/`PurchaseReturn` already post to.
This matches the explicit instruction not to invent new accounting concepts, and is a deliberate choice **against**
a GAAP-style contra-revenue account (`4100 Sales Returns & Allowances`) that would present gross revenue
differently — that would be a real accounting-policy change, out of scope, and inconsistent with `SalesReturn`'s
already-shipped, already-tested presentation. Noted as an explicitly deferred alternative (§24), not proposed here.

| Document | Debit | Credit | GST effect | Stock effect | New journal posted? |
|---|---|---|---|---|---|
| Sales Invoice (existing) | AR | Sales Revenue, CGST/SGST/IGST Payable, (Inventory via COGS) | Output tax accrues | `SOLD` | Yes (existing) |
| Sales Return (existing) | Sales Revenue, CGST/SGST/IGST Payable, Inventory | AR, COGS | Output tax reversed | back to `IN_STOCK` | Yes (existing) |
| **Credit Note — Path A (wraps a return)** | — | — | — | — | **No.** `journalEntryId` = the return's own entry |
| **Credit Note — Path B (standalone)** | Sales Revenue (± discount), CGST/SGST/IGST Payable | AR | Output tax reversed | **None** (no tag touched) | **Yes — its own entry** |
| Purchase Invoice / GRN intake (existing) | Inventory, Input CGST/SGST/IGST | Accounts Payable | Input tax credit claimed | `JewelryTag` created | Yes (existing) |
| Purchase Return (existing) | Accounts Payable | Inventory, Input CGST/SGST/IGST | ITC reversed | tag → `RETIRED` | Yes (existing) |
| **Debit Note — Path A (wraps a return)** | — | — | — | — | **No.** `journalEntryId` = the return's own entry |
| **Debit Note — Path B (standalone)** | Accounts Payable | Inventory (or a variance/expense account if no specific line — see note) | ITC reversed | **None** | **Yes — its own entry** |

**Note on Path B Debit Note's credit side:** a pure price-variance Debit Note with no specific `GrnItem`/tag line to
attribute the reduction to (e.g. "supplier granted a flat ₹5,000 reduction on the whole bag") has no natural
`Inventory` line to credit at the piece level, since the bag's pieces may already be tagged and sold individually.
**Design decision:** credit `LEDGER_ACCOUNT.INVENTORY` anyway when the GRN's lot/pieces are still substantially
`IN_STOCK` (consistent with `PurchaseLot`'s existing `costVariance` concept — CLAUDE.md I6 — which already tracks
"the ledger keeps the invoice amount, so a gap stays in Inventory until adjusted"); this is intake-symmetric and
requires no new account. **COMPLIANCE-ADJACENT, not GST-compliance:** this is an accounting-policy judgment call
(is a post-hoc price variance an inventory-cost adjustment or a period expense?), not a statutory GST question —
flagged for the business/accountant to confirm, not blocking G2's schema design.

**Document creation vs. accounting posting vs. reversal vs. void — kept distinct, per the instruction:**
- *Creation* = writing the `CreditNote`/`DebitNote` row + items. Always happens.
- *Posting* = the journal entry. Happens only on the standalone path (Path B); Path A creation never posts.
- *Reversal/cancellation* = only reachable for a standalone (Path B) document (§3.6/§4.3), and posts the **exact
  inverse** of what Path B's own creation posted — never edits the original entry, following the codebase's one
  established reversal idiom everywhere (`voidInvoice`, `reverseInvoicePayment`, `createSalesReturn` itself).
- *Void* (as a distinct concept from cancellation) is **not** introduced for Credit/Debit Notes in G2 — "cancelled"
  (§3.6/§4.3) is the only terminal state, deliberately reusing `voidInvoice`'s reversal mechanics without reusing its
  name, since a Credit Note being "voided" would be confusable with voiding the *invoice* it corrects.

---

## 9. Credit / Debit Note Numbering

Reuses `nextDocumentNumber()`/`gstFinancialYear()` as-is (§2) — no new numbering infrastructure. The only real
decision is the **key** the sequence is scoped by.

| Option | Mechanism | Tradeoff |
|---|---|---|
| **Company-wide** (same as today's `INV`/`SRET`/`PRET`) | `documentType: 'CN'` | Simplest; consistent with every existing document type; but statutorily an invoice/document series must be unique **per GSTIN** (Rule 46(b)), and this codebase already has a latent mismatch here for `INV` in a multi-GSTIN company (G0 §9's own finding) — company-wide `CN` numbering would compound that same latent gap for a new document type, not just inherit it silently. |
| **Branch-specific** | `documentType: 'CN:' + branchId` | Branches aren't GST identities in this schema (§2 — `Branch.gstRegistrationId` is what carries GST meaning, not the branch itself); using branch as the numbering key would be scoping by the wrong axis whenever a branch has no explicit registration override and falls back to the company primary. |
| **GST-registration-specific (recommended)** | `documentType: 'CN:' + sellerRegistrationId` (or a fixed sentinel for the legacy no-registration-table fallback, e.g. `'CN:LEGACY'`) | Matches the statutory unit (Rule 46(b) is per-GSTIN); directly analogous to the already-proven pattern of embedding a scoping key into `documentType` (`nextTagNumber`'s `TAG:<stockType>:<category>`, `shared/numberSequence.ts:120-129`) — not a new mechanism, an existing one applied to a new key. |

**Recommendation: GST-registration-specific**, for the reasons above. This is deliberately **narrower** scope than
fixing `INV` numbering itself (which stays company-wide in G2, unchanged, per "do not redesign G1") — it does mean
`CreditNote`/`DebitNote` numbering and `SalesInvoice` numbering will use different scoping keys for a while, which is
an intentional, documented inconsistency (§24), not an oversight: fixing `INV` to be registration-scoped too is a
real, valuable follow-up, but it is a change to G1's already-frozen numbering behavior for every existing invoice
series, which this document explicitly declines to propose.

**COMPLIANCE CONFIRMATION REQUIRED:** whether GST rules require credit-note and debit-note numbering to share the
same series/prefix space as invoices, or may run independent series — current guidance is generally understood to
allow an independent alpha-numeric series per document type per GSTIN, but this must be confirmed against current
official rules before implementation, not assumed from this document.

Format: `CN-<FY>-<sellerRegistrationId-or-LEGACY short code>-<6-digit sequence>` for Credit Notes, `DN-...` for
Debit Notes (purchase side has no registration concept — see §4 point 2 — so Debit Note numbering is simply
company-wide FY-scoped, `documentType: 'DN'`, no registration key needed).

---

## 10. Credit / Debit Note Templates

Two new models, **structurally identical siblings of `TaxInvoiceTemplate`**, not a shared polymorphic table (G1's
`TaxInvoiceTemplate` is frozen and not touched; the codebase's own established precedent for this exact situation is
"copy, never share" — same reasoning as `starterMasters.ts`'s "COPY, never reference" rule, applied here to avoid
retrofitting a `documentType` discriminator onto an already-shipped, tested model):

- `CreditNoteTemplate` (`companyId`, `name`, `description`, `branchId?`, `layout: Json`, `isDefault`, `isActive`,
  `createdById`) — identical shape to `TaxInvoiceTemplate`.
- `DebitNoteTemplate` — identical shape, purchase-flavored (`branchId` is less meaningful here since purchase has no
  per-branch GST identity — kept nullable/company-wide-only in practice, not removed from the shape, for structural
  consistency with its sibling).

New whitelist files, following `taxInvoiceBoundFields.ts`'s exact pattern (server-enforced, hard-throw on anything
unrecognized, presentation-only — **a template can never change what a GSTIN, tax amount, or document number
prints, only whether/where it appears**):

- `shared/creditNoteBoundFields.ts` — `CREDIT_NOTE_BOUND_FIELDS` = the `TAX_INVOICE_BOUND_FIELDS` set (seller/buyer/
  totals/payment/einvoice) **plus** `originalInvoice.number`, `originalInvoice.date`, `originalInvoice.placeOfSupply`,
  `reason.code`, `reason.notes`, `creditNote.number`, `creditNote.date`.
- `shared/debitNoteBoundFields.ts` — mirrors it: `originalGrn.number`/`originalGrn.date`/`supplierInvoice.number`/
  `supplierInvoice.date`, `supplier.*` in place of `buyer.*`, no `eInvoice` section (§4 point 2).

`resolveTaxInvoiceBoundField`'s exact structure (whitelist check → `get()` by dotted path → money/date formatting)
is duplicated for each new bound-field module, **not parameterized into one generic resolver** — this matches the
codebase's own stated precedent (`TaxInvoiceTemplate`'s comment explicitly contrasts itself with
`EstimateTemplate`/`TagTemplate`'s less-strict pattern) that a *statutory* document's field resolution should stay
simple, explicit, and easy to audit per document type rather than share a clever generic mechanism across them.

Resolution order at print time: branch-specific template → company default → safe built-in fallback (identical
three-tier resolution to `resolveTaxInvoiceTemplate`, §2) — `resolveCreditNoteTemplate(companyId, branchId)` /
`resolveDebitNoteTemplate(companyId)` (no branch tier on the purchase side).

---

## 11. IRP-Ready Boundary

Per G0 §26's still-open question (not resolved by G1): whether `irn`/`ewbNumber` should live directly on each GST
document row (today's `TaxInvoice` pattern) or move to a new consolidated `EInvoice` table. **G2 recommends
extending G1's existing pattern** — add the same dormant columns (`irn`, `ackNumber`, `ackDate`, `qrCodeData`)
directly onto `CreditNote` (no `ewbNumber`/`ewbValidUntil` — e-way bills don't apply to credit notes) rather than
introducing a new cross-cutting table in this phase. Reasoning: G1 already shipped and tested this exact shape on
`TaxInvoice`; duplicating it onto one more row type is zero new *pattern* risk, whereas building a polymorphic
`EInvoice(documentType, documentId)` table now — before any real IRP integration exists to prove the shape against —
risks guessing wrong about what a real integration needs. **This recommendation does not resolve G0's original
`TaxInvoice` vs. `ExportDocument` ownership ambiguity** (§26) — that predates G2 and stays open, explicitly deferred
(§24), since fixing it would mean touching `ExportDocument`, which is outside this phase's named scope.

```
SalesInvoice ── TaxInvoice (irn/ack/qr — dormant)
CreditNote ─────────────────────── (irn/ack/qr — dormant, NEW, same shape)
      ↓                                    ↓
Future EInvoiceService (G3/G4) ─── IRP (generation, cancellation, CDNR e-invoicing above threshold)
```

`DebitNote` carries **no** e-invoice columns at all (§4 point 2 — it is never the outward document TRIVO itself
would submit to an IRP).

What must exist now, so G3/G4 doesn't require a schema restructure: (1) the dormant IRN columns on `CreditNote`
(above); (2) `CreditNote`/`DebitNote` already snapshot seller/buyer/tax exactly like `TaxInvoice` does, which is
the actual payload shape a future e-invoice JSON builder would read from — nothing further needs to be added for
that; (3) numbering is already FY- and registration-aware (§9), which a real IRP payload requires. **Not** built now,
correctly deferred to G4 per G0 §18/§21: any idempotency/retry infrastructure, since none exists anywhere in this
codebase yet and inventing it speculatively for a document type with no live integration would be exactly the kind
of "design ahead of use" this document's own instructions warn against.

---

## 12. Company Provisioning

**Confirmed gap, independently re-verified in this pass:** `provisioning.service.ts` never creates a
`CompanyGstRegistration` row (grep: zero matches). Today, a newly provisioned company has zero rows in that table,
and `resolveSellerRegistration()` correctly falls back to the legacy `Company.gstin`/`stateCode`/`name`/`address`
fields (§2) — so nothing is *broken*, but the company-facing GST Registrations screen (`GstRegistrationsPage.tsx`,
already in this branch's working tree per `git status`) would show an empty list for every company provisioned this
way, and the "legal name" printed on invoices would be `Company.name` (the operator-entered company display name,
not necessarily the GST-registered legal name) rather than a proper `CompanyGstRegistration.legalName`.

**Proposed flow:**

```
provisionCompany()
  company → roles → branch → accounts → starterPackage → admin
                                                              ↓
                                        [NEW, conditional] CompanyGstRegistration (if GSTIN supplied)
                                                              ↓
                                                          verify → audit
```

- **GSTIN provided at provisioning:** create one `CompanyGstRegistration` row inside the same provisioning
  transaction, `isPrimary: true, isActive: true`, using `createGstRegistration`'s own validation
  (`assertValidGstin`, `company.service.ts:87-91`) reused, not reimplemented. `legalName` defaults to the operator-
  supplied company legal name if given separately, else `Company.name`. If provisioning fails after this step, the
  whole transaction rolls back exactly as every other provisioning step already does (`provisionCompany`'s own
  documented "any failure rolls the whole company back" contract, CLAUDE.md §11 item 3, is unchanged and covers
  this new step for free since it's inside the same transaction).
- **GSTIN not provided:** create **zero** `CompanyGstRegistration` rows — identical to today's behavior. The legacy
  `Company.gstin`/`stateCode` fields also stay null, and `resolveSellerRegistration()`'s existing fallback path
  (`sales.service.ts:729-735`) is exercised exactly as it already is for such a company. **No behavior change for a
  non-GST company.**
- **GST registration added later** (a company that started non-GST and later registers): unchanged — uses the
  already-shipped tenant-facing `createGstRegistration()` (§2), no provisioning-time involvement needed.

**Legacy `Company.gstin`/`stateCode` fields:** left exactly as G1 left them — the migration-time backfill source,
still read by `resolveSellerRegistration()`'s final fallback. This proposal does not touch them; it only makes the
happy path (a GSTIN known at provisioning time) skip straight to a proper `CompanyGstRegistration` row instead of
requiring a manual follow-up step through the tenant UI immediately after provisioning.

---

## 13. Permissions

Mapped against the existing RBAC philosophy (flat `resource:action` strings, `requirePermission()` at the router
layer, `SUPER_ADMIN`'s `'*'` always has everything) — **not a new permission system**, and following J4's own
precedent of shipping new capability-gating permissions without assuming which starter role should hold them yet
(J4-D3 left the five J3 admin permissions SUPER_ADMIN-only pending a business decision; the same posture applies to
some of these).

| Permission | Gates | Default starter-role grant |
|---|---|---|
| `creditNote:view` | List/read Credit Notes | Same roles as `invoice:create`'s holders today (`SALES_MANAGER`, `ACCOUNTANT`) — routine, view-only |
| `creditNote:create` | `createStandaloneCreditNote`, and the `issueCreditNote` flag on `createSalesReturn` | Same roles as `return:create` today — a Credit Note here is the statutory paperwork for an action those roles can already perform |
| `creditNote:cancel` | Cancelling a standalone Credit Note (§3.6) | **SUPER_ADMIN-only initially** — same posture as `invoice:void`/`payment:reverse` (J3/J4), a reversal-class action, not a routine one |
| `debitNote:view` | List/read Debit Notes | Same roles as `grn:view`/`po:approve`'s holders (`PRODUCTION_MANAGER`, `ACCOUNTANT`) |
| `debitNote:create` | `createStandaloneDebitNote`, and the `issueDebitNote` flag on `createPurchaseReturn` | Same roles as purchase-return creation today |
| `debitNote:cancel` | Cancelling a standalone Debit Note | **SUPER_ADMIN-only initially**, same reasoning as `creditNote:cancel` |
| `creditNoteTemplate:view/create/edit` | New `CreditNoteTemplate` CRUD | Mirrors `taxInvoiceTemplate:*`'s existing 3-verb convention and holders exactly |
| `debitNoteTemplate:view/create/edit` | New `DebitNoteTemplate` CRUD | Same |

**No `:approve` permission is proposed for either document.** Unlike `po:approve`/`po:approve_high_value` (a control
on committing spend *before* it happens), a Credit/Debit Note documents something that has already happened
(a return) or is a correction someone with `creditNote:create` is already trusted to make — introducing a separate
approval step would be new workflow, not requested by G2's brief, and not mirrored by any equivalent step in
`SalesReturn`/`PurchaseReturn` today (`return:create` alone gates the existing, un-approved return flow). If the
business later wants an approval gate, it is a genuinely new workflow decision, not a G2 default.

**No Prisma migration is needed for the permission strings themselves** — `Role.permissions` is `String[]`, exactly
as J4's own summary states (§11 item 11 of that phase). **No starter-role backfill is proposed to run automatically**
— same "ships in the catalog, granted explicitly by each company's own SUPER_ADMIN or via a future opt-in backfill
script" posture as every prior permission addition in this codebase's history (`masters:view`, the J2 `client:*`
slice, all of J4).

---

## 14. Audit Trail

Standard `createAuditEntry(tableName, recordId, userId, action, before, after, companyId)` calls, following the
exact pattern already used for every other lifecycle mutation in this codebase (§2's citations) — no new audit
mechanism.

| Event | `tableName` | `action` | Notes |
|---|---|---|---|
| Credit Note created (either path) | `credit_notes` | `CREATE` | `after` includes `salesReturnId` (null for Path B) and the full line breakdown, matching `createSalesReturn`'s own audit shape |
| Credit Note cancelled | `credit_notes` | `CANCEL` | `before`/`after` = status + the reversed journal's reference, same shape as `voidInvoice`'s audit entry |
| Debit Note created / cancelled | `debit_notes` | `CREATE` / `CANCEL` | Mirrors the above |
| Credit/Debit Note linked to a return (Path A) | *(part of the CREATE entry above — no separate LINK event; the link is set once, at creation, and is never changed afterward — §3.6)* | | An `UNLINK` action is **not** designed, since a Path-A document's `salesReturnId` is immutable by construction (no edit path exists on either document — §3.6/§4.3) |
| Template CRUD | `credit_note_templates` / `debit_note_templates` | `CREATE`/`EDIT` | Mirrors `TaxInvoiceTemplate`'s existing (currently un-audited — see note below) pattern |

**Note carried over, not a G2 finding:** a check of the current codebase shows `taxInvoiceTemplate.service.ts`'s own
CRUD functions do **not** call `createAuditEntry` at all (re-verified: no `createAuditEntry` reference anywhere in
that file). Whether G2's new template CRUD should audit when G1's own precedent didn't is a real inconsistency to
flag, not silently copy — **recommendation: audit the new template CRUD** (template content controls what a
statutory document looks like, arguably audit-worthy), but this is **new behavior beyond G1's own precedent**, not
required to match it, and should be called out to the implementer explicitly rather than assumed.

No secrets/PII beyond what `CreditNote`/`DebitNote` already legitimately carry (buyer/seller GSTIN, address — the
same category of data `TaxInvoice`'s audit-adjacent fields already carry today, not a new sensitivity class).

---

## 15. RLS / Tenant Model

Every new model is company-owned, following the exact playbook already proven for `CompanyGstRegistration`/
`TaxInvoiceTemplate`/`PurchaseLot` (G0 §17's transferable pattern, re-cited here rather than re-derived):

| Model | `companyId` | Ownership path | Composite-FK targets it needs |
|---|---|---|---|
| `CreditNote` | direct | `invoiceId` → `SalesInvoice(id, companyId)`; `salesReturnId` → `SalesReturn(id, companyId)`, both composite | `@@unique([id, companyId])` (referenced by `CreditNoteItem`) |
| `CreditNoteItem` | direct (denormalized, same RLS-without-a-join rule as `InvoiceItem`) | `creditNoteId` → `CreditNote(id, companyId)` composite; `invoiceItemId` → `InvoiceItem(id, companyId)` composite, nullable | — |
| `DebitNote` | direct | `grnId` → `GoodsReceiptNote(id, companyId)`; `purchaseReturnId` → `PurchaseReturn(id, companyId)`; `supplierId` → `Supplier(id, companyId)`, all composite | `@@unique([id, companyId])` |
| `DebitNoteItem` | direct | `debitNoteId` composite | — |
| `CreditNoteTemplate` / `DebitNoteTemplate` | direct | `branchId` composite (nullable), `createdById` → `User` (plain FK, matching `TaxInvoiceTemplate`'s own precedent exactly) | — |

Standard tenant migration shape per new table (RLS policy + `FORCE ROW LEVEL SECURITY` + the composite-FK pairs) —
copied from the most recent precedent (`20260929032454_g1_gst_foundation`'s own new-table statements), not
reinvented. Every access path goes through `tenantQuery`/`tenantTransaction`, never a bare `prisma.<model>` call —
`npm run audit:tenant` will catch a violation of this the same way it does for every other model today.

**Explicit cross-company rejection tests required** (mirrors G0 §17's own three mental tests, restated for G2's new
entities — actual test cases, not just design intent, belong in §23):
- Company A `CreditNote` → Company B `SalesInvoice` (`invoiceId`) — must 404 at creation.
- Company A `DebitNote` → Company B `GoodsReceiptNote`/`Supplier` — must 404 at creation.
- Company A `CreditNoteTemplate`/`DebitNoteTemplate` → Company B `Branch` — must 404 at creation (same
  `assertOwnedIfPresent('branch', ...)` call `taxInvoiceTemplate.service.ts:93` already makes, reused verbatim).

---

## 16. Edge Cases (Part 15's full list, answered)

**Sales:**
- *Full return* → Path A Credit Note covers every line; over-crediting guard trivially satisfied (100% of original).
- *Partial return* → Path A Credit Note covers the returned subset; guard checks only those lines.
- *Partial credit (no physical return)* → Path B, a `taxableValue` less than the line's full value.
- *Multiple Credit Notes against one invoice* → supported; guard (§3.7) sums across all prior CN + un-CN'd
  `SalesReturn` value per line.
- *Credit Note after payment* → allowed; unaffected by `InvoicePayment` (Credit Note never reads or writes payment
  rows, exactly like `SalesReturn` today).
- *Credit Note after partial payment* → same as above; the resulting negative/reduced `currentBalance` is the same
  mechanism `SalesReturn` already relies on.
- *Credit Note after invoice has been voided* → **blocked** (§5.3).
- *Credit Note against an IRN'd invoice* → **allowed — the intended path** (§5.2).
- *Customer balance adjustment* → `client.currentBalance` decremented by the CN's `totalAmount`, identical
  mechanism to `createSalesReturn`'s existing decrement (`sales.service.ts:1564-1567`).

**Purchase:**
- *Full / partial purchase return* → Path A Debit Note, mirrors sales full/partial exactly.
- *Multiple Debit Notes* → same over-crediting-style guard, purchase-side (sum against `PoItem`/GRN-line original
  taxable value).
- *Debit Note after supplier payment* → allowed; `SupplierPayment` is independent (§4).
- *Debit Note after ITC accounting* → correctly reverses ITC pro-rata from the GRN's own booked figures (§7), never
  re-derives from today's rate.
- *Debit Note without physical stock return* → Path B, supported (§4.1).

**GST:**
- *Intra-state / inter-state* → always inherited from the original document's own resolved state (§3.5/§5), never
  re-resolved from today's client/company state.
- *GST-exempt / zero-rated* → already generic via `HsnCode.gstRate = 0`; no new code path needed.
- *Missing GSTIN* → unchanged; `buyerGstin`/equivalent stays nullable, exactly like `TaxInvoice` today.
- *Changed GSTIN / changed branch registration* → CN/DN use the **original** document's snapshot, never re-resolve
  (§3.1).
- *Changed HSN rate after document issuance* → CN/DN inherit the original line's snapshotted `taxRate`, never the
  current `HsnCode` master rate (§3.5).

**Jewellery:**
- *Tag-based jewellery, weights, making charges, stone value, discounts* → carried through on `CreditNoteItem` for
  print legibility (copied from the source `InvoiceItem`), but GST math only needs `taxableValue`/`taxRate` — the
  weight fields are descriptive, not computational, on this document (§3.5).
- *Old-gold exchange / store credit* → **explicitly untouched by a Credit Note.** These are payment/settlement
  mechanisms (`OldGoldExchange`, `STORE_CREDIT` mode), not revenue/tax facts; a Credit Note only ever moves
  `currentBalance`/Revenue/GST, exactly like `SalesReturn` already does today without touching either mechanism.
  Stated explicitly here because J3 Decision 4 shows this codebase has previously gotten the OLD_GOLD-vs-payment
  distinction *wrong* once (payment reversal originally didn't account for it) — this document draws the boundary
  correctly from the start: a Credit Note is not a payment reversal and must never reach into `OldGoldExchange` or
  `MetalStock`.
- *Jewellery return* → `SalesReturn`'s job, unchanged; Credit Note wraps it (Path A).

---

## 17. Compliance Confirmation Required

None of the following were verified against current, live official GST documentation in this code-only design pass
— each is a concrete software decision that depends on current rules, not a general legal question:

1. **Credit/Debit Note reason-code vocabulary** (§3.3/§4.2) — the exact CDNR-schedule-compatible reason list, and
   whether it differs by B2B/B2C.
2. **Credit/Debit Note numbering rules** (§9) — whether a series may be independent of the invoice series, and
   whether GST-registration-scoping (this document's recommendation) is actually mandated or merely good practice.
3. **Time/period rules for issuing a Credit Note** — Indian GST law has a statutory deadline (tied to the September
   following the financial year of the original supply, or the annual return filing date, whichever is earlier) —
   this document does not implement any date-based eligibility check, and whether G2 should is itself a question
   requiring confirmation.
4. **IRN treatment for Credit/Debit Notes** — whether/when e-invoicing applies to CDNR documents themselves (above
   the same aggregate-turnover threshold as regular invoices, or a different one) — relevant to §11's dormant-column
   design, not to anything implemented now.
5. **E-invoice applicability thresholds generally** — unchanged from G0 §21, still unconfirmed, still not needed
   until G4.
6. **Document type codes** a future IRP payload would need for Credit/Debit Notes (distinct from `INV`) — deferred
   to G4, not needed for G2's schema.
7. **Original-invoice-reference requirements** — whether GSTR-1's CDNR schedule requires the original invoice number
   *and* date, or additional fields this design hasn't listed — §3.1's `originalInvoiceNumber`/`originalInvoiceDate`
   is a reasonable default, not confirmed against a filing spec.

---

## 18. Proposed Prisma Schema Changes

All additive (new models/columns only — no existing model's columns are removed or retyped). Presented as design
intent, not migration SQL (no migration is created in this phase).

```prisma
model CreditNote {
  id                       String        @id @default(cuid())
  companyId                String
  company                  Company       @relation(fields: [companyId], references: [id])
  creditNoteNumber         String
  financialYear            Int
  creditNoteDate           DateTime      @default(now())

  invoice                  SalesInvoice  @relation(fields: [invoiceId, companyId], references: [id, companyId])
  invoiceId                String
  originalInvoiceNumber    String        // copied at creation, for a self-contained print even if the invoice later changes header fields via a future amend
  originalInvoiceDate      DateTime

  salesReturn              SalesReturn?  @relation(fields: [salesReturnId, companyId], references: [id, companyId])
  salesReturnId            String?       // set = Path A (wraps a physical return); null = Path B (standalone)

  clientId                 String
  client                   Client        @relation(fields: [clientId, companyId], references: [id, companyId])

  reasonCode               String        // shared/gstDocumentReasons.ts whitelist, §3.3
  reasonNotes              String?

  // Seller/buyer snapshot — copied from the invoice's own TaxInvoice row, never re-resolved (§3.1)
  gstin                    String
  placeOfSupply            String
  sellerRegistrationId     String?
  sellerLegalName          String?
  sellerTradeName          String?
  sellerStateCode          String?
  sellerAddress            String?
  sellerCity               String?
  sellerDistrict           String?
  sellerPincode            String?
  sellerCountry            String?
  buyerName                String?
  buyerGstin               String?
  buyerPan                 String?
  buyerAddress             String?
  buyerCity                String?
  buyerState               String?
  buyerStateCode           String?
  buyerPincode             String?
  buyerCountry             String?

  taxableAmount             Decimal      @db.Decimal(12, 2)
  cgst                      Decimal      @default(0) @db.Decimal(12, 2)
  sgst                      Decimal      @default(0) @db.Decimal(12, 2)
  igst                      Decimal      @default(0) @db.Decimal(12, 2)
  totalTax                  Decimal      @db.Decimal(12, 2)
  totalAmount                Decimal     @db.Decimal(12, 2)

  status                   String        @default("ISSUED") // ISSUED | CANCELLED (§3.6)
  cancelledAt               DateTime?
  cancelledById              String?
  cancelledBy                User?        @relation("CreditNoteCancelledBy", fields: [cancelledById], references: [id])
  cancelReason              String?

  journalEntryId            String?       // Path A: the SalesReturn's own entry. Path B: this document's own entry.
  journalEntry               JournalEntry? @relation(fields: [journalEntryId], references: [id])

  // Dormant e-invoice columns — same shape as TaxInvoice (§11)
  irn                        String?
  ackNumber                  String?
  ackDate                     DateTime?
  qrCodeData                  String?

  createdById                String?
  createdBy                   User?        @relation("CreditNoteCreatedBy", fields: [createdById], references: [id])
  createdAt                   DateTime     @default(now())

  items                       CreditNoteItem[]

  @@unique([companyId, creditNoteNumber])
  @@unique([id, companyId])
  @@index([companyId])
  @@index([invoiceId])
  @@map("credit_notes")
}

model CreditNoteItem {
  id              String      @id @default(cuid())
  companyId       String
  company         Company     @relation(fields: [companyId], references: [id])
  creditNote      CreditNote  @relation(fields: [creditNoteId, companyId], references: [id, companyId], onDelete: Cascade)
  creditNoteId    String
  invoiceItem     InvoiceItem? @relation(fields: [invoiceItemId, companyId], references: [id, companyId])
  invoiceItemId   String?      // null on a value-only line with no specific original line (§3.2)

  description     String
  hsnCodeId       String?
  hsnCode         HsnCode?    @relation(fields: [hsnCodeId], references: [id])
  taxRate         Decimal     @db.Decimal(5, 4)   // snapshotted from the original line — never re-looked-up (§3.5)
  uom             String?

  taxableValue    Decimal     @db.Decimal(12, 2)
  cgstAmount      Decimal     @default(0) @db.Decimal(12, 2)
  sgstAmount      Decimal     @default(0) @db.Decimal(12, 2)
  igstAmount      Decimal     @default(0) @db.Decimal(12, 2)
  lineTotalTax    Decimal     @default(0) @db.Decimal(12, 2)
  totalValue      Decimal     @db.Decimal(12, 2)  // taxableValue + lineTotalTax

  // Print-only descriptive copy-through (§16) — not used in any calculation
  grossWeight     Decimal?    @db.Decimal(10, 4)
  netWeight       Decimal?    @db.Decimal(10, 4)
  stoneWeight     Decimal?    @db.Decimal(10, 4)
  karat           String?

  @@unique([id, companyId])
  @@index([companyId])
  @@map("credit_note_items")
}

// DebitNote / DebitNoteItem: structurally the mirror of CreditNote/CreditNoteItem, with:
//  - grnId (→ GoodsReceiptNote) + originalSupplierInvoiceNumber/Date instead of invoiceId
//  - purchaseReturnId instead of salesReturnId
//  - supplierId instead of clientId; supplier snapshot fields instead of buyer fields (seller = own company, same shape)
//  - NO irn/ackNumber/ackDate/qrCodeData columns (§4 point 2)
model DebitNote { /* mirror of CreditNote per the above deltas — omitted here for brevity, same field-for-field shape */ }
model DebitNoteItem { /* mirror of CreditNoteItem */ }

model CreditNoteTemplate {
  // Identical shape to TaxInvoiceTemplate (schema.prisma:205-224) — companyId, name, description,
  // branchId?, layout: Json, isDefault, isActive, createdById, createdAt, updatedAt
}
model DebitNoteTemplate { /* same shape */ }
```

**Existing models needing a new back-relation only** (no column change): `SalesInvoice.creditNotes CreditNote[]`,
`SalesReturn.creditNote CreditNote?`, `Client.creditNotes CreditNote[]`, `GoodsReceiptNote.debitNotes DebitNote[]`,
`PurchaseReturn.debitNote DebitNote?`, `Supplier.debitNotes DebitNote[]`, `InvoiceItem.creditNoteItems
CreditNoteItem[]`, `JournalEntry.creditNotes CreditNote[]` / `.debitNotes DebitNote[]`. `Company` gains 8 new
back-relations (the standard pattern every existing model already follows, `schema.prisma:66-153`).

**Why each new model is needed / what it integrates with / replaces-or-extends / migration risk:**

| Model | Why | Integrates with | Replaces? | Migration risk |
|---|---|---|---|---|
| `CreditNote`/`Item` | No formal statutory reversal document exists (§1) | `SalesInvoice`, `SalesReturn`, `TaxInvoice`'s snapshot shape, `JournalEntry` (read-only pointer) | Nothing — additive | None; pure new tables, zero existing-row backfill needed (nothing to migrate data into) |
| `DebitNote`/`Item` | Mirror gap on the purchase side | `GoodsReceiptNote`, `PurchaseReturn`, `Supplier`, `JournalEntry` | Nothing | None, same reasoning |
| `CreditNoteTemplate`/`DebitNoteTemplate` | G1's template philosophy needs the same coverage for the new documents | `TaxInvoiceTemplate`'s pattern (copied, not shared) | Nothing | None |

---

## 19. Proposed API Routes

Following the existing router conventions (`sales.router.ts`/`procurement.router.ts`, `requirePermission()` per
route, Zod body validation, `tenantContext` middleware already applied globally):

```
GET    /sales/credit-notes                       creditNote:view   list, filters: clientId, invoiceId, from/to, status
GET    /sales/credit-notes/:id                    creditNote:view
POST   /sales/credit-notes                        creditNote:create   { invoiceId, items[], reasonCode, reasonNotes? }  (Path B — standalone)
POST   /sales/returns/:returnId/credit-note        creditNote:create   {}  (Path A — wraps an existing SalesReturn; or fold into POST /sales/returns via an `issueCreditNote` body flag — see note below)
POST   /sales/credit-notes/:id/cancel              creditNote:cancel   { reason }

GET    /procurement/debit-notes                    debitNote:view
GET    /procurement/debit-notes/:id                 debitNote:view
POST   /procurement/debit-notes                     debitNote:create    { grnId, items[], reasonCode, reasonNotes? }  (Path B)
POST   /procurement/purchase-returns/:returnId/debit-note  debitNote:create   {}  (Path A)
POST   /procurement/debit-notes/:id/cancel           debitNote:cancel    { reason }

GET    /sales/credit-note-templates                  creditNoteTemplate:view
POST   /sales/credit-note-templates                  creditNoteTemplate:create
PATCH  /sales/credit-note-templates/:id               creditNoteTemplate:edit
POST   /sales/credit-note-templates/:id/duplicate      creditNoteTemplate:create

GET    /procurement/debit-note-templates              debitNoteTemplate:view
POST   /procurement/debit-note-templates               debitNoteTemplate:create
PATCH  /procurement/debit-note-templates/:id            debitNoteTemplate:edit
```

**Note on Path A's route shape:** two equally reasonable options — a dedicated sub-route on the return
(`POST /sales/returns/:returnId/credit-note`, shown above) or an `issueCreditNote: boolean` flag folded into the
existing `POST /sales/returns` body. **Recommendation: the dedicated sub-route.** It keeps `createSalesReturn`'s
existing request/response contract completely untouched for every current caller (the frontend return screen, any
existing integration), and makes "issue the formal document" a deliberate, separate, auditable action a user takes
*after* seeing the return succeed — matching this document's own §3.4 design (`issueCreditNote` as a *service-layer*
parameter is still correct there, since the router can call the service function with it set, driven by the
sub-route's own existence, without the base return route ever needing the flag in its own body schema).

---

## 20. Proposed Service Architecture

New files, following the existing one-module-one-service-file convention:

- `server/src/modules/sales/creditNote.service.ts` — `createStandaloneCreditNote()`, `createCreditNoteForReturn()`
  (called from `createSalesReturn` when `issueCreditNote` is requested — kept in its own file, imported by
  `sales.service.ts`, rather than bloating that already-large file further), `cancelCreditNote()`,
  `listCreditNotes()`, `getCreditNoteById()`.
- `server/src/modules/sales/creditNoteTemplate.service.ts` — mirrors `taxInvoiceTemplate.service.ts` exactly
  (CRUD + `resolveCreditNoteTemplate()`).
- `server/src/shared/creditNoteBoundFields.ts`, `server/src/shared/debitNoteBoundFields.ts` — mirror
  `taxInvoiceBoundFields.ts`.
- `server/src/shared/gstDocumentReasons.ts` — the reason-code whitelists (§3.3/§4.2), shared by both sides.
- `server/src/shared/gstSplit.ts` — `splitGst()` (§6), extracted from the three existing inline copies.
- `server/src/modules/procurement/debitNote.service.ts`, `debitNoteTemplate.service.ts` — mirror the sales side.

**Minimal-diff extension points on existing files** (both additive, both backward-compatible per the default-`false`
posture already stated):
- `sales.service.ts: createSalesReturn(data, ctx, userId, opts?: { issueCreditNote?: boolean })` — one new optional
  4th parameter; existing 3-arg callers unaffected.
- `sales.service.ts: amendInvoice`/`voidInvoice` — extend the existing lock/eligibility queries to also `include`
  `creditNotes: { select: { id: true, ... } }` and check it alongside `returns` (§5.3) — a few-line addition to an
  already-existing `include`/check, not a new code path.
- `procurement.service.ts: createPurchaseReturn(data, ctx, userId, opts?: { issueDebitNote?: boolean })` — same
  shape as the sales-side extension.
- `finance.service.ts: getPurchaseGstSummary()` — extend the existing return-netting `add(..., sign: -1, ...)` call
  site to also net a standalone Debit Note's lines (§7 point 2).

**Function reuse, made explicit (nothing new is computed that an existing function already computes):**
`resolveSellerRegistration`, `buyerSnapshot`, `nextDocumentNumber`, `gstFinancialYear`, `postAutoJournalEntry`,
`assertOwnedByCompany`/`assertOwnedIfPresent`/`assertAllOwned`, `createAuditEntry`, `round2` — all imported from
their existing locations, none reimplemented.

---

## 21. Proposed Frontend Screens

Following `UI_DESIGN_GUIDE.md`'s conventions (keyboard-first fields, compact grid forms, table overflow handling —
not re-derived here, just applied) and mirroring the two most structurally similar existing screens
(`GstRegistrationsPage.tsx`/`TaxInvoiceTemplatesPage.tsx`, both already in this branch's working tree, and
`SalesReturns`-equivalent screens):

- **`CreditNotesPage.tsx`** (`/sales/credit-notes`) — list (client, invoice, date, amount, status, reason),
  filters, a "New Credit Note" action opening a line-picker against a chosen invoice (mirrors the existing sales
  return line-picker UI, reused component where practical), a "Cancel" action gated by `creditNote:cancel` and only
  shown for a standalone (no `salesReturnId`) row, per §3.6.
- **On the existing Sales Return screen:** an "Also issue a formal Credit Note" checkbox/toggle at submission,
  gated by `creditNote:create` — drives the `issueCreditNote` flag (§20), visually adjacent to the return form but
  not merged into it, consistent with this document's Path A/Path B separation.
- **`CreditNoteTemplatesPage.tsx`** — near-identical to `TaxInvoiceTemplatesPage.tsx` (already exists in this
  branch), same layout-builder UX, bound-field picker sourced from `CREDIT_NOTE_BOUND_FIELDS`.
- **`DebitNotesPage.tsx`** (`/procurement/debit-notes`) and **`DebitNoteTemplatesPage.tsx`** — mirror the above on
  the procurement side; the "issue a Debit Note" toggle lives on the existing Purchase Returns screen.
- **Print:** a Credit Note/Debit Note print view reusing `printInvoice.ts`'s existing HTML-string + `window.print()`
  approach (G0 §13 confirmed this is the only printing pipeline that exists — no server-side PDF engine anywhere;
  G2 does not introduce one), parameterized by the resolved template layout exactly as the tax invoice print view
  already is.
- **Invoice detail page:** a new "Credit Notes" section listing any issued against that invoice, with the
  remaining-creditable-value shown (derived from §3.7's guard computation, exposed read-only).

No new navigation top-level group is proposed — both new list pages join the existing Sales / Procurement nav
groups respectively (`navItems.tsx`), gated the same permission-aware way every other J4-era entry already is.

---

## 22. Migration Strategy

No migration is created in this design phase. When implementation proceeds:

1. One migration for `CreditNote`/`CreditNoteItem`/`DebitNote`/`DebitNoteItem` (RLS + composite FKs + indexes, per
   §15) — pure new tables, **zero backfill needed** (there is no prior data to migrate into a brand-new document
   type; existing `SalesReturn`/`PurchaseReturn` rows are simply never retrofitted with a `CreditNote`/`DebitNote`
   automatically — §3.4's note explicitly declines to auto-backfill).
2. A second, small migration for `CreditNoteTemplate`/`DebitNoteTemplate` (can be combined with #1, or separate for
   easier review — no ordering dependency between them).
3. Per §11.11 of CLAUDE.md's own "when you add a new company-owned model" checklist: register both new tables in
   `db-secure.sql`, add the tenant RLS policy block, confirm `npm run audit:tenant` and `npm run test:rls` both pass
   clean before merge — same checklist every prior phase in this codebase's history already follows, not a new
   requirement invented for G2.
4. **A migration that touches or reads existing tenant rows must lift FORCE RLS around that specific statement**
   (CLAUDE.md §11's own documented rule, "a migration that touches tenant rows must lift FORCE RLS around its
   statement") — relevant only if a future backfill migration is ever added (e.g. §24's deferred historical-CN
   backfill), not to this phase's own additive-only migrations, which touch no existing tenant row.
5. `provisionCompany()`'s conditional `CompanyGstRegistration` step (§12) is a **code change inside an existing
   transaction**, not a schema migration — no new migration required for it beyond what G1 already shipped.

---

## 23. Test Plan

Mirrors the existing suite's own structure (`sales.service.test.ts`, `procurement.inputGst.test.ts`,
`compositeFk.test.ts`, `g1GstFoundation.test.ts` as the most directly analogous precedent) — new test files
`creditNote.service.test.ts` / `debitNote.service.test.ts`, plus additions to existing files where a lock is
extended:

**Correctness:**
- Path A: Credit Note created from a full return → items/amounts match the return exactly; `journalEntryId` points
  at the return's own entry; **no second `JournalEntry` row exists** for the pair (explicit count assertion).
- Path A: same for a partial return.
- Path B: standalone Credit Note against a full line → posts its own balanced journal (assert `totalDebit ===
  totalCredit`), decrements `client.currentBalance`, creates no `SalesReturn`, touches no `JewelryTag`.
- Path B: standalone Credit Note against a partial/value-only amount, HSN resolved fresh, correct `splitGst()`
  output for both same-state and inter-state.
- Debit Note: mirror all four cases above on the purchase side, plus the ITC pro-rata reversal assertion
  (`createPurchaseReturn`'s existing `bookedTax/taxableValue` ratio test pattern, reused).
- Over-crediting guard (§3.7): a second Credit Note that would exceed the original line value is rejected (409);
  a second one within the remaining value succeeds; a pre-G2 `SalesReturn` with no CN correctly reduces the
  available amount for a first retroactive CN.

**Lifecycle guards (§5.3):**
- `amendInvoice` on a line covered by a Credit Note → rejected, same error shape as the existing return-lock test.
- `voidInvoice` on an invoice with any Credit Note → rejected.
- Credit Note against a `VOID` invoice → rejected (both Path A, via the SalesReturn's own existing VOID check, and
  Path B, via a new explicit check).
- Credit Note against an invoice with `taxDetails.irn` set → **succeeds** (explicit positive test — this is the one
  case in the whole matrix that must NOT be blocked, easy to get backwards by copy-pasting `amendInvoice`'s guard).

**Cancellation:**
- Standalone Credit Note cancel → exact inverse journal, `client.currentBalance` restored, status → `CANCELLED`.
- Return-linked Credit Note cancel → rejected (409), matching §3.6's "cannot be cancelled in-app" rule.
- Double-cancel → rejected (count-checked claim, same idiom as `reverseInvoicePayment`'s `updateMany` claim).

**Tenant isolation (per §15's three mental tests, as real assertions, not just design intent):**
- Company A `CreditNote` → Company B `invoiceId` → 404, nothing persisted.
- Company A `DebitNote` → Company B `grnId`/`supplierId` → 404, nothing persisted.
- Company A `CreditNoteTemplate`/`DebitNoteTemplate` → Company B `branchId` → 404.
- `npm run test:rls` re-run against the real role-split cluster including these new tables.

**Reporting integration:**
- `getGstSummary`/`getPurchaseGstSummary` correctly net a standalone Credit/Debit Note's effect (a new assertion
  on each existing test file, not a new report).

**Permission gating (HTTP-level, following `http.j3Administrative.test.ts`'s precedent exactly):** each new route,
granted vs. missing permission, for both a SUPER_ADMIN and a delegated role.

**Provisioning:** `provisionCompany({ gstin: '...' })` creates exactly one `CompanyGstRegistration`, `isPrimary:
true`; `provisionCompany({})` (no GSTIN) creates zero, unchanged from today; a failure after the GST-registration
step still rolls back the whole company (extend the existing provisioning rollback test).

Before release: full suite, both `tsc`s, `npm run audit:tenant`, `npm run test:rls` — same bar every prior phase in
this codebase's history has been held to.

---

## 24. Explicitly Deferred Items

Named here so they are not silently assumed to be in scope, and not lost:

- **Historical `SalesReturn`/`PurchaseReturn` → Credit/Debit Note backfill tooling** — the capability exists
  (§3.4's note) but no dedicated bulk-backfill endpoint/script is built in G2.
- **Approval workflow** for Credit/Debit Note creation (§13) — no `:approve` permission or step proposed.
- **Date-based statutory eligibility window** for issuing a Credit Note (§17 item 3) — not enforced by any check in
  this design; needs confirmation first.
- **`INV` numbering becoming registration-scoped** to match this document's recommendation for `CN`/`DN` (§9) — a
  real, valuable follow-up that changes G1's already-shipped behavior, explicitly out of this phase's scope.
- **`TaxInvoice` vs. `ExportDocument` `irn`/`ewbNumber` ownership** (G0 §26) — still open, not resolved by G2 (§11).
- **A GAAP-style contra-revenue account** for Credit Notes instead of debiting `SALES_REVENUE` directly (§8) — an
  accounting-policy alternative, not adopted.
- **Any real IRP/e-invoice integration, idempotency infrastructure, or credential store** — explicitly G3/G4/G5 per
  G0's own phase list, untouched here.
- **GSTR-1/GSTR-3B/GSTR-2B filing-shaped exports** — `getGstSummary`/`getPurchaseGstSummary`'s existing prep-only
  posture is extended (netting), never turned into an actual filing export.
- **`getPurchaseGstSummary`'s Path-A netting for a Debit Note wrapping a return** — no change needed (the existing
  `PurchaseReturnItem`-based netting already covers it); only the Path B (standalone) netting is new work (§7).

---

## 25. Implementation Sequence

Ordered so each step is independently testable and the system is never left in a half-built state — matching this
codebase's own established "stop for review after each logical group" discipline (Phase J's own explicit precedent).

1. **G2a — Schema + tenant plumbing.** `CreditNote`/`CreditNoteItem`/`DebitNote`/`DebitNoteItem` +
   `CreditNoteTemplate`/`DebitNoteTemplate` migrations, RLS, composite FKs, `db-secure.sql` registration,
   permission-catalog strings (§13, unassigned to any starter role yet). No service logic. `audit:tenant`/
   `test:rls` green on the new tables with zero rows.
2. **G2b — `splitGst()` extraction** (§6) — pure refactor of the three existing call sites, regression tests only
   (no behavior change), landed and verified in isolation before any new document logic depends on it.
3. **G2c — Credit Note, Path A + Path B + cancel + audit** (§3, §8, §14) — the sales-side service + router, gated
   behind the new permissions. Full test coverage per §23's sales-side rows before moving on.
4. **G2d — Credit Note templates + print** (§10, §21) — depends on G2c existing to have something to print.
5. **G2e — Debit Note, Path A + Path B + cancel + audit** (§4, §7, §14) — mirrors G2c on the purchase side.
6. **G2f — Debit Note templates + print** (§10, §21) — mirrors G2d.
7. **G2g — Lifecycle guard extensions** (§5.3): `amendInvoice`/`voidInvoice`'s locks extended to check
   `CreditNote`. Deliberately sequenced **after** G2c so the guard has a real `CreditNote` table/relation to check
   against, with its own dedicated regression tests (the "invoice has a Credit Note" row of §5.3's table).
8. **G2h — Provisioning** (§12) — `provisionCompany()`'s conditional `CompanyGstRegistration` step; independent of
   G2a-g, can be built in parallel, but sequenced last here only because it's the lowest-risk, most isolated change
   and benefits from not competing for review attention with the larger document-model work.
9. **G2i — Reporting integration** (§7 point 2, §23) — `getPurchaseGstSummary`'s standalone-Debit-Note netting;
   depends on G2e existing.

Each step ends with: full suite green, both `tsc`s clean, `npm run audit:tenant` clean, and a stop for human review
before the next step begins — matching the instruction that this phase not be implemented as "one giant uncontrolled
change."

---

`G2 DESIGN: COMPLETE — READY FOR HUMAN REVIEW`
