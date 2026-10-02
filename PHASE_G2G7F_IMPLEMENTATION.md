# Phase G2g-7f — Complete GSTR-3B Aggregation & Reconciliation

Status: implementation complete, verified, **✅ APPROVED / FROZEN by the user (2026-10-02)**. Do not
modify `gstr3bReconciliation.types.ts` / `gstr3bReconciliationComposition.ts` /
`gstr3bReconciliation.service.ts`, or the `gstr3b-reconciliation` route in `finance.router.ts`,
without an explicit new instruction. No commit, no push, no frontend, no G2g-7g, no GSTN
filing/export — per the brief's own stop condition.

## 1. Audit (read-only, before any code was written)

Read the five frozen engines end to end (not just their types) before designing the composition
layer:

| Engine | File(s) | What it already authoritatively produces |
|---|---|---|
| G2g-7b Outward | `gstr3bReporting.service.ts` / `gstr3bOutwardAggregation.ts` / `gstr3bOutward.types.ts` | Table 3.1(a) (taxable outward, net of credit notes / sales returns / debit note additions) and Table 3.2 (unregistered-person breakdown by place of supply). `resolveGstr3bPeriod()` is the one period-resolution helper every sibling report (including this phase) reuses. |
| G2g-7c Book ITC | `gstr3bItcReporting.service.ts` / `gstr3bItcAggregation.ts` / `gstr3bItc.types.ts` | Table 4(A)(5) ("all other ITC") — every GRN/Purchase-Return/standalone-Debit-Note line classified ELIGIBLE / UNRESOLVED / INELIGIBLE against exactly five checkable facts, plus its own `eligibilityMatrix` naming the five further statutory conditions it cannot determine (place of supply, Section 16(4), Section 17(5), 180-day payment, GSTR-2B). |
| G2g-7d RCM | `gstr3bRcmReporting.service.ts` / `gstr3bRcmAggregation.ts` / `gstr3bRcm.types.ts` | Table 3.1(d) (RCM liability: `recognized` vs `unresolved`, never merged) and Table 4(A)(3) (RCM ITC, gated on an actual recorded cash payment per Rule 86(2) — `markRcmLiabilityPaid`). |
| G2g-7e GSTR-2B | `gstr2bReconciliation.service.ts` / `gstr2bReconciliation.ts` / `gstr2b.types.ts` | A deterministic book-vs-2B match per document (`EXACT_MATCH` → `UNRESOLVED`, 10 statuses) plus each 2B document's own stated ITC availability (`AVAILABLE` / `NOT_AVAILABLE` / `UNKNOWN`), independent of match status. |
| G2g-6a/6e Filing lifecycle | `gstr1FilingPeriod.service.ts`, `GstReturnPeriod` model | `OPEN → SNAPSHOT_CREATED → FILING_ATTEMPTED → FILED → LOCKED`, keyed by `(companyId, gstRegistrationId, returnType, financialYear, taxPeriod)`. The model's own schema comment explicitly anticipates a future `returnType='GSTR3B'` value — no service has ever written one. |

**Findings:**

1. **What's already authoritative**: all four money figures (outward liability, RCM liability/ITC,
   book ITC, 2B match status/availability) are correctly computed by their own frozen engines. This
   phase's only job is to put them side by side and compute the handful of things that only exist
   once you compare them (a Table 4 presentation, a reconciliation matrix, a book-vs-statutory
   distinction).
2. **What's missing**: nothing in the five engines combines 7c+7d into a single Table 4(A) view;
   nothing cross-references 7c's book ITC against 7e's 2B availability; nothing reads GSTR-3B filing
   status for anything other than GSTR-1.
3. **What can be composed cheaply**: everything above — none of it requires new source data, only
   arranging four already-correct result objects.
4. **What is genuinely unsupported**: import of goods/services (4(A)(1)/(2) — no Bill-of-Entry
   model), ISD (4(A)(4) — no ISD model), Rule 42/43 common-credit reversal (4(B)(1) — no exempt-
   supply/non-business-use attribution), the broader Section 17(5) blocked-credit list beyond
   composition-scheme/tax-category (4(B)(2)), and ITC reclaim tracking (4(D)(1)).
5. **Statutory rules that cannot safely be derived from current data**: place-of-supply-based ITC
   restriction, Section 16(4) time limit, Section 17(5) in full, the 180-day payment condition, and
   "GSTR-2B as final ITC eligibility" — all five were *already* named NOT_DETERMINABLE by G2g-7c's own
   `eligibilityMatrix`; this phase inherits that honesty rather than overriding it, and adds its own
   composition-only gaps (Rule 42/43, imports, ISD, ITC reclaim, and — newly surfaced by comparing 7c
   against 7e — "supplier mismatch" as a reconciliation category, which the frozen matching engine
   cannot produce at all; see §4 below).

