# Phase G2g-7e — GSTR-2B Ingestion & Reconciliation: Implementation Report

**STOP per the brief's §33 — no commit, no push, no G2g-7f, no frontend, no IMS, no imports subsystem,
no ISD, no GSTR-3B filing lifecycle, no modification to any frozen GSTR-1/filing/G2g-7b/7c/7d module.
Awaiting human review.**

Full read-only audit (brief §1): `PHASE_G2G7E_AUDIT.md`, produced and reviewed before any
schema/code change, per the brief's own "fast-track: focused audit → cohesive implementation →
comprehensive verification → freeze" instruction (§31) — this phase does not repeat G2g-7d's
multi-gate stop-and-decide structure, since the brief for this phase does not ask for it.

---

## Audit findings (see PHASE_G2G7E_AUDIT.md for the full version)

- The book-side match key for a GSTR-2B B2B invoice is `GoodsReceiptNote.invoiceNumber`/
  `invoiceDate` (one GRN = one supplier bill), **not** `GrnItem` or `PoItem` — 2B reports at invoice
  level, so book aggregation must be at GRN level, summing its items' `taxableValue`/`inputCgst`/
  `Sgst`/`Igst`.
- No field in this codebase captures a **supplier-issued** credit/debit note number —
  `PurchaseReturn`/`DebitNote` record TRIVO's own return/memo, not the supplier's statutory
  Section-34 note. CDNR/CDNRA matching is therefore capped at `POSSIBLE_MATCH` confidence by design,
  never `EXACT_MATCH`/`MATCHED_WITH_NORMALIZATION`.
- No Bill-of-Entry/import model and no ISD module exist anywhere in the schema (confirmed by
  exhaustive grep) — confirms brief §7/§8's own escape hatches apply for real, not hypothetically.
- GSTN's exact wire JSON field spelling could not be retrieved byte-exact this session (only
  converging secondary technical sources) — handled by (1) always persisting the complete original
  parsed JSON verbatim regardless of normalizer confidence, (2) a versioned normalizer so a later
  field-mapping correction is a re-normalization of preserved data, never a re-import, and (3) a
  standing `SOURCE_FIELD_MAPPING_UNVERIFIED` diagnostic on every reconciliation report. See
  `gstr2bNormalizer.ts`'s own header for the full confidence statement.
- `gstr1SnapshotHash.ts` (G2g-6b)'s canonicalize+hash pattern was the right shape to reuse, but — since
  it is part of the named-frozen GSTR-1 filing snapshot module — the two pure helper functions were
  **duplicated**, not imported, into a new `shared/gst2bHash.ts`, keeping this phase's module boundary
  independent (brief §28: "if an adapter is sufficient, use an adapter").
- `resolveGstr3bPeriod` (`gstr3bReporting.service.ts`, G2g-7b, frozen) **was** reused via import for
  pure month-boundary math only — the same reuse precedent G2g-7c already established for the
  identical helper; nothing in 7b/7c/7d was modified.

## Supported GSTR-2B sections

| Section | Reconciled against books? | Notes |
|---|---|---|
| B2B | Yes — full Level 1/2/3 matching | Primary path; reliable GRN-invoice-number key. |
| B2BA | Yes, as above | Amendment link resolved only when the source carries an unambiguous original-document reference the normalizer can locate; otherwise reported standalone with `AMENDMENT_LINK_NOT_RESOLVED`, never guess-linked. |
| CDNR / CDNRA | Yes, capped at `POSSIBLE_MATCH` | No shared document-number identity exists in this data model (see audit). |
| RCM rows within B2B | Yes — cross-referenced against `RcmLiability` | `reverseCharge` flag vs. `GrnItem.rcmLiability` presence; disagreement → `RCM_MISMATCH`. |

## Deferred GSTR-2B sections (brief §7/§8's own explicit allowances)

| Section | Status | Reasoning |
|---|---|---|
| ISD / ISDA | Preserved, not reconciled (`ISD_NOT_SUPPORTED`) | No ISD module exists in this codebase. |
| IMPG / IMPGSEZ | Preserved, not reconciled (`IMPORTS_NOT_RECONCILABLE`) | No Bill-of-Entry/import purchase model exists. |
| GSTN IMS actions (ACCEPT/REJECT/PENDING) | Not built | Brief §24 — explicitly out of scope; `provenanceStatus`/`rawRecord` leave room for this later without a model rewrite. |

