// G2g-3f — GSTR-1 Table 12 HSN-wise Summary aggregation (official GST terminology: "Table 12 — B2B
// Supplies" and "Table 12 — B2C Supplies", never "12A"/"12B"). Pure, deterministic, no Prisma access:
// takes already-loaded outward-supply invoices and formal Credit Notes (the caller's job to fetch,
// scoped to one company, via tenantQuery — see shared/tenantContext.ts) and produces one HSN+UQC+
// GST-rate row per reporting tab (B2B Supplies / B2C Supplies).
//
// Mirrors gstr1OutwardAggregation.ts's / gstr1CreditNoteAggregation.ts's own architecture exactly:
// caller/service -> already-authorized source documents -> FROZEN classifier/normalizers -> this
// pure aggregator -> report result. No Prisma inside this file, no database access, no hidden
// network calls, same input always produces the same output.
//
// Consumes, unmodified:
//   - gstr1Normalizer.ts (G2g-3b, frozen) — normalizeInvoiceItemLine() for per-line HSN/UQC/
//     quantity/tax; GstReportingLine as the common per-line shape.
//   - gstr1Classification.ts (G2g-3c, frozen) — classifyGstr1OutwardSupply() decides ONE outward
//     invoice's B2B/B2CL/B2CS/UNCLASSIFIED outcome; B2B -> "B2B Supplies", B2CL/B2CS -> "B2C
//     Supplies" (per the G2g-3f brief section 3), UNCLASSIFIED -> diagnostic, excluded.
//   - gstr1CreditNoteNormalizer.ts (G2g-3d-1, frozen) — normalizeGstr1CreditNote() for ONE formal
//     Credit Note: reportability, Path A/Path B, and the ORIGINAL outward supply's own B2B/B2CL/
//     B2CS category (never the Credit Note's own value/date — see that module's own doc).
// Also reuses, unmodified, the two frozen aggregators' own INPUT CONTRACTS (never a parallel shape):
//   - Gstr1OutwardSourceInvoice (gstr1OutwardAggregation.ts)
//   - Gstr1CreditNoteAggregationSourceDocument (gstr1CreditNoteAggregation.ts)
// This module reproduces none of those modules' rules — it only groups their output into Table 12's
// own HSN+UQC+rate reporting key, per the brief's section 5.
//
// Deliberately NOT consulted: SalesReturn. A SalesReturn is never independently subtracted from
// Table 12 (brief section 7) — only the formal Credit Note representing the statutory reduction is
// considered (a Path A Credit Note's own normalized line already carries the returned item's real
// physical quantity/value; the underlying SalesReturn is not a separate reporting document here,
// exactly as gstr1CreditNoteNormalizer.ts's own module header already establishes for CDNR/CDNUR).
//
// Money follows this codebase's established convention (see gstr1OutwardAggregation.ts's own
// header): plain `number`, Prisma Decimal already unwrapped by the caller — no decimal.js anywhere
// in this codebase. Every running sum goes through round2() at each accumulation step (same pattern
// the two frozen aggregators already use) to keep paise-level drift from compounding.

import {
  type GstReportingLine,
  type InvoiceGstContext,
  normalizeInvoiceItemLine,
} from './gstr1Normalizer';
import {
  classifyGstr1OutwardSupply,
  UNCLASSIFIED,
} from './gstr1Classification';
import { normalizeGstr1CreditNote } from './gstr1CreditNoteNormalizer';
import type { Gstr1OutwardSourceInvoice } from './gstr1OutwardAggregation';
import type { Gstr1CreditNoteAggregationSourceDocument } from './gstr1CreditNoteAggregation';
import type { BranchAccess } from '../../../shared/tenantContext';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Raised only for an authorization refusal (an explicitly requested branch this caller cannot
 *  access, or a missing required registration selection) — never for a data-quality problem, which
 *  is always a diagnostic row instead. Mirrors Gstr1OutwardAggregationAccessError /
 *  Gstr1CreditNoteAggregationAccessError exactly; kept as its own class (not reused) so this module
 *  stays fully self-contained, same precedent as the credit-note aggregator's own note on why it
 *  didn't import the outward aggregator's error class either. */
