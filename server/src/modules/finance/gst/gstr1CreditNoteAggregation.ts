// G2g-3d-2 — GSTR-1 Table 9B CDNR/CDNUR Credit Note aggregation. Pure, deterministic, no Prisma
// access: takes already-loaded, already-authorized CreditNote source documents (the caller's job
// to fetch, scoped to one company, via tenantQuery/tenantBatch — see shared/tenantContext.ts) and
// groups their FROZEN G2g-3d-1 normalization into Table 9B's recipient-type tables:
//   - CDNR  — Credit/Debit Notes for REGISTERED recipients.
//   - CDNUR — Credit/Debit Notes for UNREGISTERED recipients, split B2CL / export (export stays an
//     explicit, always-empty placeholder — see section "Export" below).
//
// Phase A (GSTR-1 readiness): a Credit Note whose ORIGINAL outward supply was itself B2CS is
// statutorily NEVER its own CDNUR line item — GSTN has no "CDNUR B2CS" category at all. It must
// instead NET AGAINST Table 7's B2CS outward-supply figure. This module therefore no longer places
// a B2CS-original Credit Note in `cdnur` at all (there is no `cdnur.b2cs` — see the note on
// `Gstr1CreditNoteAggregation.cdnur` below); it is reported instead in the sibling `b2csNetOff`
// bucket, which carries the exact same document shape as CDNR/CDNUR (nothing here is silently
// dropped — rule 5/"never silently guess"), for gstr1OutwardAggregation.ts's own Table 7 aggregator
// to consume and net against its matching B2CS bucket. This module does NOT perform that netting
// itself — it has no visibility into the gross outward-supply side at all (see this file's own
// "Deliberately NOT in scope" note below) — it only classifies and hands the eligible documents on.
//
// Mirrors gstr1OutwardAggregation.ts's (G2g-3c, frozen) own architecture exactly:
//   caller/service → authorized source documents → FROZEN normalizer → this pure aggregator →
//   report result. No Prisma inside this file, no database access, no hidden network calls, same
//   input always produces the same output.
//
// Consumes, unmodified:
//   - gstr1CreditNoteNormalizer.ts (G2g-3d-1, frozen) — normalizeGstr1CreditNote() is authoritative
//     for recipient classification (REGISTERED/UNREGISTERED), B2B/B2CL/B2CS of the ORIGINAL outward
//     supply, GSTIN normalization, Path A/Path B detection, and every exclusion reason. This module
//     never reclassifies, never re-derives any of that — it only groups the normalizer's own output
//     (rule 4 of the G2g-3d-2 brief).
//   - gstr1Normalizer.ts (G2g-3b, frozen) — GstReportingLine shape, reused only to build a per-
//     document rate breakdown (rule 16); no UQC/quantity rule is reproduced here.
//
// Deliberately NOT in scope here (see the G2g-3d-2 brief): does not create/modify CreditNotes,
// does not touch accounting or GST calculation, no frontend, no exports/CSV, no IRP/e-Invoice, no
// Table 12/13, no GSTR-3B, no Debit Notes (a separate, purchase-side flow — rule 21).
//
// Money follows this codebase's established convention (see gstr1OutwardAggregation.ts's own
// header): plain `number`, Prisma Decimal already unwrapped by the caller — no decimal.js anywhere
// in this codebase. Every running sum goes through round2() at each step (rule 17), same pattern
// gstr1OutwardAggregation.ts already uses, to keep paise-level drift from compounding.

import {
  normalizeGstr1CreditNote,
  type Gstr1CreditNoteSourceDocument,
  type Gstr1CreditNoteNormalized,
  type Gstr1CreditNoteDocument,
  type Gstr1CreditNoteDiagnostic,
  type Gstr1CreditNoteDiagnosticCode,
  type Gstr1CreditNoteExclusionReason,
  type Gstr1CreditNoteSourcePath,
} from './gstr1CreditNoteNormalizer';
import type { GstReportingLine } from './gstr1Normalizer';
import type { BranchAccess } from '../../../shared/tenantContext';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Raised only for an authorization refusal (an explicitly requested branch this caller cannot
 *  access, or a missing required registration selection) — never for a data-quality problem, which
 *  is always a diagnostic/exclusion record instead. Mirrors
 *  Gstr1OutwardAggregationAccessError's own scope exactly (that frozen class is not reused here so
 *  this module stays fully self-contained, matching how gstr1OutwardAggregation.ts itself never
 *  reused anything from gstr1Classification.ts either). */
