// G2g-7g — GSTR-3B filing/export preparation. Pure serializer: the frozen G2g-7f
// `Gstr3bReconciliationReport` -> the canonical `Gstr3bGstnExportDto` (gstr3bGstnWire.types.ts).
//
// No Prisma, no Date.now(), no randomness, no HTTP, never mutates its input — identical discipline
// to every pure engine this codebase's GST module already follows (gstr3bReconciliationComposition.ts,
// gstr1GstnSerializer.ts, ...). Same input always produces byte-identical output. Performs NO GST
// recalculation, NO reclassification, and NO re-aggregation — every number here is read straight off
// the frozen report; this file only reshapes and relabels it into the export DTO's statutory Table
// 3.1/3.2/4 structure, explicitly tagging each field SUPPORTED / PARTIALLY_SUPPORTED / NOT_SUPPORTED
// / NOT_DETERMINABLE and never substituting a fabricated zero for an unknown value.
//
// Routing note (read before changing anything below): Table 3.1(d) ("Inward supplies liable to
// reverse charge") is sourced from the frozen G2g-7d RCM engine's own `report.reverseCharge.report.
// table3_1d.recognized` — NOT from `report.outwardLiability.report.table31.table31d`, which is a
// permanent, always-UNSUPPORTED stub on the OUTWARD engine that predates the RCM engine's
// introduction and is never populated by anything. Using the wrong one would silently report 3.1(d)
// as always empty even when real RCM liability exists.

import type { Gstr3bReconciliationReport } from './gstr3bReconciliation.types';
import type {
  Gstr3bGstnExportDto,
  Gstr3bExportAmounts,
  Gstr3bExportField,
  Gstr3bExportFieldStatus,
  Gstr3bExportItcBreakdownField,
  Gstr3bExportTable31,
  Gstr3bExportTable32,
  Gstr3bExportTable4,
  Gstr3bExportTable4A,
  Gstr3bExportTable4B,
  Gstr3bExportTable4C,
  Gstr3bExportTable4D,
  Gstr3bExportNetPosition,
  Gstr3bExportDiagnostic,
} from './gstr3bGstnWire.types';

/** This phase's own export-shape identity (gstr3bGstnWire.types.ts's own `schemaVersion` field) —
 *  bump only if THIS file's output shape changes, never for an unrelated change. Also reused as the
 *  snapshot builder's serializer/adapter/gstnSchemaVersion identity (gstr3bFilingSnapshot.service.ts). */
export const GSTR3B_EXPORT_SCHEMA_VERSION = 'g2g-7g-1';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function amountsOf(t: { taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }): Gstr3bExportAmounts {
  return { taxableValue: round2(t.taxableValue), igst: round2(t.igst), cgst: round2(t.cgst), sgst: round2(t.sgst), cess: round2(t.cess) };
}

const ZERO_AMOUNTS: Gstr3bExportAmounts = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

function supportedField(amounts: Gstr3bExportAmounts, note: string): Gstr3bExportField {
  return { status: 'SUPPORTED', amounts, diagnosticCode: null, note };
}
function partiallySupportedField(amounts: Gstr3bExportAmounts, note: string): Gstr3bExportField {
  return { status: 'PARTIALLY_SUPPORTED', amounts, diagnosticCode: null, note };
}
/** Pass-through of a frozen G2g-7f "unsupported line" — status/diagnosticCode/reason are read
 *  verbatim, never recomputed or re-worded here. */
function passthroughUnsupportedField(line: { status: Gstr3bExportFieldStatus; diagnosticCode: string; reason: string }): Gstr3bExportField {
  return { status: line.status, amounts: null, diagnosticCode: line.diagnosticCode, note: line.reason };
}