export class Gstr1Table12AggregationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr1Table12AggregationAccessError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Options — identical shape/contract to the two frozen aggregators' own options.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1Table12AggregationOptions {
  /** A single selected seller GST registration — required, never defaulted. Only a source document
   *  whose OWN `sellerRegistrationId` (present) matches this id is eligible; a present-but-different
   *  id is silently out of scope (matches a WHERE clause); a MISSING one is not assumed out of scope
   *  — it proceeds to classification/normalization, which report it as a diagnostic instead. */
  gstRegistrationId: string;
  /** Complete Asia/Kolkata calendar-day boundaries, already resolved by the caller via
   *  shared/istDate.ts — this module trusts the two Date instants as given and never re-derives IST
   *  semantics itself. Outward invoices are filtered on `invoiceDate`; Credit Notes on their OWN
   *  `creditNoteDate` (never the original invoice's date) — identical to each frozen aggregator's
   *  own period filter. */
  period: { from: Date; to: Date };
  /** Same branch-access contract every other G2g-2/G2g-3c/G2g-3d-2 report already uses. */
  branchAccess?: BranchAccess;
  /** A single explicitly requested branch. Verified against `branchAccess` and REJECTED (thrown,
   *  not silently dropped) when unauthorized. */
  branchId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output contract
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr1Table12ReportingTab = 'B2B_SUPPLIES' | 'B2C_SUPPLIES';

/** One HSN + UQC + GST-rate row within one reporting tab (brief section 5 — the aggregation key
 *  never includes place of supply, and never merges B2B with B2C, different rates, or different
 *  UQCs). `quantity`/`taxableValue`/`cgst`/`sgst`/`igst`/`cess` are the NET (gross outward minus
 *  formal-Credit-Note reduction) figures a filer actually reports; the gross/reduction breakdown is
 *  retained alongside for diagnostics/reconciliation (brief section 10), never thrown away. */
export interface Gstr1Table12Row {
  reportingTab: Gstr1Table12ReportingTab;
  hsnCode: string | null;
  /** The HSN master's own description (HsnCode.description), when available — read directly off
   *  the source row's joined HSN (never off GstReportingLine.description, which is the SALES line's
   *  own free-text description, not the HSN's). First non-null value seen for this bucket wins. */
  description: string | null;
  uqc: string | null;
  gstRate: number;

  quantity: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;

  grossQuantity: number;
  creditNoteQuantityReduction: number;
  grossTaxableValue: number;
  creditNoteTaxableReduction: number;
  grossCgst: number;
  creditNoteCgstReduction: number;
  grossSgst: number;
  creditNoteSgstReduction: number;
  grossIgst: number;
  creditNoteIgstReduction: number;
  grossCess: number;
  creditNoteCessReduction: number;

  /** false when this row carries a data-quality problem a real GSTR-1 filing could not accept as-is
   *  (missing/invalid HSN, unresolved UQC, or a negative net value) — see the row's own diagnostics
   *  for which. Never itself a reason to drop or clamp the row (brief section 11). */
  filingEligible: boolean;
  /** How many outward-supply lines fed this row's gross figures. */
  recordCount: number;
  /** How many Credit Note lines fed this row's reduction figures. */
  creditNoteRecordCount: number;
}

export type Gstr1Table12DiagnosticCode =
  | 'EXCLUDED_VOID'
  | 'UNCLASSIFIED_OUTWARD_SUPPLY'
  | 'CREDIT_NOTE_EXCLUDED'
  | 'ORIGINAL_SUPPLY_UNCLASSIFIED'
  | 'MISSING_HSN'
  | 'INVALID_HSN'
  | 'MISSING_UQC'
  | 'UNSUPPORTED_UQC'
  | 'QUANTITY_UNAVAILABLE'
  | 'NEGATIVE_NET_TABLE12_BUCKET';

/** One diagnostic — either about a whole source document (VOID/UNCLASSIFIED/excluded Credit Note)
 *  or about one row's own data quality (HSN/UQC/quantity/negative net). Always additive, never a
 *  silent drop: an excluded document/row still leaves a trace here (brief section 15). */
export interface Gstr1Table12Diagnostic {
  code: Gstr1Table12DiagnosticCode;
  reason: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  creditNoteId?: string;
  creditNoteNumber?: string | null;
  reportingTab?: Gstr1Table12ReportingTab;
  hsnCode?: string | null;
  gstRate?: number;
  uqc?: string | null;
}

