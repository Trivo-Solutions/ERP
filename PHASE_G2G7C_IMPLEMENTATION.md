# Phase G2g-7c — GSTR-3B Table 4(A)(5) ITC Foundation & Eligibility Engine: Implementation

> This is a **foundation phase**, not a complete GST ITC implementation. It determines what domestic
> purchase GST exists in TRIVO's books and classifies each amount as ELIGIBLE / INELIGIBLE /
> UNRESOLVED against only the facts this phase's data model can actually establish. It does **not**
> implement imports, RCM, ISD, Rule 42/43 reversals, the 180-day reversal engine, GSTR-2B ingestion,
> or GSTR-3B filing — see §I for the complete deferred list. All frozen modules named in the brief's
> §5 (GSTR-1 classification/aggregation, the GSTR-1 filing lifecycle, `sales.service.ts`,
> `creditNote.service.ts`, `salesDebitNote.service.ts`, G2g-7b's outward aggregation/reporting) were
> read for context only — **none were modified.**

---

## A. Files created / modified

**Created:**
- `server/src/modules/finance/gst/gstr3bItc.types.ts` — data contracts (mirrors `gstr3bOutward.types.ts`'s shape).
- `server/src/modules/finance/gst/gstr3bItcEligibility.ts` — pure per-line classifier (no Prisma).
- `server/src/modules/finance/gst/gstr3bItcAggregation.ts` — pure aggregation/netting engine (no Prisma).
- `server/src/modules/finance/gst/gstr3bItcReporting.service.ts` — tenant-scoped DB loaders + period resolution.
- `server/src/modules/finance/gst/gstr3bItcEligibility.test.ts` — 18 focused classifier tests.
- `server/src/modules/finance/gst/gstr3bItcAggregation.test.ts` — 16 focused aggregation tests.
- `server/src/modules/finance/gst/gstr3bItcReporting.service.test.ts` — 9 integration tests (real procurement lifecycle).
- `server/src/test/http.gstr3bItcSecurity.test.ts` — 7 HTTP security tests (auth/permission/registration/branch/tenant isolation).
- This document.

**Modified:**
- `server/src/modules/finance/finance.router.ts` — added `GET /finance/reports/gstr3b-itc` (one route, `report:financial_view`, identical shape to the adjacent `gstr3b-outward` route).
- `CLAUDE.md` — added the G2g-7c summary entry (§7's running log), per this project's established per-phase documentation convention.

**No Prisma migration.** G2g-7a already added everything this phase reads (`GrnItem.buyerRegistrationId`, `PoItem.taxCategory`, `Supplier.isComposition`) — this phase is pure application code.

---

## B. Read-only audit findings

**What the current procurement model CAN establish:**
- The legal "inward tax event" granularity is the `GrnItem` line (confirmed by G2g-7a's own audit, re-verified here) — `taxableValue`/`inputCgst`/`inputSgst`/`inputIgst` are stamped once, at intake, by `createTagFromGrnItem` (FINISHED_GOODS) or `openPurchaseLot` (FINISHED_LOT).
- `GrnItem.buyerRegistrationId` (G2g-7a) already gives registration attribution with the correct "null stays null, never guessed" semantics.
- `PoItem.taxCategory` (G2g-7a) gives TAXABLE/EXEMPT/NIL_RATED/NON_GST/ZERO_RATED — but **only via the relation**, never snapshotted onto `GrnItem` itself. Since no `PoItem` edit endpoint exists anywhere (`procurement.service.ts` only ever calls `tx.poItem.update()` for `receivedQty`/`receivedWt` increments — confirmed by grep), this is a documented limitation with low practical divergence risk, not an active bug.
- `Supplier.isComposition` (G2g-7a) is a reliable, standing fact about the supplier.
- `Supplier.gstNumber` is free text with **no format or checksum validation anywhere in the codebase** — `createSupplier`/`createPO`/`createGRN` all accept it as-is. `shared/gstin.ts: validateGstin()` exists (built for a GSTIN-lookup service) but nothing in the procurement path calls it. This phase is the first caller that validates a *supplier's* GSTIN at all.
- `PurchaseReturnItem` already reverses a GRN line's booked GST exactly, pro-rata on an overridden amount (`procurement.service.ts: createPurchaseReturn`) — reused as-is.
- `DebitNote` Path A (wraps a `PurchaseReturn`) vs. Path B (standalone, `purchaseReturnId: null`) is an already-established, tested distinction (`debitNote.service.ts`) that `finance.service.ts: getPurchaseGstSummary` already nets correctly — this phase's loaders mirror that exact convention (Path A excluded from the standalone loader; cancelled notes excluded).

**What it CANNOT establish (and this phase does not pretend to):**
- **Place of supply for an inward goods receipt.** The only state-pair this codebase tracks for a purchase (`resolveSupplierStateCode` vs. `Company.stateCode`) drives the CGST/SGST-vs-IGST *split*, not a PoS-based ITC *restriction*. There is no distinct "place of supply" field on any purchase document.
- **Section 16(4) time-limit compliance.** No tracked GSTR-3B filing date per return period (that's the explicitly out-of-scope G2g-7f), and no annual-return filing date anywhere. The statutory deadline (30 Nov of the following FY, or the annual return date, whichever is earlier — now further complicated by the Finance (No. 2) Act 2024's Section 16(5)/(6) retrospective relief for FY 2017-18 to 2020-21 invoices filed by 30 Nov 2021) cannot be computed without a real filing date.
- **Section 17(5) blocked credits** beyond composition-scheme and non-taxable-category. No transaction-purpose/asset-class semantics (motor vehicle, employee benefit, construction, personal consumption, CSR) exist anywhere in the procurement data model to classify against the statute's specific categories.
- **The 180-day non-payment condition (Rule 37).** `SupplierPayment` (confirmed via schema + `recordSupplierPayment`) is an account-level balance payment — "not tied to a specific bill: it is a payment on the supplier's account" (the model's own comment). There is no way to determine whether *this specific inward line's share* of a bill was paid within 180 days of its invoice date.
- **GSTR-2B reconciliation.** No ingestion exists (deferred whole to G2g-7e). This report reflects TRIVO's own books only.

**Note on the recent portal change found during GSTN/CBIC verification (§C below):** from the April 2026 tax period, GSTN made Table 4A of the live GSTR-3B portal form auto-populate from GSTR-2B with protected (non-editable) tax columns — the portal will no longer accept a return claiming more ITC than GSTR-2B supports. This makes the GSTR-2B reconciliation boundary (deferred to G2g-7e) more operationally urgent going forward, but does not change this phase's approved scope.

---

## C. Official GST requirement verification (performed before implementation)

Verified via current web sources (search performed 2026-10-02; cited in the chat-delivered report, not reproduced in full here):
- **GSTR-3B Table 4 structure / CBIC Circular 170/02/2022-GST**: confirms Table 4(A) auto-populates from GSTR-2B; 4(A)(5) is "All other ITC"; reversals go in Table 4(B); GSTN explicitly tells taxpayers to reconcile against GSTR-2B and self-assess restrictions GSTR-2B's own "ITC not available" categories don't cover. **GSTR-2B ≠ automatic final eligibility** — the exact principle this engine's "never convert uncertainty into eligibility" invariant implements.
- **Section 16(4)/(5)/(6)**: the Finance (No. 2) Act, 2024 inserted Section 16(5) retrospectively (from 1 July 2017), overriding 16(4)'s time bar for FY 2017-18 to 2020-21 invoices where the GSTR-3B was filed by 30 Nov 2021. This relief is historical/narrow and does not give this phase a way to compute a *current* 16(4) deadline without a tracked filing date — confirms the UNRESOLVED/NOT_DETERMINABLE posture is correct, not overly conservative.
- **Section 17(5) / Rule 42/43 / Rule 37 (180-day)**: confirmed the statutory shape of blocked credits, common-credit reversal, and the 180-day non-payment reversal-and-reclaim mechanism — none of which this phase attempts to build, per the brief's explicit exclusion list.

---

## D. Eligibility matrix (brief §26.C)

| Condition | Status | Note |
|---|---|---|
| Buyer GST registration | **DETERMINABLE** | `GrnItem.buyerRegistrationId` (G2g-7a). `null` → UNRESOLVED (`BUYER_REGISTRATION_UNASSIGNED`), never defaulted to the primary registration. A line explicitly attributed to a *different* registration is excluded from this report entirely (it belongs to that registration's own report). |
| Supplier GSTIN | **DETERMINABLE** | Full structural + checksum validation (`shared/gstin.ts: validateGstin()`), not a 15-character length check. Missing or malformed → UNRESOLVED (`SUPPLIER_GSTIN_UNAVAILABLE`). |
| Domestic / non-RCM / non-import / non-ISD | **DETERMINABLE** | True by construction — this engine's loaders only ever read `GoodsReceiptNote`/`GrnItem`/`PurchaseReturn`/`DebitNote` rows, and this codebase has no RCM/import/ISD representation anywhere yet (G2g-7a deliberately deferred that data model to G2g-7d). |
| Tax category | **DETERMINABLE** | `PoItem.taxCategory` (G2g-7a), read via the relation. `EXEMPT`/`NIL_RATED`/`NON_GST`/`ZERO_RATED` → INELIGIBLE (`TAX_CATEGORY_NON_TAXABLE`); `null` (pre-G2g-7a row, or a standalone Debit Note line which has no taxCategory lineage at all) → UNRESOLVED (`TAX_CATEGORY_UNAVAILABLE`). Never inferred from a zero tax rate. |
| Place of supply / state restriction | **NOT_DETERMINABLE** | No distinct PoS field for an inward supply exists — the only state comparison (`resolveSupplierStateCode` vs. company state) drives the CGST/SGST-vs-IGST split, a different legal question. Reported once per report (`POS_NOT_DETERMINABLE`), never per line. |
| Section 16(4) time limit | **NOT_DETERMINABLE** | No tracked GSTR-3B filing date per period, no annual-return date. (`SECTION_16_4_NOT_DETERMINABLE`) |
| Section 17(5) blocked credits | **NOT_DETERMINABLE** | Beyond composition-scheme/tax-category (which ARE checked), no transaction-purpose/asset-class semantics exist. (`SECTION_17_5_NOT_DETERMINABLE`) |
| 180-day payment condition | **NOT_DETERMINABLE** | `SupplierPayment` is account-level, not bill-linked. (`ITC_180_DAY_STATUS_UNAVAILABLE`) |
| GSTR-2B availability | **NOT_DETERMINABLE** | No ingestion exists (G2g-7e). (`GSTR_2B_RECONCILIATION_UNAVAILABLE`) |

**Design note on why the four NOT_DETERMINABLE conditions don't gate every line to UNRESOLVED:** the brief's own §11 defines ELIGIBLE using seven *foundational* conditions (registration, supplier reliability, non-RCM/import/ISD, positive tax, no explicit non-taxable classification, "no known statutory exclusion available from CURRENT data") — none of which include 16(4)/17(5)/PoS/180-day. Reading §§12-15 as *per-line* gates instead of *report-level documentation* would make the `eligible` bucket permanently empty for every company, forever (since this system will never track a GSTR-3B filing date in this phase), contradicting §1's framing ("what can CURRENTLY be considered eligible ITC") and §24's own test list (which asks for a genuine "eligible domestic purchase" test case). See `gstr3bItcEligibility.ts`'s header comment for the full reasoning, and §J (deviations) below for how this was decided.

---

## E. Table 4(A)(5) — eligible / unresolved / ineligible

Output shape (`Gstr3bItcTable4A5` in `gstr3bItc.types.ts`):

```
table4A5:
  eligible:   { taxableValue, igst, cgst, sgst, cess }
  unresolved: { taxableValue, igst, cgst, sgst, cess }
  ineligible: { taxableValue, igst, cgst, sgst, cess }
  documentCount   // distinct GRNs + Purchase Returns + standalone Debit Notes contributing a line
  lineCount       // individual lines processed (all three statuses, excluding out-of-scope/out-of-period)
```

The three buckets are **mutually exclusive and always sum to the period's net book GST** — nothing is silently dropped, nothing double-counted. A negative bucket (return/debit-note value in this period exceeding this period's own gross in that same bucket — e.g., returning a prior month's purchase) is flagged (`NEGATIVE_NET_ITC`) but not treated as an error.

---

## F. Purchase Return / Debit Note treatment

- **A Purchase Return nets into the exact same bucket its source `GrnItem` line was already classified into** — never re-derived independently. This is enforced by the aggregator keeping a `Map<grnLineId, classification>` built while processing GRN lines, consulted when processing returns. If the parent line isn't in the loaded set (e.g. received in an earlier period, returned in this one), the engine falls back to classifying the return's own carried facts (same supplier/registration/tax-category it inherited at load time) — covered by its own test.
- **Path A Debit Notes (wrapping a Purchase Return) are never loaded for this engine at all** — identical convention to `finance.service.ts: getPurchaseGstSummary`, which already established that counting both would double-count the same rupee.
- **Standalone (Path B) Debit Notes** are loaded and netted, but **always carry `taxCategory: null`** — a `DebitNoteItem` has its own fresh HSN/rate snapshot (for price-variance/short-supply/quality/correction adjustments) but no `PoItem` lineage to read a tax category from. This routes every standalone Debit Note's reversal to the **unresolved** bucket via the same `TAX_CATEGORY_UNAVAILABLE` path a pre-G2g-7a GRN line takes — an honest limitation, not a guess.
- **Cancelled Debit Notes are excluded** — their ITC effect was already undone at cancellation (reversing journal), so including them would double-count.

---

## G. Diagnostics

**Per-line** (`Gstr3bItcLineDiagnosticCode`): `BUYER_REGISTRATION_UNASSIGNED`, `SUPPLIER_GSTIN_UNAVAILABLE`, `SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE`, `TAX_CATEGORY_UNAVAILABLE`, `TAX_CATEGORY_NON_TAXABLE`.

**Report-level, emitted exactly once per report** (`Gstr3bItcReportDiagnosticCode`): `POS_NOT_DETERMINABLE`, `SECTION_16_4_NOT_DETERMINABLE`, `SECTION_17_5_NOT_DETERMINABLE`, `ITC_180_DAY_STATUS_UNAVAILABLE`, `GSTR_2B_RECONCILIATION_UNAVAILABLE`, `PARTIAL_BRANCH_SCOPE` (branch-restricted report, same convention as G2g-7b), `NEGATIVE_NET_ITC` (one per negative bucket, if any).

---

## H. Security / tenancy

- **Registration scope**: every line is classified against exactly one requested `gstRegistrationId`; a line explicitly attributed to a *different* registration is excluded from the report (never counted as unresolved for a report it doesn't belong to) — same posture as G2g-7b's outward engine.
- **Branch scope**: `allowedBranchIds` resolved from `ctx.branchAccess`/explicit `branchId`, applied against the owning GRN's `branchId` — identical mechanism to G2g-7b. A branch-restricted report is marked `isCompleteGstinScope: false` / `partialScopeReason: 'PARTIAL_BRANCH_SCOPE'`, never presented as filing-ready.
- **Route**: `GET /finance/reports/gstr3b-itc` requires `report:financial_view` (no new permission introduced — reuses the existing J4-D1 financial-report gate every other GST/finance report in this router already requires). `gstRegistrationId` is verified owned by the caller's company (`assertOwnedByCompany`) before use; an explicit `branchId` is verified accessible (`assertBranchAccessible`) before use.
- **No new foreign-id-accepting input** beyond what the existing route pattern already validates — no new composite FK, no new RLS policy (no new table).
- **Cross-company tests**: `http.gstr3bItcSecurity.test.ts` proves a cross-company `gstRegistrationId` → 404, a cross-company/inaccessible `branchId` → 404, a same-company registration → 200, and a granted branch → 200 with the partial-scope diagnostic — mirroring `http.gstr3bSecurity.test.ts` (G2g-7b) test-for-test.

---

## I. Deferred work (explicit, per brief §26.I)

- **G2g-7d** — inward RCM: self-invoicing, payment-voucher generation, RCM tax calculation and journal posting (2204 RCM liability / 1404 RCM ITC), Table 3.1(d)/4(A)(3). No RCM data field exists anywhere yet (G2g-7a's own deferred decision, re-confirmed here).
- **G2g-7e** — GSTR-2B ingestion + reconciliation against TRIVO's own books (and against GSTR-1/3B/GL). This phase's output (`gstr3bItc.types.ts`) deliberately preserves enough provenance per line (source GRN/return/debit-note id and number, supplier, supplier GSTIN, buyer registration, invoice number/date where available, taxable value, tax amounts, classification, diagnostic code) for that future reconciliation, without building a reconciliation table now.
- **G2g-7f** — GSTR-3B filing lifecycle (snapshots, filing attempts, period lock) — explicitly out of scope; `GstReturnPeriod`/filing-attempt/filing-protection modules were not touched.
- **G2g-7g** — GSTN wire/export for GSTR-3B.
- **A dedicated Section 17(5) blocked-credit classification model** — needs real transaction-purpose/asset-class semantics this codebase doesn't have yet (motor vehicle, employee benefit, construction categories).
- **Rule 42/43 common-credit reversal** (exempt/non-business-use attribution) and the **180-day reversal/reclaim engine** — both need dedicated domain modeling (a bill-level payment link for 180-day; a taxable-vs-exempt-turnover attribution base for Rule 42/43) that doesn't exist.
- **Imports (4(A)(1)/(2), Bill of Entry/ICEGATE)** and **ISD (4(A)(4), GSTR-6 ingestion)** — out of scope per the brief; no data model exists for either.

---

## J. Deviations from the brief

1. **Requested** (§12-15, read literally as per-line instructions): "classify UNRESOLVED" for PoS/16(4)/17(5)/180-day whenever data is insufficient. **Actual**: these four are reported as report-level, once-per-report diagnostics and a report-level eligibility-matrix entry, **not** as a per-line gate on every individual line's ELIGIBLE/UNRESOLVED/INELIGIBLE bucket. **Reason**: read in the context of §11's own foundational-condition list (which excludes all four) and §24's test list (which explicitly expects a genuine "eligible domestic purchase" test case to exist), a literal per-line gate would make the `eligible` bucket permanently empty for every company, forever — since this system will never, in this phase, track a GSTR-3B filing date, a transaction-purpose classification, a PoS field, or a bill-level payment link. That outcome would defeat the report's own stated purpose (§1). The report-level diagnostics ensure nothing is hidden or silently treated as resolved — every reader of the report sees, explicitly, that these four conditions were not checked. **Risk**: none identified — this is the only reading under which the report produces any useful signal at all; full reasoning recorded in `gstr3bItcEligibility.ts`'s header for G2g-7d/e/f to pick up or challenge. **Approval needed**: yes — flagged here explicitly for human review, since this is a interpretive judgment call on ambiguous brief wording, not a mechanical implementation choice.
2. **No other deviations** — scope, frozen-module boundaries, GSTR-2B boundary, accounting boundary (no journal/posting code touched), and multi-GSTIN/branch-scope rules were all followed as specified.

---

## K. Test results (brief §25, all actually executed)

| Step | Result |
|---|---|
| 1. Focused G2g-7c tests | `gstr3bItcEligibility.test.ts` 18/18, `gstr3bItcAggregation.test.ts` 16/16, `gstr3bItcReporting.service.test.ts` 9/9, `http.gstr3bItcSecurity.test.ts` 7/7 — **50/50 passed** |
| 2. Procurement regression | included in the 773/773 run below |
| 3. Finance regression | included in the 773/773 run below |
| 4. GST regression | included in the 773/773 run below |
| 5. G2g-7a regression | `g2g7aInwardGstFoundation.test.ts` + `compositeFk.test.ts` — included in the 773/773 run below, all passed |
| 6. G2g-7b regression | `gstr3bOutwardAggregation.test.ts` + `gstr3bReporting.service.test.ts` + `http.gstr3bSecurity.test.ts` — included in the 773/773 run below, all passed (untouched, unmodified) |
| (2-6 combined) | `npx vitest run src/modules/procurement src/modules/finance src/modules/tagging/purchaseLot.test.ts src/test/g2g7aInwardGstFoundation.test.ts src/test/compositeFk.test.ts` → **32 files, 773/773 passed** |
| 7. `npm run audit:tenant --strict` | company-owned-not-through-wrapper: **0**, aliasing: **0** — clean, same baseline as before |
| 8. TypeScript (`npx tsc --noEmit`) | clean, no errors |
| 9. Prisma (`npx prisma validate`) | valid (no schema change this phase) |
| 10. Real RLS role split (`npm run test:rls` against `trivo_rlstest`, port 54329) | **99 files, 1875 passed, 1 skipped (pre-existing), 0 failed** |
| 11. Full server suite (`npx vitest run src`, single-role test DB) | **99 files, 1871 passed, 5 skipped (pre-existing), 0 failed** |

All steps were actually executed in this session (not assumed) — see the conversation's tool output for raw command results.

---

## STOP

Per the brief's §26.K: nothing was committed or pushed. No work on G2g-7d, G2g-7e, G2g-7f, or G2g-7g was started. This document, `CLAUDE.md`'s new G2g-7c entry, and the chat-delivered final report are the complete record for human review before authorizing the next phase.
