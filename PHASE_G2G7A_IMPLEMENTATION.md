# Phase G2g-7a — Inward GST Foundation & Multi-GSTIN Attribution: Implementation

> Data-model/attribution foundation only, per the G2g-7a brief. No GSTR-3B aggregation, ITC
> eligibility calculation, GSTR-2B reconciliation, RCM self-invoicing/journal posting, 180-day
> reversal logic, GSTN GSTR-3B serialization, or filing is implemented here. All frozen GSTR-1 /
> filing-lifecycle / sales modules listed in the brief's §3 were read for context only — none were
> modified.

---

## 1. Scope actually implemented

| # | Capability | Where | Status |
|---|---|---|---|
| A | `GrnItem.buyerRegistrationId` — which company GST registration an inward GRN line is attributed to | `prisma/schema.prisma`, `shared/inputGst.ts: resolveBuyerRegistration()`, wired into `tagging.service.ts: createTagFromGrnItem()` and `procurement.service.ts: openPurchaseLot()` | Done |
| B | `TaxCategory` concept (TAXABLE / EXEMPT / NIL_RATED / NON_GST / ZERO_RATED) | `shared/taxCategory.ts`, `PoItem.taxCategory`, wired into `procurement.service.ts: createPO()` | Done |
| C | `Supplier.isComposition` | `prisma/schema.prisma`, wired into `procurement.service.ts: createSupplier()` | Done (schema + create path only — no update endpoint exists for Supplier at all; see §E) |
| — | RCM data fields (supplier- or line-level) | — | **Deliberately not built — see §E** |
| — | Client `isComposition`/`isUin` (recipient classification) | — | **Deliberately deferred to G2g-7b — out of this phase's inward-only scope** |
| — | `PurchaseBill`/`SupplierInvoice` model | — | **Not built — Option B chosen, see §C** |

---

## 2. Pre-check findings (read-only pass)

Read before writing anything: `schema.prisma` (GoodsReceiptNote, GrnItem, PurchaseReturn,
PurchaseReturnItem, DebitNote, DebitNoteItem, Supplier, PurchaseOrder, PoItem, PoItemCategory,
PurchaseLot, Branch, CompanyGstRegistration, Client), `procurement.service.ts`, `tagging.service.ts`
(`createTagFromGrnItem`), `shared/inputGst.ts`, `shared/constants.ts`, `finance.service.ts`,
`shared/ledgerAccounts.ts`, `permissionCatalog.ts`, recent migration SQL files for the exact
composite-FK/RLS SQL convention, and `gstr1Classification.ts` (to confirm no existing "tax category"
concept already covers this — it doesn't; `Gstr1OutwardCategory` is B2B/B2CL/B2CS, an unrelated
per-transaction classification).

Key facts the audit confirmed against the actual code (not assumed from the brief):

1. **The actual "legal inward GST transaction" granularity is the `GrnItem` line, not the GRN header
   or the PoItem.** `GrnItem.taxableValue`/`inputCgst`/`inputSgst`/`inputIgst` are already the
   statutory numbers the purchase-GST register reads and a purchase return reverses — and they are
   stamped at two DIFFERENT moments depending on material type: `createTagFromGrnItem`
   (FINISHED_GOODS, at tag-creation time) and `openPurchaseLot` (FINISHED_LOT, at GRN-receipt time).
   Both write to the same `GrnItem` row via `tx.grnItem.update(...)`. This made the placement decision
   in §3 straightforward: stamp `buyerRegistrationId` in the exact same `tx.grnItem.update(...)` call,
   at the exact same moment, for both material types.
2. **The purchase side currently has no registration-aware state resolution at all** — `splitInputGst`
   takes `company.stateCode` (the legacy, single, company-wide field), never a specific
   `CompanyGstRegistration.stateCode`. This is the literal gap the brief describes. Deliberately
   **not** fixed in this phase — see §4 (deviations) for why changing the CGST/SGST/IGST split
   calculation itself is out of scope for a foundation phase.