export interface Gstr1Table12Aggregation {
  rows: Gstr1Table12Row[];
  diagnostics: Gstr1Table12Diagnostic[];
  summary: {
    b2bRows: number;
    b2cRows: number;
    diagnosticCount: number;
  };
  meta: {
    gstRegistrationId: string;
    period: { from: Date; to: Date };
    invoicesConsidered: number;
    invoicesExcludedByScope: number;
    creditNotesConsidered: number;
    creditNotesExcludedByScope: number;
    /** Brief section 13: TRIVO has no approved preceding-FY AATO configuration, so 4-digit/6-digit
     *  HSN filing-length compliance is never determined or asserted by this module — always this one
     *  constant, never inferred from current sales. */
    hsnDigitCompliance: 'NOT_DETERMINED';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch-access resolution — identical shape/behavior to the two frozen aggregators' own private
// resolveAllowedBranchIds (neither is exported, so this is a fresh, independent implementation of
// the same rule, not an import — same precedent gstr1CreditNoteAggregation.ts's own copy documents).
// ─────────────────────────────────────────────────────────────────────────────

function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | undefined): string[] | undefined {
  if (branchId) {
    if (branchAccess && !branchAccess.allBranches && !branchAccess.branchIds.includes(branchId)) {
      throw new Gstr1Table12AggregationAccessError(
        `Branch ${branchId} is not accessible to the caller — rejected outright rather than silently aggregating without it.`,
      );
    }
    return [branchId];
  }
  return branchAccess && !branchAccess.allBranches ? branchAccess.branchIds : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// HSN shape check (rule 12: "invalid/unusable HSN -> diagnostic") — a conservative format check
// only (HSN codes are numeric, 4/6/8 digits under the current GST HSN scheme), never a lookup
// against a live/authoritative HSN master and never a statement about 4-digit-vs-6-digit AATO
// compliance (that is explicitly section 13's NOT_DETERMINED territory, not this check's job).
// ─────────────────────────────────────────────────────────────────────────────

const PLAUSIBLE_HSN_RE = /^\d{4,8}$/;

function isPlausibleHsnCode(code: string | null): boolean {
  return !!code && PLAUSIBLE_HSN_RE.test(code.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucketing (rule 5 — reportingTab + HSN + UQC + GST rate; never place of supply).
// ─────────────────────────────────────────────────────────────────────────────

function bucketKey(reportingTab: Gstr1Table12ReportingTab, hsnCode: string | null, uqc: string | null, gstRate: number): string {
  return `${reportingTab}\u0000${hsnCode ?? ''}\u0000${gstRate}\u0000${uqc ?? ''}`;
}

function newRow(reportingTab: Gstr1Table12ReportingTab, hsnCode: string | null, uqc: string | null, gstRate: number, description: string | null): Gstr1Table12Row {
  return {
    reportingTab, hsnCode, description, uqc, gstRate,
    quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
    grossQuantity: 0, creditNoteQuantityReduction: 0,
    grossTaxableValue: 0, creditNoteTaxableReduction: 0,
    grossCgst: 0, creditNoteCgstReduction: 0,
    grossSgst: 0, creditNoteSgstReduction: 0,
    grossIgst: 0, creditNoteIgstReduction: 0,
    grossCess: 0, creditNoteCessReduction: 0,
    filingEligible: true, recordCount: 0, creditNoteRecordCount: 0,
  };
}

function applyLineToBucket(
  buckets: Map<string, Gstr1Table12Row>,
  reportingTab: Gstr1Table12ReportingTab,
  line: GstReportingLine,
  direction: 'GROSS' | 'REDUCTION',
  hsnDescription: string | null,
): Gstr1Table12Row {
  const key = bucketKey(reportingTab, line.hsnCode, line.uqc, line.gstRate);
  let row = buckets.get(key);
  if (!row) {
    row = newRow(reportingTab, line.hsnCode, line.uqc, line.gstRate, hsnDescription);
    buckets.set(key, row);
  } else if (!row.description && hsnDescription) {
    row.description = hsnDescription;
  }

  if (direction === 'GROSS') {
    row.grossQuantity = round2(row.grossQuantity + line.quantity);
    row.grossTaxableValue = round2(row.grossTaxableValue + line.taxableValue);
    row.grossCgst = round2(row.grossCgst + line.cgstAmount);
    row.grossSgst = round2(row.grossSgst + line.sgstAmount);
    row.grossIgst = round2(row.grossIgst + line.igstAmount);
    row.grossCess = round2(row.grossCess + line.cessAmount);
    row.recordCount += 1;
  } else {
    row.creditNoteQuantityReduction = round2(row.creditNoteQuantityReduction + line.quantity);
    row.creditNoteTaxableReduction = round2(row.creditNoteTaxableReduction + line.taxableValue);
    row.creditNoteCgstReduction = round2(row.creditNoteCgstReduction + line.cgstAmount);
    row.creditNoteSgstReduction = round2(row.creditNoteSgstReduction + line.sgstAmount);
    row.creditNoteIgstReduction = round2(row.creditNoteIgstReduction + line.igstAmount);
    row.creditNoteCessReduction = round2(row.creditNoteCessReduction + line.cessAmount);
    row.creditNoteRecordCount += 1;
  }
  return row;
}

function collectLineDiagnostics(
  diagnostics: Gstr1Table12Diagnostic[],
  line: GstReportingLine,
  ref: { invoiceId?: string; invoiceNumber?: string | null; creditNoteId?: string; creditNoteNumber?: string | null },
  reportingTab: Gstr1Table12ReportingTab,
): void {
  if (!line.hsnCode) {
    diagnostics.push({
      code: 'MISSING_HSN',
      reason: 'Line has no HSN code — it cannot be safely placed in the Table 12 HSN summary; never invented.',
      reportingTab, gstRate: line.gstRate, uqc: line.uqc, ...ref,
    });
  } else if (!isPlausibleHsnCode(line.hsnCode)) {
    diagnostics.push({
      code: 'INVALID_HSN',
      reason: `HSN code "${line.hsnCode}" does not match the expected numeric 4/6/8-digit HSN shape.`,
      reportingTab, hsnCode: line.hsnCode, gstRate: line.gstRate, uqc: line.uqc, ...ref,
    });
  }

  if (line.uqcSource === 'NONE') {
    diagnostics.push({
      code: 'MISSING_UQC',
      reason: 'No UQC could be resolved for this line (neither persisted nor the HSN default) — required for Table 12 filing.',
      reportingTab, hsnCode: line.hsnCode, gstRate: line.gstRate, ...ref,
    });
  }

  if (line.quantityBasis === 'UNSUPPORTED_UQC') {
    diagnostics.push({
      code: 'UNSUPPORTED_UQC',
      reason: `No statutory-quantity rule exists for UQC "${line.uqc}" — quantity reported as 0, never fabricated.`,
      reportingTab, hsnCode: line.hsnCode, gstRate: line.gstRate, uqc: line.uqc, ...ref,
    });
  } else if (line.quantityBasis === 'UNAVAILABLE') {
    diagnostics.push({
      code: 'QUANTITY_UNAVAILABLE',
      reason: `UQC "${line.uqc}" requires a physical quantity the source data does not have — reported as 0, never fabricated.`,
      reportingTab, hsnCode: line.hsnCode, gstRate: line.gstRate, uqc: line.uqc, ...ref,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates already-loaded, already-authorized outward-supply invoices and formal Credit Notes into
 * GSTR-1 Table 12's B2B Supplies / B2C Supplies HSN summary. Pure and side-effect free: no Prisma, no
 * Date.now(), no randomness — same input always produces the same output.
 *
 * Filtering order per outward invoice (identical to gstr1OutwardAggregation.ts's own precedent):
 *   1. Registration scope — a PRESENT but different `sellerRegistrationId` is silently out of scope;
 *      a MISSING one proceeds to classification, which reports it as an UNCLASSIFIED diagnostic.
 *   2. Branch scope — same "present but disallowed = silently out of scope" logic.
 *   3. Period scope — a resolvable `invoiceDate` outside [from, to] is silently out of scope; an
 *      unresolvable one is not assumed out of scope.
 *   4. VOID -> diagnostic, excluded.
 *   5. classifyGstr1OutwardSupply() (frozen) -> UNCLASSIFIED becomes a diagnostic; B2B/B2CL/B2CS
 *      proceed to per-line normalization and bucketing (B2B -> B2B_SUPPLIES, B2CL/B2CS ->
 *      B2C_SUPPLIES).
 *
 * Filtering order per Credit Note (identical to gstr1CreditNoteAggregation.ts's own precedent):
 *   1. Registration scope, 2. branch scope, 3. period scope (on the Credit Note's OWN date) — same
 *      "silently out of scope" semantics as above.
 *   4. normalizeGstr1CreditNote() (frozen) -> `reportable === false` becomes a CREDIT_NOTE_EXCLUDED
 *      diagnostic; `reportable === true` reduces the bucket matching its ORIGINAL outward supply's
 *      own category (B2B -> B2B_SUPPLIES, B2CL/B2CS -> B2C_SUPPLIES) — never the Credit Note's own
 *      value/date, never a second independent SalesReturn reduction (brief section 7).
 */
export function aggregateGstr1Table12(
  outwardSources: Gstr1OutwardSourceInvoice[],
  creditNoteSources: Gstr1CreditNoteAggregationSourceDocument[],
  options: Gstr1Table12AggregationOptions,
): Gstr1Table12Aggregation {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1Table12AggregationAccessError(
      'A single seller GST registration must be selected before aggregating GSTR-1 Table 12 — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const buckets = new Map<string, Gstr1Table12Row>();
  const diagnostics: Gstr1Table12Diagnostic[] = [];

  let invoicesConsidered = 0;
  let invoicesExcludedByScope = 0;
  let creditNotesConsidered = 0;
  let creditNotesExcludedByScope = 0;

  // ── Outward supplies ──────────────────────────────────────────────────────
  for (const inv of outwardSources) {
    const invSellerRegistrationId = inv.sellerRegistrationId?.trim();
    if (invSellerRegistrationId && invSellerRegistrationId !== gstRegistrationId) {
      invoicesExcludedByScope++;
      continue;
    }
    if (allowedBranchIds && (!inv.branchId || !allowedBranchIds.includes(inv.branchId))) {
      invoicesExcludedByScope++;
      continue;
    }
    const invoiceDate = inv.invoiceDate instanceof Date && !Number.isNaN(inv.invoiceDate.getTime()) ? inv.invoiceDate : null;
    if (invoiceDate && (invoiceDate < from || invoiceDate > to)) {
      invoicesExcludedByScope++;
      continue;
    }

    invoicesConsidered++;

    if (inv.status === 'VOID') {
      diagnostics.push({
        code: 'EXCLUDED_VOID',
        reason: 'VOID invoice excluded from Table 12 — never counted as a live outward supply.',
        invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber ?? null,
      });
      continue;
    }

    const classification = classifyGstr1OutwardSupply({
      buyerGstin: inv.buyerGstin,
      sellerStateCode: inv.sellerStateCode,
      sellerRegistrationId: inv.sellerRegistrationId,
      placeOfSupply: inv.placeOfSupply,
      invoiceValue: inv.totalAmount,
      invoiceDate,
    });

    if (classification.category === UNCLASSIFIED) {
      diagnostics.push({
        code: 'UNCLASSIFIED_OUTWARD_SUPPLY',
        reason: classification.reason,
        invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber ?? null,
      });
      continue;
    }

    const reportingTab: Gstr1Table12ReportingTab = classification.category === 'B2B' ? 'B2B_SUPPLIES' : 'B2C_SUPPLIES';

    const ctx: InvoiceGstContext = {
      invoiceNumber: inv.invoiceNumber,
      invoiceDate,
      invoiceStatus: inv.status,
      buyerGstin: inv.buyerGstin ?? null,
      placeOfSupply: inv.placeOfSupply ?? null,
      sellerRegistrationId: inv.sellerRegistrationId ?? null,
      reverseCharge: inv.reverseCharge ?? null,
    };

    for (const item of inv.items) {
      const line = normalizeInvoiceItemLine(item, ctx);
      applyLineToBucket(buckets, reportingTab, line, 'GROSS', item.hsnCode?.description ?? null);
      collectLineDiagnostics(diagnostics, line, { invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber }, reportingTab);
    }
  }

  // ── Formal Credit Notes ───────────────────────────────────────────────────
  for (const source of creditNoteSources) {
    const sourceRegistrationId = source.sellerRegistrationId?.trim();
    if (sourceRegistrationId && sourceRegistrationId !== gstRegistrationId) {
      creditNotesExcludedByScope++;
      continue;
    }
    if (allowedBranchIds && (!source.branchId || !allowedBranchIds.includes(source.branchId))) {
      creditNotesExcludedByScope++;
      continue;
    }
    const creditNoteDate = source.creditNoteDate instanceof Date && !Number.isNaN(source.creditNoteDate.getTime())
      ? source.creditNoteDate
      : null;
    if (creditNoteDate && (creditNoteDate < from || creditNoteDate > to)) {
      creditNotesExcludedByScope++;
      continue;
    }

    creditNotesConsidered++;

    const normalized = normalizeGstr1CreditNote(source);

    if (!normalized.reportable) {
      diagnostics.push({
        code: 'CREDIT_NOTE_EXCLUDED',
        reason: `Credit note excluded from Table 12 (${normalized.exclusionReason}) — see its own GSTR-1 diagnostics for detail; never silently dropped.`,
        creditNoteId: normalized.document.creditNoteId, creditNoteNumber: normalized.document.creditNoteNumber,
      });
      continue;
    }

    const originalCategory = normalized.document.originalSupplyCategory;
    const reportingTab: Gstr1Table12ReportingTab | null =
      originalCategory === 'B2B' ? 'B2B_SUPPLIES'
        : (originalCategory === 'B2CL' || originalCategory === 'B2CS') ? 'B2C_SUPPLIES'
          : null;

    if (!reportingTab) {
      // Defensive only — unreachable in practice: a reportable Credit Note's original supply is
      // always B2B/B2CL/B2CS, because the frozen normalizer excludes UNCLASSIFIED as
      // ORIGINAL_SUPPLY_UNCLASSIFIED before reportable can be true. Never fabricate a tab placement.
      diagnostics.push({
        code: 'ORIGINAL_SUPPLY_UNCLASSIFIED',
        reason: 'Reportable credit note carried an unclassified original supply category — should be unreachable; excluded from Table 12.',
        creditNoteId: normalized.document.creditNoteId, creditNoteNumber: normalized.document.creditNoteNumber,
      });
      continue;
    }

    normalized.lines.forEach((line, idx) => {
      const hsnDescription = source.items[idx]?.hsnCode?.description ?? null;
      applyLineToBucket(buckets, reportingTab, line, 'REDUCTION', hsnDescription);
      collectLineDiagnostics(
        diagnostics, line,
        { creditNoteId: normalized.document.creditNoteId, creditNoteNumber: normalized.document.creditNoteNumber },
        reportingTab,
      );
    });
  }

  // ── Finalize: net = gross - reduction, never clamped (brief section 11) ──
  for (const row of buckets.values()) {
    row.quantity = round2(row.grossQuantity - row.creditNoteQuantityReduction);
    row.taxableValue = round2(row.grossTaxableValue - row.creditNoteTaxableReduction);
    row.cgst = round2(row.grossCgst - row.creditNoteCgstReduction);
    row.sgst = round2(row.grossSgst - row.creditNoteSgstReduction);
    row.igst = round2(row.grossIgst - row.creditNoteIgstReduction);
    row.cess = round2(row.grossCess - row.creditNoteCessReduction);

    const hasNegativeNet = row.quantity < 0 || row.taxableValue < 0 || row.cgst < 0 || row.sgst < 0 || row.igst < 0 || row.cess < 0;
    if (hasNegativeNet) {
      diagnostics.push({
        code: 'NEGATIVE_NET_TABLE12_BUCKET',
        reason: `Row ${row.reportingTab}/HSN ${row.hsnCode ?? '(missing)'}/rate ${row.gstRate}/UQC ${row.uqc ?? '(none)'} has a negative net value after Credit Note reductions — retained exactly as computed, never clamped or hidden.`,
        reportingTab: row.reportingTab, hsnCode: row.hsnCode, gstRate: row.gstRate, uqc: row.uqc,
      });
      row.filingEligible = false;
    }

    if (!isPlausibleHsnCode(row.hsnCode) || !row.uqc) {
      row.filingEligible = false;
    }
  }

  const rows = Array.from(buckets.values()).sort(
    (a, b) => a.reportingTab.localeCompare(b.reportingTab)
      || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '')
      || a.gstRate - b.gstRate
      || (a.uqc ?? '').localeCompare(b.uqc ?? ''),
  );

  return {
    rows,
    diagnostics,
    summary: {
      b2bRows: rows.filter((r) => r.reportingTab === 'B2B_SUPPLIES').length,
      b2cRows: rows.filter((r) => r.reportingTab === 'B2C_SUPPLIES').length,
      diagnosticCount: diagnostics.length,
    },
    meta: {
      gstRegistrationId, period: { from, to },
      invoicesConsidered, invoicesExcludedByScope,
      creditNotesConsidered, creditNotesExcludedByScope,
      hsnDigitCompliance: 'NOT_DETERMINED',
    },
  };
}