function passthroughItcBreakdown(line: { eligible: Gstr3bExportAmounts; unresolved: Gstr3bExportAmounts; ineligible: Gstr3bExportAmounts; note: string }): Gstr3bExportItcBreakdownField {
  return {
    status: 'PARTIALLY_SUPPORTED',
    eligible: amountsOf(line.eligible),
    unresolved: amountsOf(line.unresolved),
    ineligible: amountsOf(line.ineligible),
    note: line.note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.1
// ─────────────────────────────────────────────────────────────────────────────

function buildTable31(report: Gstr3bReconciliationReport): Gstr3bExportTable31 {
  const outward = report.outwardLiability.report.table31;
  const rcm = report.reverseCharge.report.table3_1d;

  const outwardTaxableOther =
    report.outwardLiability.completeness === 'SUPPORTED'
      ? supportedField(amountsOf(outward.table31a), 'G2g-7b outward engine: gross taxable outward supply, net of credit-note/sales-return reductions, plus sales-debit-note additions.')
      : partiallySupportedField(amountsOf(outward.table31a), `Outward scope is partial (${report.outwardLiability.report.meta.partialScopeReason ?? 'branch-restricted caller or explicit branch filter'}) — this figure does not represent the complete GSTIN-wide scope for this period.`);

  const stubField = (s: { status: string; reason: string }): Gstr3bExportField => ({
    status: 'NOT_SUPPORTED',
    amounts: null,
    diagnosticCode: s.status === 'BLOCKED' ? 'TABLE31_SECTION_BLOCKED' : 'TABLE31_SECTION_UNSUPPORTED',
    note: s.reason,
  });

  const unresolvedRcm = rcm.unresolved.taxableValue !== 0 || rcm.unresolved.igst !== 0 || rcm.unresolved.cgst !== 0 || rcm.unresolved.sgst !== 0 || rcm.unresolved.cess !== 0;
  const inwardReverseCharge = unresolvedRcm
    ? partiallySupportedField(
        amountsOf(rcm.recognized),
        `G2g-7d RCM engine: recognized self-assessed RCM liability only. An additional ${JSON.stringify(amountsOf(rcm.unresolved))} is flagged RCM_UNRESOLVED (not yet a confirmed liability) and is excluded from this figure — see diagnostics.`,
      )
    : supportedField(amountsOf(rcm.recognized), 'G2g-7d RCM engine: recognized self-assessed RCM liability — no unresolved RCM lines for this period.');

  return {
    outwardTaxableOther,
    outwardZeroRated: stubField(outward.table31b),
    outwardNilExemptNonGst: stubField(outward.table31c),
    inwardReverseCharge,
    nonGstOutward: stubField(outward.table31e),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.2
// ─────────────────────────────────────────────────────────────────────────────

function buildTable32(report: Gstr3bReconciliationReport): Gstr3bExportTable32 {
  const t32 = report.outwardLiability.report.table32;
  return {
    unregisteredPersons: {
      status: 'SUPPORTED',
      rows: t32.unregisteredPersons.supplies.map((s) => ({ placeOfSupply: s.placeOfSupply, stateName: s.stateName, taxableValue: round2(s.taxableValue), igst: round2(s.igst) })),
      totalTaxableValue: round2(t32.unregisteredPersons.totalTaxableValue),
      totalIgst: round2(t32.unregisteredPersons.totalIgst),
    },
    compositionPersons: { status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: 'TABLE32_COMPOSITION_UNSUPPORTED', note: t32.compositionPersons.reason },
    uinHolders: { status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: 'TABLE32_UIN_UNSUPPORTED', note: t32.uinHolders.reason },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4 — composed verbatim from the frozen G2g-7f `inputTaxCredit.presentation` (itself already a
// merge of G2g-7c/7d) — this function recomputes nothing, it only relabels field names into this
// phase's own export vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

function buildTable4(report: Gstr3bReconciliationReport): Gstr3bExportTable4 {
  const p = report.inputTaxCredit.presentation;

  const table4A: Gstr3bExportTable4A = {
    importOfGoods: passthroughUnsupportedField(p.table4A.importOfGoods),
    importOfServices: passthroughUnsupportedField(p.table4A.importOfServices),
    inwardReverseCharge: passthroughItcBreakdown(p.table4A.inwardSuppliesLiableToRcm),
    isd: passthroughUnsupportedField(p.table4A.inwardSuppliesFromIsd),
    allOtherItc: passthroughItcBreakdown(p.table4A.allOtherItc),
  };

  const table4B: Gstr3bExportTable4B = {
    rule42And43: passthroughUnsupportedField(p.table4B.rule42And43),
    others: passthroughUnsupportedField(p.table4B.others),
  };

  const table4C: Gstr3bExportTable4C = {
    status: p.table4C.status,
    netItcAvailable: amountsOf(p.table4C.netItcAvailable),
    componentsIncluded: p.table4C.componentsIncluded,
    componentsExcluded: p.table4C.componentsExcluded,
    note: p.table4C.note,
  };

  const table4D: Gstr3bExportTable4D = {
    itcReclaimed: passthroughUnsupportedField(p.table4D.itcReclaimed),
    ineligibleItc: {
      status: p.table4D.ineligibleItc.status,
      amounts: amountsOf(p.table4D.ineligibleItc),
      diagnosticCode: null,
      note: p.table4D.ineligibleItc.note,
    },
  };

  return { table4A, table4B, table4C, table4D };
}

// ─────────────────────────────────────────────────────────────────────────────
// Net position
// ─────────────────────────────────────────────────────────────────────────────

function buildNetPosition(report: Gstr3bReconciliationReport): Gstr3bExportNetPosition {
  const bp = report.summary.bookPosition;
  return {
    bookPosition: {
      outputTaxLiability: round2(bp.outputTaxLiability),
      rcmLiabilityRecognized: round2(bp.rcmLiabilityRecognized),
      bookItcEligible: round2(bp.bookItcEligible),
      netAmount: round2(bp.estimatedNetPosition),
    },
    statutoryReportingPosition: { status: 'NOT_DETERMINABLE', reason: report.summary.statutoryReportingPosition.reason },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The serializer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serializes the frozen G2g-7f composed GSTR-3B reconciliation report into this phase's canonical
 * export DTO. Pure and side-effect free (see this file's header). Never throws for a well-formed
 * `Gstr3bReconciliationReport` — there is no structural failure mode comparable to GSTR-1's
 * serializer (no document-number/HSN/date formatting that could be malformed; every field here is
 * either a verbatim pass-through or a straightforward sum already validated upstream by the frozen
 * engines) — filing-readiness problems are instead surfaced by `validateGstr3bGstnExport` (the
 * separate pure validator, gstr3bGstnValidator.ts), never by this function raising.
 */
export function serializeGstr3bToGstnExport(report: Gstr3bReconciliationReport): Gstr3bGstnExportDto {
  const diagnostics: Gstr3bExportDiagnostic[] = report.diagnostics.map((d) => ({
    source: d.source,
    code: d.code,
    documentId: d.documentId ?? null,
    documentNumber: d.documentNumber ?? null,
    reason: d.reason,
  }));

  return {
    metadata: {
      companyId: report.meta.companyId,
      gstRegistrationId: report.meta.gstRegistrationId,
      gstin: report.meta.gstin,
      legalName: report.meta.legalName,
      stateCode: report.meta.stateCode,
      financialYear: report.meta.financialYear,
      taxPeriod: report.meta.taxPeriod,
      periodFrom: report.meta.period.from,
      periodTo: report.meta.period.to,
      schemaVersion: GSTR3B_EXPORT_SCHEMA_VERSION,
      isCompleteGstinScope: report.meta.isCompleteGstinScope,
      partialScopeReason: report.meta.partialScopeReason,
    },
    table31: buildTable31(report),
    table32: buildTable32(report),
    table4: buildTable4(report),
    netPosition: buildNetPosition(report),
    diagnostics,
  };
}

// Re-exported purely so a caller that only imports this file (not gstr3bGstnWire.types.ts directly)
// can still reference the zero-amounts constant for its own tests/fixtures if useful.
export { ZERO_AMOUNTS as GSTR3B_EXPORT_ZERO_AMOUNTS };
