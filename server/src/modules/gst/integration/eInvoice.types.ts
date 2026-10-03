// G8c — provider-NEUTRAL e-invoice (IRN) contract. No NIC/IRP wire field names appear here (no
// SellerDtls/TranDtls/AssAmt/...): an adapter maps this to its own wire format and maps its response
// back into EInvoiceGenerationResult, so nothing provider-specific leaks past providers/.
// Framework-agnostic (no Prisma import), same "pure types" shape as types.ts.

export type EInvoiceDocumentType = 'INV' | 'CRN' | 'DBN';

/** Only INV has a builder in G8c; CRN/DBN are recognised so eligibility can refuse them explicitly. */
export const EINVOICE_SUPPORTED_DOCUMENT_TYPES: readonly EInvoiceDocumentType[] = ['INV'];

export type EInvoiceSupplyType = 'B2B';

export interface CanonicalIrnParty {
  gstin: string;
  legalName: string;
  tradeName: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  pincode: string;
  stateCode: string;
}

export interface CanonicalIrnLine {
  lineNumber: number;
  description: string;
  isService: boolean;
  hsnCode: string;
  quantity: number;
  uqc: string | null;
  unitPrice: number;
  /** Paisa gap between the persisted gross and quantity x unitPrice; 0 when they reconcile exactly. */
  unitPriceDrift: number;
  grossAmount: number;
  discountAmount: number;
  taxableValue: number;
  gstRatePercent: number;
  igstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  cessAmount: number;
  totalAmount: number;
}

export interface CanonicalIrnRequest {
  documentType: EInvoiceDocumentType;
  documentNumber: string;
  /** ISO calendar date, YYYY-MM-DD. */
  documentDate: string;
  supplyType: EInvoiceSupplyType;
  reverseCharge: boolean;
  /** Inter-state-style IGST charged although seller and buyer are in the same state. */
  igstOnIntra: boolean;
  seller: CanonicalIrnParty;
  buyer: CanonicalIrnParty;
  placeOfSupplyStateCode: string;
  currency: 'INR';
  lines: CanonicalIrnLine[];
  totals: {
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    otherCharges: number;
    roundOff: number;
    invoiceTotal: number;
  };
}

/** Normalized outcome of a provider's IRN generation — never a provider-shaped object. */
export interface EInvoiceGenerationResult {
  status: 'GENERATED';
  irn: string;
  ackNumber: string;
  /** ISO timestamp (provider local time as supplied, normalized). */
  ackDate: string;
  signedInvoice: string | null;
  signedQrCode: string | null;
  /** The provider's own status for the IRN (e.g. 'ACT'), as supplied. */
  providerStatus: string | null;
  providerTimestamp: string | null;
}

// ─── Eligibility ───────────────────────────────────────────────────────────

export type EInvoiceEligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'CANNOT_DETERMINE';

export interface EInvoiceReason {
  code: string;
  message: string;
  /** NOT_ELIGIBLE = a fact that rules this document out; MISSING_DATA = TRIVO cannot tell. */
  kind: 'NOT_ELIGIBLE' | 'MISSING_DATA' | 'INFO';
}

export interface EInvoiceEligibilityResult {
  status: EInvoiceEligibilityStatus;
  /** Whether TRIVO can POST this document to an IRP. Separate from legal obligation below. */
  technicallyEligible: boolean;
  /** Whether the taxpayer is LEGALLY required to e-invoice — always NOT_DETERMINABLE: no
   *  authoritative, verified turnover/threshold value feeds this engine (A vs B in the G8c brief). */
  statutoryApplicability: 'NOT_DETERMINABLE';
  blockingReasons: EInvoiceReason[];
  warnings: EInvoiceReason[];
  documentType: EInvoiceDocumentType;
  documentId: string;
  registrationId: string;
  gstin: string | null;
  supplyType: EInvoiceSupplyType | null;
}

// ─── Source facts (what the loader hands the pure engine) ─────────────────

export type Numeric = number | string | { toString(): string };

export interface EInvoiceSource {
  documentType: EInvoiceDocumentType;
  /** The registration the caller asked to issue under (already ownership-checked by the service). */
  registration: { id: string; companyId: string; gstin: string; isActive: boolean };
  invoice: {
    id: string;
    companyId: string;
    invoiceNumber: string;
    invoiceDate: Date;
    status: string;
    currency: string;
    subtotal: Numeric;
    discountAmount: Numeric;
    otherCharges: Numeric;
    taxAmount: Numeric;
    roundOff: Numeric;
    totalAmount: Numeric;
    /** gstRegistrationId of the invoice's branch, or null when that branch has none. */
    branchGstRegistrationId: string | null;
  };
  tax: {
    gstin: string;
    placeOfSupply: string;
    reverseCharge: boolean;
    cgst: Numeric;
    sgst: Numeric;
    igst: Numeric;
    cess: Numeric;
    irn: string | null;
    sellerRegistrationId: string | null;
    sellerLegalName: string | null;
    sellerTradeName: string | null;
    sellerStateCode: string | null;
    sellerAddress: string | null;
    sellerCity: string | null;
    sellerPincode: string | null;
    buyerName: string | null;
    buyerGstin: string | null;
    buyerAddress: string | null;
    buyerCity: string | null;
    buyerStateCode: string | null;
    buyerPincode: string | null;
    buyerCountry: string | null;
  } | null;
  items: Array<{
    id: string;
    description: string;
    quantity: number;
    /** Persisted InvoiceItem.unitPrice (2 dp), when the loader supplies it. */
    unitPrice?: Numeric;
    uqc: string | null;
    hsnCode: string | null;
    /** Fraction (0.03 = 3%), as persisted on InvoiceItem.taxRate. */
    taxRate: Numeric;
    taxableValue: Numeric;
    lineDiscountAmount: Numeric;
    cgstAmount: Numeric;
    sgstAmount: Numeric;
    igstAmount: Numeric;
  }>;
}
