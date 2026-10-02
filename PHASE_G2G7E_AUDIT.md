# Phase G2g-7e — GSTR-2B Ingestion & Reconciliation: Read-Only Audit

**Status: AUDIT COMPLETE. NO CODE WRITTEN BELOW THIS POINT.** Operating under the brief's own
"fast-track" instruction (§31: "Do NOT perform repeated micro-audits... Focused audit → cohesive
implementation → comprehensive verification → freeze") — this is a single focused pass, not a
multi-round review, and implementation follows directly after this document rather than waiting for
a separate human sign-off gate (unlike G2g-7d, whose brief had repeated explicit stop-and-decide
gates this one does not repeat, beyond the final §33 stop condition).

---

## 1. What TRIVO can currently match (read-only findings)

| Fact | Where | Relevance to 2B matching |
|---|---|---|
| Supplier's bill identity | `GoodsReceiptNote.invoiceNumber` / `invoiceDate` (one GRN = one supplier bill in the common case) | **This is the book-side match key** for a 2B B2B invoice — not `GrnItem`, not `PoItem`. A GRN can have several `GrnItem` lines (several PO lines received on one bill); 2B reports at invoice level, so book aggregation must also be at GRN level, summing its items' `taxableValue`/`inputCgst`/`Sgst`/`Igst`. |
| Supplier GSTIN | `Supplier.gstNumber`, validated structurally by `shared/gstin.ts: validateGstin()` | Primary cross-reference field, same as G2g-7c/7d. |
| Buyer registration attribution | `GrnItem.buyerRegistrationId` (G2g-7a, `shared/inputGst.ts: resolveBuyerRegistration`) | Scopes a book line to one of the company's own GST registrations — the same scoping dimension a 2B statement is generated per. |
| RCM liability | `RcmLiability` (G2g-7d), linked 1:1 to a `GrnItem` | Cross-reference target for 2B's reverse-charge-flagged B2B rows. |
| Purchase return / debit note | `PurchaseReturn`/`PurchaseReturnItem`, `DebitNote`/`DebitNoteItem` | **Weak match surface for CDNR** — see §4 Data-model limitations. Neither carries a supplier-issued credit/debit note *number*; `DebitNote` is TRIVO's own outward-facing memo to the supplier (schema comment: "a debit note is issued BY this company TO a supplier... never itself an e-invoice document on our side"), not a representation of a statutory Section-34 note the *supplier* filed. The only statutory Section-34 credit/debit note correlatable to 2B's CDNR is one the **supplier** issues — which this codebase has no field to capture at all. |
| ITC foundation | `gstr3bItcEligibility.ts`/`gstr3bItcAggregation.ts` (G2g-7c, **frozen**) | Downstream consumer — this phase's reconciliation output feeds book-vs-2B comparison, never replaces or re-derives G2g-7c's own ELIGIBLE/UNRESOLVED/INELIGIBLE classification. |
| RCM foundation | `gstr3bRcmClassification.ts`/`Aggregation.ts` (G2g-7d, **frozen**) | Same relationship — this phase cross-references `RcmLiability` rows, never reclassifies them. |
| Filing-snapshot hashing precedent | `gstr1SnapshotHash.ts` (G2g-6b) — canonical-JSON-then-SHA-256 | **Pattern to reuse** (not the file itself — it's part of the named-frozen "GSTR-1 filing snapshot" module, §28's frozen list; duplicated as a small, generic, pure utility instead, to keep this phase's module boundary clean — see §C). |
| Immutable-version precedent | `GstFilingSnapshot` (version/status DRAFT→SUPERSEDED, never overwritten) | **Pattern to reuse** for `Gst2bStatement` — but **not the model itself**: `GstReturnPeriod`'s lifecycle (OPEN→SNAPSHOT_CREATED→FILED→LOCKED) is specifically about a return *we file*; GSTR-2B is a statement *GSTN hands us*, with no filing/ARN/lock concept at all. Reusing `GstReturnPeriod` would conflate two different statutory directions. A new, parallel, narrower model is cleaner. |
| Atomic per-key sequence allocation | `shared/numberSequence.ts: nextSequenceValue` (via `nextSimpleCode`) | Reusable, race-safe mechanism for allocating `Gst2bStatement.version` per (company, registration, FY, tax period) — avoids inventing a new row-lock scheme. |
| No raw-body capture today | `app.ts:61`: `express.json({ limit: '10mb' })`, no `verify` callback anywhere in the codebase | A true "source file hash" (hash of the exact uploaded bytes, not of the re-serialized parsed object) needs a dedicated raw-capturing body parser on this one route only — see §C. |

**No import/Bill-of-Entry/ISD model exists anywhere in the schema** (confirmed by exhaustive grep for
`BillOfEntry`/`ICEGATE`/`Isd`/`InputServiceDistributor` — zero matches). This directly confirms the
brief's own §7/§8 escape hatches apply, not just as a theoretical allowance.

## 2. GSTR-2B input format — confirmed sections, unconfirmed exact field spelling

Verified this session against current public GSTN/tax-portal material (not training-data recall):
GSTR-2B's **All Tables** view is organized into **B2B, B2BA, B2B-CDNR, B2B-CDNRA, ISD, ISDA, IMPG,
IMPGSEZ**; its **Summary** view separates **ITC Available** (Part A/B) from **ITC Not Available**
(Part A/B). The downloadable JSON nests document arrays under a `data`/`docdata` structure, grouped
by section and then by supplier GSTIN, with per-invoice fields converging across independent
technical sources on: counterparty GSTIN (`ctin`), trade name (`trdnm`), invoice number (`inum`),
invoice date (`dt`), invoice value (`val`), place of supply (`pos`), a reverse-charge flag, and a
per-rate items array (`itms`) carrying taxable value and CGST/SGST/IGST/cess.

**Honest confidence statement (same posture as `shared/gstin.ts`'s and `shared/gstUqc.ts`'s own
existing disclaimers in this codebase):** I could not retrieve a byte-exact, versioned GSTN wire
schema document in this session — only converging secondary-source descriptions. Per the brief's
own "do not invent fields" instruction, the implementation below is built so that **getting an exact
field spelling wrong never corrupts or loses data**: the complete original parsed JSON is always
preserved verbatim and unconditionally (`Gst2bStatement.rawPayload`), independent of how well the
normalizer's field-mapping succeeds; the normalizer is explicitly versioned
(`normalizerVersion`) so a future correction to field-mapping is a **re-normalization** of
already-preserved source data, never a re-import. Every field the normalizer cannot confidently
locate is left `null`/unresolved rather than guessed, and a structurally-unrecognized document is
reported per-record (not a global failure). **This is a source-format limitation to resolve by
testing against a real portal-downloaded GSTR-2B JSON before relying on this for a live reconciliation
decision** — flagged explicitly in the final report's Known Limitations, not silently assumed correct.

## 3. Scope decision — sections implemented now vs. deferred

Per the brief's own "do not expand the phase merely because GSTR-2B contains more sections":

| Section | This phase | Reasoning |
|---|---|---|
| B2B (incl. reverse-charge-flagged rows) | **Implemented** — normalized, persisted, matched (Level 1-3) against book GRNs | Priority 1, has a reliable book-side match key (§1). |
| B2BA (amendments to B2B) | **Implemented, with a narrowed guarantee** — normalized, preserved with provenance; auto-netted against its original ONLY when the source payload carries an unambiguous original-document reference the normalizer can resolve, otherwise reported standalone with a diagnostic rather than guessed-linked | Brief §15 explicitly forbids collapsing original+amendment without preserving provenance; given §2's field-spelling uncertainty, forcing a link would risk a **false match** — worse than an unresolved one (brief §32's own stated priority). |
| CDNR / CDNRA (supplier credit/debit notes) | **Implemented at POSSIBLE_MATCH confidence only** — normalized, totaled, cross-referenced to `PurchaseReturn` by supplier + amount proximity, **never EXACT/MATCHED_WITH_NORMALIZATION** | §1's data-model finding: no field in this codebase captures a *supplier-issued* note number. Reporting a confident exact match here would be a false precision claim. |
| RCM rows within B2B | **Implemented** — cross-referenced against `RcmLiability` via the same GRN-invoice key | Direct, explicit ask (brief §9), and `RcmLiability` already carries a `grnItemId` lineage back to the same GRN. |
| ISD / ISDA | **Preserved, not reconciled** — `supportStatus: 'ISD_NOT_SUPPORTED'` | Brief §8's own explicit allowance; confirmed no ISD module exists (§1). |
| IMPG / IMPGSEZ | **Preserved, not reconciled** — `supportStatus: 'IMPORTS_NOT_RECONCILABLE'` | Brief §7's own explicit allowance; confirmed no Bill-of-Entry/import model exists (§1). |
| GSTN IMS actions (ACCEPT/REJECT/PENDING) | **Not built** | Brief §24 — explicitly out of scope; `Gst2bDocument.provenanceStatus`/`rawRecord` leave room for this without a model rewrite, never implemented now. |

## 4. Proposed architecture (implemented in this pass)

```
POST   /finance/gstr2b/import                       — parse → validate → canonicalize → hash →
                                                         duplicate/version detect → persist → normalize
GET    /finance/reports/gstr2b-reconciliation        — load current statement's documents + book
                                                         documents (GRN/return/RCM) → pure match engine
```

- **`Gst2bStatement`** (new model) — one immutable row per (company, GST registration, FY, tax
  period, **version**). Carries `rawPayload` (full original JSON, never rewritten), `sourceFileHash`
  (SHA-256 of the exact uploaded bytes) and `canonicalPayloadHash` (SHA-256 of the canonicalized
  parsed structure — catches a re-saved file with different whitespace/key order as the same
  content), `normalizerVersion`, `status` (`ACTIVE`/`SUPERSEDED`, same vocabulary as
  `GstFilingSnapshot`). A re-import with an identical `sourceFileHash` **or** identical
  `canonicalPayloadHash` against the current `ACTIVE` statement for that exact period is reported as
  a duplicate and creates no new row (brief §26). A re-import with genuinely different content for
  the same period creates a new, higher `version` and marks the prior one `SUPERSEDED` — **never
  deleted, never overwritten** (brief §3/§25).
- **`Gst2bDocument`** (new model) — one normalized row per source document (B2B/B2BA/CDNR/CDNRA/
  ISD/ISDA/IMPG/IMPGSEZ entry), FK'd to its `Gst2bStatement`. Structured (queryable/indexable)
  rather than re-parsed from `rawPayload` on every reconciliation call — this codebase has no other
  structured representation of 2B-shaped data to fall back on (unlike GSTR-1 export, which reuses
  already-structured `SalesInvoice`/`CreditNote` tables). Carries `rawRecord` (the exact source
  sub-object) for full per-document traceability.
- **No persisted match/reconciliation table** — matching is computed fresh on every
  `GET /finance/reports/gstr2b-reconciliation` call, the same pure-engine-plus-live-loader shape
  already proven by `gstr3bItcReporting.service.ts`/`gstr3bRcmReporting.service.ts`. This avoids a
  stale-cache correctness problem entirely and needs no new invalidation logic.
- **`gstr2bNormalizer.ts`** (pure, no Prisma) — GSTN wire JSON → `Gst2bNormalizedDocument[]`.
- **`gstr2bReconciliation.ts`** (pure, no Prisma) — normalized 2B documents + book document facts →
  match results, mirroring `gstr3bRcmAggregation.ts`'s shape (diagnostics array, money totals,
  explicit per-line status, report-level capability-gap diagnostics emitted once).