3. **The sell side already has the exact pattern to mirror**: `sales.service.ts:
   resolveSellerRegistration(tx, companyId, branchId)` — branch's own `gstRegistrationId` (if
   `isActive`) else the company's primary active registration, with a legacy fallback built from
   `Company.gstin`/`stateCode` for a company with zero registrations (because `TaxInvoice.gstin` is a
   required, always-populated field). `resolveBuyerRegistration()` mirrors the branch/primary
   resolution exactly, but returns `null` instead of a legacy fallback — see §3.
4. **`company_gst_registrations` can never be hard-deleted** — `company.service.ts` only has
   `createGstRegistration`/`updateGstRegistration` (update can deactivate, never delete). This
   confirmed `ON DELETE RESTRICT` on the new composite FK is safe and, in practice, moot.
5. **No existing `TaxCategory`-shaped concept exists anywhere** — `Gstr1OutwardCategory` (B2B/B2CL/
   B2CS) is a different, unrelated per-transaction sell-side classification; nothing needed reuse.
6. **`Supplier` has no update/edit endpoint at all today** — only `POST /procurement/suppliers`
   (create) and read-only list/payments/returnable-tags/performance routes. This is a pre-existing
   gap (confirmed, not assumed), out of scope to fix here (CLAUDE.md §22 "no unrelated cleanup") — it
   just means `isComposition` can only be set at supplier creation until a future phase adds supplier
   editing.

---

## 3. Attribution design — where `buyerRegistrationId` lives, and why

**Placement: `GrnItem.buyerRegistrationId`**, nullable, composite FK to
`CompanyGstRegistration(id, companyId)`, `ON DELETE RESTRICT`.

Rejected alternatives and why:

