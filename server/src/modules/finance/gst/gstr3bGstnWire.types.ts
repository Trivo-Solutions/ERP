// G2g-7g — GSTR-3B filing/export preparation. Data contracts for the canonical, statutorily-labeled
// export representation this phase produces.
//
// IMPORTANT, read before relying on this file: unlike GSTR-1 (which has a real GSTN Offline Tool
// "Generate File" JSON upload this codebase's gstr1GstnWire.types.ts/gstr1GstnSerializer.ts verified
// byte-for-byte against a local tool install, per that file's own header), GSTR-3B has no equivalent
// public bulk-JSON-upload format on the GST portal — it is normally filed as an ONLINE summary-entry
// form (Table 3.1, 3.2, 4, 5, 5.1, 6.1, 6.2), not an uploaded file the way GSTR-1 is. No GSTN wire
// JSON schema for GSTR-3B was available or verified this session. This file therefore does NOT claim
// to be "the literal GSTN upload JSON shape" the way gstr1GstnWire.types.ts does — it is TRIVO's own
// canonical, statutorily-labeled summary representation of the frozen G2g-7f reconciliation report,
// suitable for a human preparer to transcribe into the GST portal's online form, or for a future
// phase to adapt into a real GSTN API payload once that integration is explicitly approved (see
// CLAUDE.md's G2g-7g scope boundary — no GSTN API call is made or implied by this phase).
//
// This is a COMPOSITION/RESHAPING layer only. It imports and re-presents the frozen G2g-7f
// `Gstr3bReconciliationReport` fields verbatim — see gstr3bGstnWire.ts's own header for exactly what
// is read from which frozen section. No GST figure is recalculated here.

import type { Gstr3bReconciliationSectionStatus } from './gstr3bReconciliation.types';

// ─────────────────────────────────────────────────────────────────────────────
// Completeness vocabulary — reused verbatim from the frozen G2g-7f composition layer (identical
// four-value vocabulary) rather than a second, parallel one invented here.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bExportFieldStatus = Gstr3bReconciliationSectionStatus;

export interface Gstr3bExportAmounts {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** A single statutory field this export either can or cannot populate. `amounts` is null EXACTLY
 *  when status is NOT_SUPPORTED/NOT_DETERMINABLE — never a fabricated zero standing in for
 *  "unknown" (brief §3/§10). */
export interface Gstr3bExportField {
  status: Gstr3bExportFieldStatus;
  amounts: Gstr3bExportAmounts | null;
  diagnosticCode: string | null;
  note: string;
}

/** 4(A)(3) and 4(A)(5) — never collapse ELIGIBLE/UNRESOLVED/INELIGIBLE into one number (brief §6:
 *  "Do not silently promote UNRESOLVED -> eligible / book ITC -> final filing ITC"). */
export interface Gstr3bExportItcBreakdownField {
  status: Gstr3bExportFieldStatus;
  eligible: Gstr3bExportAmounts;
  unresolved: Gstr3bExportAmounts;
  ineligible: Gstr3bExportAmounts;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.1
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportTable31 {
  outwardTaxableOther: Gstr3bExportField; // 3.1(a)
  outwardZeroRated: Gstr3bExportField; // 3.1(b)
  outwardNilExemptNonGst: Gstr3bExportField; // 3.1(c)
  /** Sourced from the frozen G2g-7d RCM engine's own `table3_1d.recognized` — NOT the outward
   *  engine's own `table31.table31d` stub, which is a permanent, always-unsupported placeholder
   *  predating the RCM engine (see gstr3bGstnWire.ts's own header for this routing decision). */
  inwardReverseCharge: Gstr3bExportField; // 3.1(d)
  nonGstOutward: Gstr3bExportField; // 3.1(e)
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.2
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportTable32Row {
  placeOfSupply: string;
  stateName: string | null;
  taxableValue: number;
  igst: number;
}

export interface Gstr3bExportTable32 {
  unregisteredPersons: { status: Gstr3bExportFieldStatus; rows: Gstr3bExportTable32Row[]; totalTaxableValue: number; totalIgst: number };
  compositionPersons: Gstr3bExportField;
  uinHolders: Gstr3bExportField;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportTable4A {
  importOfGoods: Gstr3bExportField; // 4(A)(1)
  importOfServices: Gstr3bExportField; // 4(A)(2)
  inwardReverseCharge: Gstr3bExportItcBreakdownField; // 4(A)(3)
  isd: Gstr3bExportField; // 4(A)(4)
  allOtherItc: Gstr3bExportItcBreakdownField; // 4(A)(5)
}

export interface Gstr3bExportTable4B {
  rule42And43: Gstr3bExportField; // 4(B)(1)
  others: Gstr3bExportField; // 4(B)(2)
}

export interface Gstr3bExportTable4C {
  status: Gstr3bExportFieldStatus;
  netItcAvailable: Gstr3bExportAmounts;
  componentsIncluded: string[];
  componentsExcluded: string[];
  note: string;
}

export interface Gstr3bExportTable4D {
  itcReclaimed: Gstr3bExportField; // 4(D)(1)
  ineligibleItc: Gstr3bExportField; // 4(D)(2)
}

export interface Gstr3bExportTable4 {
  table4A: Gstr3bExportTable4A;
  table4B: Gstr3bExportTable4B;
  table4C: Gstr3bExportTable4C;
  table4D: Gstr3bExportTable4D;
}

// ─────────────────────────────────────────────────────────────────────────────
// Net position — brief §10: never a field named `finalTaxLiability`. `bookPosition` is a plain
// accounting-ledger figure; `statutoryReportingPosition` stays permanently, structurally distinct.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportNetPosition {
  bookPosition: {
    outputTaxLiability: number;
    rcmLiabilityRecognized: number;
    bookItcEligible: number;
    netAmount: number;
  };
  statutoryReportingPosition: {
    status: 'NOT_DETERMINABLE';
    reason: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics — verbatim pass-through of the frozen G2g-7f report's own diagnostics array.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportDiagnostic {
  source: string;
  code: string;
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level export DTO
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bExportMetadata {
  companyId: string;
  gstRegistrationId: string;
  gstin: string;
  legalName: string;
  stateCode: string;
  financialYear: string;
  taxPeriod: string;
  periodFrom: Date;
  periodTo: Date;
  /** This phase's own export-shape identity — bump only if this file's OWN output shape changes in
   *  a future phase, same convention as GSTR-1's serializerVersion/adapterVersion constants. */
  schemaVersion: string;
  isCompleteGstinScope: boolean;
  partialScopeReason: string | null;
}

export interface Gstr3bGstnExportDto {
  metadata: Gstr3bExportMetadata;
  table31: Gstr3bExportTable31;
  table32: Gstr3bExportTable32;
  table4: Gstr3bExportTable4;
  netPosition: Gstr3bExportNetPosition;
  diagnostics: Gstr3bExportDiagnostic[];
}
