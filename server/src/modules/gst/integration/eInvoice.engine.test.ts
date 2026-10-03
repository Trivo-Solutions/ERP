import { describe, it, expect } from 'vitest';
import { evaluateEInvoiceEligibility } from './eInvoiceEligibility';
import { buildCanonicalIrnRequest } from './eInvoiceRequestBuilder';
import { EInvoiceSource } from './eInvoice.types';
import { NicIrpProvider } from './providers/nicIrpProvider';
import { UnconfiguredProvider } from './providers/unconfiguredProvider';
import { resolveProvider } from './providers/resolveProvider';

import { makeGstin } from './eInvoice.testUtil';
const SELLER = makeGstin('24', 'SELLR', '1111');
const BUYER = makeGstin('24', 'BUYER', '2222');
const BUYER_OTHER_STATE = makeGstin('27', 'BUYER', '3333');

function source(over: (s: EInvoiceSource) => void = () => {}): EInvoiceSource {
  const s: EInvoiceSource = {
    documentType: 'INV',
    registration: { id: 'reg1', companyId: 'co1', gstin: SELLER, isActive: true },
    invoice: {
      id: 'inv1', companyId: 'co1', invoiceNumber: 'INV/2026/0001', invoiceDate: new Date('2026-09-01T00:00:00Z'), status: 'ISSUED',
      currency: 'INR', subtotal: '10000', discountAmount: '0', otherCharges: '0', taxAmount: '300', roundOff: '0', totalAmount: '10300',
      branchGstRegistrationId: null,
    },
    tax: {
      gstin: SELLER, placeOfSupply: '24', reverseCharge: false, cgst: '150', sgst: '150', igst: '0', cess: '0', irn: null,
      sellerRegistrationId: 'reg1', sellerLegalName: 'Seller Jewels Pvt Ltd', sellerTradeName: 'Seller Jewels', sellerStateCode: '24',
      sellerAddress: '12 Ring Road', sellerCity: 'Surat', sellerPincode: '395002',
      buyerName: 'Buyer Traders', buyerGstin: BUYER, buyerAddress: '5 Market Street', buyerCity: 'Ahmedabad', buyerStateCode: '24', buyerPincode: '380001', buyerCountry: 'India',
    },
    items: [{
      id: 'i1', description: 'Gold ring 22K', quantity: 2, uqc: 'PCS', hsnCode: '7113', taxRate: '0.03',
      taxableValue: '10000', lineDiscountAmount: '0', cgstAmount: '150', sgstAmount: '150', igstAmount: '0',
    }],
  };
  over(s);
  return s;
}
const codes = (s: EInvoiceSource) => evaluateEInvoiceEligibility(s).blockingReasons.map((r) => r.code);