---

## Files created

- `PHASE_G2G7E_AUDIT.md` — the read-only audit (brief §1-§4 gate).
- `server/prisma/migrations/20261002170000_g2g7e_gstr2b_ingestion/migration.sql`
- `server/src/shared/gst2bHash.ts` — canonicalize + SHA-256 (duplicated from, not imported from, `gstr1SnapshotHash.ts`).
- `server/src/modules/finance/gst/gstr2b.types.ts` — data contracts (normalization + reconciliation).
- `server/src/modules/finance/gst/gstr2bNormalizer.ts` — pure GSTN JSON → normalized documents.
- `server/src/modules/finance/gst/gstr2bImport.service.ts` — tenant-scoped import orchestration (hash/version/duplicate-detect/persist/audit).
- `server/src/modules/finance/gst/gstr2bReconciliation.ts` — pure matching engine.
- `server/src/modules/finance/gst/gstr2bReconciliation.service.ts` — tenant-scoped loaders (GRN/purchase-return/2B-document) + orchestration.
- Tests: `gstr2bNormalizer.test.ts` (10), `gstr2bReconciliation.test.ts` (18), `gstr2bImport.service.test.ts` (8), `gstr2bReconciliation.service.test.ts` (5), `src/test/http.gstr2bSecurity.test.ts` (8) — **49 focused tests**.

## Files modified

- `server/prisma/schema.prisma` — new `Gst2bStatement`/`Gst2bDocument` models; back-relations on
  `Company`, `CompanyGstRegistration`, `User`.
- `server/src/app.ts` — `express.json()` gained a `verify` callback capturing the exact uploaded
  bytes onto `req.rawBody` (a `declare global` augmentation adds the field to `Express.Request`).
  Needed only by the new import route, to hash what was actually uploaded rather than a
  re-serialization of the parsed object; harmless no-op for every other route (body-parser already
  buffers the full body before parsing — this adds a reference, not a second read).
- `server/src/modules/finance/finance.router.ts` — two new routes (below).

## Database / migration

One migration, `20261002170000_g2g7e_gstr2b_ingestion` — pure `CREATE TABLE` (two tables), indexes,
composite FKs, RLS. No existing row/table touched; no backfill.

- `gst2b_statements` — immutable, versioned per (company, GST registration, FY, tax period). Unique on
  `(companyId, gstRegistrationId, financialYear, taxPeriod, version)`; `@@unique([id, companyId])`
  for composite-FK targeting. Composite FK to `company_gst_registrations`.
- `gst2b_documents` — one row per normalized source document; composite FK to `gst2b_statements`
  (`onDelete: Cascade` — a document cannot outlive its statement) and a **self**-composite-FK
  (`amendsDocumentId`) so the database itself refuses an amendment pointing at another company's
  document.

**Applied and verified against:** the local test DB (`sea_erp_test`) and the real role-split staging
cluster (`trivo_rlstest`, as `trivo_owner`, `db-secure.sql` re-run there afterward).

**Environment note, unrelated to this phase's own code:** applying pending migrations surfaced that
the already-existing (uncommitted) `20261002160000_g2g7d_inward_rcm_foundation` migration had a
stuck `_prisma_migrations` tracking row (`finished_at: null`) on both `sea_erp_test` and
`trivo_rlstest`, even though its actual schema/data effects (tables, FKs, RLS, the 1404/2204 ledger
accounts) were fully and correctly present on both — verified directly before touching anything,
including re-checking the RLS-cluster case under a temporary `NO FORCE ROW LEVEL SECURITY` read
(a bare read as a FORCE-RLS table's owner with no tenant context set always returns zero rows
regardless of whether data exists — a dead end the first read-based check walked into, caught, and
corrected for, rather than concluding data was missing). Resolved via Prisma's own documented
recovery command (`prisma migrate resolve --applied ...`) on both, never by re-running or
hand-editing that migration's SQL. **The local dev DB (`sea_erp_db`) is unrelated and was left
untouched** — it has no `_prisma_migrations` table at all (pre-existing drift predating this
session), which is a materially different, deeper inconsistency that a tracking-row resolve cannot
safely fix; flagged here for awareness, not fixed, since diagnosing/baselining it is outside this
phase's scope and risks a database the user may be relying on in its current state.

