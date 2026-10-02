// G2g-7e — GSTR-2B ingestion & reconciliation. Data contracts.
//
// See PHASE_G2G7E_AUDIT.md for the full read-only audit this phase is built against, including the
// honest confidence statement on §2 (GSTN wire JSON field names are a best-effort, converging-
// secondary-source reconstruction, not a byte-exact official schema — verify against a real
// portal-downloaded file before relying on this for a live filing decision). Nothing in this file
// imports Prisma, HTTP, or Date.now() — pure data shapes only.

// ─────────────────────────────────────────────────────────────────────────────
// Section / document-type / support-status vocabulary (PHASE_G2G7E_AUDIT.md §2/§3)
// ─────────────────────────────────────────────────────────────────────────────

export const GSTR2B_SECTIONS = ['B2B', 'B2BA', 'CDNR', 'CDNRA', 'ISD', 'ISDA', 'IMPG', 'IMPGSEZ'] as const;
export type Gstr2bSection = (typeof GSTR2B_SECTIONS)[number];

export type Gstr2bDocumentType = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'ISD_INVOICE' | 'IMPORT_BOE';

// SUPPORTED = this phase attempts book reconciliation; the other two are brief §7/§8's own explicit
// "preserve faithfully, do not reconcile" allowances — never silently dropped from the imported
// statement, just excluded from matching.
export type Gstr2bSupportStatus = 'SUPPORTED' | 'ISD_NOT_SUPPORTED' | 'IMPORTS_NOT_RECONCILABLE';

// ORIGINAL | AMENDED | SUPERSEDED | CURRENT (brief §15) — provenance, never collapsed away.
export type Gstr2bProvenanceStatus = 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED' | 'CURRENT';

export type Gstr2bItcAvailability = 'AVAILABLE' | 'NOT_AVAILABLE';

// Reconciliation-level availability state (G2g-7e correction, "Part 3" below). GSTR-2B itself
// distinguishes ITC Available (Table 3) from ITC Not Available (Table 4) — a document in the
// latter category must never be treated as ordinary available ITC downstream. UNKNOWN is the
// explicit third state for "the source did not state one, or the normalizer could not confidently
// locate it, or there is no 2B document to read it from at all" — it is a separate, honest value,
// never silently coerced to AVAILABLE, and never collapsed into matchStatus.
export type Gstr2bTwoBItcAvailability = Gstr2bItcAvailability | 'UNKNOWN';

// ─────────────────────────────────────────────────────────────────────────────
// Normalization output (gstr2bNormalizer.ts) — pure, no Prisma.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr2bNormalizedDocument {
  section: Gstr2bSection;
  documentType: Gstr2bDocumentType;
  supplierGstin: string | null;
  supplierTradeName: string | null;
  /** The source document's own number, or a Bill-of-Entry number for IMPG/IMPGSEZ. Verbatim, never reformatted. */
  documentNumber: string | null;
  documentDate: Date | null;
  documentValue: number | null;
  placeOfSupply: string | null;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  reverseCharge: boolean;
  itcAvailability: Gstr2bItcAvailability | null;
  ineligibilityReason: string | null;
  /** Populated only when the source payload carries an unambiguous original-document reference the
   *  normalizer could locate — never guessed. Resolved to an actual prior document id, if any, at
   *  import time (gstr2bImport.service.ts), not here. */
  amendsDocumentNumber: string | null;
  amendsDocumentDate: Date | null;
  supportStatus: Gstr2bSupportStatus;
  /** The exact source sub-object for this one document — full per-document traceability. */
  rawRecord: unknown;
}

export type Gstr2bNormalizationDiagnosticCode =
  | 'MISSING_DOCUMENT_NUMBER'
  | 'MISSING_TAXABLE_AMOUNTS'
  | 'UNRECOGNIZED_RECORD_SHAPE'
  | 'GSTIN_META_UNRESOLVED'
  | 'TAX_PERIOD_UNRESOLVED';

export interface Gstr2bNormalizationDiagnostic {
  section: string;
  code: Gstr2bNormalizationDiagnosticCode;
  reason: string;
  rawRecord?: unknown;
}

export interface Gstr2bNormalizationMeta {
  /** The source payload's own stated GSTIN, if the normalizer could confidently locate it. */
  gstin: string | null;
  /** MMYYYY, if resolvable from the source payload. */
  taxPeriod: string | null;
  /** The source's own statement-generation timestamp, if present and parseable — never fabricated. */
  generatedAt: Date | null;
}