describe('G8c eligibility engine', () => {
  it('a complete B2B invoice is technically eligible, with statutory applicability explicitly NOT_DETERMINABLE', () => {
    const r = evaluateEInvoiceEligibility(source());
    expect(r).toMatchObject({ status: 'ELIGIBLE', technicallyEligible: true, statutoryApplicability: 'NOT_DETERMINABLE', supplyType: 'B2B', documentId: 'inv1', registrationId: 'reg1', gstin: SELLER });
    expect(r.blockingReasons).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain('STATUTORY_APPLICABILITY_NOT_DETERMINABLE');
  });

  it('is deterministic (same input → identical result)', () => {
    expect(evaluateEInvoiceEligibility(source())).toEqual(evaluateEInvoiceEligibility(source()));
  });

  it('missing GST registration on the invoice → CANNOT_DETERMINE, never eligible', () => {
    const r = evaluateEInvoiceEligibility(source((s) => { s.tax!.sellerRegistrationId = null; }));
    expect(r.status).toBe('CANNOT_DETERMINE');
    expect(r.technicallyEligible).toBe(false);
    expect(r.blockingReasons.map((x) => x.code)).toContain('SELLER_REGISTRATION_MISSING');
  });

  it('no tax-invoice record → CANNOT_DETERMINE', () => {
    expect(evaluateEInvoiceEligibility(source((s) => { s.tax = null; })).status).toBe('CANNOT_DETERMINE');
  });

  it('invalid seller GSTIN / buyer GSTIN (checksum) are refused', () => {
    expect(codes(source((s) => { s.registration.gstin = SELLER.slice(0, 14) + (SELLER[14] === '0' ? '1' : '0'); }))).toContain('SELLER_GSTIN_INVALID');
    expect(codes(source((s) => { s.tax!.buyerGstin = BUYER.slice(0, 14) + (BUYER[14] === '0' ? '1' : '0'); }))).toContain('BUYER_GSTIN_INVALID');
  });

  it('VOID and DRAFT invoices are refused', () => {
    expect(codes(source((s) => { s.invoice.status = 'VOID'; }))).toContain('INVOICE_VOID');
    expect(codes(source((s) => { s.invoice.status = 'DRAFT'; }))).toContain('INVOICE_NOT_ISSUED');
  });

  it('an invoice that already carries an IRN is refused', () => {
    expect(codes(source((s) => { s.tax!.irn = 'a'.repeat(64); }))).toContain('IRN_ALREADY_GENERATED');
  });

  it('wrong GST registration / wrong company / wrong branch registration are refused', () => {
    expect(codes(source((s) => { s.tax!.sellerRegistrationId = 'other-reg'; }))).toContain('REGISTRATION_MISMATCH');
    expect(codes(source((s) => { s.registration.companyId = 'co2'; }))).toContain('COMPANY_MISMATCH');
    expect(codes(source((s) => { s.invoice.branchGstRegistrationId = 'other-reg'; }))).toContain('BRANCH_REGISTRATION_MISMATCH');
    expect(codes(source((s) => { s.tax!.gstin = makeGstin('24', 'OTHER', '9999'); }))).toContain('SELLER_GSTIN_MISMATCH');
    expect(codes(source((s) => { s.registration.isActive = false; }))).toContain('REGISTRATION_INACTIVE');
  });

  it('B2C (no buyer GSTIN), export and non-INR are not B2B e-invoice documents', () => {
    expect(codes(source((s) => { s.tax!.buyerGstin = null; }))).toContain('BUYER_NOT_REGISTERED');
    expect(codes(source((s) => { s.tax!.buyerCountry = 'UAE'; }))).toContain('EXPORT_NOT_SUPPORTED');
    expect(codes(source((s) => { s.invoice.currency = 'USD'; }))).toContain('CURRENCY_NOT_SUPPORTED');
  });

  it('unsupported document types (CRN/DBN) are refused explicitly', () => {
    expect(codes(source((s) => { s.documentType = 'CRN'; }))).toContain('DOCUMENT_TYPE_UNSUPPORTED');
    expect(codes(source((s) => { s.documentType = 'DBN'; }))).toContain('DOCUMENT_TYPE_UNSUPPORTED');
  });

  it('missing required invoice data is CANNOT_DETERMINE (HSN, UQC, pincode, buyer name)', () => {
    const r = evaluateEInvoiceEligibility(source((s) => {
      s.items[0].hsnCode = null; s.items[0].uqc = null; s.tax!.sellerPincode = null; s.tax!.buyerName = null;
    }));
    expect(r.status).toBe('CANNOT_DETERMINE');
    expect(r.blockingReasons.map((x) => x.code)).toEqual(expect.arrayContaining(['LINE_HSN_INVALID', 'LINE_UQC_MISSING', 'SELLER_PINCODE_INVALID', 'BUYER_NAME_MISSING']));
  });

  it('document number and date constraints from the spec', () => {
    expect(codes(source((s) => { s.invoice.invoiceNumber = '0123'; }))).toContain('DOCUMENT_NUMBER_INVALID');
    expect(codes(source((s) => { s.invoice.invoiceNumber = 'A'.repeat(17); }))).toContain('DOCUMENT_NUMBER_INVALID');
    expect(codes(source((s) => { s.invoice.invoiceDate = new Date('2025-03-31T00:00:00Z'); }))).toContain('DOCUMENT_DATE_TOO_OLD');
  });

  it('invalid tax data: split, mismatch, totals, cess, un-snapshotted lines', () => {
    expect(codes(source((s) => { s.items[0].igstAmount = '300'; }))).toContain('LINE_TAX_SPLIT_INVALID');
    expect(codes(source((s) => { s.items[0].cgstAmount = '50'; }))).toContain('LINE_TAX_MISMATCH');
    expect(codes(source((s) => { s.invoice.totalAmount = '10500'; }))).toContain('INVOICE_TOTAL_MISMATCH');
    expect(codes(source((s) => { s.tax!.cgst = '10'; }))).toContain('TAX_TOTAL_MISMATCH');
    expect(codes(source((s) => { s.tax!.cess = '5'; }))).toContain('CESS_NOT_ITEMIZED');
    expect(evaluateEInvoiceEligibility(source((s) => { s.items[0].taxableValue = '0'; s.items[0].cgstAmount = '0'; s.items[0].sgstAmount = '0'; })).status).toBe('CANNOT_DETERMINE');
    expect(codes(source((s) => { s.items = []; }))).toContain('NO_LINE_ITEMS');
  });

  it('place of supply must resolve to a state and agree with the recipient GSTIN', () => {
    expect(codes(source((s) => { s.tax!.placeOfSupply = 'Gujarat'; }))).toContain('PLACE_OF_SUPPLY_UNRESOLVED');
    expect(codes(source((s) => { s.tax!.placeOfSupply = '27'; }))).toContain('POS_BUYER_STATE_MISMATCH');
  });
});