No frozen file was read for the purpose of modifying it, and none was modified.

## 2. Official GSTN/CBIC basis

Table 3.1(a)–(e)/3.1.1 and Table 4(A)(1)–(5)/4(B)(1)–(2)/4(C)/4(D)(1)–(2) sections used here match
the post-Circular-170/02/2022-GST structure already assumed by G2g-7b/7c/7d (their own file headers
cite it). No new statutory claim is made beyond what G2g-7c/7d already established; this phase is
presentation/composition, not new classification.

## 3. Architecture

```
            G2g-7b Outward  ──┐
            G2g-7d RCM       ─┼─→  gstr3bReconciliationComposition.ts  →  Gstr3bReconciliationReport
            G2g-7c Book ITC  ─┤        (pure, no Prisma)
            G2g-7e GSTR-2B   ─┘
                     ↑
        gstr3bReconciliation.service.ts (DB wiring: registration ownership,
        period resolution, calls the four frozen *reporting services* —
        never their internal loaders/aggregators — + read-only GstReturnPeriod lookup)
                     ↑
        GET /finance/reports/gstr3b-reconciliation  (finance.router.ts)
```

Three new files, zero modified frozen files:

- `server/src/modules/finance/gst/gstr3bReconciliation.types.ts` — DTO contracts.
- `server/src/modules/finance/gst/gstr3bReconciliationComposition.ts` — pure composer (no Prisma, no
  `Date.now()`), mirroring the exact discipline of `gstr2bReconciliation.ts`/`gstr3bRcmAggregation.ts`.
- `server/src/modules/finance/gst/gstr3bReconciliation.service.ts` — tenant-scoped integration,
  calling `getGstr3bOutwardReport` / `getGstr3bInwardItcReport` / `getGstr3bRcmReport` /
  `getGstr2bReconciliationReport` verbatim (never their loaders), plus a read-only
  `GstReturnPeriod` lookup (`returnType: 'GSTR3B'`) that **creates nothing**.

One file modified: `server/src/modules/finance/finance.router.ts` — added one import and one new
route (`GET /reports/gstr3b-reconciliation`), inserted after the existing `gstr2b-reconciliation`
route. No existing route's code was touched.

**No database/schema change.** `GstReturnPeriod.returnType` is already a plain `String` column —
this phase reads it with a new value (`'GSTR3B'`) it has never been written with; nothing was added
to `schema.prisma`, and `prisma validate` confirms this (see §7).

## 4. Key design decisions

1. **Table 4 presentation (brief §7).** 4(A)(3) and 4(A)(5) are G2g-7d's/G2g-7c's `table4A3`/`table4A5`
   quoted verbatim (status `PARTIALLY_SUPPORTED`, same word those two phases already use for
   themselves). 4(A)(1)/(2)/(4) are `NOT_SUPPORTED` with `taxableValue: null` (never `0` — a null
   value cannot be mistaken for "we checked and it's zero"). 4(B)(1)/(2) are `NOT_DETERMINABLE`, same
   null-not-zero rule. 4(C) sums *only* the two supported eligible buckets and says so explicitly in
   `componentsIncluded`/`componentsExcluded` — it is a "mathematically derivable partial value plus a
   completeness status" per the brief's own instruction for exactly this case, not a complete
   statutory 4(C). 4(D)(2) reuses 7c's/7d's own INELIGIBLE buckets (composition-scheme supplier,
   non-taxable tax category) — explicitly flagged narrower than the full Section 17(5) list. 4(D)(1)
   is `NOT_DETERMINABLE` outright (no reversal/reclaim lifecycle anywhere in this codebase).