export interface Gstr2bNormalizationResult {
  meta: Gstr2bNormalizationMeta;
  documents: Gstr2bNormalizedDocument[];
  diagnostics: Gstr2bNormalizationDiagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation (gstr2bReconciliation.ts) — pure, no Prisma.
// ─────────────────────────────────────────────────────────────────────────────

// Kept deliberately small (brief §12: "use only the statuses that are actually needed").
export type Gstr2bMatchStatus =
  | 'EXACT_MATCH'
  | 'MATCHED_WITH_NORMALIZATION'
  | 'POSSIBLE_MATCH'
  | 'AMOUNT_MISMATCH'
  | 'TAX_MISMATCH'
  | 'BOOK_MISSING'
  | 'TWO_B_MISSING'
  | 'RCM_MISMATCH'
  | 'NOT_SUPPORTED'
  | 'UNRESOLVED';

export interface Gstr2bDocumentForMatch {
  id: string; // Gst2bDocument id
  section: Gstr2bSection;
  documentType: Gstr2bDocumentType;
  supplierGstin: string | null;
  documentNumber: string | null;
  documentDate: Date | null;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  reverseCharge: boolean;
  supportStatus: Gstr2bSupportStatus;
  provenanceStatus: Gstr2bProvenanceStatus;
  /** Copied verbatim from Gst2bDocument — the source's own ITC-availability classification
   *  (null = the source did not state one / could not be confidently located). Carried through to
   *  Gstr2bMatchResult.twoBItcAvailability; never used to compute matchStatus. */
  itcAvailability: Gstr2bItcAvailability | null;
  ineligibilityReason: string | null;
}

// One book-side inward invoice, aggregated at GRN level (one GRN = one supplier bill in the common
// case — see PHASE_G2G7E_AUDIT.md §1 for why GrnItem, not GoodsReceiptNote, is the wrong grain).
export interface Gstr2bBookInvoiceLine {
  grnId: string;
  grnNumber: string;
  supplierId: string;
  supplierGstin: string | null;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  branchId: string | null;
  buyerRegistrationId: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** True when any GrnItem on this GRN produced an RcmLiability (G2g-7d) — cross-referenced against
   *  a 2B document's own reverseCharge flag (brief §9). */
  hasRcmLiability: boolean;
}

// One book-side purchase return — correlated to a 2B CDNR row at POSSIBLE_MATCH confidence only
// (PHASE_G2G7E_AUDIT.md §1/§3: no field in this codebase captures a supplier-issued note number).
export interface Gstr2bBookReturnLine {
  returnId: string;
  returnNumber: string;
  supplierId: string;
  supplierGstin: string | null;
  returnDate: Date;
  amount: number;
  cgst: number;
  sgst: number;
  igst: number;
  originalInvoiceNumber: string | null;
  originalInvoiceDate: Date | null;
}

export interface Gstr2bMoneyTotals {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr2bMatchResult {
  status: Gstr2bMatchStatus;
  section: Gstr2bSection | null;
  documentType: Gstr2bDocumentType | null;
  twoBDocumentId: string | null;
  bookReferenceId: string | null; // GRN id or PurchaseReturn id, whichever side this result anchors on
  supplierGstin: string | null;
  documentNumber: string | null;
  twoB: Gstr2bMoneyTotals | null;
  book: Gstr2bMoneyTotals | null;
  reason: string;
  /** The GSTR-2B document's own ITC-availability state (Table 3 vs. Table 4), independent of
   *  `status` above — a document can be an EXACT_MATCH on identity/amount and still be
   *  NOT_AVAILABLE here (brief correction). UNKNOWN when there is no 2B document on this match at
   *  all (BOOK_MISSING) or the source payload did not state one. Never derived from `status`, and
   *  never fed into G2g-7c's frozen eligibility classifier. */
  twoBItcAvailability: Gstr2bTwoBItcAvailability;
  /** The source's own stated reason for NOT_AVAILABLE, preserved verbatim. Null whenever
   *  twoBItcAvailability is not NOT_AVAILABLE. */
  twoBIneligibilityReason: string | null;
}

export type Gstr2bReportDiagnosticCode =
  | 'IMPORTS_NOT_RECONCILABLE'
  | 'ISD_NOT_SUPPORTED'
  | 'CDNR_MATCHING_LIMITED_TO_POSSIBLE'
  | 'AMENDMENT_LINK_NOT_RESOLVED'
  | 'SOURCE_FIELD_MAPPING_UNVERIFIED'
  | 'GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY'
  | 'PARTIAL_BRANCH_SCOPE'
  | 'NO_STATEMENT_IMPORTED';

export interface Gstr2bDiagnostic {
  code: Gstr2bReportDiagnosticCode;
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
}

export interface Gstr2bReconciliationSummary {
  totalTwoBDocuments: number;
  totalBookDocuments: number;
  exactMatch: number;
  matchedWithNormalization: number;
  possibleMatch: number;
  bookMissing: number;
  twoBMissing: number;
  amountMismatch: number;
  taxMismatch: number;
  rcmMismatch: number;
  notSupported: number;
  unresolved: number;
}

export interface Gstr2bReconciliationOptions {
  companyId: string;
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  /** Absolute-rupee tolerance before an amount difference is treated as material (brief §13: "define
   *  a deterministic tolerance... do not invent a large tolerance merely to increase match rates"). */
  amountToleranceRupees?: number;
}

export interface Gstr2bReconciliationResult {
  meta: {
    companyId: string;
    gstRegistrationId: string;
    financialYear: string;
    taxPeriod: string;
    statementId: string | null;
    statementVersion: number | null;
    statementImportedAt: Date | null;
    amountToleranceRupees: number;
  };
  summary: Gstr2bReconciliationSummary;
  rcmSummary: { matched: number; bookMissing: number; twoBMissing: number; mismatched: number };
  matches: Gstr2bMatchResult[];
  twoBTotals: Gstr2bMoneyTotals;
  bookTotals: Gstr2bMoneyTotals;
  diagnostics: Gstr2bDiagnostic[];
}
