// G2g-7c — GSTR-3B Table 4(A)(5) ITC Pure Aggregation Engine.
// Pure, deterministic, side-effect free: no Prisma, no Date.now(), no HTTP imports.
// Classifies and nets domestic normal inward tax lines (GRN intake, Purchase Returns, standalone
// Debit Notes) into eligible / unresolved / ineligible buckets for Table 4(A)(5) "All other ITC".
//
// NOT a complete GSTR-3B Table 4 implementation — see gstr3bItc.types.ts's header and
// PHASE_G2G7C_IMPLEMENTATION.md for exactly what this phase covers and what it explicitly defers
// (imports 4(A)(1)/(2), RCM 4(A)(3), ISD 4(A)(4), Rule 42/43 reversals, the 180-day reversal
// engine, GSTR-2B ingestion/reconciliation, and GSTR-3B filing).

import type {
  Gstr3bItcSourceGrnLine,
  Gstr3bItcSourcePurchaseReturnLine,
  Gstr3bItcSourceStandaloneDebitNoteLine,
  Gstr3bItcAggregationOptions,
  Gstr3bItcAggregationResult,
  Gstr3bItcDiagnostic,
  Gstr3bItcMoneyTotals,
  Gstr3bItcStatus,
  Gstr3bItcEligibilityMatrixEntry,
} from './gstr3bItc.types';
import { classifyInwardTaxLine } from './gstr3bItcEligibility';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class Gstr3bItcAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr3bItcAggregationError';
  }
}

