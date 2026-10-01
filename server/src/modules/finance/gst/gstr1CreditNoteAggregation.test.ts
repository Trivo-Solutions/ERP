import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  aggregateGstr1CreditNotes,
  Gstr1CreditNoteAggregationAccessError,
  type Gstr1CreditNoteAggregationSourceDocument,
  type Gstr1CreditNoteAggregationOptions,
} from './gstr1CreditNoteAggregation';
import type { CreditNoteItemSourceRow } from './gstr1Normalizer';

const GUJARAT = '24';
const MAHARASHTRA = '27';
const REGISTERED_GSTIN = '24AAAAA0000A1Z5';

const CURRENT_PERIOD_DATE = new Date('2026-09-15T00:00:00.000Z');

const hsn7113Line: CreditNoteItemSourceRow = {
  id: 'cni_1', creditNoteId: 'cn_1', description: '22K Gold Chain',
  hsnCode: { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' }, hsnCodeId: 'hsn_7113', uqc: 'GMS',
  quantity: 1, taxRate: 0.03, taxableValue: 50000, cgstAmount: 750, sgstAmount: 750, igstAmount: 0,
  totalValue: 51500, netWeight: 10.5,
};

function source(overrides: Partial<Gstr1CreditNoteAggregationSourceDocument> = {}): Gstr1CreditNoteAggregationSourceDocument {
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
    branchId: 'branch_1',
    ...overrides,
  };
}

function options(overrides: Partial<Gstr1CreditNoteAggregationOptions> = {}): Gstr1CreditNoteAggregationOptions {
  return {
    gstRegistrationId: 'reg_1',
    period: { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
    ...overrides,
  };
}

describe('aggregateGstr1CreditNotes — A. CDNR', () => {
  it('1. registered recipient → one CDNR document', () => {
    const result = aggregateGstr1CreditNotes([source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    expect(result.b2csNetOff.documents).toHaveLength(0);
  });

  it('2. CDNR preserves recipient GSTIN', () => {
    const result = aggregateGstr1CreditNotes([source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents[0].buyerGstin).toBe(REGISTERED_GSTIN);
  });

  it('3. CDNR preserves original invoice number/date', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: REGISTERED_GSTIN, originalInvoiceNumber: 'INV-9999', originalInvoiceDate: new Date('2026-09-05') })],
      options(),
    );
    expect(result.cdnr.documents[0].originalInvoiceNumber).toBe('INV-9999');
    expect(result.cdnr.documents[0].originalInvoiceDate).toEqual(new Date('2026-09-05'));
  });

  it('4. CDNR preserves Credit Note number/date', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: REGISTERED_GSTIN, creditNoteNumber: 'CN-4242', creditNoteDate: new Date('2026-09-10') })],
      options(),
    );
    expect(result.cdnr.documents[0].creditNoteNumber).toBe('CN-4242');
    expect(result.cdnr.documents[0].creditNoteDate).toEqual(new Date('2026-09-10'));
  });

  it('5. CDNR preserves Path A (sales-return-linked)', () => {
    const result = aggregateGstr1CreditNotes([source({ buyerGstin: REGISTERED_GSTIN, salesReturnId: 'ret_1' })], options());
    expect(result.cdnr.documents[0].sourcePath).toBe('PATH_A_SALES_RETURN');
  });

  it('6. CDNR preserves Path B (standalone)', () => {
    const result = aggregateGstr1CreditNotes([source({ buyerGstin: REGISTERED_GSTIN, salesReturnId: null })], options());
    expect(result.cdnr.documents[0].sourcePath).toBe('PATH_B_STANDALONE');
  });
});

