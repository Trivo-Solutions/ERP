# Phase G2g-7d — Inward RCM & Self-Invoicing Foundation: Implementation Report

**Scope decision (confirmed before any code was written): "Foundation only."** The read-only audit
(`PHASE_G2G7D_AUDIT.md`) found that TRIVO's current data model has no line-item concept for a
*service* purchase (freight, legal fees, security, director fees) — the realistic Section 9(3) RCM
categories for a trading business — and that neither of TRIVO's two actual inward-supply flows
(jewellery-stock PO/GRN, old-gold exchange) is RCM-liable under current law (Section 9(4)'s blanket
unregistered-supplier rule is suspended; the only metal-scrap RCM notification excludes Chapter 71
precious metals). Given that, the build is a pure, reusable classification/liability/self-invoice/
ITC engine plus the minimal schema (`PoItem.rcmCategory`, `RcmLiability`, `SelfInvoice`) needed to
represent a notified supply **if and when one is ever flagged** — not a new way to record a
service-type expense. This table is expected to stay empty against today's real data; that is the
honest, correct state, not an incomplete rollout.

---

## Files created

- `PHASE_G2G7D_AUDIT.md` — the read-only audit + legal research + proposed architecture, produced
  and reviewed before any schema/code change (brief §6/§31's own "audit first" gate).
- `server/prisma/migrations/20261002160000_g2g7d_inward_rcm_foundation/migration.sql`
- `server/src/shared/rcmCategory.ts` — the `RcmCategory` enum (shared/taxCategory.ts's sibling).
- `server/src/modules/finance/gst/gstr3bRcm.types.ts` — data contracts (parallel to `gstr3bItc.types.ts`).
- `server/src/modules/finance/gst/gstr3bRcmClassification.ts` — pure classification engine
  (`classifyRcmSupply`, `determineSelfInvoiceRequirement`, `determinePaymentVoucherRequirement`).
- `server/src/modules/finance/gst/gstr3bRcmTaxCalculation.ts` — pure tax calculator (`calculateRcmTax`,
  thin wrapper reusing `shared/inputGst.ts: splitInputGst`).
- `server/src/modules/finance/gst/gstr3bRcmItcEligibility.ts` — pure ITC-eligibility engine (`classifyRcmItc`).
- `server/src/modules/finance/gst/gstr3bRcmAggregation.ts` — pure GSTR-3B 3.1(d)/4(A)(3) aggregator
  (`aggregateGstr3bRcm`).
- `server/src/modules/finance/gst/gstr3bRcmReporting.service.ts` — tenant-scoped report loader
  (`getGstr3bRcmReport`), parallel to `gstr3bItcReporting.service.ts`.
- `server/src/modules/finance/gst/gstr3bRcmBooking.service.ts` — the write side
  (`bookRcmLiabilityIfApplicable`, `markRcmLiabilityPaid`, `listRcmLiabilities`).
- Tests: `gstr3bRcmClassification.test.ts` (20), `gstr3bRcmTaxCalculation.test.ts` (8),
  `gstr3bRcmItcEligibility.test.ts` (3), `gstr3bRcmAggregation.test.ts` (11),
  `gstr3bRcmReporting.service.test.ts` (5), `src/test/gstr3bRcmBooking.test.ts` (9),
  `src/test/http.gstr3bRcmSecurity.test.ts` (7) — **63 focused tests**.

## Files modified

- `server/prisma/schema.prisma` — `PoItem.rcmCategory` (nullable); new `RcmLiability`/`SelfInvoice`
  models; back-relations on `Company`, `User` (×4), `JournalEntry` (×2), `HsnCode`,
  `CompanyGstRegistration`, `Supplier`, `GrnItem`.
- `server/src/shared/ledgerAccounts.ts` — `RCM_INPUT_TAX_CREDIT: '1404'`, `RCM_TAX_PAYABLE: '2204'`.
- `server/src/modules/platform/starterPackage/v1.ts` — same two accounts added to the chart (new
  companies get them at provisioning; existing companies via the migration's seed, below).
- `server/src/modules/tagging/tagging.service.ts` — `createTagFromGrnItem`: supplier query now
  selects `id`; one call to `bookRcmLiabilityIfApplicable` added right after the existing ordinary
  input-GST journal/GrnItem stamp, inside the same transaction. **No other line changed.**
- `server/src/modules/procurement/procurement.service.ts` — `createPO`: accepts/validates/defaults
  a per-line `rcmCategory` (mirrors `taxCategory` exactly). `openPurchaseLot`: widened parameter
  type (+`rcmCategory`/`taxCategory`/`hsnCodeId`/`supplierGstNumber`), one call to
  `bookRcmLiabilityIfApplicable` added after its own ordinary journal/GrnItem stamp. `createGRN`:
  one extra field (`supplierGstNumber: po.supplier.gstNumber`) threaded into its existing call to
  `openPurchaseLot`.
- `server/src/modules/finance/finance.router.ts` — three new routes (below).
- `server/src/test/rls.enforced.test.ts` — one hardcoded chart-of-accounts count (42 → 44), a direct,
  expected consequence of seeding two new accounts into every company (same precedent as the
  Round-Off migration bumping this same number previously).

## Files intentionally untouched

Every frozen/adjacent module named in the brief's §28: `gstr3bOutwardAggregation.ts`/
`gstr3bReporting.service.ts` (G2g-7b), `gstr3bItcEligibility.ts`/`gstr3bItcAggregation.ts`/
`gstr3bItcReporting.service.ts` (G2g-7c), every `gstr1*` module, every `gstr1Filing*`/`gstr1GstnWire`
module. Also untouched, per the brief's own scope limits: `createPurchaseReturn`/`DebitNote` (no RCM
adjustment logic — see Known Limitations), `SupplierPayment` (not used for RCM payment — see
Accounting below), any GSTR-2B/import-of-services/ISD/Rule 42-43/180-day engine, the frontend.

## Database / migration changes

One migration, `20261002160000_g2g7d_inward_rcm_foundation`:
- `ALTER TABLE po_items ADD COLUMN "rcmCategory" TEXT` (nullable, no backfill — every existing row
  stays NULL).
- `CREATE TABLE rcm_liabilities` / `CREATE TABLE self_invoices`, with composite FKs to
  `company_gst_registrations`, `grn_items`, `suppliers` (and, for `self_invoices`,
  `rcm_liabilities`) — the database itself refuses a row pointing at another company's parent.
- Seeds two new ledger accounts (`1404 RCM Input Tax Credit (ITC)`, `2204 RCM Tax Payable`) into
  every **existing** company's chart, FORCE RLS lifted around the `INSERT` exactly like the prior
  Round-Off migration's precedent. New companies get them from the Starter Package.

Applied and verified against: the local dev DB (`sea_erp_db`), the local test DB (`sea_erp_test`),
and the real role-split staging cluster (`trivo_rlstest`, as `trivo_owner`, with `db-secure.sql`
re-run there afterward so `trivo_runtime` actually has grants on the two new tables).

## RLS changes

`rcm_liabilities` and `self_invoices` are `ENABLE`+`FORCE ROW LEVEL SECURITY` with the standard
`tenant_isolation` policy — same precedent as the most recent comparable migration
(`company_gst_aatos`, 2026-09-30). **Gotcha hit and resolved during this phase's own test-writing**:
FORCE RLS applies even to the table owner, so every read of these two tables — including in test
fixtures — must go through `tenantQuery`/`tenantTransaction`, never a bare `platformPrisma` call;
this is the exact same documented gotcha CLAUDE.md already notes for `company_gst_registrations`.
All of this phase's own test files follow that rule.

## RCM classification model

`classifyRcmSupply(facts, requestedGstRegistrationId)` → `RCM_APPLICABLE | RCM_NOT_APPLICABLE |
RCM_UNRESOLVED` (+ scope `IN_SCOPE | EXCLUDED_OTHER_REGISTRATION`, mirroring the frozen G2g-7c
classifier's shape exactly). Checks, first match wins: (1) no/NONE category → NOT_APPLICABLE (the
default for ~100% of real rows); (2) category UNRESOLVED → UNRESOLVED
(`RCM_CATEGORY_UNRESOLVED`); (3) registration scope (match / unassigned `RCM_REGISTRATION_UNASSIGNED`
/ excluded-other-registration); (4) tax-category conflict (`RCM_TAX_CATEGORY_CONFLICT` — a notified
category combined with EXEMPT/NIL_RATED/NON_GST/ZERO_RATED is reported, never silently resolved
either way); otherwise `RCM_APPLICABLE`. **Never infers RCM from a blank supplier GSTIN** — Section
9(4)'s blanket rule is suspended (verified this session; PHASE_G2G7D_AUDIT.md §B.2) — only an
explicit, human-entered `PoItem.rcmCategory` naming a real notified category can produce
`RCM_APPLICABLE`.

`determineSelfInvoiceRequirement`/`determinePaymentVoucherRequirement` are separate, derived
functions — `RCM_APPLICABLE` alone never implies either requirement unconditionally (brief §14/§15):
self-invoice is `REQUIRED` only when the supplier additionally has no valid GSTIN; payment voucher
is `REQUIRED` whenever RCM applies, independent of registration.

## RCM tax calculation

`calculateRcmTax` reuses `shared/inputGst.ts: splitInputGst` verbatim (brief §10 — "do not duplicate
GST splitting logic") and adds only a `posUnresolved` flag for when neither state code resolves, fed
into the report-level `RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE`-class diagnostics. The self-assessed rate
is looked up from the line's own `HsnCode.gstRate` at booking time (not `PoItem.taxRate`, which a
correctly-entered RCM line should carry as 0 — see Known Limitations).

## Liability accounting

At booking time (inside `createTagFromGrnItem`/`openPurchaseLot`'s existing transaction, immediately
after the ordinary input-GST journal), an `RCM_APPLICABLE` line posts:

```
Dr 1404 RCM Input Tax Credit (ITC)   totalTax
   Cr 2204 RCM Tax Payable                totalTax
```

— a balanced self-assessed accrual, consistent with how this codebase already books ordinary output
GST (2201-2203) at the moment of sale, well before any actual cash remittance to the government is
modeled. **An `RCM_UNRESOLVED` line posts nothing** — a flagged-but-unconfirmed fact is never
written to the books (brief §25).

`markRcmLiabilityPaid()` (new, `journal:create` — the same permission `recordSupplierPayment`
already rides, since this is the identical class of accounting action) posts the settlement:

```
Dr 2204 RCM Tax Payable         totalTax
   Cr <Cash/Bank>                    totalTax
```

count-checked (`updateMany` with a `status: 'LIABILITY_RECOGNIZED'` precondition), not a blind
update — closing the exact lost-update class of bug J3.5's hardening pass already fixed once.

## Self-invoice handling

`SelfInvoice` is created only when `selfInvoiceRequirement === 'SELF_INVOICE_REQUIRED'` (RCM applies
AND the supplier has no valid GSTIN), inside the same transaction as the liability. Numbered via the
already-proven registration-scoped `nextDocumentNumber` pattern — `` `SELFINV:${gstRegistrationId ??
'LEGACY'}` ``, prefix `SELFINV`, FY-scoped exactly like `CN:`/`SDN:`. Every money/HSN field is a
snapshot copied from the liability at issue time; `supplierName`/`supplierAddress` are copied too
(a later edit to the `Supplier` row must not rewrite an already-issued self-invoice).

## Payment voucher handling

Architecture/status only, exactly per the brief's own §15 instruction — `RcmLiability.
paymentVoucherRequirement` is computed and reported, but **no document is generated**. Deferred
whole, not partially built.

## ITC handling

`classifyRcmItc(liabilityStatus)` → `ELIGIBLE` only when `status === 'TAX_PAID'`; otherwise
`UNRESOLVED` (`RCM_PAYMENT_NOT_RECORDED`). Merely recognizing a liability never makes ITC available
(brief §16/§17, Rule 86(2)) — verified by a dedicated regression test
(`gstr3bRcmItcEligibility.test.ts`: "merely recognizing a liability never makes ITC available on its
own"). `INELIGIBLE` exists in the type for future extensibility (Section 17(5)) but is not reachable
in this phase's model — flagged as `RCM_SECTION_17_5_NOT_DETERMINABLE` at the report level instead of
silently defaulting every line to eligible.

## GSTR-3B mapping

- **Table 3.1(d)**: `aggregateGstr3bRcm`'s `table3_1d.recognized` — sum of every in-scope
  `RCM_APPLICABLE` line. `table3_1d.unresolved` is a **separate** bucket, never merged in.
- **Table 4(A)(3)**: `table4A3.{eligible, unresolved, ineligible}` — distinct from G2g-7c's own
  4(A)(5) bucket (never touched) and from 4(A)(2) import-of-services (not modeled; this codebase has
  no import-of-service data at all).

## Diagnostics

Per-line: `RCM_CATEGORY_UNRESOLVED`, `RCM_REGISTRATION_UNASSIGNED`, `RCM_TAX_CATEGORY_CONFLICT`.
Per-liability: `RCM_PAYMENT_NOT_RECORDED`. Report-level (always emitted once):
`RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE`, `RCM_SECTION_17_5_NOT_DETERMINABLE`,
`GSTR_2B_RCM_RECONCILIATION_UNAVAILABLE`, plus `PARTIAL_BRANCH_SCOPE` when branch-restricted.

## API

`GET /finance/reports/gstr3b-rcm` (`report:financial_view`, `gstRegistrationId` required, same
ownership/branch-access gate as every other GST report in `finance.router.ts`). `GET
/finance/rcm-liabilities` (`report:financial_view`) and `POST
/finance/rcm-liabilities/:id/mark-paid` (`journal:create`) — no new permission string was created,
per the brief's own §23 instruction, reusing the established conventions.

## Tests

```
Focused (new G2g-7d files):            63
Procurement/tagging regression:        full existing suites re-run, 0 failed
Full server suite (local, sea_erp_test): 106 files / 1938 passed, 5 pre-existing skips, 0 failed
Full server suite (test:rls, trivo_rlstest): 106 files / 1942 passed, 1 pre-existing skip, 0 failed
Tenant audit (npm run audit:tenant):   0 violations (baseline unchanged — new code uses
                                        tenantQuery/tenantTransaction throughout)
TypeScript (tsconfig.json, tsconfig.build.json): both clean
Prisma validate:                       clean
```

One pre-existing test (`rls.enforced.test.ts`) had a hardcoded chart-of-accounts row count that
needed bumping from 42 to 44 — an expected, direct consequence of seeding the two new accounts into
every company, not a regression; fixed and re-verified.

## Known limitations

**Statutory limitations** (confirmed `NOT_DETERMINABLE` by the data model, reported as diagnostics,
never silently assumed resolved): RCM time of supply (Sections 12(3)/13(3) — no per-GRN-line
payment-date link exists; `SupplierPayment` is account-level); Section 17(5) blocked-credit
categories; GSTR-2B reconciliation (no ingestion exists — deferred to G2g-7e, per the brief's own
stop boundary).

**Data-model limitations**: `createPO` does **not** force `taxRate = 0` when a line's `rcmCategory`
is a notified category — a line combining both would double-book (once as ordinary input GST, once
as self-assessed RCM tax). This phase relies on correct operator entry rather than an automatic
guard; a future hardening pass could add that check. No validation currently exists preventing a
future caller from setting `rcmCategory` on a non-FINISHED_GOODS/FINISHED_LOT line either — this was
not exercised because no such line type currently reaches `bookRcmLiabilityIfApplicable` (only the
two existing booking call sites invoke it).

**Business-decision limitations** (the "foundation only" scope, confirmed before implementation):
no new entity exists to record a genuine service-type inward supply (GTA freight, legal fees,
security, director fees) — the only realistic Section 9(3) categories for this business. Against
today's real data, `rcm_liabilities`/`self_invoices` are expected to stay empty. `createPurchaseReturn`/
`DebitNote` have no RCM-aware adjustment path (brief §21's own allowed deferral —
`RCM_ADJUSTMENT_UNRESOLVED` was never needed because no live RCM transaction exists yet to return).

**Deferred phases** (explicitly out of scope per the brief's §29/§32): G2g-7e (GSTR-2B
reconciliation), G2g-7f (GSTR-3B filing lifecycle), G2g-7g (GSTN wire/export), import of services,
ISD, Rule 42/43, the 180-day supplier-payment reconciliation, frontend.

---

**STOP per the brief's §32.** No commit, no push, no G2g-7e, no frontend, no filing work. Awaiting
human review.