function emptyTotals(): Gstr3bItcMoneyTotals {
  return { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}

function addInto(bucket: Gstr3bItcMoneyTotals, sign: 1 | -1, taxable: number, cgst: number, sgst: number, igst: number, cess: number) {
  bucket.taxableValue = round2(bucket.taxableValue + sign * taxable);
  bucket.cgst = round2(bucket.cgst + sign * cgst);
  bucket.sgst = round2(bucket.sgst + sign * sgst);
  bucket.igst = round2(bucket.igst + sign * igst);
  bucket.cess = round2(bucket.cess + sign * cess);
}

function bucketFor(buckets: { eligible: Gstr3bItcMoneyTotals; unresolved: Gstr3bItcMoneyTotals; ineligible: Gstr3bItcMoneyTotals }, status: Gstr3bItcStatus) {
  if (status === 'ELIGIBLE') return buckets.eligible;
  if (status === 'INELIGIBLE') return buckets.ineligible;
  return buckets.unresolved;
}

function resolveAllowedBranchIds(
  branchAccess: Gstr3bItcAggregationOptions['branchAccess'],
  branchId: string | null | undefined,
): string[] | undefined {
  if (branchId?.trim()) return [branchId.trim()];
  if (branchAccess && !branchAccess.allBranches) return branchAccess.branchIds;
  return undefined;
}

// Fixed report-level eligibility matrix (brief §26.C) — what this phase's data model can and
// cannot determine. Identical for every call (no per-company variance), so it is a constant, not
// computed from the input rows.
function buildEligibilityMatrix(): Gstr3bItcEligibilityMatrixEntry[] {
  return [
    { condition: 'Buyer GST registration', status: 'DETERMINABLE', note: 'GrnItem.buyerRegistrationId (G2g-7a) — null is reported UNRESOLVED, never defaulted to the primary registration.' },
    { condition: 'Supplier GSTIN', status: 'DETERMINABLE', note: 'Full structural + checksum validation via shared/gstin.ts. Composition-scheme suppliers (Supplier.isComposition) are classified INELIGIBLE outright.' },
    { condition: 'Domestic / non-RCM / non-import / non-ISD', status: 'DETERMINABLE', note: 'True by construction — this engine only ever loads GoodsReceiptNote/GrnItem/PurchaseReturn/DebitNote rows, none of which this codebase has an RCM/import/ISD representation for (deferred to G2g-7d).' },
    { condition: 'Tax category', status: 'DETERMINABLE', note: 'PoItem.taxCategory (G2g-7a), read via the relation — GrnItem itself carries no snapshot of its own; a pre-G2g-7a line (null) is UNRESOLVED.' },
    { condition: 'Place of supply / state restriction', status: 'NOT_DETERMINABLE', note: 'No distinct place-of-supply field exists for an inward supply — supplier-state-vs-company-state only drives the CGST/SGST-vs-IGST split, not a PoS-based ITC restriction. See POS_NOT_DETERMINABLE.' },
    { condition: 'Section 16(4) time limit', status: 'NOT_DETERMINABLE', note: 'No tracked GSTR-3B filing date per return period, and no annual-return filing date — the statutory deadline cannot be computed without them. See SECTION_16_4_NOT_DETERMINABLE.' },
    { condition: 'Section 17(5) blocked credits', status: 'NOT_DETERMINABLE', note: 'No transaction-purpose/asset-class semantics (motor vehicle, employee benefit, construction, etc.) exist in the procurement data model beyond the composition/tax-category signals already captured. See SECTION_17_5_NOT_DETERMINABLE.' },
    { condition: '180-day payment condition', status: 'NOT_DETERMINABLE', note: 'SupplierPayment is an account-level balance payment, not linked to a specific bill/GRN — there is no reliable way to tell whether THIS line\'s share of a bill was paid within 180 days. See ITC_180_DAY_STATUS_UNAVAILABLE.' },
    { condition: 'GSTR-2B availability', status: 'NOT_DETERMINABLE', note: 'No GSTR-2B ingestion exists (deferred to G2g-7e) — this report reflects TRIVO\'s own books only, not reconciled against the supplier-reported GSTR-2B. See GSTR_2B_RECONCILIATION_UNAVAILABLE.' },
  ];
}

export function aggregateGstr3bInwardItc(
  grnLines: Gstr3bItcSourceGrnLine[],
  purchaseReturnLines: Gstr3bItcSourcePurchaseReturnLine[],
  standaloneDebitNoteLines: Gstr3bItcSourceStandaloneDebitNoteLine[],
  options: Gstr3bItcAggregationOptions,
): Gstr3bItcAggregationResult {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr3bItcAggregationError('A single buyer GST registration ID is required before aggregating GSTR-3B inward ITC.');
  }

  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const diagnostics: Gstr3bItcDiagnostic[] = [];

  const isBranchRestricted = !!options.branchId || (options.branchAccess && !options.branchAccess.allBranches);
  const isCompleteGstinScope = !isBranchRestricted;
  const partialScopeReason = isBranchRestricted ? 'PARTIAL_BRANCH_SCOPE' : null;
  if (isBranchRestricted) {
    diagnostics.push({
      code: 'PARTIAL_BRANCH_SCOPE',
      documentType: 'REPORT_SCOPE',
      reason: `Report scope is restricted to branch ${options.branchId ?? 'subset'} and does not constitute a complete GSTIN-wide statutory GSTR-3B ITC figure.`,
    });
  }

  const eligible = emptyTotals();
  const unresolved = emptyTotals();
  const ineligible = emptyTotals();
  const buckets = { eligible, unresolved, ineligible };

  let grnLinesConsidered = 0, grnLinesExcludedByScope = 0;
  let purchaseReturnLinesConsidered = 0, purchaseReturnLinesExcludedByScope = 0;
  let standaloneDebitNoteLinesConsidered = 0, standaloneDebitNoteLinesExcludedByScope = 0;

  const documentIds = new Set<string>();
  const supplierIds = new Set<string>();
  let lineCount = 0;

  // GrnItem id -> its own classification, so a later Purchase Return line that reverses it nets
  // into the exact same bucket its parent went into (never re-derived independently).
  const grnLineClassification = new Map<string, { status: Gstr3bItcStatus; grnId: string }>();

  // ─── 1. GRN intake lines (positive) ───────────────────────────────────────
  for (const line of grnLines) {
    if (allowedBranchIds && (!line.branchId || !allowedBranchIds.includes(line.branchId))) {
      grnLinesExcludedByScope++;
      continue;
    }
    if (line.receivedDate < from || line.receivedDate > to) {
      grnLinesExcludedByScope++;
      continue;
    }

    const classification = classifyInwardTaxLine(line.facts, gstRegistrationId);
    if (classification.scope === 'EXCLUDED_OTHER_REGISTRATION') {
      grnLinesExcludedByScope++;
      continue;
    }

    grnLinesConsidered++;
    lineCount++;
    documentIds.add(`GRN:${line.grnId}`);
    supplierIds.add(line.supplierId);
    grnLineClassification.set(line.id, { status: classification.status, grnId: line.grnId });

    addInto(bucketFor(buckets, classification.status), 1, line.taxableValue, line.cgst, line.sgst, line.igst, line.cess);

    if (classification.diagnosticCode) {
      diagnostics.push({
        code: classification.diagnosticCode,
        documentType: 'GRN_LINE',
        documentId: line.id,
        documentNumber: line.grnNumber,
        reason: classification.reason ?? '',
      });
    }
  }

  // ─── 2. Purchase Returns (negative — nets into the SAME bucket as the GRN line it reverses) ──
  for (const ret of purchaseReturnLines) {
    if (allowedBranchIds && (!ret.branchId || !allowedBranchIds.includes(ret.branchId))) {
      purchaseReturnLinesExcludedByScope++;
      continue;
    }
    if (ret.returnDate < from || ret.returnDate > to) {
      purchaseReturnLinesExcludedByScope++;
      continue;
    }

    // Prefer the parent GrnItem's own already-computed classification (it was already resolved
    // in-scope above, in the identical period/branch context) — falls back to re-classifying the
    // return's own facts only when the parent line falls outside this report's loaded set (e.g. a
    // GRN received in an earlier period, returned in this one — still a real, in-scope reversal).
    const parent = grnLineClassification.get(ret.sourceGrnLineId);
    const classification = parent
      ? { scope: 'IN_SCOPE' as const, status: parent.status, diagnosticCode: null, reason: null }
      : classifyInwardTaxLine(ret.facts, gstRegistrationId);

    if (classification.scope === 'EXCLUDED_OTHER_REGISTRATION') {
      purchaseReturnLinesExcludedByScope++;
      continue;
    }

    purchaseReturnLinesConsidered++;
    lineCount++;
    documentIds.add(`PRET:${ret.returnId}`);

    addInto(bucketFor(buckets, classification.status), -1, ret.amount, ret.cgst, ret.sgst, ret.igst, ret.cess);

    if (!parent && classification.diagnosticCode) {
      diagnostics.push({
        code: classification.diagnosticCode,
        documentType: 'PURCHASE_RETURN',
        documentId: ret.id,
        documentNumber: ret.returnNumber,
        reason: classification.reason ?? '',
      });
    }
  }

  // ─── 3. Standalone (Path B) Debit Notes (negative) — Path A is never loaded by the caller;
  // its ITC effect is already represented by the Purchase Return it wraps (same convention as
  // getPurchaseGstSummary — never double-count the same rupee). ──────────────────────────────
  for (const dn of standaloneDebitNoteLines) {
    if (allowedBranchIds && (!dn.branchId || !allowedBranchIds.includes(dn.branchId))) {
      standaloneDebitNoteLinesExcludedByScope++;
      continue;
    }
    if (dn.debitNoteDate < from || dn.debitNoteDate > to) {
      standaloneDebitNoteLinesExcludedByScope++;
      continue;
    }

    const classification = classifyInwardTaxLine(dn.facts, gstRegistrationId);
    if (classification.scope === 'EXCLUDED_OTHER_REGISTRATION') {
      standaloneDebitNoteLinesExcludedByScope++;
      continue;
    }

    standaloneDebitNoteLinesConsidered++;
    lineCount++;
    documentIds.add(`DN:${dn.debitNoteId}`);

    addInto(bucketFor(buckets, classification.status), -1, dn.taxableValue, dn.cgst, dn.sgst, dn.igst, dn.cess);

    if (classification.diagnosticCode) {
      diagnostics.push({
        code: classification.diagnosticCode,
        documentType: 'STANDALONE_DEBIT_NOTE',
        documentId: dn.id,
        documentNumber: dn.debitNoteNumber,
        reason: classification.reason ?? '',
      });
    }
  }

  // ─── Negative-net diagnostics (returns/debit-notes in this period exceeding this period's own
  // gross in the same bucket — a legitimate GST scenario, e.g. returning a prior month's purchase,
  // not an error, but worth flagging). ────────────────────────────────────────────────────────
  for (const [label, bucket] of [['eligible', eligible], ['unresolved', unresolved], ['ineligible', ineligible]] as const) {
    if (bucket.taxableValue < 0 || bucket.cgst < 0 || bucket.sgst < 0 || bucket.igst < 0 || bucket.cess < 0) {
      diagnostics.push({
        code: 'NEGATIVE_NET_ITC',
        documentType: 'REPORT_SCOPE',
        reason: `The "${label}" bucket is negative — returns/debit notes recorded in this period reduce it below zero, most likely because they reverse a purchase booked in an earlier period.`,
        amountDetails: { taxableValue: bucket.taxableValue, cgst: bucket.cgst, sgst: bucket.sgst, igst: bucket.igst, cess: bucket.cess },
      });
    }
  }

  // ─── Report-level capability-gap diagnostics (emitted once, never per line) ──────────────────
  diagnostics.push(
    { code: 'POS_NOT_DETERMINABLE', documentType: 'REPORT_SCOPE', reason: 'Place-of-supply-based ITC restriction cannot be determined from current inward data — see the eligibility matrix.' },
    { code: 'SECTION_16_4_NOT_DETERMINABLE', documentType: 'REPORT_SCOPE', reason: 'Section 16(4) time-limit compliance cannot be determined — no tracked GSTR-3B filing date or annual-return date exists in this system yet.' },
    { code: 'SECTION_17_5_NOT_DETERMINABLE', documentType: 'REPORT_SCOPE', reason: 'Section 17(5) blocked-credit categories cannot be reliably inferred from current transaction data beyond composition/tax-category.' },
    { code: 'ITC_180_DAY_STATUS_UNAVAILABLE', documentType: 'REPORT_SCOPE', reason: 'The 180-day non-payment reversal condition cannot be evaluated — SupplierPayment is account-level, not linked to a specific bill.' },
    { code: 'GSTR_2B_RECONCILIATION_UNAVAILABLE', documentType: 'REPORT_SCOPE', reason: 'This report reflects TRIVO\'s own books only — no GSTR-2B ingestion/reconciliation exists yet (deferred to G2g-7e).' },
  );

  return {
    meta: {
      companyId: options.companyId,
      gstRegistrationId,
      buyerGstin: options.buyerGstin,
      buyerStateCode: options.buyerStateCode,
      financialYear: options.period.financialYear,
      taxPeriod: options.period.taxPeriod,
      period: { from: options.period.from, to: options.period.to },
      isCompleteGstinScope,
      partialScopeReason,
      calculationVersion: 'g2g7c-v1',
      supplierCount: supplierIds.size,
      sourceCounts: {
        grnLinesConsidered,
        grnLinesExcludedByScope,
        purchaseReturnLinesConsidered,
        purchaseReturnLinesExcludedByScope,
        standaloneDebitNoteLinesConsidered,
        standaloneDebitNoteLinesExcludedByScope,
      },
    },
    table4A5: {
      status: 'IMPLEMENTED',
      eligible,
      unresolved,
      ineligible,
      documentCount: documentIds.size,
      lineCount,
    },
    eligibilityMatrix: buildEligibilityMatrix(),
    diagnostics,
  };
}
