// G2g-4c-1 — Canonical GSTN Export DTO. The intermediate representation between TRIVO's existing
// FROZEN GSTR-1 reporting engines (gstr1OutwardAggregation.ts / gstr1CreditNoteAggregation.ts /
// gstr1SalesDebitNoteAdapter.ts / gstr1Table12Aggregation.ts / gstr1Table13Aggregation.ts /
// gstr1Reporting.service.ts) and a FUTURE GSTN-offline-tool-compatible JSON serializer (G2g-4c-3,
// gated behind a validator, G2g-4c-2, neither built here).
//
//   TRIVO frozen reporting DTOs -> gstr1GstnAdapter.ts -> THIS canonical DTO -> [future] validator
//   -> [future] serializer -> GSTN offline JSON
//
// This file is TYPES ONLY — no logic, no Prisma, no transformation. See gstr1GstnAdapter.ts for the
// pure mapping layer that actually produces values of these types from the frozen engines' output.
//
// Design rules this file follows throughout (see the G2g-4c-1 brief for the full rationale of each):
//   - Every GSTN-facing object (B2B/B2CL/B2CS/CDNR/CDNUR/HSN/Documents-Issued) carries ONLY what the
//     GSTN offline-tool schema itself needs. TRIVO-internal identifiers (invoiceId, branchId,
//     sellerRegistrationId, any other source id) are NEVER present on these objects — they live
//     separately in `Gstr1GstnTraceability`, which the future serializer can omit wholesale.
//   - Money/quantity values are carried as already-computed `number` (this codebase's established
//     convention — see gstr1Normalizer.ts's own header) — never recalculated here, never decimal.js.
//   - Dates stay as `Date` — no DD-MM-YYYY (or any other) string formatting. That is the future
//     serializer's job once the exact GSTN field format is confirmed.
//   - A field this phase cannot authoritatively populate is `null`, never a fabricated value — paired
//     with a `Gstr1GstnDiagnostic` (MISSING_EXPORT_FIELD) so the gap is visible, never silent.
//   - Every "unsupported in this phase" capability (exports, advances, nil/exempt/non-GST, amendments,
//     e-commerce) is represented explicitly via `Gstr1GstnCapabilityMetadata`, never as an empty array
//     that could be misread as "zero of these happened this period."

// ─────────────────────────────────────────────────────────────────────────────
// Capability / support metadata
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr1GstnCapabilitySupport = 'SUPPORTED' | 'UNSUPPORTED';

/** What this export phase can and cannot represent. Every field is populated — "unsupported" is a
 *  first-class, explicit fact here, never conflated with "zero records this period" (see this file's
 *  own header). The SUPPORTED set matches exactly the sections the G2g-4c-1 brief lists as in scope;
 *  the UNSUPPORTED set is permanent for this phase, not a TODO the adapter silently fills in. */
export interface Gstr1GstnCapabilityMetadata {
  b2b: Gstr1GstnCapabilitySupport;
  b2cl: Gstr1GstnCapabilitySupport;
  b2cs: Gstr1GstnCapabilitySupport;
  cdnr: Gstr1GstnCapabilitySupport;
  cdnur: Gstr1GstnCapabilitySupport;
  hsnB2b: Gstr1GstnCapabilitySupport;
  hsnB2c: Gstr1GstnCapabilitySupport;
  documentsIssued: Gstr1GstnCapabilitySupport;
  /** Always 'UNSUPPORTED' in this phase — see the G2g-4c-1 brief's "Do NOT implement" list. */
  exports: Gstr1GstnCapabilitySupport;
  advances: Gstr1GstnCapabilitySupport;
  nilExemptNonGst: Gstr1GstnCapabilitySupport;
  amendments: Gstr1GstnCapabilitySupport;
  ecommerce: Gstr1GstnCapabilitySupport;
}

// ─────────────────────────────────────────────────────────────────────────────
// AATO (Annual Aggregate Turnover)
// ─────────────────────────────────────────────────────────────────────────────

/** 'MISSING' when TRIVO has no AATO record at all for the financial year in question — distinct
 *  from 'UNVERIFIED' (a record exists, nobody has confirmed it against the GST portal yet) and
 *  'VERIFIED'. Never collapsed into one another — the future validator decides whether MISSING or
 *  UNVERIFIED blocks a filing-grade export; this type only preserves the distinction (G2g-4c-1
 *  brief, "AATO" section: "do not invent AATO ... do not convert missing/unverified AATO into an
 *  authoritative 0"). */