export class Gstr1CreditNoteAggregationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr1CreditNoteAggregationAccessError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input contract — one already-loaded, already-authorized CreditNote (+ items), exactly the frozen
// G2g-3d-1 source shape, plus the one extra fact this aggregation phase needs that the normalizer
// itself has no reason to carry: branch scope (rule 8).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Gstr1CreditNoteSourceDocument` (frozen, unchanged) plus the branch this credit note belongs to
 * for scoping purposes. CreditNote itself carries no `branchId` column (see the Prisma model) —
 * branch scope is inherited from the SalesInvoice being credited, which the caller joins when
 * loading these rows (same "already-loaded, already-authorized" contract every other field on
 * `Gstr1CreditNoteSourceDocument` already follows). This module performs no lookup of its own.
 */
export interface Gstr1CreditNoteAggregationSourceDocument extends Gstr1CreditNoteSourceDocument {
  branchId: string | null | undefined;
}

export interface Gstr1CreditNoteAggregationOptions {
  /** Rule 6: aggregation MUST be for one selected seller GST registration — required, never
   *  defaulted to Company.gstin/a primary/another registration/a branch GSTIN. Only a CreditNote
   *  whose OWN `sellerRegistrationId` (present) matches this id is eligible; a present-but-different
   *  id is silently out of scope (exactly like a WHERE clause the caller's own query would have
   *  applied) — identical posture to gstr1OutwardAggregation.ts's own `gstRegistrationId` option. A
   *  MISSING id on the source is NOT assumed out of scope; it proceeds to the frozen normalizer,
   *  which already reports it as MISSING_SELLER_REGISTRATION (rule 6's own last paragraph). */
  gstRegistrationId: string;
  /** Complete Asia/Kolkata calendar-day boundaries, already resolved by the caller via
   *  shared/istDate.ts (rule 7) — this module trusts the two Date instants as given and never
   *  re-derives IST semantics itself. Filtered against the CreditNote's OWN `creditNoteDate` —
   *  never the original invoice date, the SalesReturn date, or a payment/journal date (rule 7). */
  period: { from: Date; to: Date };
  /** Same branch-access contract every other G2g-2/G2g-3c report already uses — reused unchanged,
   *  not a new mechanism (rule 8). */
  branchAccess?: BranchAccess;
  /** A single explicitly requested branch. Verified against `branchAccess` and REJECTED (thrown,
   *  not silently dropped) when unauthorized — mirrors gstr1OutwardAggregation.ts's own explicit-
   *  branchId behavior exactly (rule 8's "unauthorized/cross-company branch → explicit access
   *  error"). Ownership against a live Branch row is NOT re-verified here — that already happened
   *  one layer up, wherever these source documents were fetched (same division of responsibility
   *  as the frozen outward aggregator). */
  branchId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output contract
// ─────────────────────────────────────────────────────────────────────────────

/** One HSN+rate+UQC slice of ONE Credit Note's own lines (rule 16) — grouped only within that
 *  single document, never across different Credit Notes (rule 16's explicit "do not aggregate
 *  rates across different Credit Notes into the document record"). */
export interface Gstr1CreditNoteRateBreakdown {
  rate: number;
  hsnCode: string | null;
  uqc: string | null;
  quantity: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  /** Always 0 — see gstr1Normalizer.ts's own cessAmount comment: this schema has no line-level
   *  cess column on CreditNoteItem, and a header-level figure is never fabricated down to a line. */
  cess: number;
}

/**
 * One independent, reportable Credit Note document (rule 14: never consolidated with another
 * Credit Note, even against the same original invoice). Preserves every field rule 9/10 requires,
 * plus the FROZEN normalizer's own document fields unchanged — this aggregator adds grouping
 * (`rateBreakdown`) and reporting-direction semantics (`documentType`/`sign`, rule 12), nothing else.
 */
export interface Gstr1CreditNoteReportDocument {
  /** A Credit Note is a reduction, never simply multiplied by -1 in its own stored values (rule
   *  12) — `documentType`/`sign` make the reporting direction explicit instead, while every money
   *  field below keeps the Credit Note's own actual persisted positive value. */
  documentType: 'CREDIT_NOTE';
  sign: -1;

  creditNoteId: string;
  creditNoteNumber: string;
  creditNoteDate: Date;

  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;

  buyerGstin: string | null;
  sellerRegistrationId: string;
  placeOfSupply: string | null;

