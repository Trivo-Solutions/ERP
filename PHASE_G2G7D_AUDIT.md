# Phase G2g-7d — Inward RCM & Self-Invoicing: Read-Only Audit

**Status: AUDIT COMPLETE. NO CODE WRITTEN. Awaiting decisions before implementation**, per the
phase brief's own repeated stop-and-review gates (its §6, §8D/E, §22, §28, §31-32).

This mirrors the project's existing precedent of a dedicated audit/decisions file before a
statutorily-sensitive phase (`PHASE_J1_AUDIT.md`, `COMPANY_ISOLATION_AUDIT.md`,
`PHASE_G2G7A_IMPLEMENTATION.md`, `PHASE_G2G7C_IMPLEMENTATION.md`).

---

## A. Current data model — exactly what exists today

| Fact | Where | Detail |
|---|---|---|
| Supplier | `Supplier` (schema.prisma:1042) | `gstNumber String?`, `isComposition Boolean` (G2g-7a). **No RCM/registration-status field.** Deliberately no `isRcmLiable` — comment at 1066-1070 already reasons RCM is a supply property, not a supplier property. |
| PO line | `PoItem` (1301) | `materialType` (FINISHED_GOODS / FINISHED_LOT / raw-material types — **always physical jewellery stock**), `hsnCodeId`, `taxRate` (snapshot), `taxCategory` (G2g-7a: TAXABLE/EXEMPT/NIL_RATED/NON_GST/ZERO_RATED). **No field for a service line (freight, legal fee, security, director fee) at all** — `PoItem` requires `quantity`/`weight`/`materialCode` in a stock sense; there is no "expense" or "non-stock inward supply" line anywhere in the schema. |
| GRN line | `GrnItem` (1416) | `taxableValue`, `inputCgst/Sgst/Igst` (booked once, at intake), `buyerRegistrationId` (G2g-7a, resolved from the GRN's receiving branch, never backfilled). **No date of its own** — inherits `GoodsReceiptNote.receivedDate`. |
| Dates | `PurchaseOrder.orderDate`, `GoodsReceiptNote.receivedDate` (required, drives journal date/FY/period filters) vs `GoodsReceiptNote.invoiceDate` (optional, supplier's bill date, **purely informational — not used as a time-of-supply driver anywhere**). No per-line date. |
| Payments | `SupplierPayment` (1099) | **Account-level only** — no `grnId`/`poId`/bill link of any kind (schema comment is explicit about this). Cannot answer "was THIS supply's RCM tax paid, and when" at a per-transaction level. |
| Registrations | `CompanyGstRegistration` (181), `Branch.gstRegistrationId` (2238) | `resolveBuyerRegistration()` (`shared/inputGst.ts:45`) resolves from the GRN's receiving branch → company's primary active registration → `null`. No legacy fallback (deliberate, matches G2g-7a's "never silently backfill" rule). |
| Purchase Return / Debit Note | `PurchaseReturn`/`Item` (1120), `DebitNote`/`Item` (1176) | Reverses input GST proportionally from the **originally booked** rate, never today's rate. `DebitNote.grnId` is a **required, non-nullable FK** — cannot represent a note for a supply with no GRN lineage (e.g. a GTA bill, which has no "goods receipt" in this stock sense). |
| Numbering | `shared/numberSequence.ts` | `nextDocumentNumber(companyId, documentType, prefix, tx, year)`. **Registration-scoped precedent already exists and is proven**: `creditNote.service.ts`/`salesDebitNote.service.ts` key their counters as `` `CN:${sellerRegistrationId}` ``/`` `SDN:${...}` ``. Buy-side docs (`PO`, `GRN`, `PRET`, `SPMT`) are all plain, non-registration-scoped — the buy side has never needed per-registration numbering before G2g-7a. |
| Accounting | `shared/ledgerAccounts.ts` + full chart in `starterPackage/v1.ts:109-157` (36 accounts, codes 1000-7000) | `1401/1402/1403` = Input CGST/SGST/IGST (ordinary purchase ITC). `2201/2202/2203` = CGST/SGST/IGST Payable (ordinary **sell-side** output tax). **Zero RCM-specific accounts anywhere in the chart.** No "RCM Payable" / "RCM ITC Receivable" pair exists. |
| Existing engines | `gstr3bItcEligibility.ts`, `gstr3bItcAggregation.ts`, `gstr3bItcReporting.service.ts` (G2g-7c, frozen) | Explicitly carve out RCM as "trivially true by construction... this codebase has no RCM/import/ISD representation... deferred to G2g-7d" (`gstr3bItcEligibility.ts:29-33`). `gstr3bOutwardAggregation.ts:651` already excludes inward RCM from the **outward** 3.1 figure with diagnostic `INWARD_RCM_EXCLUDED_IN_G2G7B`. Both sides are already waiting for this phase, cleanly. |
| Sell-side RCM flag | `TaxInvoice.reverseCharge Boolean` (schema.prisma:3596) | The **only** RCM field in the whole schema today — marks an **outward** invoice this company issues under RCM (i.e., where the *recipient* pays). Opposite direction from this phase. Not reusable. |
| Security pattern | `finance.router.ts` (19 GST/financial report routes) | Uniform: `requirePermission('report:financial_view')` → `assertOwnedByCompany('companyGstRegistration', ...)` → `assertBranchAccessible`/`branchAccess` threading. No GST-specific permission sub-string exists; the established convention is to reuse `report:financial_view`. |

**Net finding: zero RCM data representation exists anywhere** — confirmed by exhaustive grep (every
"RCM"/"reverse charge" hit in the repo is either the unrelated sell-side `TaxInvoice.reverseCharge`,
or GSTR-1/3B code that has already explicitly carved RCM out and pointed at this phase).

### A.1 — The fact that changes this phase's shape for *this* business

`PoItem`/`GrnItem` only ever represent **physical jewellery stock** (finished goods, raw metal,
diamonds/stones). There is no line-item concept anywhere for a *service* purchase. This matters
because — per the legal research below — almost every realistic RCM category for a trading business
(GTA freight, advocate fees, security services, director's services, sponsorship, rent-a-cab) is a
**service**, not a stock purchase. See §B.6 for why this is a genuine fork, not a detail.

---

## B. Official-source legal findings (verified this session, not from training-data recall)

1. **Section 9(3)** — RCM applies only to specific CBIC-notified goods/services, no threshold. For a
   jewellery trading business the realistic categories are: GTA freight, legal services from an
   advocate, security services (non-corporate supplier), director's services, sponsorship services,
   renting of motor vehicles — **all services**, none of which this schema can currently record as a
   line item. [Notified list — ClearTax](https://cleartax.in/s/reverse-charge-gst), [CBIC handbook on
   RCM](https://d23z1tp9il9etb.cloudfront.net/download/pdf25/Handbook%20on%20Reverse%20Charge%20under%20GST12-2-25.pdf).
2. **Section 9(4)** (blanket RCM on *any* unregistered-supplier purchase) has been **suspended since
   February 2019** for everyone except real-estate promoters (cement/capital goods, Notification
   07/2019-CT(Rate)). **"Unregistered supplier" alone is explicitly NOT a current RCM trigger for this
   business** — confirms the brief's own warning (§3/§6) not to assume otherwise, and confirms the
   audited schema's existing restraint (no `Supplier.isRcm`) was already the right call.
   [TaxGuru — Section 9(4) abeyance](https://taxguru.in/goods-and-service-tax/gst-reverse-charge-section-9-4-abeyance-amendment-revival.html).
3. **Metal scrap RCM (Notification 06/2024-CT(Rate), eff. 10-Oct-2024)** brings scrap sold by an
   unregistered supplier under RCM — but **only for Customs Tariff Chapters 72-81 (base metals: iron,
   copper, aluminium, etc.)**. **Chapter 71 (precious metals — gold, silver) is NOT covered.** This is
   directly relevant: TRIVO's Old Gold Exchange (C4/D4/I7) deals exclusively in Chapter 71 gold/silver
   scrap, so **this notification does not apply to it.**
   [TaxGuru](https://taxguru.in/goods-and-service-tax/metal-scrap-supplied-unregistered-suppliers-brought-reverse-charge.html),
   [VJM Global](https://www.vjmglobal.com/blog/tds-and-gst-under-rcm-on-supply-of-metal-scrap).
4. **Self-invoice (§31(3)(f), Rule 46 2nd proviso, new Rule 47A eff. 1-Nov-2024 / Notification
   20/2024-CT)** — required **only when (a) the recipient is liable under RCM, AND (b) the supplier is
   unregistered** (no other valid tax document exists). Must be issued within **30 days of receipt**.
   If the RCM supplier IS registered, the supplier issues their own invoice (marked RCM-applicable,
   tax not charged) and **no self-invoice is needed**.
   [GST Vidhi](https://gstvidhi.com/articles-gst-vidhi-act-detail.aspx?id=2392),
   [TaxScan — Rule 47A](https://www.taxscan.in/?p=453702).
5. **Payment voucher (§31(3)(g))** — recipient issues this to the supplier *at the time of payment*,
   for RCM supplies (closely associated with the unregistered-supplier/self-invoice case in practice).
   [IRISGST](https://irisgst.com/reverse-charge-mechanism-preparation-of-payment-voucher/).
6. **Time of supply (§12(3) goods / §13(3) services)** — earliest of: receipt of goods (goods only);
   date of payment in books or bank debit, whichever earlier; or the day after 30 days (goods) / 60
   days (services) from the supplier's invoice/document date. [Masters India](https://www.mastersindia.co/blog/gst-time-of-supply-section-12-13/).
   This system has **no per-transaction payment-date linkage** (`SupplierPayment` is account-level,
   §A) — so "date of payment" cannot be determined reliably. This is a genuine, not merely a
   data-entry, gap.
7. **RCM ITC (§16, Rule 86(2))** — RCM tax **must be paid in cash** (electronic cash ledger; the
   credit ledger cannot be used) before the ITC becomes available; ITC accrues in the period the tax
   is actually *paid*, not merely accrued/self-invoiced. Not hit by §16(4)'s time limit for this reason.
   Still subject to §17(5) blocked-credit categories and the ordinary business-use test.
   [Busy.in — Section 16(4)](https://busy.in/gst/gst-section-16-4-itc-time-limit-2026/).
8. **GSTR-2B** does **not** auto-populate RCM supplies from unregistered persons (nor import-of-services
   RCM) into GSTR-3B — the taxpayer must self-assess and manually enter these. For registered-supplier
   RCM categories (GTA/legal/security), GSTR-2B reflects the supplier's own filing but the ITC side is
   still the recipient's own self-assessment. [TaxHeal — ignore 3.1(d) prompt](https://www.taxheal.com/?p=88283).
9. **GSTR-3B mapping** — RCM liability → **Table 3.1(d)**. RCM **ITC**: domestic RCM → **Table 4(A)(3)**
   specifically (distinct from 4(A)(2), which is **import of services** RCM — not this phase's scope,
   confirmed absent from the data model per §A). Never 4(A)(5) (ordinary ITC, G2g-7c's frozen bucket).

### B.1 — The business-relevance conclusion this audit must state plainly

Putting §A.1 and §B.2/§B.3 together: **under the current data model, there is no transaction type in
TRIVO's live data that is actually subject to RCM today.** Jewellery-stock purchases from unregistered
suppliers are not RCM (§9(4) suspended); old-gold/silver scrap intake is not RCM (Chapter 71 excluded
from the only metal-scrap notification); and the realistic §9(3) service categories (freight, legal,
security, director, sponsorship, rent-a-cab) have **no line-item representation in this schema at all**
— they are not currently recorded as purchases/expenses anywhere in the ERP.

This does not make the engine pointless — a future service-expense recording feature, a future
notification change, or a manual/administrative entry could all produce real RCM facts — but it does
mean this phase is **genuinely a dormant foundation** against today's actual data, not a feature that
will show live, non-zero numbers. That must be stated honestly in the report and the UI/API response,
never implied otherwise (brief §25, "No False Compliance").

---

## C. Time-of-supply data — direct answer

Not reliably determinable today: no per-GRN-line payment-date link (`SupplierPayment` is
account-level); `GoodsReceiptNote.invoiceDate` exists but is never used as a time driver; no field
records "date of entry in recipient's books" distinct from `receivedDate`. **Classification/liability
dates in this phase will use `GoodsReceiptNote.receivedDate` as the best available proxy for "date of
receipt," explicitly diagnosed as `RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE` wherever the §12(3)/§13(3)
30/60-day-from-invoice or payment-date branches would matter** — never silently assumed.

## D. Self-invoice representability

No existing model fits: `DebitNote.grnId` is mandatory (a self-invoice for a GTA/legal-fee supply has
no GRN to point at); the sell-side `TaxInvoice`/`CreditNote` e-invoice shape is the wrong direction.
**A new `SelfInvoice` model is required** if self-invoicing is to be represented at all (architecture
below) — the brief's own §D anticipated this ("do not implement until the audit establishes the
required model" — it now has).

## E. Payment voucher representability

No existing model. Per brief §15, this phase represents only a `PAYMENT_VOUCHER_REQUIRED /
NOT_REQUIRED / NOT_DETERMINED` status field on the liability record — no document generation.

## F. GSTR-3B mapping (deterministic, for the future aggregator)

- **Table 3.1(d)**: sum of `RcmLiability.{taxableValue, cgst, sgst, igst, cess}` for the period/registration where `classification = RCM_APPLICABLE`.
- **Table 4(A)(3)**: sum of the same lines **only** where ITC eligibility = `eligible` under the modeled rules (§B.7's "paid in cash" gate) — never equal to 3.1(d) by construction, and never merged with G2g-7c's domestic 4(A)(5) bucket.

---

## Proposed architecture (smallest model that is honest about what's determinable)

```
PoItem.rcmCategory (new, explicit, nullable, mirrors taxCategory — never inferred)
        |
gstr3bRcmClassification.ts   — pure: RCM_APPLICABLE | RCM_NOT_APPLICABLE | RCM_UNRESOLVED + diagnostics
        |
gstr3bRcmTaxCalculation.ts   — pure: reuses splitInputGst() for CGST/SGST vs IGST; no new split logic
        |
RcmLiability (new table)     — companyId, gstRegistrationId, source PoItem/GrnItem ref, taxable/cgst/sgst/igst/cess,
                                category, selfInvoiceRequirement, paymentVoucherRequirement, itcStatus, period, provenance
        |                \
SelfInvoice (new table)     \  payment-voucher: status field only on RcmLiability (no document model, per brief §15)
  FY+registration-numbered
  (SELFINV:<regId> key, same
  proven pattern as CN:/SDN:)
        |
gstr3bRcmAggregation.ts      — pure aggregator → Table 3.1(d) liability, Table 4(A)(3) ITC (modeled-eligible only)
        |
gstr3bRcmReporting.service.ts — tenant-scoped, mirrors gstr3bItcReporting.service.ts's load→resolve→aggregate shape
        |
GET /finance/reports/gstr3b-rcm  (report:financial_view, same registration/branch-ownership gate as every other GST report)
```

Key design choices, each tied to an audit/legal finding above (not invented):
- **`rcmCategory` lives on `PoItem`** (line-level, per brief §5/§9), not `Supplier` — explicit enum
  (`NONE | GTA_FREIGHT | LEGAL_SERVICES | SECURITY_SERVICES | DIRECTOR_SERVICES | SPONSORSHIP |
  RENT_A_CAB | OTHER_NOTIFIED | UNRESOLVED`), decided at entry like `taxCategory`, defaults to `NONE`
  for every existing/new row unless explicitly set — **never** inferred from `gstNumber` blank/filled
  (§B.2 is exactly why).
- **Classification never short-circuits on "unregistered" alone** — only an explicit non-`NONE`
  `rcmCategory` plus the existing registration/GSTIN/tax-category checks (reusing the same five-check
  shape as `gstr3bItcEligibility.ts`) can produce `RCM_APPLICABLE`.
- **Tax calculation reuses `splitInputGst`** verbatim (brief §10) — no new CGST/SGST/IGST logic.
- **Self-invoice requirement is its own derived field**, never `RCM_APPLICABLE → required` (brief §14)
  — `SELF_INVOICE_REQUIRED` only when classification is `RCM_APPLICABLE` **and** the specific
  supplier's `gstNumber` is blank; `NOT_REQUIRED` when `RCM_APPLICABLE` with a registered supplier;
  `NOT_DETERMINED` when classification itself is `RCM_UNRESOLVED`.
- **ITC eligibility is gated on an explicit "RCM tax paid" event**, never on liability-creation alone
  (brief §16/§17) — since `SupplierPayment` cannot represent a per-bill government cash payment (§A),
  this needs a **new, narrow, explicit action** (e.g. `markRcmLiabilityPaid()`) that records the cash
  payment and posts the liability-extinguishing journal; until that action runs, ITC status is
  `UNRESOLVED` (`RCM_PAYMENT_NOT_RECORDED`), never `ELIGIBLE`.
- **New ledger accounts are required** — none of the 36 existing accounts can represent an RCM
  liability or RCM-specific ITC without mixing into ordinary Input/Output GST (forbidden by brief §20).
  Proposed (pending confirmation, same "seed into every company's chart via migration" precedent as
  6600 Round Off): `2204 RCM Tax Payable`, `1404 RCM Input Tax Credit (ITC)`.
- **Numbering**: `SelfInvoice` reuses the proven registration-scoped `nextDocumentNumber` pattern —
  `` `SELFINV:${gstRegistrationId}` ``, prefix `SELFINV`, FY-scoped — exactly like `CN:`/`SDN:` (§A).
- **No change to any frozen G2g-7b/7c file** — the new engine reads `PoItem.rcmCategory`/`RcmLiability`
  independently; ordinary ITC continues through the untouched G2g-7c pipeline, which already
  (correctly) assumes zero RCM in its own inputs.

---

## Open decisions — need your confirmation before any schema/code changes

See the question below for the one genuine fork. Two smaller points, stated for the record rather
than blocking: (1) the two new ledger-account codes above are a proposal, not yet seeded anywhere;
(2) self-invoice/payment-voucher stay architecture-only (status fields), no PDF/print generation, per
the brief's own §15 instruction — flagging only so it isn't read as an oversight later.
