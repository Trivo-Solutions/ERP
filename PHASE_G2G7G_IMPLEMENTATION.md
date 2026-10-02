# Phase G2g-7g — GSTR-3B Filing/Export Preparation

Status: **✅ APPROVED / FROZEN by the user (2026-10-02)**, including the close-out mutation-
protection pass below (§17). No commit, no push, no frontend, no GSTN API/GSP/ASP/IRP/E-Way Bill
integration — per the brief's own stop condition, unchanged by the close-out.

## 1. Audit findings (brief §0/§2, before any code was written)

Read end to end before designing anything: all five G2g-7a–7f implementation reports, the complete
G2g-6a–6e GSTR-1 filing lifecycle (`gstr1FilingSnapshot.service.ts`, `gstr1FilingAttempt.service.ts`,
`gstr1FilingPeriod.service.ts`, `gstr1FilingProtection.ts`), the `GstReturnPeriod`/`GstFilingSnapshot`/
`GstFilingAttempt` schema, and the frozen G2g-7f composition layer (`gstr3bReconciliation.types.ts`,
`gstr3bReconciliationComposition.ts`, `gstr3bReconciliation.service.ts`) and its four inputs
(`gstr3bOutward.types.ts`, `gstr3bItc.types.ts`, `gstr3bRcm.types.ts`, `gstr2b.types.ts`).

1. **`GstReturnPeriod.returnType = 'GSTR3B'` needs zero schema change.** The column is a plain
   `String`, and the model's own schema comment explicitly anticipates this value — confirmed by
   reading G2g-7f's own `resolveFilingStatus()`, which already *reads* `returnType: 'GSTR3B'`
   read-only. No migration was written for this phase.
2. **`GstFilingSnapshot`/`GstFilingAttempt` are fully generic.** `canonicalDtoJson`/`wireJson`/
   `validationResult`/`reportParams` are all `Json`; `serializerVersion`/`adapterVersion`/
   `gstnSchemaVersion` are free strings. Nothing in either model's schema is GSTR-1-specific.