export type Gstr1AatoVerificationState = 'VERIFIED' | 'UNVERIFIED' | 'MISSING';

export interface Gstr1TurnoverFigure {
  /** Indian FY format "YYYY-YY" (e.g. "2024-25"), or null when not even the financial year itself
   *  could be resolved. */
  financialYear: string | null;
  /** The persisted turnover figure, or null EXACTLY when `verificationState === 'MISSING'` — never
   *  a fabricated 0 standing in for "we don't know." */
  amount: number | null;
  verificationState: Gstr1AatoVerificationState;
  /** CompanyGstAato.source ('MANUAL' | 'GST_PORTAL' | 'IMPORT' | 'SYSTEM_CALCULATED' | 'OTHER'),
   *  passed through unchanged; null when there is no record to read it from. */
  source: string | null;
}

export interface Gstr1AatoMetadata {
  precedingFy: Gstr1TurnoverFigure;
  currentFy: Gstr1TurnoverFigure;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filing period
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1FilingPeriod {
  /** The internal reporting-period boundaries this export was built from (Asia/Kolkata calendar-day
   *  boundaries, already resolved upstream — see gstr1Reporting.service.ts). */
  internalFrom: Date;
  internalTo: Date;
  /** The GSTN statutory filing period in MMYYYY form (e.g. "092026"), ONLY when the caller has
   *  already determined the internal date range maps unambiguously onto exactly one such period —
   *  this adapter never derives it itself (G2g-4c-1 brief: "do not silently convert an arbitrary
   *  date range into a filing period"; "exact monthly/quarterly validity belongs to the future
   *  validator"). Null when not supplied/not resolvable — never guessed from internalFrom/internalTo. */
  filingPeriodMmYYYY: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export metadata
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder only. The G2g-4c-1 brief explicitly forbids hard-coding a schema version (e.g.
 *  "GST3.2") into business logic as an immutable assumption — the real value will be confirmed and
 *  wired by the serializer phase (G2g-4c-3) against the then-current official GSTN offline-tool
 *  specification. Exported purely as a typed fallback for a caller that has no confirmed version
 *  yet; this adapter's own logic never branches on it. */
export const GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED = 'UNSPECIFIED' as const;

export interface Gstr1GstnExportMetadata {
  /** This GST registration's own GSTIN — the export is always scoped to ONE registration (see the
   *  G2g-4c-1 brief's "Filing scope" section); never a company-wide or branch-level mixture. */
  gstin: string;
  legalName: string;
  tradeName: string | null;
  period: Gstr1FilingPeriod;
  /** Typed/configurable — see GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED's own comment. */
  schemaVersion: string;
  aato: Gstr1AatoMetadata;
  /** True when this export does NOT represent the complete GST-registration-wide scope (e.g. it was
   *  built from a single-branch report, or from a caller whose own branch access is restricted) —
   *  the G2g-4c-1 brief requires this to be preserved so a future validator/service can refuse a
   *  partial-branch export from ever being treated as a complete filing. */
  isPartialBranchExport: boolean;
  capabilities: Gstr1GstnCapabilityMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared money shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One GST-rate slice of a B2B/B2CL document's own lines — the GSTN schema's own "item/rate group"
 *  concept, keyed by rate alone (never HSN — GSTN's B2B/B2CL item arrays are not HSN-keyed). */
export interface Gstr1GstnRateGroup {
  rate: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// B2B — Table 4
// ─────────────────────────────────────────────────────────────────────────────

/** GSTN's own B2B invoice-type codes. TRIVO has no persisted SEZ/deemed-export indicator on any
 *  sale (see the module header's "a field this phase cannot authoritatively populate" rule) — this
 *  type exists so a future phase that DOES capture that distinction has somewhere typed to put it;
 *  this adapter itself never sets a value here (always null — see gstr1GstnAdapter.ts). */
export type Gstr1GstnB2bInvoiceType = 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW';

export interface Gstr1GstnB2bInvoice {
  recipientGstin: string;
  invoiceNumber: string;
  /** null when the source invoice itself carried no resolvable date (a data-quality gap — see this
   *  export's own MISSING_EXPORT_FIELD diagnostic) — never defaulted to "today" or to the filing
   *  period's own boundary. */
  invoiceDate: Date | null;
  /** Tax-inclusive document total (the persisted, authoritative figure — never a sum of
   *  `rateGroups`). */
  invoiceValue: number;
  placeOfSupply: string | null;
  /** null when TRIVO's own source fact was itself null/unset — never fabricated as false. */
  reverseCharge: boolean | null;
  /** Always null in this phase — see Gstr1GstnB2bInvoiceType's own comment and this export's
   *  MISSING_EXPORT_FIELD diagnostic. */
  invoiceType: Gstr1GstnB2bInvoiceType | null;
  rateGroups: Gstr1GstnRateGroup[];
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// B2CL — Table 5
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1GstnB2clInvoice {
  placeOfSupply: string;
  invoiceNumber: string;
  /** In practice always present by the time a record reaches B2CL (gstr1Classification.ts's own
   *  threshold check requires a valid invoice date before B2CL can even be decided) — still typed
   *  nullable, never force-unwrapped, matching the frozen record's own defensive typing. */
  invoiceDate: Date | null;
  invoiceValue: number;
  rateGroups: Gstr1GstnRateGroup[];
  taxableValue: number;
  /** B2CL is, by classification, always inter-state (gstr1Classification.ts) — igst only, cgst/sgst
   *  are not meaningful here and are not carried on this type at all (unlike the shared
   *  Gstr1GstnRateGroup, which keeps them for B2B's benefit). */
  igst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// B2CS — Table 7
// ─────────────────────────────────────────────────────────────────────────────

/** GSTN's own B2CS "type" dimension — "Other than E-commerce" vs "E-commerce operator". TRIVO has
 *  no e-commerce-operator sales flow at all (see the G2g-4c-1 brief's explicit "Do NOT implement:
 *  e-commerce-specific sections"), so this adapter only ever produces 'OE' — never fabricated as
 *  'E', and e-commerce is additionally called out as UNSUPPORTED in `Gstr1GstnCapabilityMetadata`. */
export type Gstr1GstnB2csEcommerceType = 'OE';

/** One GSTN Table 7 B2CS aggregation bucket. GSTN's own B2CS schema has NO HSN/UQC dimension at
 *  all — TRIVO's internal B2CS aggregation (gstr1OutwardAggregation.ts's `Gstr1B2csGroup`) retains
 *  HSN/UQC for its own diagnostic purposes, but this adapter collapses that down to exactly the
 *  dimensions GSTN's own schema actually keys on (supply type, place of supply, inter/intra-state,
 *  rate) — see gstr1GstnAdapter.ts's own collapsing logic. Never a 1:1 passthrough of the internal
 *  HSN/UQC-split groups (G2g-4c-1 brief's explicit "do not simply delete HSN/UQC and leave
 *  duplicate records"). */
export interface Gstr1GstnB2csRecord {
  ecommerceSupplyType: Gstr1GstnB2csEcommerceType;
  supplyType: 'INTRA_STATE' | 'INTER_STATE';
  placeOfSupply: string;
  rate: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CDNR / CDNUR — Table 9B (Credit Notes `ntty: 'C'`, Sales Debit Notes `ntty: 'D'`)
// ─────────────────────────────────────────────────────────────────────────────

/** 'C' = Credit Note, 'D' = (Sales/outward) Debit Note — GSTN's own `ntty` distinction. Never to be
 *  confused with this codebase's procurement-side `DebitNote` model, which is a wholly separate,
 *  purchase-side domain that MUST NEVER reach outward GSTR-1 at all (see gstr1GstnAdapter.ts's own
 *  header — the adapter has no code path that could even accept one). */
export type Gstr1GstnNoteType = 'C' | 'D';

export interface Gstr1GstnCdnrNote {
  noteType: Gstr1GstnNoteType;
  recipientGstin: string;
  noteNumber: string;
  noteDate: Date;
  /** Tax-inclusive note total — the Credit Note's/Sales Debit Note's own persisted positive value.
   *  Direction (reduction vs. addition) is carried by `noteType` alone, per GSTN's own convention —
   *  never represented here as a negative number for a Credit Note (see the frozen
   *  gstr1CreditNoteAggregation.ts's own `sign` field, which exists for exactly this reason upstream
   *  and is intentionally not reproduced on this GSTN-facing shape). */
  noteValue: number;
  placeOfSupply: string | null;
  rateGroups: Gstr1GstnRateGroup[];
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr1GstnCdnurNote {
  noteType: Gstr1GstnNoteType;
  noteNumber: string;
  noteDate: Date;
  noteValue: number;
  placeOfSupply: string | null;
  rateGroups: Gstr1GstnRateGroup[];
  taxableValue: number;
  igst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HSN summary — Table 12 (hsn_b2b / hsn_b2c)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1GstnHsnSummaryRow {
  hsnCode: string | null;
  description: string | null;
  uqc: string | null;
  quantity: number;
  rate: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** GSTN's Table 12 `val` (total invoice value for the HSN bucket). Always null in this phase — the
   *  frozen `aggregateGstr1Table12()` output carries no authoritative total-value figure at the
   *  bucket level (only taxableValue + the individual tax components), and the G2g-4c-1 brief
   *  explicitly forbids deriving `val = txval + tax` here. Paired with a MISSING_EXPORT_FIELD
   *  diagnostic; the future serializer/validator decides how (or whether) to derive it. */
  totalValue: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents Issued — Table 13
// ─────────────────────────────────────────────────────────────────────────────

/** Only the three TRIVO document categories this phase has an established GSTN mapping for — see
 *  gstr1GstnAdapter.ts's own mapping function. Every other `Table13DocumentCategory` the frozen
 *  Table 13 engine type permits (DELIVERY_CHALLAN, RECEIPT_VOUCHER, PAYMENT_VOUCHER, REFUND_VOUCHER,
 *  OTHER) is not currently produced by any TRIVO loader and is excluded here with an INVALID_MAPPING
 *  diagnostic rather than guessed at (G2g-4c-1 brief: "do not invent document categories"). */
export type Gstr1GstnDocumentIssuedCategory = 'INVOICES_FOR_OUTWARD_SUPPLY' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface Gstr1GstnDocumentSeries {
  documentCategory: Gstr1GstnDocumentIssuedCategory;
  sellerRegistrationId: string | null;
  seriesPrefix: string;
  financialYear: number | null;
  fromDocumentNumber: string;
  toDocumentNumber: string;
  fromSerial: number;
  toSerial: number;
  totalIssued: number;
  /** Real cancelled/VOID documents only — the frozen Table 13 engine already keeps an unexplained
   *  sequence gap as its own diagnostic and NEVER folds it into this count (see
   *  gstr1Table13Aggregation.ts's own rule 6); this field is a verbatim passthrough of that engine's
   *  own `cancelledDocuments`, never recomputed. */
  cancelled: number;
  netIssued: number;
  filingEligible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Traceability — kept structurally separate from every GSTN-facing object above (none of them carry
// a TRIVO id). The future serializer can drop this entire structure with zero effect on the GSTN
// payload itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1GstnTraceability {
  sourceRegistrationId: string;
  b2bInvoiceIds: string[];
  b2clInvoiceIds: string[];
  cdnrCreditNoteIds: string[];
  cdnurCreditNoteIds: string[];
  cdnrDebitNoteIds: string[];
  cdnurDebitNoteIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics — the adapter's OWN mapping-limitation notes (never the frozen engines' own
// diagnostics, which already have their own typed shapes and stay on their own reports). Severity
// (blocking vs. warning) is deliberately NOT decided here — that is G2g-4c-2's job.
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr1GstnDiagnosticCode =
  | 'UNSUPPORTED_SECTION'
  | 'MISSING_EXPORT_FIELD'
  | 'INVALID_MAPPING'
  | 'PARTIAL_BRANCH_SCOPE'
  | 'AATO_NOT_VERIFIED'
  | 'AMENDMENT_DATA_UNAVAILABLE';

export interface Gstr1GstnDiagnostic {
  code: Gstr1GstnDiagnosticCode;
  message: string;
  /** Loose, human-readable scope tag ('B2B' | 'TABLE_12' | 'TABLE_13' | 'AATO' | 'SCOPE' |
   *  'AMENDMENTS' | ...) — not a statutory field, purely for a human/validator to locate which part
   *  of the export a diagnostic concerns. */
  section?: string;
  documentId?: string;
  documentNumber?: string;
  field?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The canonical DTO
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1GstnExportDto {
  metadata: Gstr1GstnExportMetadata;
  b2b: Gstr1GstnB2bInvoice[];
  b2cl: Gstr1GstnB2clInvoice[];
  b2cs: Gstr1GstnB2csRecord[];
  cdnr: Gstr1GstnCdnrNote[];
  cdnur: Gstr1GstnCdnurNote[];
  hsnB2b: Gstr1GstnHsnSummaryRow[];
  hsnB2c: Gstr1GstnHsnSummaryRow[];
  documentsIssued: Gstr1GstnDocumentSeries[];
  traceability: Gstr1GstnTraceability;
  diagnostics: Gstr1GstnDiagnostic[];
}
