/**
 * GSTR-1 Reporting Types for Tables 4, 5, 7, and 9B.
 * Authoritative types matching the frozen backend GSTR-1 aggregation engines:
 * - gstr1OutwardAggregation.ts (Tables 4, 5, 7)
 * - gstr1CreditNoteAggregation.ts (Table 9B)
 */

export interface Gstr1MoneyTotals {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

export interface Gstr1LineDetail extends Gstr1MoneyTotals {
  hsnCode: string | null;
  gstRate: number;
  uqc: string | null;
  uqcSource?: string;
  quantity: number;
  quantityBasis?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 4: B2B Invoices (Registered Recipients)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1B2bInvoiceRecord {
  category: 'B2B';
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string | Date | null;
  buyerGstin: string;
  placeOfSupply: string | null;
  isInterState: boolean | null;
  reverseCharge: boolean | null;
  sellerRegistrationId: string;
  invoiceValue: number;
  totals: Gstr1MoneyTotals;
  lines: Gstr1LineDetail[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 5: B2CL Invoices (Large Unregistered Inter-State Supplies)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1B2clInvoiceRecord {
  category: 'B2CL';
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string | Date | null;
  placeOfSupply: string;
  sellerRegistrationId: string;
  invoiceValue: number;
  threshold: number;
  totals: Gstr1MoneyTotals;
  lines: Gstr1LineDetail[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 7: B2CS (Small Unregistered Supplies with Net-off)
// Gross - Credit Note Reduction = Net
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1B2csGroup extends Gstr1MoneyTotals {
  placeOfSupply: string;
  isInterState: boolean;
  gstRate: number;
  hsnCode: string | null;
  uqc: string | null;
  quantity: number;
  recordCount: number;

  // Phase A: Gross outward supplies
  grossTaxableValue: number;
  grossCgst: number;
  grossSgst: number;
  grossIgst: number;
  grossCess: number;
  grossQuantity: number;

  // Phase A: Credit note reductions
  creditNoteTaxableReduction: number;
  creditNoteCgstReduction: number;
  creditNoteSgstReduction: number;
  creditNoteIgstReduction: number;
  creditNoteCessReduction: number;
  creditNoteQuantityReduction: number;
  creditNoteRecordCount: number;

  // Statutory filing status
  filingEligible: boolean;
}

export interface Gstr1OutwardDiagnostic {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string | Date | null;
  reportability: 'EXCLUDED_VOID' | 'UNCLASSIFIED' | string;
  reason: string;
}

export type Gstr1B2csCreditNoteDiagnosticReason =
  | 'CREDIT_NOTE_EXCLUDED'
  | 'NEGATIVE_NET_B2CS_BUCKET'
  | 'DUPLICATE_CREDIT_NOTE_ID'
  | string;

export interface Gstr1B2csCreditNoteDiagnostic {
  reason: Gstr1B2csCreditNoteDiagnosticReason;
  detail: string;
  creditNoteId?: string;
  creditNoteNumber?: string | null;
  placeOfSupply?: string | null;
  gstRate?: number;
  hsnCode?: string | null;
  uqc?: string | null;
}

export interface Gstr1OutwardTotals {
  b2b: Gstr1MoneyTotals & { invoiceValue: number; invoiceCount: number };
  b2cl: Gstr1MoneyTotals & { invoiceValue: number; invoiceCount: number };
  b2cs: Gstr1MoneyTotals & { invoiceValue: number; recordCount: number };
  grandTotal: Gstr1MoneyTotals & { invoiceValue: number };
}

export interface Gstr1OutwardResponse {
  b2b: Gstr1B2bInvoiceRecord[];
  b2cl: Gstr1B2clInvoiceRecord[];
  b2cs: Gstr1B2csGroup[];
  diagnostics: Gstr1OutwardDiagnostic[];
  b2csCreditNoteDiagnostics: Gstr1B2csCreditNoteDiagnostic[];
  totals: Gstr1OutwardTotals;
  meta: {
    gstRegistrationId: string;
    period: { from: string | Date; to: string | Date };
    invoicesConsidered: number;
    invoicesExcludedByScope: number;
    creditNotesConsideredForNetOff: number;
    creditNotesExcludedByScope: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 9B: Credit / Debit Notes (CDNR / CDNUR)
// Registered: CDNR
// Unregistered/Export: CDNUR (B2CL / Export)
// CRITICAL: NO CDNUR B2CS
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1CreditNoteRateBreakdown {
  rate: number;
  hsnCode: string | null;
  uqc: string | null;
  quantity: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr1CreditNoteDiagnostic {
  code: string;
  lineIndex?: number;
  description?: string;
}

export interface Gstr1CreditNoteReportDocument {
  documentType: 'CREDIT_NOTE';
  sign: -1;
  creditNoteId: string;
  creditNoteNumber: string;
  creditNoteDate: string | Date;
  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: string | Date;
  buyerGstin: string | null;
  sellerRegistrationId: string;
  placeOfSupply: string | null;
  originalSupplyCategory: string;
  sourcePath: string;
  reasonCode: string;
  reasonNotes: string | null;
  noteValue: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  rateBreakdown: Gstr1CreditNoteRateBreakdown[];
  diagnostics: Gstr1CreditNoteDiagnostic[];
}

export interface Gstr1CreditNoteBucketSummary {
  documentCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  noteValue: number;
}

export interface Gstr1CreditNoteBucket {
  documents: Gstr1CreditNoteReportDocument[];
  summary: Gstr1CreditNoteBucketSummary;
}

export interface Gstr1CreditNoteAggregationDiagnostic {
  creditNoteId: string;
  creditNoteNumber: string | null;
  reason: string;
  detail: string;
}

export interface Gstr1CreditNoteExclusionRecord {
  creditNoteId: string;
  creditNoteNumber: string;
  creditNoteDate: string | Date;
  exclusionReason: string;
  diagnostics: Gstr1CreditNoteDiagnostic[];
}

export interface Gstr1CreditNoteResponse {
  cdnr: Gstr1CreditNoteBucket;
  cdnur: {
    b2cl: Gstr1CreditNoteBucket;
    export: Gstr1CreditNoteBucket;
  };
  b2csNetOff?: Gstr1CreditNoteBucket;
  diagnostics: Gstr1CreditNoteAggregationDiagnostic[];
  excluded: Gstr1CreditNoteExclusionRecord[];
  meta: {
    gstRegistrationId: string;
    period: { from: string | Date; to: string | Date };
    notesConsidered: number;
    notesExcludedByScope: number;
  };
}
