// G2g-7d — Inward RCM (reverse-charge) & self-invoicing foundation. Data contracts.
// Parallel to (and deliberately modeled on) gstr3bItc.types.ts (G2g-7c, frozen) — same
// scope/status/diagnostic shape, mirrored for the RCM side — but this is NOT a complete RCM
// implementation. See gstr3bRcmClassification.ts's own header for the statutory scope this phase
// actually covers, and PHASE_G2G7D_AUDIT.md for the full read-only audit and legal research.
//
// Statutory references (verified against official/authoritative sources this session — see
// PHASE_G2G7D_AUDIT.md §B for citations):
// - CGST Act Section 9(3)/9(4) (RCM applicability — §9(4)'s blanket unregistered-supplier RCM has
//   been suspended since Feb 2019 except for real-estate promoters)
// - CGST Act Section 31(3)(f), Rule 46 2nd proviso, Rule 47A (self-invoice — required only when
//   RCM applies AND the supplier is unregistered; 30-day issuance window)
// - CGST Act Section 31(3)(g) (payment voucher)
// - CGST Act Section 12(3)/13(3) (RCM time of supply — NOT reliably determinable in this data
//   model; see RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE)
// - CGST Rules Rule 86(2) (RCM tax must be paid from the electronic cash ledger — not the credit
//   ledger — before the corresponding ITC becomes available)
// - GSTR-3B Table 3.1(d) (RCM liability) and Table 4(A)(3) (RCM ITC — distinct from 4(A)(2)
//   import-of-services RCM, and from G2g-7c's own 4(A)(5) domestic bucket)

import type { BranchAccess } from '../../../shared/tenantContext';

// ─────────────────────────────────────────────────────────────────────────────
// Per-line classification (pure, no Prisma) — see gstr3bRcmClassification.ts
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bRcmStatus = 'RCM_APPLICABLE' | 'RCM_NOT_APPLICABLE' | 'RCM_UNRESOLVED';

export type Gstr3bRcmLineScope = 'IN_SCOPE' | 'EXCLUDED_OTHER_REGISTRATION';

export type Gstr3bRcmLineDiagnosticCode =
  | 'RCM_CATEGORY_UNRESOLVED'
  | 'RCM_REGISTRATION_UNASSIGNED'
  | 'RCM_TAX_CATEGORY_CONFLICT';

// Report-level-only diagnostic codes — emitted at most once per report, never per line.
export type Gstr3bRcmReportDiagnosticCode =
  | 'RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE'
  | 'RCM_SECTION_17_5_NOT_DETERMINABLE'
  | 'GSTR_2B_RCM_RECONCILIATION_UNAVAILABLE'
  | 'PARTIAL_BRANCH_SCOPE';

// Per-liability diagnostic — the payment-not-recorded gap is specific to one liability row, not a
// report-wide capability gap, so it carries a documentId like the line-level codes above.
export type Gstr3bRcmLiabilityDiagnosticCode = 'RCM_PAYMENT_NOT_RECORDED';

export type Gstr3bRcmDiagnosticCode = Gstr3bRcmLineDiagnosticCode | Gstr3bRcmReportDiagnosticCode | Gstr3bRcmLiabilityDiagnosticCode;

export interface Gstr3bRcmClassification {
  scope: Gstr3bRcmLineScope;
  /** Meaningless when scope is EXCLUDED_OTHER_REGISTRATION — the line belongs to a different report. */
  status: Gstr3bRcmStatus;
  diagnosticCode: Gstr3bRcmLineDiagnosticCode | null;
  reason: string | null;
}

// The only facts the per-line classifier is allowed to look at — deliberately narrow, same
// discipline as Gstr3bItcLineFacts. No Date.now(), no Prisma, no HTTP.
export interface Gstr3bRcmLineFacts {
  /** PoItem.rcmCategory (shared/rcmCategory.ts) — null/'NONE' is the overwhelming default. */
  rcmCategory: string | null;
  buyerRegistrationId: string | null;
  /** PoItem.taxCategory, read via the relation — null means no snapshot exists for this line. */
  taxCategory: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-invoice / payment-voucher requirement (brief §14/§15) — never inferred from
// RCM_APPLICABLE alone; see gstr3bRcmClassification.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bRcmSelfInvoiceRequirement = 'SELF_INVOICE_REQUIRED' | 'SELF_INVOICE_NOT_REQUIRED' | 'SELF_INVOICE_NOT_DETERMINED';
export type Gstr3bRcmPaymentVoucherRequirement = 'PAYMENT_VOUCHER_REQUIRED' | 'PAYMENT_VOUCHER_NOT_REQUIRED' | 'PAYMENT_VOUCHER_NOT_DETERMINED';

// ─────────────────────────────────────────────────────────────────────────────
// Tax calculation (pure) — see gstr3bRcmTaxCalculation.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmTaxCalculationInput {
  taxableValue: number;
  taxRate: number;
  supplierStateCode: string | null;
  companyStateCode: string | null;
  cess?: number;
}