## RLS

Both new tables: `ENABLE`/`FORCE ROW LEVEL SECURITY` + the standard `tenant_isolation` policy —
identical precedent to every tenant table added since Phase 11 (most recently `rcm_liabilities`/
`self_invoices`).

## Source format

GSTN GSTR-2B downloadable JSON, nested under `data.docdata.<section>[]` (grouped by supplier GSTIN
for B2B/B2BA/CDNR/CDNRA, flat for ISD/ISDA/IMPG/IMPGSEZ). Field-name confidence: best-effort,
converging-secondary-source reconstruction — see `gstr2bNormalizer.ts`'s header and
`PHASE_G2G7E_AUDIT.md` §2 for the full honest statement and the design choices (liberal field-name
lookup, never-guess-a-missing-value, always-preserve-the-raw-payload) that make that uncertainty
safe rather than silently wrong. **Verify against a real portal-downloaded file before relying on
this for a live filing decision** — also surfaced as a standing diagnostic on every report.

## Normalization

`gstr2bNormalizer.ts: normalizeGstr2bPayload()` — pure, synchronous. Tries several candidate field
names per value (e.g. `inum`/`invoiceNumber`, `ctin`/`gstin`, `txval`/`taxableValue`), sums a
document's `itms[]` rate-bucket array into one document-level total, parses GSTN's DD-MM-YYYY date
convention (tolerating ISO as a fallback), and never fabricates a value it found no candidate for —
a document missing its number or every tax amount is still emitted (never dropped), flagged with a
diagnostic (`MISSING_DOCUMENT_NUMBER`/`MISSING_TAXABLE_AMOUNTS`). Throws `Gstr2bNormalizationError`
only when the top-level payload isn't a JSON object at all.

## Matching algorithm

`gstr2bReconciliation.ts: reconcileGstr2b()` — pure, deterministic. Three identity tiers per brief
§11, strictly ordered, never skipped past a higher tier to force a result:

