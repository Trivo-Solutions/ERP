import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeGstr1CreditNote,
  type Gstr1CreditNoteSourceDocument,
} from './gstr1CreditNoteNormalizer';
import { UNCLASSIFIED } from './gstr1Classification';
import type { CreditNoteItemSourceRow } from './gstr1Normalizer';

// Aug 2024 onward = current ₹1,00,000 B2CL threshold; before = historical ₹2,50,000 threshold —
// same boundary gstr1Classification.test.ts already exercises; reused, not re-derived.
const CURRENT_PERIOD_DATE = new Date('2026-01-15T00:00:00.000Z');
const HISTORICAL_PERIOD_DATE = new Date('2023-06-15T00:00:00.000Z');

const GUJARAT = '24';
const MAHARASHTRA = '27';

const hsn7113Line: CreditNoteItemSourceRow = {
  id: 'cni_1', creditNoteId: 'cn_1', description: '22K Gold Chain',
  hsnCode: { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' }, hsnCodeId: 'hsn_7113', uqc: 'GMS',
  quantity: 1, taxRate: 0.03, taxableValue: 50000, cgstAmount: 750, sgstAmount: 750, igstAmount: 0,
  totalValue: 51500, netWeight: 10.5,
};

function baseDoc(overrides: Partial<Gstr1CreditNoteSourceDocument> = {}): Gstr1CreditNoteSourceDocument {
  return {
    id: 'cn_1',
    creditNoteNumber: 'CN-0001',
    creditNoteDate: CURRENT_PERIOD_DATE,
    status: 'ISSUED',
    invoiceId: 'inv_1',
    originalInvoiceNumber: 'INV-0001',
    originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 50_000,
    salesReturnId: null,
    sellerRegistrationId: 'reg_1',
    sellerStateCode: GUJARAT,
    buyerGstin: null,
    buyerCountry: 'India',
    placeOfSupply: MAHARASHTRA,
    reasonCode: 'POST_SALE_DISCOUNT',
    reasonNotes: null,
    taxableAmount: 1500,
    cgst: 0,
    sgst: 0,
    igst: 90,
    totalTax: 90,
    totalAmount: 1590,
    items: [hsn7113Line],
    ...overrides,
  };
}

describe('normalizeGstr1CreditNote — A. REGISTERED / CDNR', () => {
  it('1. registered GSTIN → CDNR + B2B', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: GUJARAT }));
    expect(result.document.recipientType).toBe('REGISTERED');
    expect(result.document.reportingTable).toBe('CDNR');
    expect(result.document.originalSupplyCategory).toBe('B2B');
    expect(result.reportable).toBe(true);
    expect(result.exclusionReason).toBeUndefined();
  });

  it('2. GSTIN whitespace normalization', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ buyerGstin: '  24AAAAA0000A1Z5  ', placeOfSupply: GUJARAT }));
    expect(result.document.buyerGstin).toBe('24AAAAA0000A1Z5');
    expect(result.document.recipientType).toBe('REGISTERED');
    expect(result.document.reportingTable).toBe('CDNR');
  });

  it('3. GSTIN lowercase normalization', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ buyerGstin: '24aaaaa0000a1z5', placeOfSupply: GUJARAT }));
    expect(result.document.buyerGstin).toBe('24AAAAA0000A1Z5');
    expect(result.document.recipientType).toBe('REGISTERED');
  });

  it('4. malformed GSTIN → explicit diagnostic, no guessing', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ buyerGstin: 'NOT-A-VALID-GSTIN' }));
    expect(result.document.recipientType).toBe('UNCLASSIFIED');
    expect(result.document.reportingTable).toBe('UNCLASSIFIED');
    expect(result.reportable).toBe(false);
    expect(result.exclusionReason).toBe('INVALID_RECIPIENT_GSTIN');
    expect(result.diagnostics.some((d) => d.code === 'INVALID_RECIPIENT_GSTIN')).toBe(true);
  });
});

describe('normalizeGstr1CreditNote — B. UNREGISTERED / CDNUR', () => {
  it('5. interstate above threshold → B2CL + CDNUR', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000,
    }));
    expect(result.document.recipientType).toBe('UNREGISTERED');
    expect(result.document.reportingTable).toBe('CDNUR');
    expect(result.document.originalSupplyCategory).toBe('B2CL');
    expect(result.reportable).toBe(true);
  });

  it('6. interstate at/below threshold → B2CS + CDNUR', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 90_000,
    }));
    expect(result.document.reportingTable).toBe('CDNUR');
    expect(result.document.originalSupplyCategory).toBe('B2CS');
  });

  it('7. intrastate unregistered → B2CS + CDNUR', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000,
    }));
    expect(result.document.reportingTable).toBe('CDNUR');
    expect(result.document.originalSupplyCategory).toBe('B2CS');
  });
});

