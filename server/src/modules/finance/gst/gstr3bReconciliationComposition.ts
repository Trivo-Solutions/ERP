// G2g-7f — Complete GSTR-3B Aggregation & Reconciliation. Pure composition engine.
//
// No Prisma, no Date.now(), no HTTP imports — identical discipline to every frozen engine this file
// composes (gstr3bOutwardAggregation.ts, gstr3bItcAggregation.ts, gstr3bRcmAggregation.ts,
// gstr2bReconciliation.ts). This file does not reclassify a single line, recompute a single tax
// figure, or re-run a single match — it only reads the four engines' own finished results and the
// filing-period status (resolved by the service layer) and arranges them into one report, per
// CLAUDE.md G2g-7f's architecture: "Frozen engines -> Adapter/composition layer -> GSTR-3B
// reconciliation report."

import type {
  Gstr3bReconciliationComposeInput,
  Gstr3bReconciliationReport,
  Gstr3bItcPresentation,
  Gstr3bItcPresentationUnsupportedLine,
  Gstr3bItcPresentationTable4A,
  Gstr3bItcPresentationTable4B,
  Gstr3bItcPresentationTable4C,
  Gstr3bItcPresentationTable4D,
  Gstr3bTwoBDerivedItc,
  Gstr3bReconciliationMatrixEntry,
  Gstr3bReconciliationMatrixCategory,
  Gstr3bReconciliationDiagnostic,
  Gstr3bReconciliationSummary,
} from './gstr3bReconciliation.types';
import type { Gstr2bMatchResult, Gstr2bMoneyTotals } from './gstr2b.types';
import type { Gstr3bItcMoneyTotals } from './gstr3bItc.types';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function emptyItcTotals(): Gstr3bItcMoneyTotals {
  return { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}
function emptyMoneyTotals(): Gstr2bMoneyTotals {
  return { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}
function addInto(bucket: Gstr2bMoneyTotals, t: Gstr2bMoneyTotals | null | undefined) {
  if (!t) return;
  bucket.taxableValue = round2(bucket.taxableValue + t.taxableValue);
  bucket.igst = round2(bucket.igst + t.igst);
  bucket.cgst = round2(bucket.cgst + t.cgst);
  bucket.sgst = round2(bucket.sgst + t.sgst);
  bucket.cess = round2(bucket.cess + t.cess);
}
function sumItc(a: Gstr3bItcMoneyTotals, b: Gstr3bItcMoneyTotals): Gstr3bItcMoneyTotals {
  return {
    taxableValue: round2(a.taxableValue + b.taxableValue),
    igst: round2(a.igst + b.igst),
    cgst: round2(a.cgst + b.cgst),
    sgst: round2(a.sgst + b.sgst),
    cess: round2(a.cess + b.cess),
  };
}
function totalTaxOf(t: Gstr3bItcMoneyTotals): number {
  return round2(t.igst + t.cgst + t.sgst + t.cess);
}

function unsupportedLine(status: 'NOT_SUPPORTED' | 'NOT_DETERMINABLE', diagnosticCode: string, reason: string): Gstr3bItcPresentationUnsupportedLine {
  return { status, taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 ITC presentation (brief §7)
// ─────────────────────────────────────────────────────────────────────────────

function buildItcPresentation(input: Gstr3bReconciliationComposeInput): { presentation: Gstr3bItcPresentation; diagnostics: Gstr3bReconciliationDiagnostic[] } {
  const diagnostics: Gstr3bReconciliationDiagnostic[] = [];

  const importOfGoods = unsupportedLine('NOT_SUPPORTED', 'IMPORT_ITC_NOT_SUPPORTED', 'No Bill-of-Entry / import-of-goods model exists anywhere in this codebase.');
  const importOfServices = unsupportedLine('NOT_SUPPORTED', 'IMPORT_ITC_NOT_SUPPORTED', 'No import-of-services purchase model exists anywhere in this codebase.');
  const inwardSuppliesFromIsd = unsupportedLine('NOT_SUPPORTED', 'ISD_ITC_NOT_SUPPORTED', 'No Input Service Distributor model exists anywhere in this codebase.');
  diagnostics.push({ source: 'COMPOSITION', code: 'IMPORT_ITC_NOT_SUPPORTED', reason: 'GSTR-3B Table 4(A)(1)/4(A)(2) (import of goods/services) cannot be populated — no import model exists.' });
  diagnostics.push({ source: 'COMPOSITION', code: 'ISD_ITC_NOT_SUPPORTED', reason: 'GSTR-3B Table 4(A)(4) (ISD) cannot be populated — no ISD model exists.' });

  const table4A: Gstr3bItcPresentationTable4A = {
    importOfGoods,
    importOfServices,
    inwardSuppliesLiableToRcm: {
      status: 'PARTIALLY_SUPPORTED',
      source: 'G2G-7D_RCM_ENGINE',
      eligible: input.rcm.table4A3.eligible,
      unresolved: input.rcm.table4A3.unresolved,
      ineligible: input.rcm.table4A3.ineligible,
      documentCount: input.rcm.table4A3.documentCount,
      lineCount: input.rcm.table4A3.lineCount,
      note: 'Composed verbatim from the frozen G2g-7d RCM engine — see its own diagnostics for what remains NOT_DETERMINABLE (time of supply, Section 17(5)).',
    },
    inwardSuppliesFromIsd,
    allOtherItc: {
      status: 'PARTIALLY_SUPPORTED',
      source: 'G2G-7C_ITC_ENGINE',
      eligible: input.itc.table4A5.eligible,
      unresolved: input.itc.table4A5.unresolved,
      ineligible: input.itc.table4A5.ineligible,
      documentCount: input.itc.table4A5.documentCount,
      lineCount: input.itc.table4A5.lineCount,
      note: 'Composed verbatim from the frozen G2g-7c ITC engine — see its own eligibilityMatrix for what remains NOT_DETERMINABLE (place of supply, Section 16(4)/17(5), 180-day payment, GSTR-2B).',
    },
  };

  const rule42And43 = unsupportedLine('NOT_DETERMINABLE', 'RULE_42_43_NOT_DETERMINABLE', 'No exempt-supply / non-business-use attribution data exists to compute a Rule 42/43 common-credit reversal.');
  const othersB2 = unsupportedLine('NOT_DETERMINABLE', 'SECTION_17_5_NOT_DETERMINABLE', 'No data models the specific Section 17(5) blocked-credit categories (motor vehicles, employee welfare, construction, etc.) beyond what is already excluded in the INELIGIBLE buckets above.');
  diagnostics.push({ source: 'COMPOSITION', code: 'RULE_42_43_NOT_DETERMINABLE', reason: 'GSTR-3B Table 4(B)(1) (Rule 42/43 reversal) cannot be computed from current data.' });
  diagnostics.push({ source: 'COMPOSITION', code: 'SECTION_17_5_NOT_DETERMINABLE', reason: 'GSTR-3B Table 4(B)(2) (other ITC reversals, e.g. full Section 17(5)) cannot be computed beyond the narrower INELIGIBLE buckets already reported in 4(A)(3)/4(A)(5).' });
  const table4B: Gstr3bItcPresentationTable4B = { rule42And43, others: othersB2 };

  const netItcAvailable = sumItc(table4A.inwardSuppliesLiableToRcm.eligible, table4A.allOtherItc.eligible);
  const table4C: Gstr3bItcPresentationTable4C = {
    status: 'PARTIALLY_SUPPORTED',
    netItcAvailable,
    componentsIncluded: ['4(A)(3) RCM eligible', '4(A)(5) all-other eligible'],
    componentsExcluded: ['4(A)(1) import of goods', '4(A)(2) import of services', '4(A)(4) ISD', '4(B)(1) Rule 42/43 reversal', '4(B)(2) other reversals'],
    note: 'Mathematically derivable sum of the two supported eligible buckets only — NOT a complete statutory 4(C), since every excluded component above is either NOT_SUPPORTED or NOT_DETERMINABLE, never assumed zero.',
  };

  const itcReclaimed = unsupportedLine('NOT_DETERMINABLE', 'ITC_RECLAIM_NOT_DETERMINABLE', 'No reversal-then-reclaim lifecycle is tracked anywhere in this codebase.');
  diagnostics.push({ source: 'COMPOSITION', code: 'ITC_RECLAIM_NOT_DETERMINABLE', reason: 'GSTR-3B Table 4(D)(1) (ITC reclaimed) cannot be determined — no reversal/reclaim tracking exists.' });

  const ineligibleCombined = sumItc(table4A.inwardSuppliesLiableToRcm.ineligible, table4A.allOtherItc.ineligible);
  const table4D: Gstr3bItcPresentationTable4D = {
    itcReclaimed,
    ineligibleItc: {
      status: 'PARTIALLY_SUPPORTED',
      taxableValue: ineligibleCombined.taxableValue,
      igst: ineligibleCombined.igst,
      cgst: ineligibleCombined.cgst,
      sgst: ineligibleCombined.sgst,
      cess: ineligibleCombined.cess,
      note: 'Sum of the G2g-7c/7d INELIGIBLE buckets (composition-scheme supplier, non-taxable tax category) — narrower than the full Section 17(5) blocked-credit list, which remains NOT_DETERMINABLE.',
    },
  };

  return { presentation: { table4A, table4B, table4C, table4D }, diagnostics };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2B-derived ITC totals (brief §5)
// ─────────────────────────────────────────────────────────────────────────────

function buildTwoBDerivedItc(input: Gstr3bReconciliationComposeInput): Gstr3bTwoBDerivedItc {
  const bookItc = sumItc(sumItc(input.itc.table4A5.eligible, input.itc.table4A5.unresolved), input.itc.table4A5.ineligible);

  const twoBItcMatched = emptyMoneyTotals();
  const twoBItcAvailable = emptyMoneyTotals();
  const twoBItcNotAvailable = emptyMoneyTotals();
  const twoBItcUnknownAvailability = emptyMoneyTotals();

  const MATCHED_STATUSES = new Set(['EXACT_MATCH', 'MATCHED_WITH_NORMALIZATION', 'POSSIBLE_MATCH', 'AMOUNT_MISMATCH', 'TAX_MISMATCH', 'RCM_MISMATCH']);
  for (const m of input.twoB.matches) {
    if (!m.twoB) continue; // no 2B document on this match (BOOK_MISSING) — nothing to attribute to the 2B side
    if (MATCHED_STATUSES.has(m.status)) addInto(twoBItcMatched, m.twoB);
    if (m.twoBItcAvailability === 'AVAILABLE') addInto(twoBItcAvailable, m.twoB);
    else if (m.twoBItcAvailability === 'NOT_AVAILABLE') addInto(twoBItcNotAvailable, m.twoB);
    else addInto(twoBItcUnknownAvailability, m.twoB);
  }

  return {
    bookItc,
    bookItcUnresolved: input.itc.table4A5.unresolved,
    bookItcIneligible: input.itc.table4A5.ineligible,
    twoBItcMatched,
    twoBItcAvailable,
    twoBItcNotAvailable,
    twoBItcUnknownAvailability,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation matrix (brief §6)
// ─────────────────────────────────────────────────────────────────────────────

function classifyMatrixCategory(m: Gstr2bMatchResult): Gstr3bReconciliationMatrixCategory {
  switch (m.status) {
    case 'EXACT_MATCH':
    case 'MATCHED_WITH_NORMALIZATION':
    case 'POSSIBLE_MATCH':
      if (m.twoBItcAvailability === 'AVAILABLE') return 'MATCHED_AVAILABLE';
      if (m.twoBItcAvailability === 'NOT_AVAILABLE') return 'MATCHED_NOT_AVAILABLE';
      return 'MATCHED_UNKNOWN_AVAILABILITY';
    case 'BOOK_MISSING':
      return 'BOOK_ONLY';
    case 'TWO_B_MISSING':
      if (m.twoBItcAvailability === 'AVAILABLE') return 'TWO_B_ONLY_AVAILABLE';
      if (m.twoBItcAvailability === 'NOT_AVAILABLE') return 'TWO_B_ONLY_NOT_AVAILABLE';
      return 'TWO_B_ONLY_UNKNOWN_AVAILABILITY';
    case 'AMOUNT_MISMATCH':
      return 'AMOUNT_MISMATCH';
    case 'TAX_MISMATCH':
      return 'TAX_MISMATCH';
    case 'RCM_MISMATCH':
      return 'RCM_MISMATCH';
    case 'NOT_SUPPORTED':
    case 'UNRESOLVED':
    default:
      return 'NOT_RECONCILABLE';
  }
}

const MATRIX_CATEGORIES: Gstr3bReconciliationMatrixCategory[] = [
  'MATCHED_AVAILABLE', 'MATCHED_NOT_AVAILABLE', 'MATCHED_UNKNOWN_AVAILABILITY',
  'BOOK_ONLY', 'TWO_B_ONLY_AVAILABLE', 'TWO_B_ONLY_NOT_AVAILABLE', 'TWO_B_ONLY_UNKNOWN_AVAILABILITY',
  'AMOUNT_MISMATCH', 'TAX_MISMATCH', 'RCM_MISMATCH', 'NOT_RECONCILABLE',
];

function buildReconciliationMatrix(matches: Gstr2bMatchResult[]): Gstr3bReconciliationMatrixEntry[] {
  const buckets = new Map<Gstr3bReconciliationMatrixCategory, Gstr3bReconciliationMatrixEntry>();
  for (const category of MATRIX_CATEGORIES) {
    buckets.set(category, { category, documentCount: 0, twoBTotals: emptyMoneyTotals(), bookTotals: emptyMoneyTotals() });
  }
  for (const m of matches) {
    const entry = buckets.get(classifyMatrixCategory(m))!;
    entry.documentCount += 1;
    addInto(entry.twoBTotals, m.twoB);
    addInto(entry.bookTotals, m.book);
  }
  // Only categories that actually occurred are returned — an always-zero row for a category this
  // period had no documents in is noise, not a finding (every category is still derivable on demand;
  // this is a display choice, not a data-completeness one).
  return MATRIX_CATEGORIES.map((c) => buckets.get(c)!).filter((e) => e.documentCount > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Book vs. statutory position (brief §15)
// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(input: Gstr3bReconciliationComposeInput, presentation: Gstr3bItcPresentation): Gstr3bReconciliationSummary {
  const outputTaxLiability = round2(input.outward.table31.table31a.igst + input.outward.table31.table31a.cgst + input.outward.table31.table31a.sgst + input.outward.table31.table31a.cess);
  const rcmLiabilityRecognized = round2(input.rcm.table3_1d.recognized.igst + input.rcm.table3_1d.recognized.cgst + input.rcm.table3_1d.recognized.sgst + input.rcm.table3_1d.recognized.cess);
  const bookItcEligible = totalTaxOf(presentation.table4C.netItcAvailable);
  const estimatedNetPosition = round2(outputTaxLiability + rcmLiabilityRecognized - bookItcEligible);

  return {
    bookPosition: { outputTaxLiability, rcmLiabilityRecognized, bookItcEligible, estimatedNetPosition },
    statutoryReportingPosition: {
      status: 'NOT_DETERMINABLE',
      reason: 'The accounting book position above is NOT the statutory GSTR-3B filing liability. It omits imports, ISD, Rule 42/43 reversals, the full Section 16(4)/17(5)/180-day eligibility rules, and final GSTR-2B-based ITC availability — each individually flagged NOT_SUPPORTED/NOT_DETERMINABLE in inputTaxCredit.presentation. Do not file a return based on this number alone.',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition entry point
// ─────────────────────────────────────────────────────────────────────────────

export function composeGstr3bReconciliationReport(input: Gstr3bReconciliationComposeInput): Gstr3bReconciliationReport {
  const diagnostics: Gstr3bReconciliationDiagnostic[] = [];

  for (const d of input.outward.diagnostics) diagnostics.push({ source: 'OUTWARD', code: d.code, documentId: d.documentId, documentNumber: d.documentNumber, reason: d.reason });
  for (const d of input.rcm.diagnostics) diagnostics.push({ source: 'RCM', code: d.code, documentId: d.documentId, documentNumber: d.documentNumber, reason: d.reason });
  for (const d of input.itc.diagnostics) diagnostics.push({ source: 'ITC', code: d.code, documentId: d.documentId, documentNumber: d.documentNumber, reason: d.reason });
  for (const d of input.twoB.diagnostics) diagnostics.push({ source: 'TWO_B', code: d.code, documentId: d.documentId, documentNumber: d.documentNumber, reason: d.reason });

  const { presentation, diagnostics: itcPresentationDiagnostics } = buildItcPresentation(input);
  diagnostics.push(...itcPresentationDiagnostics);

  const twoBDerived = buildTwoBDerivedItc(input);
  const matrix = buildReconciliationMatrix(input.twoB.matches);

  diagnostics.push({
    source: 'COMPOSITION',
    code: 'SUPPLIER_MISMATCH_NOT_DETECTABLE',
    reason: 'The GSTR-2B matching engine (G2g-7e) indexes candidates by supplier GSTIN before comparing document number/date/amount — two documents whose supplier identity genuinely differs are never compared to each other, so a true "supplier mismatch" never appears as one matched-but-disagreeing row. It instead surfaces as two independent unmatched entries (a BOOK_ONLY row and a TWO_B_ONLY_* row). This matrix therefore has no SUPPLIER_MISMATCH category — reporting one would always read zero and falsely imply the check was performed.',
  });

  if (twoBDerived.bookItc.taxableValue > 0 && input.twoB.summary.bookMissing > 0) {
    diagnostics.push({
      source: 'COMPOSITION',
      code: 'BOOK_ITC_MISSING_FROM_2B',
      reason: `${input.twoB.summary.bookMissing} book purchase document(s) with recorded ITC have no corresponding document in the current GSTR-2B statement for this period — the supplier may not have filed yet.`,
    });
  }
  if (input.twoB.summary.twoBMissing > 0) {
    diagnostics.push({
      source: 'COMPOSITION',
      code: 'TWO_B_ITC_MISSING_FROM_BOOK',
      reason: `${input.twoB.summary.twoBMissing} GSTR-2B document(s) have no corresponding book purchase record for this period — review before claiming any such ITC.`,
    });
  }
  diagnostics.push({
    source: 'COMPOSITION',
    code: 'POS_RESTRICTION_NOT_DETERMINABLE',
    reason: 'Place-of-supply-based ITC restrictions cannot be determined from current inward data (no inward place-of-supply field beyond the existing intra/inter-state split) — not reflected in any ELIGIBLE/eligible total above.',
  });
  // Note: when !input.statementAvailable, 7e's own service has already emitted a
  // NO_STATEMENT_IMPORTED diagnostic, passed through in the TWO_B loop above — not duplicated here.
  if (input.filingStatus.status === 'NOT_STARTED') {
    diagnostics.push({
      source: 'COMPOSITION',
      code: 'FILING_PERIOD_NOT_STARTED',
      reason: 'No GSTR-3B return period record exists yet for this registration/period. This report is a pre-filing reconciliation view only — it does not create, file, or lock a return period.',
    });
  }

  const summary = buildSummary(input, presentation);
  diagnostics.push({ source: 'COMPOSITION', code: 'STATUTORY_POSITION_NOT_DETERMINABLE', reason: summary.statutoryReportingPosition.reason });

  const outwardTotal = input.outward.table31.table31a;
  const outwardCompleteness: Gstr3bReconciliationReport['outwardLiability']['completeness'] =
    input.outward.meta.isCompleteGstinScope && outwardTotal.status === 'IMPLEMENTED' ? 'SUPPORTED' : 'PARTIALLY_SUPPORTED';

  return {
    meta: {
      companyId: input.companyId,
      gstRegistrationId: input.gstRegistrationId,
      gstin: input.gstin,
      stateCode: input.stateCode,
      legalName: input.legalName,
      financialYear: input.financialYear,
      taxPeriod: input.taxPeriod,
      period: input.period,
      isCompleteGstinScope: input.outward.meta.isCompleteGstinScope && input.itc.meta.isCompleteGstinScope && input.rcm.meta.isCompleteGstinScope,
      partialScopeReason: input.outward.meta.partialScopeReason ?? input.itc.meta.partialScopeReason ?? input.rcm.meta.partialScopeReason ?? null,
    },
    filingStatus: input.filingStatus,
    outwardLiability: { completeness: outwardCompleteness, report: input.outward },
    reverseCharge: { completeness: 'PARTIALLY_SUPPORTED', report: input.rcm },
    inputTaxCredit: { completeness: 'PARTIALLY_SUPPORTED', book: input.itc, presentation, twoBDerived },
    twoBReconciliation: { statementAvailable: input.statementAvailable, report: input.twoB, matrix },
    summary,
    diagnostics,
  };
}
