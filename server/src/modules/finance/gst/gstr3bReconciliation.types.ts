// G2g-7f — Complete GSTR-3B Aggregation & Reconciliation. Data contracts.
//
// This is a COMPOSITION layer only. It does not reimplement any GST calculation, eligibility
// classification, RCM classification, or GSTR-2B matching logic — it imports and re-presents the
// frozen result shapes from G2g-7b (gstr3bOutward.types.ts), G2g-7c (gstr3bItc.types.ts), G2g-7d
// (gstr3bRcm.types.ts), and G2g-7e (gstr2b.types.ts) verbatim, inside one cohesive report, and adds
// only what none of those four files can produce alone: a merged GSTR-3B Table 4 ITC presentation
// (4(A)/4(B)/4(C)/4(D)), a deterministic book-vs-2B reconciliation matrix, and a filing-period
// status lookup (read-only — this phase creates no GstReturnPeriod row, files nothing, locks
// nothing).
//
// See PHASE_G2G7F_IMPLEMENTATION.md for the full audit, design reasoning, and the exact GSTR-3B
// statutory sections this composition supports / does not support.

import type { BranchAccess } from '../../../shared/tenantContext';
import type { Gstr3bOutwardAggregationResult } from './gstr3bOutward.types';
import type { Gstr3bItcAggregationResult, Gstr3bItcMoneyTotals } from './gstr3bItc.types';
import type { Gstr3bRcmAggregationResult, Gstr3bRcmMoneyTotals } from './gstr3bRcm.types';
import type { Gstr2bReconciliationResult, Gstr2bMatchResult, Gstr2bMoneyTotals } from './gstr2b.types';

// ─────────────────────────────────────────────────────────────────────────────
// Completeness vocabulary (brief §14) — every major section carries one of these, never silently
// omitted and never a fabricated numeric value standing in for "we don't know".
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bReconciliationSectionStatus = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_DETERMINABLE';

// ─────────────────────────────────────────────────────────────────────────────
// Filing-period status (brief §12) — reporting context only, read-only. Reuses the existing
// GstReturnPeriod model/lifecycle (G2g-6a/6e, frozen) with returnType='GSTR3B' — a value that model
// was explicitly designed to accept later (see its own schema comment) but that no service has ever
// written. This phase never writes one either; a NOT_STARTED result (no row found) is the expected,
// honest answer today for every company.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bFilingLifecycleStatus = 'NOT_STARTED' | 'OPEN' | 'SNAPSHOT_CREATED' | 'FILING_ATTEMPTED' | 'FILED' | 'LOCKED';

export interface Gstr3bReconciliationFilingStatus {
  returnType: 'GSTR3B';
  status: Gstr3bFilingLifecycleStatus;
  periodId: string | null;
  filedAt: Date | null;
  lockedAt: Date | null;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 ITC presentation (brief §7) — merges G2g-7c (4(A)(5)) and G2g-7d (4(A)(3)) into the full
// statutory Table 4(A)/4(B)/4(C)/4(D) shape. Sections with no supporting data model anywhere in this
// codebase (imports, ISD, Rule 42/43, Section 16(4)/17(5)/180-day reversal detail, ITC reclaim) are
// NOT_SUPPORTED / NOT_DETERMINABLE with a diagnostic — never a fabricated zero or derived estimate.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bItcPresentationUnsupportedLine {
  status: 'NOT_SUPPORTED' | 'NOT_DETERMINABLE';
  taxableValue: null;
  igst: null;
  cgst: null;
  sgst: null;
  cess: null;
  diagnosticCode: string;
  reason: string;
}

export interface Gstr3bItcPresentation4A3 {
  status: 'PARTIALLY_SUPPORTED';
  source: 'G2G-7D_RCM_ENGINE';
  eligible: Gstr3bRcmMoneyTotals;
  unresolved: Gstr3bRcmMoneyTotals;
  ineligible: Gstr3bRcmMoneyTotals;
  documentCount: number;
  lineCount: number;
  note: string;
}

export interface Gstr3bItcPresentation4A5 {
  status: 'PARTIALLY_SUPPORTED';
  source: 'G2G-7C_ITC_ENGINE';
  eligible: Gstr3bItcMoneyTotals;
  unresolved: Gstr3bItcMoneyTotals;
  ineligible: Gstr3bItcMoneyTotals;
  documentCount: number;
  lineCount: number;
  note: string;
}

export interface Gstr3bItcPresentationTable4A {
  importOfGoods: Gstr3bItcPresentationUnsupportedLine; // 4(A)(1)
  importOfServices: Gstr3bItcPresentationUnsupportedLine; // 4(A)(2)
  inwardSuppliesLiableToRcm: Gstr3bItcPresentation4A3; // 4(A)(3)
  inwardSuppliesFromIsd: Gstr3bItcPresentationUnsupportedLine; // 4(A)(4)
  allOtherItc: Gstr3bItcPresentation4A5; // 4(A)(5)
}