1. **Exact** — same supplier GSTIN, exact (byte-for-byte) document number, same calendar day.
2. **Normalized** — same GSTIN/date; document number matches after stripping separators/whitespace/case (`INV/001` ≡ `INV-001` ≡ `inv 001`).
3. **Possible** — same GSTIN and date only; **never** escalated to a confident status regardless of amount agreement (brief §32's own priority: a false match is worse than an honest unresolved one).

A ₹1.00 absolute tolerance (brief §13's "define a deterministic tolerance... do not invent a large
one") separates an exact-enough amount from a genuine `AMOUNT_MISMATCH`/`TAX_MISMATCH`. An RCM
disagreement (2B's `reverseCharge` flag vs. the book GRN's own `RcmLiability` presence) overrides an
otherwise-clean match to `RCM_MISMATCH`. CDNR/CDNRA never exceeds `POSSIBLE_MATCH` (see audit). A 2B
document in an unsupported section (ISD/IMPG) is reported `NOT_SUPPORTED`, never compared against
books. Unclaimed book lines → `BOOK_MISSING`; unclaimed 2B documents → `TWO_B_MISSING`. A
branch-restricted caller sees book lines filtered to their branch(es) only — 2B itself is never
branch-filtered (it has no branch concept, brief §19) — with a `PARTIAL_BRANCH_SCOPE` diagnostic
explaining that an out-of-scope book document will show as `TWO_B_MISSING`, not as a genuine gap.

## Amendment handling

`gstr2bImport.service.ts` attempts to resolve a B2BA/CDNRA document's `amendsDocumentNumber` against
an existing `Gst2bDocument` (any statement/version for the same registration, current or superseded)
by exact supplier GSTIN + document number. On success: the amendment is stamped
`provenanceStatus: 'AMENDED'` and the original it supersedes is flipped to `'SUPERSEDED'` (excluded
from all totals/matching from then on — brief §15's "avoid double counting"). On failure: the
amendment stays at the default `'CURRENT'`, the original (if it exists at all) is untouched, and
`reconcileGstr2b` emits `AMENDMENT_LINK_NOT_RESOLVED` for it — both sides are still reported and
totaled independently rather than guess-merged, a documented, bounded double-count risk in exactly
this one unresolved case (never silently hidden).

## Credit-note handling

CDNR/CDNRA documents are normalized and totaled identically to B2B/B2BA, but matched against
`PurchaseReturn` rows at `POSSIBLE_MATCH` confidence only (supplier GSTIN + amount proximity,
tolerance × 5 — a looser band than invoice matching, since there is no document-number identity to
narrow the candidate set at all) — see Audit §1/§3. A standing `CDNR_MATCHING_LIMITED_TO_POSSIBLE`
diagnostic is emitted whenever any CDNR/CDNRA document or book return line exists, so this
limitation is never silently invisible in the report.

## RCM handling

Cross-referenced via the book GRN's own `hasRcmLiability` flag (true when any of its `GrnItem` rows
produced a G2g-7d `RcmLiability`) against the 2B document's own `reverseCharge` flag — a disagreement
in either direction becomes `RCM_MISMATCH`, tallied separately in `rcmSummary`. No automatic
RCM-liability creation or adjustment happens from a 2B row (brief §9/§23) — this is reconciliation
only.

## ITC reconciliation

This phase does **not** produce a final ITC figure. `GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY` is emitted
on every report (brief §16, a hard requirement, not a suggestion): a `MATCHED` status means the book
figure and GSTR-2B agree, nothing more. G2g-7c's own `gstr3bItcEligibility.ts`/`Aggregation.ts` are
untouched and remain the authoritative ELIGIBLE/UNRESOLVED/INELIGIBLE classifier; this phase's output
is a reconciliation input for a human (or a future phase) to combine with that classification, never
a replacement or auto-override of it.

## API endpoints

Both reuse `report:financial_view` — the brief's own §22 instruction ("use the existing permission
unless a genuine security reason requires another; do not create unnecessary permissions") applied
to both new routes, matching this router's existing uniform convention across all 20+ GST/financial
routes. No new permission was introduced.

- `POST /finance/gstr2b/import` — `gstRegistrationId` (+ optional `financialYear`/`taxPeriod`
  override) as **query parameters**; the request **body** is the raw GSTN GSTR-2B JSON itself, not
  wrapped in an envelope, so the hashed/stored payload is exactly, and only, what GSTN generated.
  Returns `{ statementId, version, duplicate, financialYear, taxPeriod, documentCounts,
  normalizationDiagnostics }`.
- `GET /finance/reports/gstr2b-reconciliation` — `gstRegistrationId` + `taxPeriod` (MMYYYY) required,
  `financialYear`/`branchId` optional. Computed fresh every call (no persisted match cache, same
  posture as `gstr3b-itc`/`gstr3b-rcm`).

## Security

Registration ownership (`assertOwnedByCompany`) and branch access (`assertBranchAccessible`) checked
identically to every other GST route in this router, before either service function runs. The import
route additionally cross-checks the uploaded statement's own GSTIN against the resolved
registration's GSTIN — rejecting (400) an attempt to attribute one registration's statement to a
different one, even one the caller legitimately owns. Both `Gst2bStatement`/`Gst2bDocument` enforce
tenant isolation at the database level (RLS) independent of application-level checks.

## Tests

```
Focused (new G2g-7e files):                 49
G2g-7c/7d regression (ITC/RCM suites):      re-run as part of full suite below, 0 failed
GST regression (all gst* suites):           re-run as part of full suite below, 0 failed
Procurement/finance regression:             re-run as part of full suite below, 0 failed
Full server suite (local, sea_erp_test):    111 files / 1987 passed, 5 pre-existing skips, 0 failed
Full server suite (test:rls, trivo_rlstest):111 files / 1991 passed, 1 pre-existing skip, 0 failed
Tenant audit (npm run audit:tenant):        0 violations (unchanged baseline)
TypeScript (tsconfig.json, tsconfig.build.json, and client tsconfig): all clean
Prisma validate:                            clean
```

---

## Known limitations

**Statutory limitations** (explicit, never silently assumed clear): a `MATCHED` reconciliation status
is not a final ITC determination (brief §16) — Section 16(4)/17(5)/180-day/place-of-supply remain
G2g-7c's own `NOT_DETERMINABLE` report-level diagnostics, untouched and not re-derived here.

**Source-format limitations**: the GSTN wire JSON field-name mapping is a best-effort reconstruction
(see `gstr2bNormalizer.ts`'s header) — the normalizer is liberal about field-name variants but has
not been verified against a byte-exact official schema or a real portal-downloaded file this session.
A `normalizerVersion` stamp and a fully-preserved `rawPayload` make a future correction a
re-normalization of already-imported data, not a re-import.

**Matching limitations**: CDNR/CDNRA can never reach `EXACT_MATCH`/`MATCHED_WITH_NORMALIZATION` —
this codebase has no field for a supplier-issued note number (data-model limitation below, not a
matching-algorithm gap). Book-side period filtering uses the GRN's own `receivedDate` within the
requested calendar month; a supplier invoice received in a later period than it was dated may not
align with the GSTR-2B period it actually appears in, producing a `BOOK_MISSING`/`TWO_B_MISSING`
pair that is really a timing mismatch, not a true discrepancy — not specially detected in this
foundation phase.

**Data-model limitations**: `PurchaseReturn`/`DebitNote` have no field for a supplier's own
Section-34 credit/debit note number (only TRIVO's own return/memo identity) — the CDNR matching cap
above is a direct consequence, not an oversight. `RcmLiability` has no independent 2B-side identity
beyond its originating GRN — RCM cross-referencing reuses the same GRN-invoice key as ordinary B2B
matching.

**Deferred modules** (brief §7/§8/§24, confirmed absent in this codebase — see Audit §1): import of
goods (IMPG/IMPGSEZ — no Bill-of-Entry model), ISD/ISDA (no ISD module), the GSTN Invoice Management
System (ACCEPT/REJECT/PENDING actions). G2g-7f (GSTR-3B filing lifecycle) and G2g-7g (GSTN wire/
export) remain untouched, per the brief's own stop boundary.

---

**STOP per the brief's §33.** No commit, no push, no G2g-7f, no frontend, no IMS, no imports
subsystem, no ISD, no GSTR-3B filing lifecycle, no modification to any frozen GSTR-1/G2g-7b/7c/7d
module. Awaiting human review.

---

## Correction (2026-10-02) — GSTR-2B ITC availability (Table 3 vs. Table 4) is now independent output

The reconciliation engine already normalized and persisted the source's own ITC-availability flag
(`Gst2bDocument.itcAvailability`/`.ineligibilityReason`) but never read it back out — it vanished
before reaching a report. Added:

- `Gstr2bTwoBItcAvailability = 'AVAILABLE' | 'NOT_AVAILABLE' | 'UNKNOWN'` (`gstr2b.types.ts`).
  `UNKNOWN` is an explicit, honest third state — never silently coerced to `AVAILABLE` — used
  whenever there is no 2B document on a match at all (e.g. `BOOK_MISSING`) or the source payload
  didn't state a value.
- `Gstr2bDocumentForMatch.itcAvailability`/`.ineligibilityReason` (input) and
  `Gstr2bMatchResult.twoBItcAvailability`/`.twoBIneligibilityReason` (output) — the DB loader in
  `gstr2bReconciliation.service.ts` now selects the two columns it previously omitted.
- `gstr2bReconciliation.ts` gained one pure helper (`twoBAvailabilityOf`) spread into all 7
  `matches.push(...)` sites. `matchStatus` computation itself was not touched — availability is
  purely additive, uncoupled data; an `EXACT_MATCH` can carry `twoBItcAvailability: 'NOT_AVAILABLE'`.

No schema change (the columns already existed), no change to the normalizer's own resolution logic,
no change to G2g-7b/7c/7d, no frontend. 8 new focused tests in `gstr2bReconciliation.test.ts`
(`describe('twoBItcAvailability — independent of matchStatus')`). Full verification re-run clean:
49/49 focused G2g-7e tests, 730/730 full GST regression suite, both `tsc`, `prisma validate`,
`npm run audit:tenant` (0 violations), `npm run test:rls` (1999 passed / 1 pre-existing skip, 111
files, 0 failed).

**G2g-7e, including this correction, is now ✅ APPROVED / FROZEN by the user (2026-10-02).** Do not
modify `gstr2bNormalizer.ts`/`gstr2bReconciliation.ts`/`gstr2bImport.service.ts`/
`gstr2bReconciliation.service.ts`/`gstr2b.types.ts` without an explicit new instruction. G2g-7f
(GSTR-3B filing lifecycle) and G2g-7g (GSTN wire/export) remain the next unopened doors — still not
started, still requiring their own explicit go-ahead.