describe('aggregateGstr1CreditNotes — B. CDNUR', () => {
  it('7. unregistered B2CL → CDNUR/B2CL', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 })],
      options(),
    );
    expect(result.cdnur.b2cl.documents).toHaveLength(1);
    expect(result.b2csNetOff.documents).toHaveLength(0);
    expect(result.cdnr.documents).toHaveLength(0);
  });

  it('8. unregistered B2CS → b2csNetOff, never a CDNUR bucket', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 })],
      options(),
    );
    expect(result.b2csNetOff.documents).toHaveLength(1);
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    // Phase A: GSTN has no "CDNUR B2CS" category — confirm the type itself carries no such key.
    expect((result.cdnur as Record<string, unknown>).b2cs).toBeUndefined();
  });

  it('9. B2CL remains separate from the B2CS net-off bucket — never collapsed together', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', creditNoteNumber: 'CN-0001', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 }),
        source({ id: 'cn_2', creditNoteNumber: 'CN-0002', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 }),
      ],
      options(),
    );
    expect(result.cdnur.b2cl.documents).toHaveLength(1);
    expect(result.b2csNetOff.documents).toHaveLength(1);
    expect(result.cdnur.b2cl.documents[0].creditNoteId).toBe('cn_1');
    expect(result.b2csNetOff.documents[0].creditNoteId).toBe('cn_2');
  });

  it('10. CDNUR preserves place of supply', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 })],
      options(),
    );
    expect(result.cdnur.b2cl.documents[0].placeOfSupply).toBe(MAHARASHTRA);
  });
});

describe('aggregateGstr1CreditNotes — C. STATUS', () => {
  it('11. cancelled Credit Note excluded from every bucket', () => {
    const result = aggregateGstr1CreditNotes([source({ status: 'CANCELLED', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    expect(result.b2csNetOff.documents).toHaveLength(0);
  });

  it('12. cancelled Credit Note remains visible in excluded, data preserved', () => {
    const result = aggregateGstr1CreditNotes([source({ status: 'CANCELLED', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].exclusionReason).toBe('CANCELLED');
    expect(result.excluded[0].document.noteValue).toBe(1590);
    expect(result.excluded[0].diagnostics.some((d) => d.code === 'CANCELLED')).toBe(true);
  });
});

describe('aggregateGstr1CreditNotes — D. REGISTRATION', () => {
  it('13. matching sellerRegistrationId included', () => {
    const result = aggregateGstr1CreditNotes([source({ sellerRegistrationId: 'reg_1', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options({ gstRegistrationId: 'reg_1' }));
    expect(result.cdnr.documents).toHaveLength(1);
  });

  it('14. different sellerRegistrationId excluded from scope — silently, not a diagnostic', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ sellerRegistrationId: 'reg_belongs_to_another_company', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ gstRegistrationId: 'reg_1' }),
    );
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.meta.notesExcludedByScope).toBe(1);
    expect(result.meta.notesConsidered).toBe(0);
  });

  it('15. missing seller registration preserved as a diagnostic/non-reportable record', () => {
    const result = aggregateGstr1CreditNotes([source({ sellerRegistrationId: null, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].exclusionReason).toBe('MISSING_SELLER_REGISTRATION');
    expect(result.meta.notesConsidered).toBe(1);
  });
});

describe('aggregateGstr1CreditNotes — E. PERIOD', () => {
  it('16. Credit Note date inside period included', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ creditNoteDate: new Date('2026-09-15'), buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ period: { from: new Date('2026-09-01'), to: new Date('2026-09-30T23:59:59.999Z') } }),
    );
    expect(result.cdnr.documents).toHaveLength(1);
  });

  it('17. Credit Note date outside period excluded (scope, not a diagnostic)', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ creditNoteDate: new Date('2026-10-05'), buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ period: { from: new Date('2026-09-01'), to: new Date('2026-09-30T23:59:59.999Z') } }),
    );
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.meta.notesExcludedByScope).toBe(1);
  });

  it('18. original invoice date does NOT determine the Credit Note period — either direction', () => {
    const period = { from: new Date('2026-09-01'), to: new Date('2026-09-30T23:59:59.999Z') };
    // CN date inside period, original invoice date far outside → still included.
    const includedDespiteOldInvoice = aggregateGstr1CreditNotes(
      [source({ creditNoteDate: new Date('2026-09-15'), originalInvoiceDate: new Date('2020-01-01'), buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ period }),
    );
    expect(includedDespiteOldInvoice.cdnr.documents).toHaveLength(1);

    // CN date outside period, original invoice date inside → excluded anyway.
    const excludedDespiteRecentInvoice = aggregateGstr1CreditNotes(
      [source({ creditNoteDate: new Date('2026-11-01'), originalInvoiceDate: new Date('2026-09-15'), buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ period }),
    );
    expect(excludedDespiteRecentInvoice.cdnr.documents).toHaveLength(0);
    expect(excludedDespiteRecentInvoice.meta.notesExcludedByScope).toBe(1);
  });
});