describe('G8c canonical IRN request builder', () => {
  it('maps persisted values deterministically, with no provider-specific field names', () => {
    const a = buildCanonicalIrnRequest(source());
    expect(a).toEqual(buildCanonicalIrnRequest(source()));
    expect(a).toMatchObject({
      documentType: 'INV', documentNumber: 'INV/2026/0001', documentDate: '2026-09-01', supplyType: 'B2B', reverseCharge: false, igstOnIntra: false,
      placeOfSupplyStateCode: '24', currency: 'INR',
      seller: { gstin: SELLER, legalName: 'Seller Jewels Pvt Ltd', tradeName: 'Seller Jewels', city: 'Surat', pincode: '395002', stateCode: '24' },
      buyer: { gstin: BUYER, legalName: 'Buyer Traders', stateCode: '24', pincode: '380001' },
      totals: { taxableValue: 10000, cgst: 150, sgst: 150, igst: 0, cess: 0, otherCharges: 0, roundOff: 0, invoiceTotal: 10300 },
    });
    expect(a.lines[0]).toMatchObject({ lineNumber: 1, hsnCode: '7113', quantity: 2, uqc: 'PCS', unitPrice: 5000, grossAmount: 10000, taxableValue: 10000, gstRatePercent: 3, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, totalAmount: 10300 });
    // no NIC wire names leak into the canonical contract
    const flat = JSON.stringify(a);
    for (const wire of ['SellerDtls', 'BuyerDtls', 'TranDtls', 'DocDtls', 'ItemList', 'ValDtls', 'AssAmt', 'TotInvVal', 'GstRt', 'HsnCd', 'Stcd']) expect(flat).not.toContain(wire);
  });

  it('uses persisted tax (never recomputes) and carries the invoice discount share, round-off and other charges', () => {
    const a = buildCanonicalIrnRequest(source((s) => {
      s.items[0].lineDiscountAmount = '500'; s.items[0].taxableValue = '9500'; s.items[0].cgstAmount = '142.5'; s.items[0].sgstAmount = '142.5';
      s.invoice.subtotal = '10000'; s.invoice.discountAmount = '500'; s.invoice.taxAmount = '285'; s.invoice.otherCharges = '20'; s.invoice.roundOff = '0.5'; s.invoice.totalAmount = '9805.5';
      s.tax!.cgst = '142.5'; s.tax!.sgst = '142.5';
    }));
    expect(a.lines[0]).toMatchObject({ grossAmount: 10000, discountAmount: 500, taxableValue: 9500, cgstAmount: 142.5 });
    expect(a.totals).toMatchObject({ taxableValue: 9500, otherCharges: 20, roundOff: 0.5, invoiceTotal: 9805.5 });
  });

  it('inter-state IGST, same-state IGST (IgstOnIntra) and reverse charge', () => {
    const inter = buildCanonicalIrnRequest(source((s) => {
      s.tax!.buyerGstin = BUYER_OTHER_STATE; s.tax!.buyerStateCode = '27'; s.tax!.placeOfSupply = '27';
      s.items[0].cgstAmount = '0'; s.items[0].sgstAmount = '0'; s.items[0].igstAmount = '300'; s.tax!.cgst = '0'; s.tax!.sgst = '0'; s.tax!.igst = '300';
    }));
    expect(inter.totals.igst).toBe(300);
    expect(inter.igstOnIntra).toBe(false);
    expect(inter.placeOfSupplyStateCode).toBe('27');
    const intra = buildCanonicalIrnRequest(source((s) => {
      s.items[0].cgstAmount = '0'; s.items[0].sgstAmount = '0'; s.items[0].igstAmount = '300'; s.tax!.cgst = '0'; s.tax!.sgst = '0'; s.tax!.igst = '300';
    }));
    expect(intra.igstOnIntra).toBe(true);
    expect(buildCanonicalIrnRequest(source((s) => { s.tax!.reverseCharge = true; })).reverseCharge).toBe(true);
  });

  it('splits a long address at 100 characters on a word boundary', () => {
    const long = `${'Gold Tower '.repeat(12)}Ring Road`.trim();
    const a = buildCanonicalIrnRequest(source((s) => { s.tax!.sellerAddress = long; }));
    expect(a.seller.addressLine1.length).toBeLessThanOrEqual(100);
    expect(`${a.seller.addressLine1} ${a.seller.addressLine2}`).toBe(long);
  });

  it('refuses to build for an ineligible document', () => {
    expect(() => buildCanonicalIrnRequest(source((s) => { s.invoice.status = 'VOID'; }))).toThrow(/ineligible/);
  });
});

describe('G8c provider boundary', () => {
  it('NIC_IRP does NOT claim IRN support and stays deterministically UNSUPPORTED (wire spec unverified)', async () => {
    const nic = new NicIrpProvider();
    expect(nic.supportsIrnGeneration).toBe(false);
    expect(await nic.generateIrn()).toMatchObject({ status: 'UNSUPPORTED_PROVIDER_OPERATION', operation: 'GENERATE_IRN', provider: 'NIC_IRP' });
    expect(resolveProvider('NIC_IRP').supportsIrnGeneration).toBe(false);
  });

  it('the unconfigured provider is unsupported and does not claim IRN support', async () => {
    const p = new UnconfiguredProvider('IRIS_IRP');
    expect((p as { supportsIrnGeneration?: boolean }).supportsIrnGeneration).toBeFalsy();
    expect(await p.generateIrn({} as never, buildCanonicalIrnRequest(source()))).toMatchObject({ status: 'UNSUPPORTED_PROVIDER_OPERATION' });
  });
});