  /** The ORIGINAL outward supply's own B2B/B2CL/B2CS category (frozen classifier, unchanged) — the
   *  basis for the CDNUR-B2CL vs. b2csNetOff split (Phase A; rule 10: "based on the ORIGINAL
   *  OUTWARD SUPPLY classification ... not on the Credit Note amount"). Always 'B2B' on a CDNR
   *  document (a registered recipient's original supply is always B2B); carried through
   *  regardless for traceability, never re-derived here. */
  originalSupplyCategory: Gstr1CreditNoteDocument['originalSupplyCategory'];

  sourcePath: Gstr1CreditNoteSourcePath;

  reasonCode: string;
  reasonNotes: string | null;

  /** Tax-inclusive Credit Note total (rule 9's "noteValue"). */
  noteValue: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;

  /** Rate-level breakdown of THIS document's own lines only (rule 16). */
  rateBreakdown: Gstr1CreditNoteRateBreakdown[];

  /** Line-quality notes carried straight from the frozen normalizer (e.g. UNSUPPORTED_UQC) —
   *  informational only; a document with any of these is still reportable and still appears here
   *  (rule 9's "diagnostics if applicable"). */
  diagnostics: Gstr1CreditNoteDiagnostic[];
}

export interface Gstr1CreditNoteBucketSummary {
  documentCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  noteValue: number;
}

export interface Gstr1CreditNoteBucket {
  documents: Gstr1CreditNoteReportDocument[];
  summary: Gstr1CreditNoteBucketSummary;
}

/** One source CreditNote excluded from CDNR/CDNUR by the FROZEN normalizer's own `reportable`
 *  gate — never silently dropped (rule 5). Carries the complete normalizer output so the excluded
 *  record's own values/diagnostics remain fully inspectable, exactly as persisted (never zeroed). */
export interface Gstr1CreditNoteExclusionRecord {
  creditNoteId: string;
  creditNoteNumber: string;
  creditNoteDate: Date;
  exclusionReason: Gstr1CreditNoteExclusionReason;
  diagnostics: Gstr1CreditNoteDiagnostic[];
  document: Gstr1CreditNoteDocument;
}

export type Gstr1CreditNoteAggregationDiagnosticReason =
  | 'OUT_OF_SCOPE_REGISTRATION'
  | 'OUT_OF_SCOPE_BRANCH'
  | 'OUT_OF_SCOPE_PERIOD'
  | 'DUPLICATE_SOURCE_ID'
  /** Guards the two unreachable-in-practice branches below (a reportable document whose
   *  reportingTable/originalSupplyCategory somehow didn't resolve to a real bucket) — kept
   *  distinct from the frozen normalizer's own `Gstr1CreditNoteDiagnosticCode` values so this
   *  aggregator never claims one of ITS reasons for a condition the normalizer didn't actually
   *  report. */
  | 'UNREACHABLE_CLASSIFICATION'
  | Gstr1CreditNoteDiagnosticCode;

/** Aggregation-level notes — things decided BEFORE (or independent of) the frozen normalizer:
 *  scope exclusions (rule: "silently out of scope," matching a WHERE clause — see meta counters
 *  below) are recorded here for visibility even though they never reach normalization at all, and a
 *  duplicate source id (rule 20) is recorded here too. Per-document data-quality diagnostics from
 *  the normalizer itself live on the document (`Gstr1CreditNoteReportDocument.diagnostics` /
 *  `Gstr1CreditNoteExclusionRecord.diagnostics`), not duplicated here. */
export interface Gstr1CreditNoteAggregationDiagnostic {
  creditNoteId: string;
  creditNoteNumber: string | null;
  reason: Gstr1CreditNoteAggregationDiagnosticReason;
  detail: string;
}

export interface Gstr1CreditNoteAggregation {
  cdnr: Gstr1CreditNoteBucket;
  /** Phase A: no `b2cs` key here — GSTN's own CDNUR table has no B2CS category (see this file's own
   *  header). A B2CS-original Credit Note is never reported here; it is routed to `b2csNetOff`
   *  instead, never fabricated into a fake "CDNUR B2CS" bucket just to preserve the old shape. */
  cdnur: {
    b2cl: Gstr1CreditNoteBucket;
    /** Rule 11: G2g-3d-1 already refuses to guess export-with-payment/export-without-payment via
     *  EXPORT_CLASSIFICATION_UNAVAILABLE — those notes land in `excluded`, never here. This bucket
     *  is an explicit, permanently empty placeholder for the later export phase (rule 18's own
     *  conceptual shape), never fabricated. */
    export: Gstr1CreditNoteBucket;
  };
  /** Phase A: every reportable Credit Note whose ORIGINAL outward supply was itself B2CS — same
   *  document shape as `cdnr`/`cdnur.b2cl` (nothing lost, nothing silently dropped), but NOT part
   *  of Table 9B's CDNR/CDNUR at all. Consumed by gstr1OutwardAggregation.ts to net against Table
   *  7's matching B2CS bucket ("Net B2CS = Gross B2CS - eligible B2CS Credit Notes") — this module
   *  itself performs no netting (see the header note on scope). */
  b2csNetOff: Gstr1CreditNoteBucket;
  diagnostics: Gstr1CreditNoteAggregationDiagnostic[];
  excluded: Gstr1CreditNoteExclusionRecord[];
  meta: {
    gstRegistrationId: string;
    period: { from: Date; to: Date };
    /** Source documents that matched the selected registration/branch/period scope and were
     *  actually run through the frozen normalizer (whether or not they ended up excluded or
     *  reportable). */
    notesConsidered: number;
    /** Source documents that never reached normalization at all because they belonged to a
     *  different registration, a different (inaccessible) branch, a different period, or were a
     *  repeat of an id already processed — exactly what a scoped query would simply never have
     *  fetched, or what rule 20 says must never be double-counted. */
    notesExcludedByScope: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch-access resolution — identical shape/behavior to gstr1OutwardAggregation.ts's own private
// resolveAllowedBranchIds (that file is frozen and does not export it, so this is a fresh,
// independent implementation of the same rule, not an import — rule 8's "exact same pattern").
// ─────────────────────────────────────────────────────────────────────────────

function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | undefined): string[] | undefined {
  if (branchId) {
    if (branchAccess && !branchAccess.allBranches && !branchAccess.branchIds.includes(branchId)) {
      throw new Gstr1CreditNoteAggregationAccessError(
        `Branch ${branchId} is not accessible to the caller — rejected outright, per rule 8, rather than silently aggregating without it.`,
      );
    }
    return [branchId];
  }
  return branchAccess && !branchAccess.allBranches ? branchAccess.branchIds : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate breakdown (rule 16) — grouped ONLY within one Credit Note's own lines; called once per
// document, never across documents.
// ─────────────────────────────────────────────────────────────────────────────

function rateBreakdownKey(line: GstReportingLine): string {
  return `${line.hsnCode ?? ''}\u0000${line.gstRate}\u0000${line.uqc ?? ''}`;
}

function buildRateBreakdown(lines: GstReportingLine[]): Gstr1CreditNoteRateBreakdown[] {
  const byKey = new Map<string, Gstr1CreditNoteRateBreakdown>();
  for (const line of lines) {
    const key = rateBreakdownKey(line);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = round2(existing.quantity + line.quantity);
      existing.taxableValue = round2(existing.taxableValue + line.taxableValue);
      existing.igst = round2(existing.igst + line.igstAmount);
      existing.cgst = round2(existing.cgst + line.cgstAmount);
      existing.sgst = round2(existing.sgst + line.sgstAmount);
      existing.cess = round2(existing.cess + line.cessAmount);
    } else {
      byKey.set(key, {
        rate: line.gstRate, hsnCode: line.hsnCode, uqc: line.uqc,
        quantity: line.quantity, taxableValue: line.taxableValue,
        igst: line.igstAmount, cgst: line.cgstAmount, sgst: line.sgstAmount, cess: line.cessAmount,
      });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.rate - b.rate || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '') || (a.uqc ?? '').localeCompare(b.uqc ?? ''),
  );
}

function toReportDocument(normalized: Gstr1CreditNoteNormalized): Gstr1CreditNoteReportDocument {
  const doc = normalized.document;
  return {
    documentType: 'CREDIT_NOTE',
    sign: -1,
    creditNoteId: doc.creditNoteId,
    creditNoteNumber: doc.creditNoteNumber,
    creditNoteDate: doc.creditNoteDate,
    originalInvoiceId: doc.originalInvoiceId,
    originalInvoiceNumber: doc.originalInvoiceNumber,
    originalInvoiceDate: doc.originalInvoiceDate,
    buyerGstin: doc.buyerGstin,
    // Non-null: reportable === true guarantees sellerRegistrationId is present (else the frozen
    // normalizer would have set exclusionReason = 'MISSING_SELLER_REGISTRATION').
    sellerRegistrationId: doc.sellerRegistrationId!,
    placeOfSupply: doc.placeOfSupply,
    originalSupplyCategory: doc.originalSupplyCategory,
    sourcePath: doc.sourcePath,
    reasonCode: doc.reasonCode,
    reasonNotes: doc.reasonNotes,
    noteValue: doc.noteValue,
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cgst: doc.cgst,
    sgst: doc.sgst,
    cess: doc.cess,
    rateBreakdown: buildRateBreakdown(normalized.lines),
    diagnostics: normalized.diagnostics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary rollups (rule 19: derived from the reportable document records themselves, never a
// second independent calculation from raw source rows).
// ─────────────────────────────────────────────────────────────────────────────

function sumDocuments(documents: Gstr1CreditNoteReportDocument[]): Gstr1CreditNoteBucketSummary {
  return documents.reduce(
    (acc, d) => ({
      documentCount: acc.documentCount + 1,
      taxableValue: round2(acc.taxableValue + d.taxableValue),
      igst: round2(acc.igst + d.igst),
      cgst: round2(acc.cgst + d.cgst),
      sgst: round2(acc.sgst + d.sgst),
      cess: round2(acc.cess + d.cess),
      noteValue: round2(acc.noteValue + d.noteValue),
    }),
    { documentCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, noteValue: 0 },
  );
}

function bucketFor(documents: Gstr1CreditNoteReportDocument[]): Gstr1CreditNoteBucket {
  const sorted = [...documents].sort((a, b) => a.creditNoteNumber.localeCompare(b.creditNoteNumber));
  return { documents: sorted, summary: sumDocuments(sorted) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates already-loaded, already-authorized CreditNote source documents into GSTR-1 Table 9B's
 * CDNR / CDNUR (B2CL; export left an empty placeholder — rule 11), per the FROZEN G2g-3d-1
 * normalizer's own output (unreproduced, unmodified). Pure and side-effect free: no Prisma, no
 * Date.now(), no randomness — same input always produces the same output. Never itself nets
 * against the B2B/B2CL/B2CS outward-supply buckets G2g-3c produces (rule 13) — a B2CS-original
 * Credit Note is instead handed on, unnetted, via `b2csNetOff` (Phase A) for
 * gstr1OutwardAggregation.ts to net; every other bucket here remains a wholly separate report this
 * module never reads or writes.
 *
 * Filtering order per source document (mirrors gstr1OutwardAggregation.ts's own precedent —
 * "what a scoped query would already have applied" vs. "a genuine data-quality problem the frozen
 * normalizer itself must decide"):
 *   1. Duplicate id (rule 20) — a repeat of an id already processed in this call is skipped and
 *      recorded as a diagnostic; deduplicated deterministically by CreditNote id, first occurrence
 *      wins. Chosen over rejecting the whole call outright so one bad duplicate in a large batch
 *      doesn't blank an entire period's report — the same "surface, don't abort" posture every
 *      other diagnostic in this module family already takes.
 *   2. Registration scope (rule 6) — a PRESENT but different `sellerRegistrationId` is silently out
 *      of scope; a MISSING one proceeds to the normalizer, which reports MISSING_SELLER_REGISTRATION.
 *   3. Branch scope (rule 8) — same "present but disallowed = silently out of scope" logic, using
 *      the caller's own `branchAccess`/`branchId`.
 *   4. Period scope (rule 7) — a resolvable `creditNoteDate` outside `[from, to]` is silently out of
 *      scope. An unresolvable one is NOT assumed out of scope (that would be a guess); the frozen
 *      normalizer doesn't gate reportability on date validity at all, so it proceeds normally.
 *   5. `normalizeGstr1CreditNote()` (frozen, unchanged) — `reportable === false` becomes an
 *      `excluded` record carrying the normalizer's own exclusionReason/diagnostics/document
 *      verbatim (rule 5); `reportable === true` becomes one independent report document, routed to
 *      CDNR / CDNUR-B2CL / b2csNetOff (Phase A) by the normalizer's own `reportingTable` /
 *      `originalSupplyCategory` (rule 9/10) — never re-derived here.
 */
export function aggregateGstr1CreditNotes(
  sources: Gstr1CreditNoteAggregationSourceDocument[],
  options: Gstr1CreditNoteAggregationOptions,
): Gstr1CreditNoteAggregation {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1CreditNoteAggregationAccessError(
      'A single seller GST registration must be selected before aggregating GSTR-1 Credit Notes (rule 6) — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const cdnrDocuments: Gstr1CreditNoteReportDocument[] = [];
  const b2clDocuments: Gstr1CreditNoteReportDocument[] = [];
  const b2csNetOffDocuments: Gstr1CreditNoteReportDocument[] = [];
  const excluded: Gstr1CreditNoteExclusionRecord[] = [];
  const diagnostics: Gstr1CreditNoteAggregationDiagnostic[] = [];
  const seenIds = new Set<string>();

  let notesConsidered = 0;
  let notesExcludedByScope = 0;

  for (const source of sources) {
    if (seenIds.has(source.id)) {
      diagnostics.push({
        creditNoteId: source.id,
        creditNoteNumber: source.creditNoteNumber ?? null,
        reason: 'DUPLICATE_SOURCE_ID',
        detail: `CreditNote ${source.id} was supplied more than once to this aggregation call — only the first occurrence is counted (rule 20); it is never double-counted.`,
      });
      continue;
    }
    seenIds.add(source.id);

    const sourceRegistrationId = source.sellerRegistrationId?.trim();
    if (sourceRegistrationId && sourceRegistrationId !== gstRegistrationId) {
      notesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!source.branchId || !allowedBranchIds.includes(source.branchId))) {
      notesExcludedByScope++;
      continue;
    }

    const creditNoteDate = source.creditNoteDate instanceof Date && !Number.isNaN(source.creditNoteDate.getTime())
      ? source.creditNoteDate
      : null;
    if (creditNoteDate && (creditNoteDate < from || creditNoteDate > to)) {
      notesExcludedByScope++;
      continue;
    }

    notesConsidered++;

    const normalized = normalizeGstr1CreditNote(source);

    if (!normalized.reportable) {
      excluded.push({
        creditNoteId: normalized.document.creditNoteId,
        creditNoteNumber: normalized.document.creditNoteNumber,
        creditNoteDate: normalized.document.creditNoteDate,
        exclusionReason: normalized.exclusionReason!,
        diagnostics: normalized.diagnostics,
        document: normalized.document,
      });
      continue;
    }

    const document = toReportDocument(normalized);

    if (normalized.document.reportingTable === 'CDNR') {
      cdnrDocuments.push(document);
    } else if (normalized.document.reportingTable === 'CDNUR') {
      if (normalized.document.originalSupplyCategory === 'B2CL') {
        b2clDocuments.push(document);
      } else if (normalized.document.originalSupplyCategory === 'B2CS') {
        // Phase A: never a "CDNUR B2CS" line item — nets against Table 7 B2CS instead (see this
        // file's own header and gstr1OutwardAggregation.ts).
        b2csNetOffDocuments.push(document);
      } else {
        // Defensive only — unreachable in practice: a reportable CDNUR document always carries a
        // B2CL/B2CS originalSupplyCategory, because the frozen normalizer itself excludes the
        // UNCLASSIFIED combination as ORIGINAL_SUPPLY_UNCLASSIFIED before reportable can be true.
        // Never fabricate a bucket placement — surface it instead (same "never silently drop a
        // record" posture as every other diagnostic here).
        diagnostics.push({
          creditNoteId: document.creditNoteId,
          creditNoteNumber: document.creditNoteNumber,
          reason: 'UNREACHABLE_CLASSIFICATION',
          detail: 'Reportable CDNUR document carried an unclassified original supply category — should be unreachable; not placed in any CDNUR sub-bucket.',
        });
      }
    } else {
      // Defensive only — unreachable in practice: reportingTable === 'UNCLASSIFIED' always implies
      // recipientType === 'UNCLASSIFIED', which the frozen normalizer always excludes as
      // INVALID_RECIPIENT_GSTIN before reportable can be true.
      diagnostics.push({
        creditNoteId: document.creditNoteId,
        creditNoteNumber: document.creditNoteNumber,
        reason: 'UNREACHABLE_CLASSIFICATION',
        detail: 'Reportable document carried an unclassified reporting table — should be unreachable; not placed in CDNR or CDNUR.',
      });
    }
  }

  return {
    cdnr: bucketFor(cdnrDocuments),
    cdnur: {
      b2cl: bucketFor(b2clDocuments),
      // Rule 11/18: always empty — export support is explicitly out of scope for G2g-3d-2.
      export: bucketFor([]),
    },
    // Phase A: B2CS-original Credit Notes, net-off candidates for Table 7 — never a CDNUR bucket.
    b2csNetOff: bucketFor(b2csNetOffDocuments),
    diagnostics,
    excluded,
    meta: { gstRegistrationId, period: { from, to }, notesConsidered, notesExcludedByScope },
  };
}