export interface Gstr3bRcmTaxCalculation {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  totalTax: number;
  /** True when neither state code could be resolved — the CGST/SGST-vs-IGST split still had to
   *  fall back to something (same fallback the ordinary purchase-side split uses), so the split is
   *  not a confident place-of-supply determination. Surfaced as RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE's
   *  sibling concern at the report level, never silently treated as resolved. */
  posUnresolved: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// RCM ITC eligibility (pure) — see gstr3bRcmItcEligibility.ts. Deliberately separate from
// classification above: an RCM_APPLICABLE liability's ITC is gated on whether the tax was actually
// PAID (Rule 86(2)), never on classification or liability-creation alone (brief §16/§17).
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bRcmItcStatus = 'ELIGIBLE' | 'UNRESOLVED' | 'INELIGIBLE';

export interface Gstr3bRcmItcClassification {
  status: Gstr3bRcmItcStatus;
  diagnosticCode: Gstr3bRcmLiabilityDiagnosticCode | null;
  reason: string | null;
}

export type Gstr3bRcmLiabilityStatus = 'LIABILITY_RECOGNIZED' | 'TAX_PAID';

// ─────────────────────────────────────────────────────────────────────────────
// Source Document Shape (pure engine input contract) — one row per RcmLiability. Only
// RCM_APPLICABLE / RCM_UNRESOLVED facts ever produce a row here (RCM_NOT_APPLICABLE lines are
// never persisted — see the RcmLiability model's own header comment). `facts` is reclassified
// fresh at report time, never read off a frozen classification column — same convention as
// G2g-7c's classifyInwardTaxLine being re-run from live GrnItem/PoItem facts.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmSourceLiabilityLine {
  id: string; // RcmLiability id
  grnId: string;
  grnNumber: string;
  receivedDate: Date;
  branchId: string | null;
  supplierId: string;
  supplierName: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  selfInvoiceRequirement: Gstr3bRcmSelfInvoiceRequirement;
  paymentVoucherRequirement: Gstr3bRcmPaymentVoucherRequirement;
  liabilityStatus: Gstr3bRcmLiabilityStatus;
  facts: Gstr3bRcmLineFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Options
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmAggregationPeriod {
  from: Date;
  to: Date;
  financialYear: string;
  taxPeriod: string;
}

export interface Gstr3bRcmAggregationOptions {
  companyId: string;
  gstRegistrationId: string;
  buyerGstin: string;
  buyerStateCode: string;
  period: Gstr3bRcmAggregationPeriod;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money & Totals
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmMoneyTotals {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.1(d) — RCM liability. `recognized` = a confirmed (RCM_APPLICABLE) self-assessed
// liability; `unresolved` = flagged but not yet a confirmed liability amount — NEVER merged into
// `recognized` (brief §25: no false compliance).
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmTable31d {
  status: 'IMPLEMENTED';
  recognized: Gstr3bRcmMoneyTotals;
  unresolved: Gstr3bRcmMoneyTotals;
  documentCount: number;
  lineCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4(A)(3) — RCM ITC, distinct from 4(A)(2) (import of services, not modeled here — this
// codebase has no import-of-service data) and from G2g-7c's own domestic 4(A)(5) bucket.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmTable4A3 {
  status: 'IMPLEMENTED';
  eligible: Gstr3bRcmMoneyTotals;
  unresolved: Gstr3bRcmMoneyTotals;
  ineligible: Gstr3bRcmMoneyTotals;
  documentCount: number;
  lineCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-invoice / payment-voucher summary — counts only (the documents themselves are a separate
// model/report; this is the "how many of each" rollup the brief's §24 response shape asks for).
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmRequirementSummary {
  required: number;
  notRequired: number;
  notDetermined: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmDiagnostic {
  code: Gstr3bRcmDiagnosticCode;
  documentType: 'RCM_LIABILITY' | 'REPORT_SCOPE';
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation Result & Meta
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bRcmAggregationMeta {
  companyId: string;
  gstRegistrationId: string;
  buyerGstin: string;
  buyerStateCode: string;
  financialYear: string;
  taxPeriod: string;
  period: { from: Date; to: Date };
  isCompleteGstinScope: boolean;
  partialScopeReason: string | null;
  calculationVersion: string;
  supplierCount: number;
  sourceCounts: {
    liabilityLinesConsidered: number;
    liabilityLinesExcludedByScope: number;
  };
}

export interface Gstr3bRcmAggregationResult {
  meta: Gstr3bRcmAggregationMeta;
  table3_1d: Gstr3bRcmTable31d;
  table4A3: Gstr3bRcmTable4A3;
  selfInvoice: Gstr3bRcmRequirementSummary;
  paymentVoucher: Gstr3bRcmRequirementSummary;
  diagnostics: Gstr3bRcmDiagnostic[];
}