- **`GoodsReceiptNote` header** (mirroring `TaxInvoice` sitting on `SalesInvoice`'s header) — rejected
  because the GRN header is written *before* either material type's tax event runs (a FINISHED_GOODS
  line's GST isn't booked until someone later calls `createTagFromGrnItem`, possibly a different day).
  Stamping at GRN-creation time would resolve registration correctly (branch doesn't change), but
  would decouple the attribution from the actual tax event — breaking the "stamped once, at the
  moment the tax event is booked" invariant every other immutable snapshot in this codebase follows
  (`TaxInvoice.sellerRegistrationId`, `PoItem.taxRate`, `GrnItem.taxableValue` itself).
- **A new `PurchaseBill`/`SupplierInvoice` model** (brief §5 Option A) — rejected. The brief's own
  Option B test ("attach to the existing document that represents the accounting/tax event") is
  satisfied exactly by `GrnItem` per finding §2.1 above; building a parallel statutory-bill model
  would create a second representation of the same purchase transaction the brief explicitly warns
  against, for no attribution benefit `GrnItem` doesn't already give.
- **`PoItem`** — rejected. A PO is an order, not yet a receipt; nothing has been legally received
  under any registration until a GRN exists. (`PoItem.taxCategory`, by contrast, *is* placed here —
  see §… below — because a tax *category* is a fact about the goods being ordered, decided at order
  time, not about which of the company's registrations received them.)

**Resolution logic** (`resolveBuyerRegistration`, `shared/inputGst.ts`): the GRN's own *receiving*
branch (`GoodsReceiptNote.branchId`) → that branch's linked, active `CompanyGstRegistration` if any,
else the company's primary active registration, else `null`. Deliberately takes the GRN's receiving
branch, **never** the tag's own branch — `createTagFromGrnItem`'s `branchId` parameter can override
where a tag ends up, but the inward supply was legally received wherever the GRN says it was.
Deliberately does **not** fall back to the company's primary registration when the branch has an
explicit but currently-inactive link (mirrors `resolveSellerRegistration`'s identical behavior
exactly) — an explicit, stale link is reported as unresolved (`null`), never silently swapped for a
different registration the branch didn't ask for. Covered by
`src/test/g2g7aInwardGstFoundation.test.ts`.

Never request-supplied: like `resolveSellerRegistration`, this is resolved entirely server-side from
an already-validated `branchId` (validated by `assertBranchAccessible` back at `createGRN` time) —
there is no new foreign-id-accepting input surface, so no new ownership check was needed beyond what
`createGRN` already enforces.

---

## 4. Tax category design

**Placement: `PoItem.taxCategory`** (nullable `String`, no FK — five fixed statutory values, not a
company-configurable master), alongside the existing `hsnCodeId`/`taxRate` snapshot pair, for the
same reason: a purchase line's statutory classification is a fact about *the goods on the order*,
decided once at PO entry, that a later master change must never reinterpret.

Values: `TAXABLE | EXEMPT | NIL_RATED | NON_GST | ZERO_RATED` (`shared/taxCategory.ts`:
`TAX_CATEGORIES`, `isValidTaxCategory()`, `DEFAULT_TAX_CATEGORY`). Framework-agnostic (no Prisma
import), same shape as `shared/karatMaster.ts`'s `isValidKarat()` minus the per-company DB lookup —
these five values are fixed by GST law, not configurable per company.

**Avoiding zero-rate ambiguity**: `createPO` never derives `taxCategory` from `taxRate`. A line with
`taxRate = 0` (the existing behavior for a non-GST-registered supplier, or a non-INR PO) still
defaults to `TAXABLE` unless the caller explicitly says otherwise — a 0% charge on a supplier's bill
and a genuinely EXEMPT/NIL_RATED/NON_GST/ZERO_RATED *supply* are different statutory facts that must
never be conflated (tested explicitly: `g2g7aInwardGstFoundation.test.ts` — "a zero tax rate
(unregistered-supplier bill) does NOT get auto-classified...").

**Historical rows**: existing `PoItem` rows are left `taxCategory = NULL` — there is no reliable way
to infer this retroactively from `taxRate` alone (see above), so nothing was guessed.

**New rows**: `createPO` accepts an optional `taxCategory` per line, validates it against
`isValidTaxCategory()` (400 on anything else), and defaults to `TAXABLE` only when the caller omits
the field — the overwhelming common case for a jewellery procurement line, and the status quo
assumption this codebase already made everywhere before this column existed.

---

## 5. Supplier/RCM foundation — what was added, and what was deliberately deferred

**Added**: `Supplier.isComposition: Boolean @default(false)`. This is a fact about the supplier's
*own* GST registration status (composition-scheme dealers cannot charge GST a buyer can claim as
input credit) — genuinely static and supplier-level, unlike RCM. Wired into `createSupplier()` as an
optional field (default `false`); no update path exists for `Supplier` at all today (§2.6), so it can
currently only be set at creation.

**Deliberately NOT added: any `isRcmLiable`/RCM flag, anywhere, in this phase.**

The brief itself (§10/§11) flags that RCM applicability under GST turns on the *nature of the
specific supply* (HSN/SAC, or specific notified categories like GTA/legal services), not a permanent
property of a supplier's identity — a supplier who is sometimes RCM-liable and sometimes not (e.g.
most of their invoices are regular B2B, but one line is a notified RCM service) would be mis-modeled
by a supplier-level boolean. The brief's own framing ("do not incorrectly encode it as a permanent
supplier property... if transaction-level classification is required, document the final decision")
reads as a warning that the placement question itself is unresolved, not as license to pick one
placement provisionally.

Three placements were considered:
- **Supplier-level** (`Supplier.isRcmLiable`) — rejected: wrong per the reasoning above; would need
  undoing (a real schema migration) the moment a mixed-liability supplier shows up in practice, which
  is the common case, not an edge case, for RCM.
- **`PoItem`-level** (alongside the new `taxCategory`) — considered seriously (same timing as
  `taxRate`/`taxCategory`, same "decided at order time" shape). Not built in this pass because this
  phase has no fixture or real business rule in the codebase to validate the field's shape against
  (no RCM-related code, test, or UI exists anywhere yet to check an assumption like "a boolean is
  enough" or "it needs a reason/category too" against), and the brief explicitly scopes RCM
  *calculation* to G2g-7d while only optionally permitting a *data field* now ("may introduce" —
  §11). Building the wrong shape now (e.g. a bare boolean, if G2g-7d turns out to need an RCM
  *category* instead) would itself be a schema migration to undo — strictly worse than deferring with
  this reasoning recorded for G2g-7d to pick up.
- **A new join/line-item concept scoped to the specific supply** — not designed at all; would be
  speculative without G2g-7d's actual requirements in hand.

**Decision**: defer entirely to G2g-7d, which is explicitly the RCM phase per the brief's own phase
list (§11, §I). This is recorded here so G2g-7d starts from this reasoning rather than re-deriving it.

**Client `isComposition`/`isUin` (recipient classification, brief §12)**: also deliberately deferred,
to **G2g-7b** — the brief explicitly permits this ("If adding fields now is unnecessary for G2g-7a,
defer them to G2g-7b"), and G2g-7a is scoped to **inward**/procurement only; `Client` is the
outward/recipient side, out of this phase's scope by definition.

---

## 6. Historical data

No migration performs any `UPDATE`/backfill — it is pure `ALTER TABLE ADD COLUMN` (+ one index, one
composite FK). Verified with `prisma migrate diff --from-url <test-db> --to-schema-datamodel
schema.prisma --script`, which returned `-- This is an empty migration.` after applying it — i.e. the
hand-written SQL produces byte-for-byte the same end state Prisma's own generator would, and nothing
beyond the three column additions touches any row.

- **`grn_items.buyerRegistrationId`**: every existing row (and every row created by code paths other
  than `createTagFromGrnItem`/`openPurchaseLot` — e.g. a raw-material GRN line that never books input
  GST at all) is, and remains, `NULL`. No inference was performed, no company backfilled.
- **`po_items.taxCategory`**: every existing row is, and remains, `NULL`. No inference from
  `taxRate` was performed (see §4).
- **`suppliers.isComposition`**: every existing row defaults to `false` — the one field in this phase
  with a non-null default, because (a) it is `NOT NULL` by its own nature (a boolean, not an
  attribution FK) and (b) `false` ("not marked composition") is the status quo assumption this
  codebase already made implicitly everywhere (every existing `Supplier.gstNumber`-bearing row was
  already being treated as a regular registered dealer; this column makes that assumption explicit
  and overridable going forward, it does not change behavior for any existing row since nothing reads
  it yet).

Exact counts are not reported as a fixed number because this is a schema-level, zero-DML migration —
the "number of existing records affected" is, by construction, the full existing row count of
`grn_items`/`po_items`/`suppliers` in whichever database it's applied to, and all of them end up
`NULL`/`false` (unassigned), none `assigned`.

---

## 7. Security / tenancy

- **RLS**: no new table — `grn_items`, `po_items`, `suppliers` already carry `FORCE ROW LEVEL
  SECURITY` and their own `tenant_isolation` policy from earlier phases. New nullable/defaulted
  columns need no new policy (same precedent as G2g-6e's migration note).
- **Composite FK**: `grn_items.buyerRegistrationId` + `companyId` → `company_gst_registrations(id,
  companyId)`, `ON DELETE RESTRICT ON UPDATE CASCADE` — same pattern/clause as
  `branches.gstRegistrationId` (G1) and `gst_return_periods.gstRegistrationId` (G2g-6a). Verified the
  database itself refuses a cross-company pointer even from the platform (BYPASSRLS) role — see test
  "cross-company: a GRN line can never be pointed at another company's registration (composite FK)".
- **Ownership validation**: no new request-supplied foreign id was introduced (see §3 — resolution is
  entirely server-side off an already-validated `branchId`), so no new `assertOwnedByCompany` call was
  needed. `createPO`'s new `taxCategory` input is validated against a fixed enum (`isValidTaxCategory`),
  not a foreign id, so it carries no cross-company surface either.
- **Cross-company tests**: `src/test/g2g7aInwardGstFoundation.test.ts` — composite-FK rejection (above)
  plus a control case proving the same write succeeds against the caller's own registration (the keys
  do not block legitimate use). Not added to `src/test/compositeFk.test.ts`'s shared `forgeries` table —
  every other phase that has added a new composite FK since (G2g-6a's three new tables) tested its own
  cross-company rejection in its own phase-specific test file rather than extending that shared
  fixture, which this phase follows for consistency and to avoid risking the ~15 existing forgery cases
  in that file on an unrelated, more invasive fixture change (a `GrnItem` + `CompanyGstRegistration`
  would need to be added to that file's shared `bringUp()`, and `company_gst_registrations` has the
  FORCE-RLS-blocks-even-platform-role quirk noted below, which that file's helpers aren't built for).
- **Known test-only quirk, not a security issue**: `company_gst_registrations` is `FORCE ROW LEVEL
  SECURITY` even for the single-role test database's owner/platform connection (a deliberate G1-era
  choice — see `g2g6aGstFilingFoundation.test.ts`'s own comment) — rows are created through the real
  service (`createGstRegistration`, which runs inside `tenantTransaction`) and read back through
  `tenantQuery`, never a bare `prisma.companyGstRegistration.*` call. `grn_items`/`po_items`/
  `suppliers` have no such quirk (confirmed against the existing `procurement.inputGst.test.ts`, which
  reads/writes them with a bare platform-client call throughout).

---

## 8. Test results

- **Focused (new)**: `src/test/g2g7aInwardGstFoundation.test.ts` — 16/16 passed. Covers:
  registration resolution (no registration → null; primary-only; branch-specific override; branch
  link inactive → null, not silently substituted; FINISHED_LOT path via `openPurchaseLot`;
  cross-company FK rejection; control case), tax category (all five accepted; invalid rejected;
  default-on-omission; explicit value preserved; zero-rate independence), `Supplier.isComposition`
  (default false; settable true), and one procurement-lifecycle regression assertion.
- **Procurement/tagging/GST/sales regression**: `src/modules/procurement/**`,
  `src/modules/tagging/**`, `src/modules/finance/gst/**`, `src/modules/sales/**`,
  `src/test/compositeFk.test.ts`, `src/test/tenantIsolation.procurementQuality.test.ts` — 37 test
  files, **974/974 passed**.
- **Full server suite** (`npx vitest run src`): **92 test files, 1787 passed, 5 skipped (pre-existing),
  0 failed.**
- **TypeScript**: `npx tsc --noEmit` — clean, no errors.
- **Prisma**: `npx prisma validate` — valid. `npx prisma migrate diff --from-url <test-db>
  --to-schema-datamodel schema.prisma --script` — empty diff (hand-written migration matches the
  schema exactly).
- **`npm run audit:tenant` (--strict)**: `company-owned model, NOT through a tenant wrapper: 0`,
  `aliasing/passing the bare client around: 0`. Clean.
- **RLS (real role split, `trivo_rlstest` cluster, port 54329)**: migration deployed via
  `OWNER_DATABASE_URL`, `npm run db:secure` re-applied, then `npm run test:rls` against the new test
  file plus the procurement/tagging/composite-FK suites — all passed against the genuine
  `trivo_runtime` (no BYPASSRLS, FORCE RLS) role, proving the attribution and the new composite FK
  hold under the real production-shaped role split, not just the single-role everyday test DB.

---

## 9. Deferred work — by later phase

- **G2g-7b**: `Client.isComposition`/`isUin` (recipient classification, GSTR-3B Table 3.2 prep).
- **G2g-7c**: (per the brief's own phase list — not detailed further here; nothing in this phase
  assumes or blocks it.)
- **G2g-7d**: RCM classification data model (supplier- or line-level — see §5's full reasoning for
  why this phase deliberately left the placement question open rather than guessing) + eventual RCM
  tax calculation, journal posting (2204 RCM liability / 1404 RCM ITC), self-invoicing, payment-voucher
  generation, Table 3.1(d)/4(A)(3).
- **G2g-7e**: not detailed in the brief beyond its existence; untouched.
- **G2g-7f**: GSTR-3B filing lifecycle (snapshots, filing attempts, period lock) — explicitly
  prohibited from this phase (brief §18); `GstReturnPeriod`/filing-attempt/filing-protection modules
  were read for context only, never modified.
- **G2g-7g**: not detailed in the brief beyond its existence; untouched.
- **Separately, still open from earlier phases** (CLAUDE.md §8): G2g-7a does not touch either —
  `createInvoice()`'s optional `tagId` (sell-side, unrelated), `convertMemoToInvoice()`'s blind tag
  flip (sell-side, unrelated). Also still open: I3 (GST credit note on a sales return) and TCS on cash
  jewellery sales — both sell-side, unrelated to this inward-only phase.
- **A genuinely required follow-up this audit surfaced but which is out of scope here**: the purchase
  side's CGST/SGST/IGST split (`splitInputGst`) still compares against `Company.stateCode` (the
  legacy, single, company-wide field), never a specific registration's own `stateCode` — so a
  multi-GSTIN company with registrations in different states does not yet get a registration-aware
  intra/inter-state split on the buy side. `buyerRegistrationId` now records *which* registration
  received each inward supply, which is the prerequisite data a later phase needs to fix this — but
  actually changing the split calculation is a behavior change to existing accounting output, which
  brief §16 ("this phase must not alter existing accounting behavior") and the foundation-only
  framing of G2g-7a both argue against doing here. Recorded for whichever of G2g-7b–g (or a dedicated
  follow-up) is the right place to pick it up.

---

## 10. Deviations from the prompt

1. **Requested**: "may introduce data fields/enums needed to represent future RCM classification"
   (§11, permissive, not mandatory). **Actual**: no RCM field was added at all, anywhere.
   **Reason**: see §5 — the placement question (supplier vs. line vs. a yet-undesigned
   supply-scoped concept) is genuinely unresolved from this codebase alone, and the brief's own
   wording is permissive ("may"), not a requirement. **Risk**: none — G2g-7d still has a completely
   open design space; nothing here constrains or complicates that phase's choice. **Approval
   needed**: no — this is a null action within an explicitly optional brief item, not a deviation
   from a mandatory one.
2. **Requested**: implicitly, that `PoItem.taxCategory`/`Supplier.isComposition` become reachable
   end-to-end (brief §20's testing list implies real create/validate paths, not schema-only columns).
   **Actual**: both are wired into their respective `create` functions (`createPO`, `createSupplier`)
   but **not** into any `update` path, because **no update endpoint exists for either `PurchaseOrder`
   line items or `Supplier` at all** in this codebase today (confirmed in the pre-check, §2.6).
   **Reason**: building a new Supplier-edit endpoint was not asked for and is unrelated-scope work
   (CLAUDE.md §22). **Risk**: `isComposition`/`taxCategory` can only be set going forward at creation
   time until an edit path exists; low risk (schema supports editing it later with zero migration).
   **Approval needed**: no — flagged here for visibility, not blocking.

---

## 11. Human approval checkpoint

Per the brief's §25: **stopped after G2g-7a.** No work on G2g-7b (or any other lettered sub-phase) was
started. This document, together with the chat-delivered final report, is the complete record for
review before authorizing the next phase. Nothing was committed or pushed (brief §23) — all changes
are in the working tree.