export interface Gstr3bItcPresentationTable4B {
  rule42And43: Gstr3bItcPresentationUnsupportedLine; // 4(B)(1)
  others: Gstr3bItcPresentationUnsupportedLine; // 4(B)(2)
}

export interface Gstr3bItcPresentationTable4C {
  status: 'PARTIALLY_SUPPORTED';
  /** Sum of 4(A)(3).eligible + 4(A)(5).eligible only — imports/ISD/4(B) reversals are excluded by
   *  construction (they are NOT_SUPPORTED/NOT_DETERMINABLE above), not netted in as zero. */
  netItcAvailable: Gstr3bItcMoneyTotals;
  componentsIncluded: string[];
  componentsExcluded: string[];
  note: string;
}

export interface Gstr3bItcPresentationTable4D {
  /** 4(D)(1) — ITC reclaimed (previously reversed, now reclaimed). No model anywhere in this
   *  codebase tracks a reversal-then-reclaim lifecycle. */
  itcReclaimed: Gstr3bItcPresentationUnsupportedLine;
  /** 4(D)(2) — ineligible ITC. Reuses G2g-7c/7d's own INELIGIBLE buckets (composition-scheme
   *  supplier, non-taxable category) verbatim — the only ineligibility conditions this phase's data
   *  model can establish. This is NARROWER than the full Section 17(5) blocked-credit list (motor
   *  vehicles, employee welfare, construction, etc.), which remains NOT_DETERMINABLE and is never
   *  folded into this number. */
  ineligibleItc: {
    status: 'PARTIALLY_SUPPORTED';
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    note: string;
  };
}