describe('normalizeGstr1CreditNote — C. HISTORICAL THRESHOLD', () => {
  it('8. original invoice before Aug 1 2024 uses the ₹2.5 lakh threshold', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA,
      originalInvoiceValue: 200_000, originalInvoiceDate: HISTORICAL_PERIOD_DATE,
    }));
    // ₹2,00,000 is below the historical ₹2.5L threshold → B2CS, not B2CL.
    expect(result.document.originalSupplyCategory).toBe('B2CS');
  });

  it('9. original invoice on/after Aug 1 2024 uses the ₹1 lakh threshold', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA,
      originalInvoiceValue: 200_000, originalInvoiceDate: CURRENT_PERIOD_DATE,
    }));
    // Same ₹2,00,000 is above the current ₹1L threshold → B2CL.
    expect(result.document.originalSupplyCategory).toBe('B2CL');
  });
});

describe('normalizeGstr1CreditNote — D. PATH', () => {
  it('10. SalesReturn-linked CreditNote → PATH_A_SALES_RETURN', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ salesReturnId: 'ret_1', reasonCode: 'SALES_RETURN' }));
    expect(result.document.sourcePath).toBe('PATH_A_SALES_RETURN');
  });

  it('11. Standalone CreditNote → PATH_B_STANDALONE', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ salesReturnId: null }));
    expect(result.document.sourcePath).toBe('PATH_B_STANDALONE');
  });
});

describe('normalizeGstr1CreditNote — E. STATUS', () => {
  it('12. active CreditNote → reportable', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ status: 'ISSUED', buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: GUJARAT }));
    expect(result.reportable).toBe(true);
    expect(result.exclusionReason).toBeUndefined();
  });

  it('13. cancelled CreditNote → excluded with explicit reason, data preserved (not zeroed)', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      status: 'CANCELLED', buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: GUJARAT,
    }));
    expect(result.reportable).toBe(false);
    expect(result.exclusionReason).toBe('CANCELLED');
    expect(result.document.status).toBe('CANCELLED');
    expect(result.document.noteValue).toBe(1590);
    expect(result.document.taxableValue).toBe(1500);
  });

  it('cancellation takes priority over every other exclusion reason', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ status: 'CANCELLED', buyerGstin: 'BAD-GSTIN' }));
    expect(result.exclusionReason).toBe('CANCELLED');
  });
});

describe('normalizeGstr1CreditNote — F. SNAPSHOTS', () => {
  it('14. buyer GSTIN comes from the immutable snapshot', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: GUJARAT }));
    expect(result.document.buyerGstin).toBe('24AAAAA0000A1Z5');
  });

  it('15. seller registration comes from the persisted document context', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ sellerRegistrationId: 'reg_42' }));
    expect(result.document.sellerRegistrationId).toBe('reg_42');
  });

  it('16. original invoice number/date preserved', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ originalInvoiceNumber: 'INV-9999', originalInvoiceDate: HISTORICAL_PERIOD_DATE }));
    expect(result.document.originalInvoiceNumber).toBe('INV-9999');
    expect(result.document.originalInvoiceDate).toBe(HISTORICAL_PERIOD_DATE);
    expect(result.document.originalInvoiceId).toBe('inv_1');
  });

  it('17. place of supply preserved', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ placeOfSupply: MAHARASHTRA }));
    expect(result.document.placeOfSupply).toBe(MAHARASHTRA);
  });

  it('18. no HSN master lookup occurs during normalization (module has no Prisma/HSN dependency)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'gstr1CreditNoteNormalizer.ts'), 'utf8');
    expect(source).not.toMatch(/hsnCode\.findMany|hsnCode\.findFirst|prisma\.hsnCode/i);
  });
});

describe('normalizeGstr1CreditNote — G. TAX', () => {
  it('19. persisted IGST/CGST/SGST/taxable value preserved on the document', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ taxableAmount: 1500, cgst: 0, sgst: 0, igst: 90, totalAmount: 1590 }));
    expect(result.document.taxableValue).toBe(1500);
    expect(result.document.cgst).toBe(0);
    expect(result.document.sgst).toBe(0);
    expect(result.document.igst).toBe(90);
    expect(result.document.noteValue).toBe(1590);
  });

  it('20. no dynamic GST recalculation — line tax comes straight from the persisted CreditNoteItem snapshot', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ items: [hsn7113Line] }));
    expect(result.lines[0].taxableValue).toBe(50000);
    expect(result.lines[0].cgstAmount).toBe(750);
    expect(result.lines[0].sgstAmount).toBe(750);
  });
});