describe('aggregateGstr1CreditNotes — F. BRANCH', () => {
  it('19. allowed branch included', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ branchId: 'branch_1', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] } }),
    );
    expect(result.cdnr.documents).toHaveLength(1);
  });

  it('20. inaccessible branch excluded (restricted caller)', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ branchId: 'branch_2', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] } }),
    );
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.meta.notesExcludedByScope).toBe(1);
  });

  it('21. explicit unauthorized branch throws, is not silently excluded', () => {
    expect(() =>
      aggregateGstr1CreditNotes(
        [source()],
        options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] }, branchId: 'branch_2' }),
      ),
    ).toThrow(Gstr1CreditNoteAggregationAccessError);
  });

  it('22. cross-company/unknown branch id requested explicitly is rejected the same way', () => {
    expect(() =>
      aggregateGstr1CreditNotes(
        [source()],
        options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] }, branchId: 'branch_from_another_company' }),
      ),
    ).toThrow(Gstr1CreditNoteAggregationAccessError);
  });
});

describe('aggregateGstr1CreditNotes — G. PATH / DOUBLE COUNTING', () => {
  it('23. Path A produces exactly one document', () => {
    const result = aggregateGstr1CreditNotes([source({ salesReturnId: 'ret_1', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.cdnr.documents[0].sourcePath).toBe('PATH_A_SALES_RETURN');
  });

  it('24. this module never consumes SalesReturn data directly — no SalesReturn shape is accepted as input', () => {
    const src = fs.readFileSync(path.join(__dirname, 'gstr1CreditNoteAggregation.ts'), 'utf8');
    expect(src).not.toMatch(/SalesReturnItemSourceRow/);
    expect(src).not.toMatch(/normalizeSalesReturnItemLine/);
  });

  it('25. Path B produces exactly one document', () => {
    const result = aggregateGstr1CreditNotes([source({ salesReturnId: null, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.cdnr.documents[0].sourcePath).toBe('PATH_B_STANDALONE');
  });
});

describe('aggregateGstr1CreditNotes — H. MULTIPLE NOTES', () => {
  it('26. two Credit Notes against the same invoice remain two documents', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', creditNoteNumber: 'CN-001', totalAmount: 10_000, taxableAmount: 9_700, cgst: 150, sgst: 150, igst: 0, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
        source({ id: 'cn_2', creditNoteNumber: 'CN-002', totalAmount: 5_000, taxableAmount: 4_850, cgst: 75, sgst: 75, igst: 0, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
      ],
      options(),
    );
    expect(result.cdnr.documents).toHaveLength(2);
    // never consolidated into one "₹17,000 Credit Note" (rule 14)
    expect(result.cdnr.documents.map((d) => d.noteValue).sort((a, b) => a - b)).toEqual([5_000, 10_000]);
  });

  it('27. summary correctly sums both documents', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', creditNoteNumber: 'CN-001', totalAmount: 10_000, taxableAmount: 9_700, cgst: 150, sgst: 150, igst: 0, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
        source({ id: 'cn_2', creditNoteNumber: 'CN-002', totalAmount: 5_000, taxableAmount: 4_850, cgst: 75, sgst: 75, igst: 0, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
      ],
      options(),
    );
    expect(result.cdnr.summary.documentCount).toBe(2);
    expect(result.cdnr.summary.noteValue).toBe(15_000);
    expect(result.cdnr.summary.taxableValue).toBe(14_550);
    expect(result.cdnr.summary.cgst).toBe(225);
    expect(result.cdnr.summary.sgst).toBe(225);
  });
});

describe('aggregateGstr1CreditNotes — I. TAX', () => {
  it('28. persisted tax values preserved on the document', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ taxableAmount: 1500, cgst: 0, sgst: 0, igst: 90, totalAmount: 1590, buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 500_000 })],
      options(),
    );
    const doc = result.cdnur.b2cl.documents[0];
    expect(doc.taxableValue).toBe(1500);
    expect(doc.igst).toBe(90);
    expect(doc.cgst).toBe(0);
    expect(doc.sgst).toBe(0);
    expect(doc.noteValue).toBe(1590);
  });

  it('29. multiple rates remain separated within one document\'s rateBreakdown', () => {
    const line3pct: CreditNoteItemSourceRow = { ...hsn7113Line, id: 'cni_1', taxRate: 0.03, taxableValue: 50000, cgstAmount: 750, sgstAmount: 750, igstAmount: 0 };
    const line5pct: CreditNoteItemSourceRow = {
      ...hsn7113Line, id: 'cni_2', hsnCode: { code: '7117', description: 'Imitation jewellery', defaultUqc: 'GMS' }, hsnCodeId: 'hsn_7117',
      taxRate: 0.05, taxableValue: 10000, cgstAmount: 250, sgstAmount: 250, igstAmount: 0,
    };
    const result = aggregateGstr1CreditNotes(
      [source({ items: [line3pct, line5pct], buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      options(),
    );
    const doc = result.cdnr.documents[0];
    expect(doc.rateBreakdown).toHaveLength(2);
    const rates = doc.rateBreakdown.map((r) => r.rate).sort();
    expect(rates).toEqual([0.03, 0.05]);
  });

  it('30. no dynamic GST recalculation — line tax comes straight from the persisted snapshot', () => {
    const result = aggregateGstr1CreditNotes([source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    const line = result.cdnr.documents[0].rateBreakdown[0];
    expect(line.taxableValue).toBe(50000);
    expect(line.cgst).toBe(750);
    expect(line.sgst).toBe(750);
  });
});

describe('aggregateGstr1CreditNotes — J. EXPORT', () => {
  it('31. export-unavailable diagnostic prevents CDNUR placement — the note is excluded, not reported', () => {
    const result = aggregateGstr1CreditNotes(
      [source({ buyerGstin: null, buyerCountry: 'United Arab Emirates', sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 50_000 })],
      options(),
    );
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    expect(result.b2csNetOff.documents).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].exclusionReason).toBe('EXPORT_CLASSIFICATION_UNAVAILABLE');
  });

  it('32. no export record is ever invented — cdnur.export stays empty regardless', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', buyerGstin: null, buyerCountry: 'United Arab Emirates', sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 50_000 }),
        source({ id: 'cn_2', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
      ],
      options(),
    );
    expect(result.cdnur.export.documents).toEqual([]);
    expect(result.cdnur.export.summary).toEqual({ documentCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, noteValue: 0 });
  });
});

describe('aggregateGstr1CreditNotes — K. DUPLICATES', () => {
  it('33. duplicate source CreditNote id cannot double-count', () => {
    const dup = source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT });
    const result = aggregateGstr1CreditNotes([dup, dup], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.reason === 'DUPLICATE_SOURCE_ID')).toBe(true);
  });
});