export interface Gstr3bItcPresentation {
  table4A: Gstr3bItcPresentationTable4A;
  table4B: Gstr3bItcPresentationTable4B;
  table4C: Gstr3bItcPresentationTable4C;
  table4D: Gstr3bItcPresentationTable4D;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2B-derived ITC totals (brief §5) — six distinct, non-interchangeable numbers. Never collapsed
// into one "ITC Available" figure.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bTwoBDerivedItc {
  /** Total ITC-bearing value recorded in books for this period (G2g-7c eligible+unresolved+ineligible). */
  bookItc: Gstr3bItcMoneyTotals;
  bookItcUnresolved: Gstr3bItcMoneyTotals;
  bookItcIneligible: Gstr3bItcMoneyTotals;
  /** Total 2B-document value on any match that found a corresponding book entry (any confidence tier). */
  twoBItcMatched: Gstr2bMoneyTotals;
  /** Total 2B-document value where the source statement itself marked ITC AVAILABLE (Table 3 of 2B). */
  twoBItcAvailable: Gstr2bMoneyTotals;
  /** Total 2B-document value where the source statement itself marked ITC NOT_AVAILABLE (Table 4 of 2B). */
  twoBItcNotAvailable: Gstr2bMoneyTotals;
  /** Total 2B-document value where availability could not be read from the source at all. */
  twoBItcUnknownAvailability: Gstr2bMoneyTotals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation matrix (brief §6) — one deterministic category per 2B-vs-book match, built on top
// of (never re-deriving) G2g-7e's own matchStatus + twoBItcAvailability. A "supplier mismatch" row,
// as named in the brief's own example table, cannot be produced by the frozen matching engine: 7e
// indexes matches by supplier GSTIN from the very first step, so two documents whose supplier
// identity actually differs are never compared against each other at all — each surfaces
// independently as BOOK_ONLY / TWO_B_ONLY_* rather than as one row with a "mismatch" label. This is
// reported as a standing diagnostic (SUPPLIER_MISMATCH_NOT_DETECTABLE), not simulated with a
// category that would always read zero.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bReconciliationMatrixCategory =
  | 'MATCHED_AVAILABLE' // Book Yes | 2B Yes | Available
  | 'MATCHED_NOT_AVAILABLE' // Book Yes | 2B Yes | Not Available
  | 'MATCHED_UNKNOWN_AVAILABILITY' // Book Yes | 2B Yes | Unknown -> review
  | 'BOOK_ONLY' // Book Yes | 2B No
  | 'TWO_B_ONLY_AVAILABLE' // Book No | 2B Yes | Available
  | 'TWO_B_ONLY_NOT_AVAILABLE' // Book No | 2B Yes | Not Available
  | 'TWO_B_ONLY_UNKNOWN_AVAILABILITY' // Book No | 2B Yes | Unknown
  | 'AMOUNT_MISMATCH' // Book Yes | 2B Yes | taxable value disagrees
  | 'TAX_MISMATCH' // Book Yes | 2B Yes | tax amount disagrees
  | 'RCM_MISMATCH' // Book Yes | 2B Yes | reverse-charge flag disagrees
  | 'NOT_RECONCILABLE'; // ISD/import documents — preserved, never matched

export interface Gstr3bReconciliationMatrixEntry {
  category: Gstr3bReconciliationMatrixCategory;
  documentCount: number;
  twoBTotals: Gstr2bMoneyTotals;
  bookTotals: Gstr2bMoneyTotals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics — pass-through from each frozen engine (tagged by source) plus composition-layer-only
// codes for facts only visible once the four engines are compared against each other.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bReconciliationDiagnosticSource = 'OUTWARD' | 'RCM' | 'ITC' | 'TWO_B' | 'COMPOSITION';

export type Gstr3bReconciliationCompositionDiagnosticCode =
  | 'IMPORT_ITC_NOT_SUPPORTED'
  | 'ISD_ITC_NOT_SUPPORTED'
  | 'SECTION_17_5_NOT_DETERMINABLE'
  | 'RULE_42_43_NOT_DETERMINABLE'
  | 'ITC_RECLAIM_NOT_DETERMINABLE'
  | 'POS_RESTRICTION_NOT_DETERMINABLE'
  | 'BOOK_ITC_MISSING_FROM_2B'
  | 'TWO_B_ITC_MISSING_FROM_BOOK'
  | 'SUPPLIER_MISMATCH_NOT_DETECTABLE'
  | 'FILING_PERIOD_NOT_STARTED'
  | 'STATUTORY_POSITION_NOT_DETERMINABLE';

export interface Gstr3bReconciliationDiagnostic {
  source: Gstr3bReconciliationDiagnosticSource;
  code: string;
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Book vs. statutory position (brief §15) — two distinct things, never conflated.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bBookPosition {
  outputTaxLiability: number; // sum of outward table31a igst+cgst+sgst+cess
  rcmLiabilityRecognized: number; // rcm table3_1d.recognized tax
  bookItcEligible: number; // itc table4A5.eligible + rcm table4A3.eligible tax
  /** output + RCM liability - book-eligible ITC. An accounting-ledger-shaped number, not a GSTR-3B
   *  statutory filing figure (see statutoryReportingPosition below). */
  estimatedNetPosition: number;
}

export interface Gstr3bReconciliationSummary {
  bookPosition: Gstr3bBookPosition;
  statutoryReportingPosition: {
    status: 'NOT_DETERMINABLE';
    reason: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level report
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bReconciliationMeta {
  companyId: string;
  gstRegistrationId: string;
  gstin: string;
  stateCode: string;
  legalName: string;
  financialYear: string;
  taxPeriod: string;
  period: { from: Date; to: Date };
  isCompleteGstinScope: boolean;
  partialScopeReason: string | null;
}

export interface Gstr3bReconciliationOutwardSection {
  completeness: Gstr3bReconciliationSectionStatus;
  report: Gstr3bOutwardAggregationResult;
}

export interface Gstr3bReconciliationRcmSection {
  completeness: Gstr3bReconciliationSectionStatus;
  report: Gstr3bRcmAggregationResult;
}

export interface Gstr3bReconciliationItcSection {
  completeness: Gstr3bReconciliationSectionStatus;
  book: Gstr3bItcAggregationResult;
  presentation: Gstr3bItcPresentation;
  twoBDerived: Gstr3bTwoBDerivedItc;
}

export interface Gstr3bReconciliationTwoBSection {
  /** True only when an ACTIVE Gst2bStatement has actually been imported for this exact period. */
  statementAvailable: boolean;
  report: Gstr2bReconciliationResult;
  matrix: Gstr3bReconciliationMatrixEntry[];
}

export interface Gstr3bReconciliationReport {
  meta: Gstr3bReconciliationMeta;
  filingStatus: Gstr3bReconciliationFilingStatus;
  outwardLiability: Gstr3bReconciliationOutwardSection;
  reverseCharge: Gstr3bReconciliationRcmSection;
  inputTaxCredit: Gstr3bReconciliationItcSection;
  twoBReconciliation: Gstr3bReconciliationTwoBSection;
  summary: Gstr3bReconciliationSummary;
  diagnostics: Gstr3bReconciliationDiagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure composer input contract (gstr3bReconciliationComposition.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bReconciliationComposeInput {
  companyId: string;
  gstRegistrationId: string;
  gstin: string;
  stateCode: string;
  legalName: string;
  financialYear: string;
  taxPeriod: string;
  period: { from: Date; to: Date };
  outward: Gstr3bOutwardAggregationResult;
  rcm: Gstr3bRcmAggregationResult;
  itc: Gstr3bItcAggregationResult;
  twoB: Gstr2bReconciliationResult;
  statementAvailable: boolean;
  filingStatus: Gstr3bReconciliationFilingStatus;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

export type { Gstr2bMatchResult };