3. **The G2g-6b/6c/6e *service functions* are NOT directly reusable, even though the brief asked
   whether they could be.** `gstr1FilingSnapshot.service.ts` hardcodes `GSTR1_RETURN_TYPE = 'GSTR1'`
   and calls the frozen GSTR-1-only pipeline (`buildGstr1GstnExportCore`, `Gstr1GstnExportDto`,
   `serializeGstr1ToGstnJson`) — it cannot be pointed at a different return type or a different
   report shape without modifying a frozen file. `gstr1FilingAttempt.service.ts`'s own
   `createGstr1FilingAttempt`/`listGstr1FilingAttempts` are blocked only by one hardcoded constant
   (the rest is generic) but still write GSTR-1-named audit actions
   (`GSTR1_FILING_ATTEMPT_CREATED`, ...). `gstr1FilingPeriod.service.ts`'s
   `fileGstr1ReturnPeriod`/`lockGstr1ReturnPeriod` contain **zero** GSTR-1-specific *business logic*
   at all (they resolve purely by `attemptId`/`periodId`) but still write hardcoded
   `'GSTR1_PERIOD_FILED'`/`'GSTR1_PERIOD_LOCKED'` audit actions — calling them directly for a
   GSTR-3B period would mislabel the audit trail with the wrong return-type name.
   **Conclusion:** reuse the tables, the four-state lifecycle, and the hash implementation (exactly
   as the brief's §13/§14/§15 ask); write new, parallel, GSTR-3B-labeled service functions rather
   than modifying the frozen G2g-6 files or forking a second lifecycle. This is explicitly **not** "a
   second filing lifecycle" (brief §14) — it is the same `OPEN → SNAPSHOT_CREATED → FILING_ATTEMPTED
   → FILED → LOCKED` state machine on the same tables, with only the return-type-specific
   orchestration (what report to build, what to serialize/validate) necessarily duplicated, exactly
   as unavoidable as GSTR-1's own equivalent file already is for GSTR-1.
4. **No verified GSTN wire JSON schema exists for GSTR-3B in this session.** Unlike GSTR-1 (G2g-4c-3
   verified its wire shape byte-for-byte against a local GSTN Offline Tool install), GSTR-3B has no
   public bulk-upload JSON format in the same sense — it is normally filed as an **online summary
   form** on the GST portal (Table 3.1, 3.2, 4, 5, 5.1, 6.1, 6.2), not an uploaded file. No such
   source was available or claimed this session. This phase's export DTO is therefore TRIVO's own
   canonical, statutorily-labeled summary representation (suitable for manual portal entry or a
   future GSTN-API adapter), explicitly **not** asserted as "the literal GSTN wire shape" —
   documented in `gstr3bGstnWire.types.ts`'s own header, the same honesty posture G2g-7e's
   `gstr2bNormalizer.ts` already established for its own unverified-source-format caveat.
5. **Table 3.1(d) is a routing trap.** The outward engine (G2g-7b) carries its own
   `table31.table31d` — a permanent, always-`UNSUPPORTED` stub that predates the RCM engine and is
   never populated by anything. The *real* Table 3.1(d) figure is the RCM engine's (G2g-7d) own
   `table3_1d.recognized`. Using the wrong source would silently report 3.1(d) as always empty even
   with real RCM liability on the books — caught during design, documented prominently in
   `gstr3bGstnWire.ts`'s header, and covered by a dedicated test
   (`'3.1(d): sourced from the RCM engine's table3_1d, not the outward engine's own always-unsupported
   stub'`).
6. **`isFilingReady` cannot mean "statutorily complete" without being permanently, vacuously false.**
   The permanent structural gaps this codebase cannot close (imports, ISD, Rule 42/43, the full
   Section 16(4)/17(5)/180-day/GSTR-2B-finality conditions) are — by G2g-7c/7d/7f's own frozen,
   unchanged design — *always* true, for every company, forever. Making them BLOCKING would mean no
   export in this system could ever be "filing-ready," making the signal meaningless. Design decision
   (documented at length in `gstr3bGstnValidator.ts`'s own header, not hidden): `isFilingReady` means
   "TRIVO's own data is internally resolved and consistent for this period" (no unresolved book
   ITC/RCM lines, valid GSTIN, complete branch scope) — a real, achievable, testable signal — while
   `netPosition.statutoryReportingPosition.status` on the DTO **always** stays `'NOT_DETERMINABLE'`
   regardless of `isFilingReady`, so nothing this validator emits can ever be read as "a GSTN-
   certified-complete statutory filing." Both facts are surfaced together, always; neither hides the
   other. This also makes the full snapshot → attempt → ACCEPTED → FILED → LOCKED lifecycle genuinely
   testable end to end (see §13 below), rather than permanently unreachable.

No frozen file (G2g-6a–6e, G2g-7a–7f) was modified. Confirmed by `git diff` scope (see §4) and by the
full regression suite passing unchanged.

## 2. Files created

Pure, no-Prisma layer:
- `server/src/modules/finance/gst/gstr3bGstnWire.types.ts` — the canonical export DTO contracts
  (Table 3.1/3.2/4, net position, diagnostics), with an explicit `Gstr3bExportFieldStatus` vocabulary
  reused verbatim from the frozen G2g-7f `Gstr3bReconciliationSectionStatus` type.
- `server/src/modules/finance/gst/gstr3bGstnWire.ts` — the pure serializer:
  `serializeGstr3bToGstnExport(report: Gstr3bReconciliationReport): Gstr3bGstnExportDto`. Reshapes
  only; recomputes nothing.
- `server/src/modules/finance/gst/gstr3bGstnValidator.ts` — the pure filing-readiness validator:
  `validateGstr3bGstnExport(dto): Gstr3bGstnValidationResult` — BLOCKING / WARNING / INFORMATIONAL.

Integration layer:
- `server/src/modules/finance/gst/gstr3bExport.service.ts` — `buildGstr3bGstnExport(ctx, params,
  userId)`: calls the frozen `getGstr3bReconciliationReport` (G2g-7f), then the two pure functions
  above, then audits. No persistence.
- `server/src/modules/finance/gst/gstr3bFilingSnapshot.service.ts` — `createGstr3bFilingSnapshot`.
- `server/src/modules/finance/gst/gstr3bFilingAttempt.service.ts` — `createGstr3bFilingAttempt`,
  `recordGstr3bFilingAttemptOutcome`, `listGstr3bFilingAttempts`.
- `server/src/modules/finance/gst/gstr3bFilingPeriod.service.ts` — `fileGstr3bReturnPeriod`,
  `lockGstr3bReturnPeriod`.

Tests (focused, new — see §16 for counts):
- `gstr3bGstnWire.test.ts`, `gstr3bGstnValidator.test.ts` (pure)
- `gstr3bExport.service.test.ts`, `gstr3bFilingSnapshot.service.test.ts`,
  `gstr3bFilingAttempt.service.test.ts`, `gstr3bFilingPeriod.service.test.ts` (integration, real PO →
  GRN → tag → invoice data, same fixture pattern as `gstr3bReconciliation.service.test.ts`)
- `server/src/test/http.gstr3bExportSecurity.test.ts`,
  `server/src/test/http.gstr3bFilingSecurity.test.ts` (real HTTP)

## 3. Files modified

- `server/src/modules/finance/finance.router.ts` — one new import block, one new report route (`GET
  /reports/gstr3b-export`), six new filing-lifecycle routes (`/gstr3b/snapshots`,
  `/gstr3b/filing-attempts` ×3, `/gstr3b/filing-attempts/:attemptId/file`,
  `/gstr3b/periods/:periodId/lock`). No existing route's code was touched — all additions are
  appended after the existing `/gstr1/periods/:periodId/lock` route.

**No schema/migration change** — `prisma validate` confirms (§16); no new Prisma model/column exists
in this phase's diff.

## 4. Frozen files confirmed untouched

`gstr1FilingSnapshot.service.ts`, `gstr1FilingAttempt.service.ts`, `gstr1FilingPeriod.service.ts`,
`gstr1FilingProtection.ts`, `gstr1SnapshotHash.ts` (imported from, never edited), every G2g-7a–7f file
(`gstr3bOutwardAggregation.ts`, `gstr3bItcAggregation.ts`/`Eligibility.ts`,
`gstr3bRcmAggregation.ts`/`Classification.ts`/`TaxCalculation.ts`/`ItcEligibility.ts`,
`gstr2bReconciliation.ts`/`Normalizer.ts`, `gstr3bReconciliationComposition.ts`,
`gstr3bReconciliation.service.ts`, and all four `*.types.ts` files). Verified by `git diff` scope
(only `finance.router.ts` modified, purely additively) and by the full regression suite passing with
0 failures.

## 5. API contract

```
GET  /finance/reports/gstr3b-export
  Required: gstRegistrationId, taxPeriod (MMYYYY)
  Optional: financialYear, branchId
  Permission: report:financial_view   (brief §12's own explicit instruction — matches gstr1-export's
                                        and gstr3b-reconciliation's identical permission choice)
  Returns: { success, data: { export: Gstr3bGstnExportDto, validation: Gstr3bGstnValidationResult } }
  — a normal JSON envelope, NOT a downloadable attachment (deviation from gstr1-export — see §7 item 1).

POST /finance/gstr3b/snapshots                              permission: gst:snapshot_create
  body: { gstRegistrationId, taxPeriod, financialYear?, branchId? }  -> 201, Gstr3bFilingSnapshotResult

POST /finance/gstr3b/filing-attempts                         permission: gst:filing_record
  body: { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode } -> 201

POST /finance/gstr3b/filing-attempts/:attemptId/outcome      permission: gst:filing_record
  body: { outcome, arn?, externalReference?, errorCode?, errorMessage?, responseMetadata? } -> 200

GET  /finance/gstr3b/filing-attempts                          permission: gst:period_view
  query: gstRegistrationId, financialYear, taxPeriod -> 200, list

POST /finance/gstr3b/filing-attempts/:attemptId/file          permission: gst:filing_record -> 200
POST /finance/gstr3b/periods/:periodId/lock                   permission: gst:filing_record -> 200
```

No new permission was introduced. `gst:snapshot_create`/`gst:filing_record`/`gst:period_view` are the
**existing** G2g-6a catalog entries — never GSTR1-specific in their string name, cataloged but not
granted to any starter role yet (same posture every J4-class permission in this codebase already
has — a company's own `SUPER_ADMIN` delegates them via the Role Editor when ready).

## 6. GSTR-3B field coverage matrix

| Field | Coverage | Source |
|---|---|---|
| 3.1(a) Outward taxable (other) | **Supported** (SUPPORTED/PARTIALLY_SUPPORTED by scope) | G2g-7b `table31a` |
| 3.1(b) Zero-rated | Not supported | outward stub |
| 3.1(c) Nil-rated/exempt/non-GST | Not supported | outward stub |
| 3.1(d) Inward RCM liability | **Supported/Partially supported** | G2g-7d `table3_1d.recognized` (never the outward stub — see §1.5) |
| 3.1(e) Non-GST outward | Not supported | outward stub |
| 3.2 Unregistered persons | **Supported** | G2g-7b `table32.unregisteredPersons` |
| 3.2 Composition / UIN | Not supported | outward stub |
| 4(A)(1) Import of goods | Not supported | no Bill-of-Entry model |
| 4(A)(2) Import of services | Not supported | no import-of-services model |
| 4(A)(3) RCM ITC | **Partially supported** — eligible/unresolved/ineligible split, never collapsed | G2g-7d `table4A3` |
| 4(A)(4) ISD | Not supported | no ISD model |
| 4(A)(5) All other ITC | **Partially supported** — eligible/unresolved/ineligible split | G2g-7c `table4A5` |
| 4(B)(1) Rule 42/43 | Not determinable | no exempt-supply attribution |
| 4(B)(2) Other reversals | Not determinable | no full Section 17(5) model |
| 4(C) Net ITC available | **Partially supported** — sum of only 4(A)(3)+4(A)(5) eligible, components listed | G2g-7f `table4C` |
| 4(D)(1) ITC reclaimed | Not determinable | no reversal/reclaim lifecycle |
| 4(D)(2) Ineligible ITC | **Partially supported** — narrower than full 17(5) | G2g-7c/7d INELIGIBLE buckets |
| Net position (book) | **Supported**, explicitly labeled `bookPosition`, never `finalTaxLiability` | G2g-7f `summary.bookPosition` |
| Statutory filing position | **Always `NOT_DETERMINABLE`**, always surfaced | G2g-7f `summary.statutoryReportingPosition` |

Every unsupported/not-determinable field carries `amounts: null` — never a fabricated zero — plus a
`diagnosticCode` and human-readable `note` naming exactly why.

## 7. Deviations from the brief

1. **`/reports/gstr3b-export` returns a JSON envelope, not a downloadable file.** `gstr1-export`
   returns a raw GSTN-upload-ready file because that file genuinely exists and is meant to be
   uploaded as-is. GSTR-3B has no equivalent upload artifact (§1.4) — the export IS a data structure
   for a human preparer or a future integration to consume, not a file to hand to a portal. Keeping it
   as `{success, data}` also lets the response carry the validator's `blockers`/`warnings`/
   `informational` alongside the figures in one call, which a raw-file response could not do without
   an awkward side-channel.
2. **`isFilingReady` is deliberately NOT "statutory filing completeness."** See §1.6. This is the
   single most consequential design decision in this phase and is documented in three places so it
   cannot be missed: `gstr3bGstnValidator.ts`'s own header, this report, and the dedicated test proving
   a clean period genuinely reaches `isFilingReady: true` while `statutoryReportingPosition.status`
   stays `NOT_DETERMINABLE` on the very same payload.
3. **Snapshot/attempt/period are new files, not modifications or direct reuse of the frozen G2g-6
   functions.** See §1.3. This is "reuse the generic architecture" (brief §13) interpreted as reusing
   the *tables*, the *lifecycle*, and the *hash algorithm* — not literally calling GSTR-1-typed,
   GSTR-1-labeled functions for a GSTR-3B payload.

No other deviation. Scope restrictions (brief §19) were followed exactly: no GSTN API call, no GSP/
ASP/IRP/E-Way Bill, no frontend, no new accounting/ITC subsystem, no Rule 42/43 implementation, no
import/ISD subsystem, no supplier fuzzy matching, no modification to any frozen file, no unrelated
cleanup, no schema change.

## 8. Validation rules (brief §11)

Full list in `gstr3bGstnValidator.ts`. Summary:

**BLOCKING** (keeps `isFilingReady: false`): missing/invalid GSTIN, malformed tax period, partial
branch scope, unresolved book ITC (4(A)(5)), unresolved RCM ITC (4(A)(3)), unresolved RCM liability
(3.1(d)), non-finite amounts (defensive).

**WARNING** (never blocks — permanent structural gaps): unsupported imports, unsupported ISD,
incomplete Table 4(B), incomplete Table 4(D)(1), partial Table 4(C), incomplete Table 3.2
(composition/UIN), negative amounts (plausible in a returns-heavy period).

**INFORMATIONAL** (always present): the statutory-position-not-determinable caveat (verbatim from
G2g-7f), a source-diagnostic count.

## 9. Snapshot behavior

Mirrors G2g-6b exactly: resolve-or-create the `GstReturnPeriod` by its natural key via an atomic
native upsert (never a two-step find-then-create — the same documented P2002/ON-CONFLICT-DO-NOTHING
pitfall G2g-6b's own header explains), row-lock it, refuse (409) if already `FILED`/`LOCKED`, allocate
`version` under the lock via `aggregate._max` (never `count()+1`), persist `status: 'DRAFT'` when
`isFilingReady` else `'BLOCKED'`, supersede the period's own prior `DRAFT`/`BLOCKED` snapshots (never a
`FILED` one). `wireJson`/`wireJsonHash` store the identical export DTO a second time (hashed a second
time) purely because the shared, generic schema requires both columns NOT NULL — there is no second,
independently-computed wire representation for GSTR-3B to diverge from (§1.4).

## 10. Filing lifecycle behavior

Identical two transitions to G2g-6e, reproduced under GSTR-3B's own audit-action names
(`GSTR3B_PERIOD_FILED`/`GSTR3B_PERIOD_LOCKED`, never the GSTR-1-named ones — asserted directly by a
test): `FILING_ATTEMPTED → FILED` only from one specific `ACCEPTED` `GstFilingAttempt`, re-validated
fresh under a row lock (closing the identical TOCTOU window G2g-6e's own header documents); `FILED →
LOCKED`, one-way, no unlock/override mechanism. **No automatic FILED state** — proved directly: a test
asserts a period with both a snapshot and an attempt already created is still `SNAPSHOT_CREATED`, not
`FILED`, until an explicit `ACCEPTED` outcome and an explicit `/file` call occur.

## 11. Hash/canonicalization design

Reused verbatim (imported, never duplicated) from the frozen `gstr1SnapshotHash.ts`, per the brief's
own §15 instruction: `canonicalizeForHash`/`canonicalJsonString`/`sha256Hex` — recursive object-key
sorting (arrays never reordered), SHA-256 hex. Deterministic: proved by a dedicated pure-serializer
test (`'is deterministic: identical input always serializes to byte-identical JSON'`) and a
pure-validator test (`'is deterministic: identical input always validates to the identical result'`).
No `Date.now()`, no random ids, inside either pure file.

## 12. Security

Every new route: `authenticate` → `resolveTenantContext` → `requirePermission(...)` → (for the report
route) `assertBranchAccessible`/`assertOwnedByCompany('companyGstRegistration', ...)` — identical
pattern to every sibling GST report route in this file, never left to the service layer alone (the
filing-lifecycle services perform their own independent ownership/ownership-of-snapshot/
ownership-of-period checks as defense in depth, matching G2g-6's own convention).

Tested over real HTTP:
- `http.gstr3bExportSecurity.test.ts` (9 tests) — 401, 403, missing `gstRegistrationId`/`taxPeriod`
  (400 each), cross-company registration (404), cross-company branch (404), a restricted branch grant
  succeeding on its own branch and rejected on another in the same company (404), an invalid
  `taxPeriod` (400), same-company success (200).
- `http.gstr3bFilingSecurity.test.ts` (7 tests) — 401 on two representative routes, 403 for each of
  `gst:snapshot_create`/`gst:filing_record`/`gst:period_view` when missing, a full granted-caller
  happy path exercising all six routes in sequence (create snapshot → create attempt → record
  outcome → list → file → lock), a cross-company `gstRegistrationId` on snapshot creation (404).

## 13. Focused test results

| Suite | File | Count |
|---|---|---|
| Pure serializer | `gstr3bGstnWire.test.ts` | 16 |
| Pure validator | `gstr3bGstnValidator.test.ts` | 13 |
| Export integration | `gstr3bExport.service.test.ts` | 5 |
| Snapshot integration | `gstr3bFilingSnapshot.service.test.ts` | 6 |
| Attempt integration | `gstr3bFilingAttempt.service.test.ts` | 8 |
| Period/lifecycle integration | `gstr3bFilingPeriod.service.test.ts` | 6 |
| HTTP export security | `http.gstr3bExportSecurity.test.ts` | 9 |
| HTTP filing-lifecycle security | `http.gstr3bFilingSecurity.test.ts` | 7 |
| **New total** | | **70** |

Integration tests build their fixtures through the real pipeline (PO → GRN → tag intake → retail
sale), the identical pattern `gstr3bReconciliation.service.test.ts` (G2g-7f) established, rather than
hand-typed fake report objects — a shape drift in any frozen upstream engine would surface here first.

## 14. Full regression results

| Check | Result |
|---|---|
| New G2g-7g focused tests | 70/70 passed |
| Full GST module regression (`src/modules/finance/gst/` + all `http.gstr1*/gstr2b*/gstr3b*` HTTP security files) | 907/907 passed, 0 failed |
| Full server suite (`npx vitest run`) | 2098/2103 passed, 5 pre-existing skips, 0 failed |
| Real role-split RLS suite (`npm run test:rls` against `trivo_rlstest`) | 2102/2103 passed, 1 pre-existing skip, 0 failed |
| `npm run audit:tenant` | 0 bare company-owned-model Prisma calls (clean, unchanged baseline) |
| `npx tsc --noEmit` (server) | clean |
| `npx tsc --noEmit` (client) | clean (unaffected — no client file touched) |
| `npx prisma validate` | schema valid (no change made) |

## 15. Known limitations (stated, not hidden)

- **Not a GSTN-wire-verified export.** No GSTR-3B GSTN upload JSON schema was available or verified
  this session — this export is TRIVO's own canonical representation, suitable for manual portal
  entry or a future, explicitly-approved GSTN-integration phase (see §1.4/§7 item 1).
- **`isFilingReady: true` is not statutory completeness.** See §1.6/§7 item 2 — read alongside
  `netPosition.statutoryReportingPosition.status`, which is permanently `NOT_DETERMINABLE`.
- **4(C)/4(D) remain partial by construction**, inherited unchanged from G2g-7f — every excluded
  component is independently flagged, nothing is silently assumed zero.
- ~~No GSTR-3B mutation-protection guard analogous to `gstr1FilingProtection.ts`.~~ **Closed the
  same day by the close-out pass — see §17.**
- **`doc.wireJson`/`canonicalDtoJson` store the identical payload twice** (§9) — an accepted
  consequence of reusing the generic, GSTR-1-shaped `GstFilingSnapshot` schema for a return type that
  has no second, independently-computed wire representation.

## 16. Confirmations

- **Frozen modules were not modified** — verified by `git diff` scope and the unchanged full
  regression suite.
- **No new permission was introduced** — `report:financial_view`/`gst:snapshot_create`/
  `gst:filing_record`/`gst:period_view` all pre-existed G2g-6a's catalog.
- **No schema/migration was added** — `prisma validate` confirms; no model/column appears in this
  phase's diff.
- **No commit, no push, no frontend work, no GSTN API/GSP/ASP/IRP/E-Way Bill integration** were
  performed. This phase stops here for human review, per the brief's own stop condition.

## 17. Close-out pass (2026-10-02) — GSTR-3B filing mutation protection

A tight, separately-scoped follow-up: once a GSTR-3B return period is FILED or LOCKED, prevent
later mutations to the source GST/accounting documents that would change the position it
represents. Did not reopen or redesign any of §1–16 above; no GSTN/API integration; no new filing
lifecycle (reused G2g-7g's own, from §10).

**New file:** `server/src/modules/finance/gst/gstr3bFilingProtection.ts` —
`assertGstr3bPeriodMutable()` / `findGstr3bFilingProtection()` / `Gstr3bFilingProtectionError`
(409, `GSTR3B_FILED_PERIOD_IMMUTABLE`) / `auditGstr3bMutationBlocked()`. Mirrors
`gstr1FilingProtection.ts`'s proven row-lock concurrency pattern exactly, but is DATE-based rather
than document-traceability-based: GSTR-1's guard checks "was this exact document represented in the
filed snapshot's traceability array," which has no GSTR-3B equivalent (G2g-7b/7c/7d/7f are pure
period-range aggregations keyed by document dates, not per-document id lists). The GSTR-3B guard
instead resolves a mutation's own effective date to a tax period (`resolveFilingPeriodMmYYYY`,
reused from this phase's own `gstr3bReporting.service.ts`) and checks whether the one
`GstReturnPeriod` (`returnType: 'GSTR3B'`) for that exact company + GST registration + period is
FILED or LOCKED — which also correctly catches a brand-new, backdated document GSTR-1's own
traceability check could never see (it can't appear in a snapshot that predates its own creation).

**Mutation paths protected** (traced from the real services, not invented): outward —
`createInvoice`/`amendInvoice` (checked against both the invoice's current period and, if the date
is being changed, its target period)/`voidInvoice`/`createSalesReturn`/`convertMemoToInvoice`
(`sales.service.ts`); `createCreditNoteForReturn` (Path A, shared by both its own call site and
`createCreditNoteForExistingReturn`)/`createStandaloneCreditNote` (Path B)/`cancelCreditNote`
(`creditNote.service.ts`); `createSalesDebitNote`/`cancelSalesDebitNote`
(`salesDebitNote.service.ts`). Inward/ITC — `createTagFromGrnItem` (`tagging.service.ts`);
`openPurchaseLot`/`createPurchaseReturn` (`procurement.service.ts`); `createStandaloneDebitNote`
(Path B)/`cancelDebitNote` (`debitNote.service.ts`). RCM — `markRcmLiabilityPaid`
(`gstr3bRcmBooking.service.ts`), since marking paid is the one event (Rule 86(2)) that can
retroactively flip a liability's ITC eligibility for its own already-filed period.

**Deliberately NOT protected**, each for a traced, specific reason: Path A purchase/sales debit-
and credit-note creation functions beyond their own shared helper (their ITC/outward effect is
already fully represented by the return they wrap — protecting the return is protecting them, and
both `gstr3bItcReporting.service.ts`'s `loadStandaloneDebitNoteLines` and the outward engine
explicitly exclude Path A from their own aggregation to avoid double-counting); raw GSTR-2B
ingestion (brief's own instruction — it never auto-books anything); PO `taxCategory` edits (no such
edit endpoint exists in this codebase — only set at PO creation); `PurchaseReturn`
cancellation/`RcmLiability` creation-cancellation (no such mutation exists — RCM liability creation
is already covered via its own GRN-intake checkpoint, and nothing in this codebase cancels an
already-booked liability).

**Audit convention:** a `GSTR3B_MUTATION_BLOCKED` entry is recorded only for the cancel/void/
settle-style call sites that already followed this convention for GSTR-1
(`amendInvoice`/`voidInvoice`/`cancelCreditNote`/`cancelSalesDebitNote`), plus the two new
cancel/settle paths this close-out itself wired (`cancelDebitNote`, `markRcmLiabilityPaid`) — never
for a plain creation path, which simply rolls back on throw and records nothing, matching
`gstr1FilingProtection.ts`'s own identical choice.

**Tests:** `g2g7gGstr3bMutationGuard.test.ts` (35 — pure status-matrix/isolation, one real-mutation
block+allow pair per family, FILED and LOCKED both proven for a representative subset, cross-
registration and cross-company isolation, `GSTR3B_MUTATION_BLOCKED` audit entries, and one true
end-to-end run through the real `createGstr3bFilingSnapshot → createGstr3bFilingAttempt →
recordGstr3bFilingAttemptOutcome → fileGstr3bReturnPeriod → lockGstr3bReturnPeriod` pipeline);
`http.gstr3bMutationGuardSecurity.test.ts` (2 — the 409 reaches a real HTTP caller on
`POST /sales/invoices/:id/void`, OPEN leaves existing behavior untouched). A real debugging note
worth keeping: the frozen RCM engine (`gstr3bRcmAggregation.ts`) classifies ANY liability inside a
requested date range by comparing its own `buyerRegistrationId` against the report's requested
registration, not merely by excluding other registrations — so the end-to-end test had to be
backdated into a quiet period (same technique `g2g6dGstr1MutationGuard.test.ts`'s own e2e test
already used), or an unrelated registration's still-unpaid liability dated "today" from an earlier
test in the same file would surface as a spurious `UNRESOLVED_RCM_LIABILITY` blocker.

**Verification:** full suite 2135/2140 (5 pre-existing skips), 0 failed; `test:rls` against the
real role-split `trivo_rlstest` cluster 2139/2140 (1 pre-existing skip), 0 failed; `audit:tenant`
clean (0 bare company-owned-model calls); `tsc --noEmit` clean relative to this change (5
pre-existing, unrelated errors remain in `gstr3bGstnWire.test.ts`, confirmed pre-existing by
diffing against the last commit); `prisma validate` clean. **No schema/migration change** — the
guard reads only the existing `GstReturnPeriod.status` column.

**Out-of-scope finding, not fixed:** `nextDocumentNumber`'s self-invoice sequence is keyed
internally by `SELFINV:<registrationId>`, but the rendered number string
(`SELFINV-<FY>-<counter>`) never embeds the registration — two different registrations' first
self-invoice in the same financial year would render the identical string, and
`SelfInvoice.selfInvoiceNumber` appears to be unique company-wide, not per-registration. Discovered
while building this close-out's RCM test fixtures (worked around there with a checksum-valid
supplier GSTIN so `SELF_INVOICE_NOT_REQUIRED` applied instead); the underlying numbering file
(`gstr3bRcmBooking.service.ts`) is otherwise untouched by this pass.
