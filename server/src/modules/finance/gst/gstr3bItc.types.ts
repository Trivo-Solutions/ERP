// G2g-7c — GSTR-3B Table 4(A)(5) ITC Foundation & Eligibility Engine. Data contracts.
// Parallel to (and deliberately modeled on) gstr3bOutward.types.ts — same meta/diagnostic shape,
// mirrored for the inward side — but this is NOT a complete GST ITC implementation. See the
// eligibility engine's own header comment for the statutory scope this phase actually covers.
//
// Statutory references:
// - CBIC Circular No. 170/02/2022-GST (Table 4 reporting; Table 4(A) auto-populates from GSTR-2B,
//   reversals go in Table 4(B))
// - CGST Act Section 16(2) second proviso + CGST Rules Rule 37 (180-day non-payment reversal)
// - CGST Act Section 16(4) (time limit on availment), as amended by Section 16(5)/(6)
//   (Finance (No. 2) Act, 2024 — retrospective relief for FY 2017-18 to 2020-21 only)
// - CGST Act Section 17(5) (blocked credits) and Section 17(1)/(2) with Rules 42/43 (common-credit
//   attribution/reversal for exempt or non-business use)
// - CGST Act Section 10 (Composition Scheme — a composition supplier's bill carries no GST a buyer
//   can claim as ITC)

import type { BranchAccess } from '../../../shared/tenantContext';

// ─────────────────────────────────────────────────────────────────────────────
// Per-line classification (pure, no Prisma) — see gstr3bItcEligibility.ts
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bItcStatus = 'ELIGIBLE' | 'INELIGIBLE' | 'UNRESOLVED';

export type Gstr3bItcLineScope = 'IN_SCOPE' | 'EXCLUDED_OTHER_REGISTRATION';

// Per-line diagnostic codes. These drive the ELIGIBLE / INELIGIBLE / UNRESOLVED decision for one
// inward tax line. Separate from the report-level-only codes below (POS/16(4)/17(5)/180-day/2B),
// which document a CAPABILITY GAP in this phase rather than gate any individual line — see the
// eligibility engine's header for why those five are deliberately not per-line gates here.
export type Gstr3bItcLineDiagnosticCode =
  | 'BUYER_REGISTRATION_UNASSIGNED'
  | 'SUPPLIER_GSTIN_UNAVAILABLE'
  | 'SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE'
  | 'TAX_CATEGORY_UNAVAILABLE'
  | 'TAX_CATEGORY_NON_TAXABLE';

// Report-level-only diagnostic codes — emitted at most once per report, never per line. Each
// documents a statutory determination this phase's data model cannot make at all (see
// PHASE_G2G7C_IMPLEMENTATION.md's eligibility matrix for why each one is NOT_DETERMINABLE today).
export type Gstr3bItcReportDiagnosticCode =
  | 'POS_NOT_DETERMINABLE'
  | 'SECTION_16_4_NOT_DETERMINABLE'
  | 'SECTION_17_5_NOT_DETERMINABLE'
  | 'ITC_180_DAY_STATUS_UNAVAILABLE'
  | 'GSTR_2B_RECONCILIATION_UNAVAILABLE'
  | 'PARTIAL_BRANCH_SCOPE'
  | 'NEGATIVE_NET_ITC';

export type Gstr3bItcDiagnosticCode = Gstr3bItcLineDiagnosticCode | Gstr3bItcReportDiagnosticCode;

export interface Gstr3bItcClassification {
  scope: Gstr3bItcLineScope;
  /** Meaningless when scope is EXCLUDED_OTHER_REGISTRATION — the line belongs to a different report. */
  status: Gstr3bItcStatus;
  diagnosticCode: Gstr3bItcLineDiagnosticCode | null;
  reason: string | null;
}

// The only facts the per-line classifier is allowed to look at — deliberately narrow (see brief
// §11: "classify using only facts actually available"). No Date.now(), no Prisma, no HTTP.
export interface Gstr3bItcLineFacts {
  buyerRegistrationId: string | null;
  supplierGstin: string | null;
  supplierIsComposition: boolean;
  /** PoItem.taxCategory, read via the relation — null means no snapshot exists for this line. */
  taxCategory: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Document Shapes (Pure Engine Input Contracts)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcSourceGrnLine {
  id: string; // GrnItem id
  grnId: string;
  grnNumber: string;
  receivedDate: Date;
  branchId: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  supplierId: string;
  supplierName: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  facts: Gstr3bItcLineFacts;
}

export interface Gstr3bItcSourcePurchaseReturnLine {
  id: string; // PurchaseReturnItem id
  returnId: string;
  returnNumber: string;
  returnDate: Date;
  /** The GrnItem this return reverses — eligibility is inherited from it, never re-derived. */
  sourceGrnLineId: string;
  branchId: string | null;
  amount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  facts: Gstr3bItcLineFacts;
}

export interface Gstr3bItcSourceStandaloneDebitNoteLine {
  id: string; // DebitNoteItem id
  debitNoteId: string;
  debitNoteNumber: string;
  debitNoteDate: Date;
  grnId: string;
  branchId: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  facts: Gstr3bItcLineFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Options
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcAggregationPeriod {
  from: Date;
  to: Date;
  financialYear: string;
  taxPeriod: string;
}

export interface Gstr3bItcAggregationOptions {
  companyId: string;
  gstRegistrationId: string;
  buyerGstin: string;
  buyerStateCode: string;
  period: Gstr3bItcAggregationPeriod;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money & Totals
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcMoneyTotals {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4(A)(5) Output
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcTable4A5 {
  status: 'IMPLEMENTED';
  eligible: Gstr3bItcMoneyTotals;
  unresolved: Gstr3bItcMoneyTotals;
  ineligible: Gstr3bItcMoneyTotals;
  documentCount: number;
  lineCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcDiagnostic {
  code: Gstr3bItcDiagnosticCode;
  documentType: 'GRN_LINE' | 'PURCHASE_RETURN' | 'STANDALONE_DEBIT_NOTE' | 'REPORT_SCOPE';
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
  amountDetails?: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility matrix — one row per statutory condition this phase was asked to evaluate (brief
// §26.C). Mirrors, in code, the same table the human-readable implementation report presents.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bItcConditionStatus = 'DETERMINABLE' | 'NOT_DETERMINABLE';

export interface Gstr3bItcEligibilityMatrixEntry {
  condition: string;
  status: Gstr3bItcConditionStatus;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation Result & Meta
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcAggregationMeta {
  companyId: string;
  gstRegistrationId: string;
  buyerGstin: string;
  buyerStateCode: string;
  financialYear: string;
  taxPeriod: string;
  period: {
    from: Date;
    to: Date;
  };
  isCompleteGstinScope: boolean;
  partialScopeReason: string | null;
  calculationVersion: string;
  supplierCount: number;
  sourceCounts: {
    grnLinesConsidered: number;
    grnLinesExcludedByScope: number;
    purchaseReturnLinesConsidered: number;
    purchaseReturnLinesExcludedByScope: number;
    standaloneDebitNoteLinesConsidered: number;
    standaloneDebitNoteLinesExcludedByScope: number;
  };
}

export interface Gstr3bItcAggregationResult {
  meta: Gstr3bItcAggregationMeta;
  table4A5: Gstr3bItcTable4A5;
  eligibilityMatrix: Gstr3bItcEligibilityMatrixEntry[];
  diagnostics: Gstr3bItcDiagnostic[];
}