- **`gstr2bImport.service.ts`** / **`gstr2bReconciliation.service.ts`** — tenant-scoped
  orchestration/loaders, mirroring `gstr1FilingSnapshot.service.ts` (hashing/versioning/persistence)
  and `gstr3bRcmReporting.service.ts` (document loaders) respectively.
- **Permission**: reuses `report:financial_view` for both the import and the reconciliation routes —
  the brief's own §22 instruction ("use existing `report:financial_view` unless a genuine security
  reason requires another permission; do not create unnecessary permissions") applied consistently
  to both new routes, matching this router's own uniform existing convention (confirmed in §1: all
  19+ GST/financial routes already share this one permission).
- **Raw-body hashing**: a dedicated `express.json({ verify })` instance mounted only on the import
  route (not a global `app.ts` change) captures the exact uploaded bytes onto `req.rawBody` before
  Express's normal JSON body parsing proceeds, so `sourceFileHash` is a hash of what was actually
  uploaded, not a re-serialization of the parsed object.
- **No modification to any frozen module**: `gstr3bOutwardAggregation.ts`/`gstr3bReporting.service.ts`
  (7b), `gstr3bItcEligibility.ts`/`Aggregation.ts`/`Reporting.service.ts` (7c), `gstr3bRcm*.ts` (7d),
  every `gstr1*`/`gstr1Filing*` module — none are imported from, changed, or depended on beyond
  reading already-public types where genuinely needed (none were, in the end: this phase's book-side
  loaders are built fresh against `GrnItem`/`PurchaseReturnItem`/`RcmLiability`, parallel to but
  independent of 7c/7d's own loaders).

## 5. RLS / tenant isolation plan

Both new tables: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + the standard
`tenant_isolation` policy, `@@unique([id, companyId])` for composite-FK targets, composite FKs to
`CompanyGstRegistration`/itself (amendment self-reference) — identical precedent to every tenant
table added since Phase 11 (most recently `rcm_liabilities`/`self_invoices`). Import route validates
`gstRegistrationId` ownership via `assertOwnedByCompany` before anything else, exactly like every
other GST route in `finance.router.ts`. The imported JSON's own top-level GSTIN is cross-checked
against the resolved registration's `gstin` — a mismatch is rejected (400), closing the one way a
caller could otherwise attribute a wrong-GSTIN statement to a registration they do own.

## 6. What this phase explicitly does NOT do (brief §23/§24/§28/§33)

No automatic journal entries, no automatic purchase/GRN/supplier-balance creation, no automatic RCM
liability creation from a 2B row, no automatic ITC approval — 2B match status feeds a human-readable
reconciliation report only. No frontend. No GSTR-3B filing lifecycle. No GSTN wire/export. No IMS.
No modification to any named-frozen module.

---

**Proceeding directly to implementation per the brief's fast-track instruction.**