describe('normalizeGstr1CreditNote — H. LINE NORMALIZATION', () => {
  it('21. PCS/NOS line uses billing quantity', () => {
    const pcsLine: CreditNoteItemSourceRow = {
      ...hsn7113Line, uqc: 'PCS', quantity: 3,
      hsnCode: { code: '7113', description: 'Jewellery', defaultUqc: 'PCS' },
    };
    const result = normalizeGstr1CreditNote(baseDoc({ items: [pcsLine] }));
    expect(result.lines[0].quantity).toBe(3);
    expect(result.lines[0].quantityBasis).toBe('BILLING_PIECES');
  });

  it('22. GMS line uses net weight', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ items: [hsn7113Line] }));
    expect(result.lines[0].quantity).toBe(10.5);
    expect(result.lines[0].quantityBasis).toBe('NET_WEIGHT_GMS');
  });

  it('23. unsupported UQC returns zero + diagnostic', () => {
    const bagLine: CreditNoteItemSourceRow = {
      ...hsn7113Line, uqc: 'BAG',
      hsnCode: { code: '7113', description: 'Jewellery', defaultUqc: null },
    };
    const result = normalizeGstr1CreditNote(baseDoc({ items: [bagLine] }));
    expect(result.lines[0].quantity).toBe(0);
    expect(result.lines[0].quantityBasis).toBe('UNSUPPORTED_UQC');
    expect(result.diagnostics.some((d) => d.code === 'UNSUPPORTED_UQC')).toBe(true);
  });

  it('24. value-only CreditNote line (quantity null — Path B) remains zero/no-physical-quantity', () => {
    const valueOnlyLine: CreditNoteItemSourceRow = { ...hsn7113Line, quantity: null };
    const result = normalizeGstr1CreditNote(baseDoc({ items: [valueOnlyLine], salesReturnId: null }));
    expect(result.lines[0].quantity).toBe(0);
    expect(result.lines[0].quantityBasis).toBe('NO_PHYSICAL_QUANTITY');
  });
});

describe('normalizeGstr1CreditNote — I. EXPORT', () => {
  it('25. missing export indicator does not guess export status — domestic buyerCountry classifies normally', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, buyerCountry: 'India', sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 50_000,
    }));
    expect(result.reportable).toBe(true);
    expect(result.exclusionReason).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === 'EXPORT_CLASSIFICATION_UNAVAILABLE')).toBe(false);
  });

  it('26. explicit diagnostic when export classification is required but unavailable', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: null, buyerCountry: 'United Arab Emirates', sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 50_000,
    }));
    expect(result.reportable).toBe(false);
    expect(result.exclusionReason).toBe('EXPORT_CLASSIFICATION_UNAVAILABLE');
    expect(result.diagnostics.some((d) => d.code === 'EXPORT_CLASSIFICATION_UNAVAILABLE')).toBe(true);
  });

  it('a registered (CDNR) recipient with a non-India buyerCountry is not flagged export-unavailable — export sub-split only applies to CDNUR', () => {
    const result = normalizeGstr1CreditNote(baseDoc({
      buyerGstin: '24AAAAA0000A1Z5', buyerCountry: 'United Arab Emirates', placeOfSupply: GUJARAT,
    }));
    expect(result.document.reportingTable).toBe('CDNR');
    expect(result.diagnostics.some((d) => d.code === 'EXPORT_CLASSIFICATION_UNAVAILABLE')).toBe(false);
  });
});

describe('normalizeGstr1CreditNote — J. MULTIPLE NOTES', () => {
  it('27. two CreditNotes against the same original invoice remain two independent normalized objects', () => {
    const cn1 = normalizeGstr1CreditNote(baseDoc({ id: 'cn_1', creditNoteNumber: 'CN-001', totalAmount: 10_000, taxableAmount: 9_700 }));
    const cn2 = normalizeGstr1CreditNote(baseDoc({ id: 'cn_2', creditNoteNumber: 'CN-002', totalAmount: 5_000, taxableAmount: 4_850 }));
    expect(cn1.document.creditNoteId).toBe('cn_1');
    expect(cn2.document.creditNoteId).toBe('cn_2');
    expect(cn1.document.noteValue).toBe(10_000);
    expect(cn2.document.noteValue).toBe(5_000);
    // No netting/aggregation of any kind — each result is exactly its own single-document computation.
    expect(cn1.document.originalInvoiceNumber).toBe(cn2.document.originalInvoiceNumber);
  });
});

describe('normalizeGstr1CreditNote — K. TENANT SAFETY', () => {
  it('28. pure function has no Prisma/database access', () => {
    const source = fs.readFileSync(path.join(__dirname, 'gstr1CreditNoteNormalizer.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]@prisma\/client['"]/);
    expect(source).not.toMatch(/from ['"].*config\/database['"]/);
    expect(source).not.toMatch(/from ['"].*tenantContext['"]/);
    expect(source.toLowerCase()).not.toContain('prisma.');
  });
});

describe('normalizeGstr1CreditNote — additional: missing seller registration', () => {
  it('excludes with MISSING_SELLER_REGISTRATION when sellerRegistrationId is absent, regardless of recipient type', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ sellerRegistrationId: null, buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: GUJARAT }));
    expect(result.reportable).toBe(false);
    expect(result.exclusionReason).toBe('MISSING_SELLER_REGISTRATION');
  });
});

describe('normalizeGstr1CreditNote — additional: reasonCode/reasonNotes passthrough', () => {
  it('preserves reasonCode and reasonNotes exactly as persisted', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ reasonCode: 'OTHER', reasonNotes: 'Freight waived' }));
    expect(result.document.reasonCode).toBe('OTHER');
    expect(result.document.reasonNotes).toBe('Freight waived');
  });

  it('reasonNotes null stays null, never coerced to empty string', () => {
    const result = normalizeGstr1CreditNote(baseDoc({ reasonNotes: null }));
    expect(result.document.reasonNotes).toBeNull();
  });
});