describe('aggregateGstr1CreditNotes — L. DEBIT NOTES', () => {
  it('34. DebitNote-shaped data cannot be supplied as CreditNote aggregation input (type boundary)', () => {
    // A DebitNote (server/prisma/schema.prisma) is purchase-side: grnId/supplierId, no invoiceId,
    // no originalInvoiceNumber/Date, no salesReturnId, no buyerGstin, no CreditNoteItem-shaped
    // `items`. It structurally cannot satisfy Gstr1CreditNoteAggregationSourceDocument — the
    // compiler is the actual guard here, exercised via @ts-expect-error below.
    const debitNoteShaped = {
      id: 'dn_1',
      debitNoteNumber: 'DN-0001',
      debitNoteDate: CURRENT_PERIOD_DATE,
      grnId: 'grn_1',
      supplierId: 'sup_1',
      status: 'ISSUED',
      reasonCode: 'RATE_DIFFERENCE',
      reasonNotes: null,
      taxableAmount: 1000,
      cgst: 0, sgst: 0, igst: 0, totalTax: 0, totalAmount: 1000,
    };
    // @ts-expect-error — a DebitNote-shaped object is missing invoiceId/originalInvoiceNumber/
    // originalInvoiceDate/salesReturnId/buyerGstin/items and cannot satisfy the CreditNote
    // aggregation input contract (rule 21/34 — Debit Notes are a separate, purchase-side flow).
    const rejected: Gstr1CreditNoteAggregationSourceDocument = debitNoteShaped;
    expect(rejected.id).toBe('dn_1'); // keeps the variable "used" for lint purposes only
  });
});

