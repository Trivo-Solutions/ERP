// G2g-7b — GSTR-3B Outward Tax Liability Data Contracts.
// Typed data models for GSTR-3B Table 3.1 and Table 3.2 pure aggregation, reporting service,
// and HTTP responses.
//
// Statutory references:
// - CBIC Circular No. 170/02/2022-GST (Table 3.1 and Table 3.2 reporting requirements)
// - CGST Act Section 34 (Credit and Debit Notes)
// - CGST Rules Rule 61 (Form and manner of submission of return in FORM GSTR-3B)

import type { BranchAccess } from '../../../shared/tenantContext';

// ─────────────────────────────────────────────────────────────────────────────
// Source Document Shapes (Pure Engine Input Contracts)
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bTaxInvoiceDetail {
  buyerGstin: string | null;
  placeOfSupply: string | null;
  sellerStateCode: string | null;
  sellerRegistrationId: string | null;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  totalTax: number;
  reverseCharge: boolean;
}

export interface Gstr3bOutwardSourceInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date | null | undefined;
  status: string;
  branchId: string | null | undefined;
  totalAmount: number;
  otherCharges: number;
  taxDetails: Gstr3bTaxInvoiceDetail | null;
  itemsCount: number;
}

export interface Gstr3bOutwardSourceCreditNote {
  id: string;
  creditNoteNumber: string;
  creditNoteDate: Date | null | undefined;
  status: string;
  branchId: string | null | undefined;
  invoiceId: string;
  salesReturnId: string | null;
  sellerRegistrationId: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  totalTax: number;
  totalAmount: number;
}

export interface Gstr3bOutwardSourceSalesDebitNote {
  id: string;
  debitNoteNumber: string;
  debitNoteDate: Date | null | undefined;
  status: string;
  branchId: string | null | undefined;
  invoiceId: string;
  sellerRegistrationId: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  totalTax: number;
  totalAmount: number;
}

export interface Gstr3bOutwardSourceSalesReturn {
  id: string;
  returnNumber: string;
  returnDate: Date | null | undefined;
  branchId: string | null | undefined;
  invoiceId: string;
  sellerRegistrationId: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  totalAmount: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  creditNoteId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine Options
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bOutwardAggregationPeriod {
  from: Date;
  to: Date;
  financialYear: string;
  taxPeriod: string;
}

export interface Gstr3bOutwardAggregationOptions {
  companyId: string;
  gstRegistrationId: string;
  sellerGstin: string;
  sellerStateCode: string;
  period: Gstr3bOutwardAggregationPeriod;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money & Totals
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bMoneyTotals {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.1 Structures
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bTable31aDocumentCounts {
  activeInvoices: number;
  salesDebitNotes: number;
  pathBStandaloneCreditNotes: number;
  pathACreditNotes: number;
  unwrappedSalesReturns: number;
  deduplicatedSalesReturns: number;
  voidInvoices: number;
  cancelledCreditNotes: number;
  cancelledSalesDebitNotes: number;
}

export interface Gstr3bTable31aTaxableOutward extends Gstr3bMoneyTotals {
  status: 'IMPLEMENTED';
  grossTaxableValue: number;
  grossIgst: number;
  grossCgst: number;
  grossSgst: number;
  grossCess: number;
  creditNoteReductions: Gstr3bMoneyTotals;
  salesReturnReductions: Gstr3bMoneyTotals;
  salesDebitNoteAdditions: Gstr3bMoneyTotals;
  documentCounts: Gstr3bTable31aDocumentCounts;
}

export type Gstr3bUnsupportedStatus = 'UNSUPPORTED' | 'BLOCKED';

export interface Gstr3bTable31SectionUnsupported {
  status: Gstr3bUnsupportedStatus;
  reason: string;
  taxableValue: 0;
  igst: 0;
  cgst: 0;
  sgst: 0;
  cess: 0;
}

export interface Gstr3bTable31 {
  table31a: Gstr3bTable31aTaxableOutward;
  table31b: Gstr3bTable31SectionUnsupported;
  table31c: Gstr3bTable31SectionUnsupported;
  table31d: Gstr3bTable31SectionUnsupported;
  table31e: Gstr3bTable31SectionUnsupported;
  table311: Gstr3bTable31SectionUnsupported;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table 3.2 Structures
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bTable32UnregisteredEntry {
  placeOfSupply: string;
  stateName: string | null;
  taxableValue: number;
  igst: number;
  documentCounts: {
    invoices: number;
    salesDebitNotes: number;
    creditNotes: number;
    unwrappedSalesReturns: number;
  };
}

export interface Gstr3bTable32UnregisteredSection {
  status: 'IMPLEMENTED';
  totalTaxableValue: number;
  totalIgst: number;
  supplies: Gstr3bTable32UnregisteredEntry[];
}

export interface Gstr3bTable32UnsupportedSection {
  status: Gstr3bUnsupportedStatus;
  reason: string;
  totalTaxableValue: 0;
  totalIgst: 0;
  supplies: [];
}

export interface Gstr3bTable32 {
  unregisteredPersons: Gstr3bTable32UnregisteredSection;
  compositionPersons: Gstr3bTable32UnsupportedSection;
  uinHolders: Gstr3bTable32UnsupportedSection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr3bDiagnosticCode =
  | 'MISSING_SELLER_REGISTRATION'
  | 'EXCLUDED_VOID'
  | 'EXCLUDED_CANCELLED'
  | 'MISSING_TAX_INVOICE'
  | 'OUTWARD_OTHER_CHARGES_INCLUDED'
  | 'OUTWARD_OTHER_CHARGES_UNCLASSIFIED'
  | 'SALES_RETURN_WRAPPED_BY_CREDIT_NOTE'
  | 'UNWRAPPED_SALES_RETURN_NO_CREDIT_NOTE'
  | 'INVALID_BUYER_GSTIN'
  | 'PARTIAL_BRANCH_SCOPE'
  | 'NEGATIVE_NET_TAXABLE_LIABILITY'
  | 'NEGATIVE_NET_TAX_LIABILITY';

export interface Gstr3bDiagnostic {
  code: Gstr3bDiagnosticCode;
  documentType: 'INVOICE' | 'CREDIT_NOTE' | 'SALES_DEBIT_NOTE' | 'SALES_RETURN' | 'REPORT_SCOPE';
  documentId?: string | null;
  documentNumber?: string | null;
  reason: string;
  amountDetails?: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation Result & Meta
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bOutwardAggregationMeta {
  companyId: string;
  gstRegistrationId: string;
  sellerGstin: string;
  sellerStateCode: string;
  financialYear: string;
  taxPeriod: string;
  period: {
    from: Date;
    to: Date;
  };
  isCompleteGstinScope: boolean;
  partialScopeReason: string | null;
  otherChargesBreakdown: {
    invoiceCountWithOtherCharges: number;
    totalOtherChargesTaxable: number;
  };
  sourceCounts: {
    invoicesConsidered: number;
    invoicesExcludedByScope: number;
    creditNotesConsidered: number;
    creditNotesExcludedByScope: number;
    salesDebitNotesConsidered: number;
    salesDebitNotesExcludedByScope: number;
    salesReturnsConsidered: number;
    salesReturnsExcludedByScope: number;
  };
}

export interface Gstr3bOutwardAggregationResult {
  meta: Gstr3bOutwardAggregationMeta;
  table31: Gstr3bTable31;
  table32: Gstr3bTable32;
  diagnostics: Gstr3bDiagnostic[];
}