2. **Six distinct ITC numbers (brief §5), never one "ITC Available".**
   `Gstr3bTwoBDerivedItc` exposes `bookItc` / `bookItcUnresolved` / `bookItcIneligible` (all three
   read straight off 7c's own buckets) and `twoBItcMatched` / `twoBItcAvailable` /
   `twoBItcNotAvailable` / `twoBItcUnknownAvailability` (summed from 7e's `matches[]`, keyed off
   `matchStatus` and `twoBItcAvailability` independently — a document can be matched AND
   `NOT_AVAILABLE` at once, and the composer keeps that straight; see the `MATCHED_NOT_AVAILABLE`
   test).
3. **Reconciliation matrix (brief §6) — grounded in what the frozen matcher can actually tell us, not
   invented.** Each of 7e's match statuses × availability states maps to one of eleven deterministic
   categories (`MATCHED_AVAILABLE`, `MATCHED_NOT_AVAILABLE`, `MATCHED_UNKNOWN_AVAILABILITY`,
   `BOOK_ONLY`, `TWO_B_ONLY_AVAILABLE`, `TWO_B_ONLY_NOT_AVAILABLE`,
   `TWO_B_ONLY_UNKNOWN_AVAILABILITY`, `AMOUNT_MISMATCH`, `TAX_MISMATCH`, `RCM_MISMATCH`,
   `NOT_RECONCILABLE`). **The brief's own example row, "supplier mismatch", is NOT one of them** —
   audited and confirmed genuinely absent: `gstr2bReconciliation.ts` indexes every match candidate by
   supplier GSTIN *before* comparing anything else, so two documents whose supplier identity actually
   differs are never compared to each other at all; a real supplier-identity disagreement surfaces as
   two independent rows (one `BOOK_ONLY`, one `TWO_B_ONLY_*`), never as one matched-but-disagreeing
   row. Rather than add a `SUPPLIER_MISMATCH` category that would always read zero and falsely imply
   the check runs, the composer documents this as a standing diagnostic
   (`SUPPLIER_MISMATCH_NOT_DETECTABLE`, always emitted once) — this is the one place brief §19 ("no
   false completeness") directly overrode a brief §6 example.
4. **Filing status — read-only, not a new lifecycle (brief §12).** `GstReturnPeriod` is queried with
   `returnType: 'GSTR3B'`; today this always returns nothing (`NOT_STARTED`), because no service in
   this codebase has ever written such a row — confirmed by grep across `src/` before relying on it.
   Nothing is created, filed, or locked by this phase; a `FILED`/`LOCKED` row (hypothetically written
   by a future phase) would be read and surfaced verbatim, never reinterpreted.
5. **Book position vs. statutory position (brief §15), kept structurally separate.**
   `summary.bookPosition` is a plain accounting-ledger computation (output tax + RCM liability −
   eligible ITC) — genuinely useful, genuinely derivable, and labeled as exactly that.
   `summary.statutoryReportingPosition.status` is hard-coded `'NOT_DETERMINABLE'` with a reason
   listing every component (imports/ISD/Rule 42-43/full 16(4)/17(5)/180-day/final 2B eligibility)
   that would have to be resolved before the book figure could be called a real GSTR-3B filing
   liability. There is no code path that can accidentally present one as the other.
6. **Branch scoping (brief §11).** `branchAccess`/`branchId` are threaded through to all four
   component calls (outward/ITC/RCM/2B) identically — each one's own existing branch-scoping logic
   (already proven in 7b/7c/7d/7e) applies unchanged. 7e's reconciliation service already emits its
   own `PARTIAL_BRANCH_SCOPE` diagnostic with the exact "book-scoped vs. registration-wide 2B" wording
   the brief asks for; this phase passes it through under `source: 'TWO_B'` rather than re-deriving
   the same sentence, and the HTTP security tests prove a restricted branch grant is actually
   enforced end-to-end (see §6).

## 5. API

```
GET /finance/reports/gstr3b-reconciliation
  Required: gstRegistrationId, taxPeriod (MMYYYY)
  Optional: financialYear, branchId
  Permission: report:financial_view (no new permission introduced)
```

Required params deliberately match `gstr2b-reconciliation` (not the from/to-flexible individual
GSTR-3B reports) — GSTR-2B, one of the four composed inputs, is inherently a single calendar-month
statement, so the composed report must be too.

## 6. Security

Enforced identically to every sibling GST report route (`authenticate`, `resolveTenantContext`,
`requirePermission('report:financial_view')`, `assertBranchAccessible`, `assertOwnedByCompany` for
`companyGstRegistration` — all pre-existing middleware, none modified). The service layer
independently re-validates registration ownership (`companyId` + `isActive`) before calling the four
sub-reports, matching the "defense in depth" convention every G2g-7b/7c/7d/7e service already follows.

Tested over real HTTP (`http.gstr3bReconciliationSecurity.test.ts`, 9 tests): unauthenticated (401),
missing permission (403), missing `gstRegistrationId`/`taxPeriod` (400 each), cross-company
registration (404), cross-company branch (404), a restricted branch grant succeeding on its own
branch and rejected on another in the same company (404), an invalid `taxPeriod` string (400), and
the ordinary same-company success path (200, asserting `filingStatus.status === 'NOT_STARTED'`).

## 7. Tests and verification

| Suite | File | Count |
|---|---|---|
| Pure composition | `gstr3bReconciliationComposition.test.ts` | 18 |
| Service integration (real GRN/invoice/2B-import data) | `gstr3bReconciliation.service.test.ts` | 6 |
| HTTP security | `src/test/http.gstr3bReconciliationSecurity.test.ts` | 9 |
| **New total** | | **33** |

Composition tests build every fixture through the *real* frozen pure engines
(`aggregateGstr3bOutwardSupplies`, `aggregateGstr3bInwardItc`, `aggregateGstr3bRcm`,
`reconcileGstr2b`) rather than hand-typed result objects, so a shape drift in any frozen engine would
break these tests before it could silently corrupt the composed report. Coverage includes: verbatim
4(A)(3)/4(A)(5) pass-through, NOT_SUPPORTED/NOT_DETERMINABLE lines carrying `null` (never `0`),
4(C)'s partial net-ITC sum, 4(D)'s ineligible-bucket sum, all four 2B-derived-ITC totals (matched /
available / not-available / unknown, proven independent of each other), every reconciliation-matrix
category including the deliberately-absent `SUPPLIER_MISMATCH`, diagnostic pass-through tagged by
source, `FILED` filing status passed through unaltered, and the book-vs-statutory-position
separation. The service test exercises a full real lifecycle — PO → GRN → tag (ordinary + RCM-tagged
line) → retail sale → GSTR-2B statement import — and asserts the composed report reflects all four
engines' real output, plus registration-not-found (404-class) and missing-taxPeriod (throw) and an
empty-period zeroed report (no crash).

Full verification run after implementation:

| Check | Result |
|---|---|
| New G2g-7f focused tests | 33/33 passed |
| Full GST module regression (`src/modules/finance/gst/` + GST HTTP security files) | 769/769 passed |
| Full server suite (`npx vitest run`) | 2028/2033 passed, 5 pre-existing skips, 0 failed |
| Real role-split RLS suite (`npm run test:rls` against `trivo_rlstest`) | 2032/2033 passed, 1 pre-existing skip, 0 failed |
| `npm run audit:tenant` | 0 bare company-owned-model Prisma calls (clean) |
| `npx tsc --noEmit` (server) | clean |
| `npx prisma validate` | schema valid (no change made) |

## 8. Known limitations (stated, not hidden)

- **Not a filing calculator.** `summary.statutoryReportingPosition.status` is permanently
  `NOT_DETERMINABLE` by design — this report must never be used as the sole basis for an actual
  GSTR-3B filing figure.
- **No automatic "supplier mismatch" detection** — see §4.3. Detecting a genuine supplier-identity
  disagreement between book and 2B would require a new fuzzy cross-supplier matching pass inside the
  frozen 7e engine, explicitly out of scope (frozen, and brief §2 forbids refactoring frozen modules
  for this phase).
- **4(C)/4(D) are partial by construction** — every excluded component is independently flagged
  `NOT_SUPPORTED`/`NOT_DETERMINABLE` in `inputTaxCredit.presentation`; nothing is silently assumed
  zero, but a reader who only looks at the summed numbers without reading `componentsExcluded`/the
  diagnostics list could still misread a partial number as a complete one. This is the same residual
  risk the brief itself names in §19 and accepts as the honest alternative to fabricating completeness.
- **GSTR-2B is single-month only** — this composed report inherits that constraint from G2g-7e; a
  multi-month from/to GSTR-3B view (as the individual outward/ITC/RCM reports support) is not
  available here.
- **Filing status will read `NOT_STARTED` for every company today** — no service anywhere creates a
  `GSTR3B`-typed `GstReturnPeriod` row. This is expected and documented, not a bug; it becomes useful
  automatically if/when a future phase (outside this brief's scope) starts creating them.

## 9. Confirmations

- **Frozen modules were not modified.** Verified by `git status`/`git diff` scope (only
  `finance.router.ts` touched, additively) and by the full regression suite above passing unchanged.
- **No new permission was introduced** — reuses `report:financial_view` throughout.
- **No schema/migration was added** — `prisma validate` confirms, and no new Prisma model/column
  appears in this phase's diff.
- **No commit, no push, no frontend work, no G2g-7g, no GSTN filing/export** were performed. This
  phase stops here for human review, per the brief's own stop condition.