describe('aggregateGstr1CreditNotes — M. SUMMARY', () => {
  it('35. document totals and summary totals reconcile exactly across mixed buckets', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', creditNoteNumber: 'CN-1', totalAmount: 1590, taxableAmount: 1500, cgst: 0, sgst: 0, igst: 90, buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 }),
        source({ id: 'cn_2', creditNoteNumber: 'CN-2', totalAmount: 2000, taxableAmount: 1900, cgst: 0, sgst: 0, igst: 100, buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 }),
        source({ id: 'cn_3', creditNoteNumber: 'CN-3', totalAmount: 3000, taxableAmount: 2900, cgst: 50, sgst: 50, igst: 0, buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 }),
        source({ id: 'cn_4', creditNoteNumber: 'CN-4', totalAmount: 4000, taxableAmount: 3800, cgst: 100, sgst: 100, igst: 0, buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
      ],
      options(),
    );
    const manualB2clSum = result.cdnur.b2cl.documents.reduce((s, d) => round2(s + d.noteValue), 0);
    expect(result.cdnur.b2cl.summary.noteValue).toBe(manualB2clSum);
    const manualB2csNetOffSum = result.b2csNetOff.documents.reduce((s, d) => round2(s + d.noteValue), 0);
    expect(result.b2csNetOff.summary.noteValue).toBe(manualB2csNetOffSum);
    const manualCdnrSum = result.cdnr.documents.reduce((s, d) => round2(s + d.noteValue), 0);
    expect(result.cdnr.summary.noteValue).toBe(manualCdnrSum);

    function round2(n: number) { return Math.round(n * 100) / 100; }
  });

  it('36. every document represents its impact as a reduction consistently', () => {
    const result = aggregateGstr1CreditNotes(
      [
        source({ id: 'cn_1', buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }),
        source({ id: 'cn_2', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 }),
      ],
      options(),
    );
    const allDocuments = [...result.cdnr.documents, ...result.cdnur.b2cl.documents, ...result.b2csNetOff.documents];
    expect(allDocuments.length).toBeGreaterThan(0);
    for (const doc of allDocuments) {
      expect(doc.documentType).toBe('CREDIT_NOTE');
      expect(doc.sign).toBe(-1);
      // actual persisted positive values retained — never multiplied by -1 (rule 12)
      expect(doc.noteValue).toBeGreaterThan(0);
    }
  });
});

describe('aggregateGstr1CreditNotes — additional: registration required', () => {
  it('throws when gstRegistrationId is missing/blank', () => {
    expect(() => aggregateGstr1CreditNotes([source()], options({ gstRegistrationId: '' }))).toThrow(Gstr1CreditNoteAggregationAccessError);
  });
});

describe('aggregateGstr1CreditNotes — additional: empty input', () => {
  it('an empty input returns zero totals cleanly, with no crash', () => {
    const result = aggregateGstr1CreditNotes([], options());
    expect(result.cdnr.documents).toEqual([]);
    expect(result.cdnur.b2cl.documents).toEqual([]);
    expect(result.b2csNetOff.documents).toEqual([]);
    expect(result.cdnur.export.documents).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.cdnr.summary).toEqual({ documentCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, noteValue: 0 });
  });
});

describe('aggregateGstr1CreditNotes — additional: tenant safety', () => {
  it('pure function has no Prisma/database access', () => {
    const src = fs.readFileSync(path.join(__dirname, 'gstr1CreditNoteAggregation.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]@prisma\/client['"]/);
    expect(src).not.toMatch(/from ['"].*config\/database['"]/);
    expect(src).not.toMatch(/from ['"].*tenantContext['"].*\n.*PrismaClient/);
    expect(src.toLowerCase()).not.toContain('prisma.');
  });

  it('never reclassifies — no independent GSTIN format or classification logic duplicated here', () => {
    const src = fs.readFileSync(path.join(__dirname, 'gstr1CreditNoteAggregation.ts'), 'utf8');
    expect(src).not.toMatch(/GSTIN_FORMAT/);
    expect(src).not.toMatch(/classifyGstr1OutwardSupply/);
  });
});
