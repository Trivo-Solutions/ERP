import { describe, it, expect } from 'vitest';
import {
  aggregateGstr1Table12,
  Gstr1Table12AggregationAccessError,
  type Gstr1Table12AggregationOptions,
} from './gstr1Table12Aggregation';
import type { Gstr1OutwardSourceInvoice } from './gstr1OutwardAggregation';
import type { Gstr1CreditNoteAggregationSourceDocument } from './gstr1CreditNoteAggregation';
import type { InvoiceItemSourceRow, CreditNoteItemSourceRow } from './gstr1Normalizer';

const GUJARAT = '24';
const MAHARASHTRA = '27';
const REGISTERED_GSTIN = '27AAAAA0000A1Z5';
const HSN_7113 = { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' };
const HSN_9999 = { code: '9999', description: 'Other articles', defaultUqc: null };

const CURRENT_PERIOD_DATE = new Date('2026-09-15T00:00:00.000Z');

function item(overrides: Partial<InvoiceItemSourceRow> = {}): InvoiceItemSourceRow {
  return {
    id: 'item_1',
    invoiceId: 'inv_1',
    description: 'Gold ring',
    quantity: 1,
    netGoldWeight: 10,
    hsnCode: HSN_7113,
    hsnCodeId: 'hsn_7113',
    uqc: 'GMS',
    taxRate: 0.03,
    taxableValue: 100_000,
    cgstAmount: 1500,
    sgstAmount: 1500,
    igstAmount: 0,
    lineTotalTax: 3000,
    ...overrides,
  };
}

function invoice(overrides: Partial<Gstr1OutwardSourceInvoice> = {}): Gstr1OutwardSourceInvoice {
  return {
    invoiceId: 'inv_1',
    invoiceNumber: 'INV-0001',
    invoiceDate: CURRENT_PERIOD_DATE,
    status: 'ISSUED',
    branchId: 'branch_1',
    totalAmount: 103_000,
    buyerGstin: null,
    placeOfSupply: MAHARASHTRA,
    sellerStateCode: GUJARAT,
    sellerRegistrationId: 'reg_1',
    reverseCharge: false,
    items: [item()],
    ...overrides,
  };
}

const creditNoteHsnLine: CreditNoteItemSourceRow = {
  id: 'cni_1', creditNoteId: 'cn_1', description: 'Returned ring',
  hsnCode: HSN_7113, hsnCodeId: 'hsn_7113', uqc: 'GMS',
  quantity: 1, taxRate: 0.03, taxableValue: 20_000, cgstAmount: 300, sgstAmount: 0, igstAmount: 300,
  totalValue: 20_600, netWeight: 2,
};

function creditNote(overrides: Partial<Gstr1CreditNoteAggregationSourceDocument> = {}): Gstr1CreditNoteAggregationSourceDocument {
  return {
    id: 'cn_1',
    creditNoteNumber: 'CN-0001',
    creditNoteDate: CURRENT_PERIOD_DATE,
    status: 'ISSUED',
    invoiceId: 'inv_1',
    originalInvoiceNumber: 'INV-0001',
    originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 103_000,
    salesReturnId: null,
    sellerRegistrationId: 'reg_1',
    sellerStateCode: GUJARAT,
    buyerGstin: null,
    buyerCountry: 'India',
    placeOfSupply: MAHARASHTRA,
    reasonCode: 'OTHER',
    reasonNotes: null,
    taxableAmount: 20_000,
    cgst: 300,
    sgst: 0,
    igst: 300,
    totalTax: 600,
    totalAmount: 20_600,
    items: [creditNoteHsnLine],
    branchId: 'branch_1',
    ...overrides,
  };
}

function options(overrides: Partial<Gstr1Table12AggregationOptions> = {}): Gstr1Table12AggregationOptions {
  return {
    gstRegistrationId: 'reg_1',
    period: { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
    ...overrides,
  };
}

function run(invoices: Gstr1OutwardSourceInvoice[], creditNotes: Gstr1CreditNoteAggregationSourceDocument[] = [], opts: Partial<Gstr1Table12AggregationOptions> = {}) {
  return aggregateGstr1Table12(invoices, creditNotes, options(opts));
}

describe('aggregateGstr1Table12 — classification/tab', () => {
  it('1. B2B (registered buyer) -> B2B_SUPPLIES', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2B_SUPPLIES');
    expect(result.summary.b2bRows).toBe(1);
    expect(result.summary.b2cRows).toBe(0);
  });

  it('2. B2CL (unregistered, interstate, above threshold) -> B2C_SUPPLIES', () => {
    const result = run([invoice({ totalAmount: 200_000, items: [item({ taxableValue: 195_000 })] })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2C_SUPPLIES');
  });

  it('3. B2CS (unregistered, intra-state) -> B2C_SUPPLIES', () => {
    const result = run([invoice({ placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2C_SUPPLIES');
  });

  it('4. UNCLASSIFIED (missing seller state for an unregistered buyer) -> diagnostic, excluded from rows', () => {
    const result = run([invoice({ sellerStateCode: null })]);
    expect(result.rows).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === 'UNCLASSIFIED_OUTWARD_SUPPLY')).toBe(true);
  });
});

describe('aggregateGstr1Table12 — aggregation', () => {
  it('5. same HSN + same rate + same UQC merges across invoices', () => {
    const result = run([
      invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', buyerGstin: REGISTERED_GSTIN }),
      invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'item_2', invoiceId: 'inv_2' })] }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].taxableValue).toBe(200_000);
    expect(result.rows[0].recordCount).toBe(2);
  });

  it('6. same HSN + different GST rate does NOT merge', () => {
    const result = run([
      invoice({
        buyerGstin: REGISTERED_GSTIN,
        items: [
          item({ id: 'i1', taxRate: 0.03 }),
          item({ id: 'i2', taxRate: 0.18, taxableValue: 5_000, cgstAmount: 450, sgstAmount: 450, igstAmount: 0, lineTotalTax: 900 }),
        ],
      }),
    ]);
    expect(result.rows).toHaveLength(2);
  });

  it('7. same HSN + different UQC does NOT merge', () => {
    const result = run([
      invoice({
        buyerGstin: REGISTERED_GSTIN,
        items: [
          item({ id: 'i1', uqc: 'GMS' }),
          item({ id: 'i2', uqc: 'PCS', quantity: 2, taxableValue: 5_000, cgstAmount: 450, sgstAmount: 450, igstAmount: 0, lineTotalTax: 900 }),
        ],
      }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.uqc).sort()).toEqual(['GMS', 'PCS']);
  });

  it('8. B2B and B2C never merge, even with identical HSN/rate/UQC', () => {
    const result = run([
      invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', buyerGstin: REGISTERED_GSTIN }),
      invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', buyerGstin: null, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT, items: [item({ id: 'item_2', invoiceId: 'inv_2' })] }),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.reportingTab).sort()).toEqual(['B2B_SUPPLIES', 'B2C_SUPPLIES']);
  });

  it('9. multiple invoices aggregate correctly', () => {
    const result = run([
      invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', buyerGstin: REGISTERED_GSTIN }),
      invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'item_2', invoiceId: 'inv_2', taxableValue: 50_000, cgstAmount: 750, sgstAmount: 750, lineTotalTax: 1500 })] }),
      invoice({ invoiceId: 'inv_3', invoiceNumber: 'INV-0003', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'item_3', invoiceId: 'inv_3', taxableValue: 25_000, cgstAmount: 375, sgstAmount: 375, lineTotalTax: 750 })] }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].taxableValue).toBe(175_000);
    expect(result.rows[0].cgst).toBe(2625);
    expect(result.rows[0].sgst).toBe(2625);
    expect(result.rows[0].recordCount).toBe(3);
  });

  it('10. monetary rounding is deterministic across many lines', () => {
    const invoices = Array.from({ length: 5 }, (_, i) => invoice({
      invoiceId: `inv_${i}`, invoiceNumber: `INV-000${i}`, buyerGstin: REGISTERED_GSTIN,
      items: [item({ id: `item_${i}`, invoiceId: `inv_${i}`, taxableValue: 33.33, cgstAmount: 0.5, sgstAmount: 0.5, igstAmount: 0, lineTotalTax: 1 })],
    }));
    const result = run(invoices);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].taxableValue).toBe(166.65);
    expect(result.rows[0].cgst).toBe(2.5);
    expect(result.rows[0].sgst).toBe(2.5);
  });
});

describe('aggregateGstr1Table12 — quantity', () => {
  it('11. GMS uses the normalized netGoldWeight', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ uqc: 'GMS', netGoldWeight: 12.5 })] })]);
    expect(result.rows[0].grossQuantity).toBe(12.5);
  });

  it('12. PCS uses the normalized billing quantity', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ uqc: 'PCS', quantity: 3 })] })]);
    expect(result.rows[0].grossQuantity).toBe(3);
  });

  it('13. unsupported UQC does not fabricate quantity', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ hsnCode: HSN_9999, uqc: 'BOX', netGoldWeight: 0 })] })]);
    expect(result.rows[0].grossQuantity).toBe(0);
    expect(result.diagnostics.some((d) => d.code === 'UNSUPPORTED_UQC')).toBe(true);
  });

  it('14. missing quantity generates a diagnostic (a Path A Credit Note line whose UQC calls for a weight it doesn\'t have)', () => {
    // InvoiceItem/CreditNoteItem's own `quantity`/`netGoldWeight` columns are effectively always
    // populated on a real outward-supply line, so UNAVAILABLE is only reachable in practice on a
    // Credit Note's own `netWeight`, which genuinely can be null (see CreditNoteItemSourceRow's own
    // doc comment) while `quantity` (physical-vs-value-only) is still set.
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN })],
      [creditNote({ salesReturnId: 'ret_1', buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, uqc: 'GMS', quantity: 1, netWeight: null }] })],
    );
    expect(result.rows[0].creditNoteQuantityReduction).toBe(0);
    expect(result.diagnostics.some((d) => d.code === 'QUANTITY_UNAVAILABLE')).toBe(true);
  });
});

describe('aggregateGstr1Table12 — credit notes', () => {
  it('15. formal Path A reduces taxable/tax values', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ taxableValue: 100_000, cgstAmount: 1500, sgstAmount: 1500, igstAmount: 0, lineTotalTax: 3000 })] })],
      [creditNote({ salesReturnId: 'ret_1', buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, quantity: 1, cgstAmount: 300, sgstAmount: 0, igstAmount: 300, taxableValue: 20_000 }] })],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].grossTaxableValue).toBe(100_000);
    expect(result.rows[0].creditNoteTaxableReduction).toBe(20_000);
    expect(result.rows[0].taxableValue).toBe(80_000);
  });

  it('16. Path A reduces physical quantity where a normalized quantity exists', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ netGoldWeight: 10 })] })],
      [creditNote({ salesReturnId: 'ret_1', buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, quantity: 1, netWeight: 3 }] })],
    );
    expect(result.rows[0].grossQuantity).toBe(10);
    expect(result.rows[0].creditNoteQuantityReduction).toBe(3);
    expect(result.rows[0].quantity).toBe(7);
  });

  it('17. Path B (standalone) reduces value/tax without fabricating quantity', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ netGoldWeight: 10, taxableValue: 100_000, cgstAmount: 1500, sgstAmount: 1500 })] })],
      [creditNote({ salesReturnId: null, buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, quantity: null, netWeight: null, taxableValue: 5_000, cgstAmount: 75, sgstAmount: 75, igstAmount: 0 }] })],
    );
    expect(result.rows[0].creditNoteQuantityReduction).toBe(0); // no physical quantity fabricated
    expect(result.rows[0].creditNoteTaxableReduction).toBe(5_000);
    expect(result.rows[0].taxableValue).toBe(95_000);
  });

  it('18. a cancelled Credit Note is excluded — never reduces a bucket', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN })],
      [creditNote({ status: 'CANCELLED', buyerGstin: REGISTERED_GSTIN })],
    );
    expect(result.rows[0].creditNoteTaxableReduction).toBe(0);
    expect(result.diagnostics.some((d) => d.code === 'CREDIT_NOTE_EXCLUDED')).toBe(true);
  });

  it('19. a SalesReturn with no formal Credit Note never reduces Table 12 (no SalesReturn input exists at all)', () => {
    // This aggregator's input contract has no SalesReturn concept whatsoever — passing an empty
    // creditNoteSources array is structurally equivalent to "the return has no formal CN yet."
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ taxableValue: 100_000 })] })], []);
    expect(result.rows[0].creditNoteTaxableReduction).toBe(0);
    expect(result.rows[0].taxableValue).toBe(result.rows[0].grossTaxableValue);
  });

  it('20. a Path A Credit Note produces exactly one reduction batch per line — never double-reduced', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ taxableValue: 100_000, cgstAmount: 1500, sgstAmount: 1500 })] })],
      [creditNote({ salesReturnId: 'ret_1', buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, taxableValue: 20_000, cgstAmount: 300, sgstAmount: 0, igstAmount: 300 }] })],
    );
    expect(result.rows[0].creditNoteRecordCount).toBe(1);
    expect(result.rows[0].creditNoteTaxableReduction).toBe(20_000);
  });

  it('21. classification uses the ORIGINAL invoice value, not the Credit Note\'s own (small) value', () => {
    const result = run(
      [invoice({ buyerGstin: null, placeOfSupply: MAHARASHTRA, sellerStateCode: GUJARAT, totalAmount: 200_000, items: [item({ taxableValue: 195_000 })] })],
      [creditNote({
        buyerGstin: null, placeOfSupply: MAHARASHTRA, sellerStateCode: GUJARAT,
        originalInvoiceValue: 200_000, taxableAmount: 100, cgst: 0, sgst: 0, igst: 3, totalTax: 3, totalAmount: 103,
        items: [{ ...creditNoteHsnLine, taxableValue: 100, cgstAmount: 0, sgstAmount: 0, igstAmount: 3 }],
      })],
    );
    // Original invoice is B2CL (interstate, > 1,00,000) -> B2C_SUPPLIES, even though the CN itself is tiny.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2C_SUPPLIES');
    expect(result.rows[0].creditNoteTaxableReduction).toBe(100);
  });

  it('22. a B2B Credit Note reduces the B2B bucket', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN })],
      [creditNote({ buyerGstin: REGISTERED_GSTIN })],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2B_SUPPLIES');
    expect(result.rows[0].creditNoteTaxableReduction).toBe(20_000);
  });

  it('23. a B2CL/B2CS Credit Note reduces the B2C bucket', () => {
    const result = run(
      [invoice({ buyerGstin: null, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      [creditNote({ buyerGstin: null, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT, originalInvoiceValue: 103_000 })],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportingTab).toBe('B2C_SUPPLIES');
    expect(result.rows[0].creditNoteTaxableReduction).toBe(20_000);
  });
});

describe('aggregateGstr1Table12 — scope', () => {
  it('24. wrong GST registration silently excludes the invoice', () => {
    const result = run([invoice({ sellerRegistrationId: 'reg_other', buyerGstin: REGISTERED_GSTIN })]);
    expect(result.rows).toHaveLength(0);
    expect(result.meta.invoicesExcludedByScope).toBe(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('25. missing seller registration on the source produces a diagnostic, not silent exclusion', () => {
    const result = run([invoice({ sellerRegistrationId: null, buyerGstin: REGISTERED_GSTIN })]);
    expect(result.meta.invoicesConsidered).toBe(1);
    expect(result.diagnostics.some((d) => d.code === 'UNCLASSIFIED_OUTWARD_SUPPLY')).toBe(true);
  });

  it('26. branch filtering works', () => {
    const result = run(
      [invoice({ branchId: 'branch_2', buyerGstin: REGISTERED_GSTIN })],
      [],
      { branchAccess: { allBranches: false, branchIds: ['branch_1'] } },
    );
    expect(result.rows).toHaveLength(0);
    expect(result.meta.invoicesExcludedByScope).toBe(1);
  });

  it('27. an explicitly requested but unauthorized branch is rejected outright', () => {
    expect(() => run([invoice()], [], { branchAccess: { allBranches: false, branchIds: ['branch_1'] }, branchId: 'branch_2' }))
      .toThrow(Gstr1Table12AggregationAccessError);
  });

  it('28. period boundaries are inclusive at both ends, as given by the caller', () => {
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-30T23:59:59.999Z');
    const inRange = run([invoice({ invoiceDate: to, buyerGstin: REGISTERED_GSTIN })], [], { period: { from, to } });
    expect(inRange.meta.invoicesExcludedByScope).toBe(0);
    const outOfRange = run([invoice({ invoiceDate: new Date('2026-10-01T00:00:00.001Z'), buyerGstin: REGISTERED_GSTIN })], [], { period: { from, to } });
    expect(outOfRange.meta.invoicesExcludedByScope).toBe(1);
  });

  it('29. a VOID invoice is excluded via a diagnostic, never silently dropped', () => {
    const result = run([invoice({ status: 'VOID', buyerGstin: REGISTERED_GSTIN })]);
    expect(result.rows).toHaveLength(0);
    const diag = result.diagnostics.find((d) => d.code === 'EXCLUDED_VOID');
    expect(diag).toBeTruthy();
    expect(diag!.invoiceId).toBe('inv_1');
  });
});

describe('aggregateGstr1Table12 — data quality', () => {
  it('30. missing HSN generates a diagnostic and marks the row filing-ineligible', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ hsnCode: null, hsnCodeId: null })] })]);
    expect(result.diagnostics.some((d) => d.code === 'MISSING_HSN')).toBe(true);
    expect(result.rows[0].filingEligible).toBe(false);
  });

  it('31. missing/unsupported UQC generates a diagnostic', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ hsnCode: HSN_9999, uqc: null })] })]);
    expect(result.diagnostics.some((d) => d.code === 'MISSING_UQC')).toBe(true);
    expect(result.rows[0].filingEligible).toBe(false);
  });

  it('32. a negative net bucket is flagged, not silently clamped', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ taxableValue: 5_000, cgstAmount: 75, sgstAmount: 75, igstAmount: 0 })] })],
      [creditNote({ buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, taxableValue: 20_000, cgstAmount: 300, sgstAmount: 300, igstAmount: 0 }] })],
    );
    expect(result.rows[0].taxableValue).toBeLessThan(0);
    expect(result.diagnostics.some((d) => d.code === 'NEGATIVE_NET_TABLE12_BUCKET')).toBe(true);
    expect(result.rows[0].filingEligible).toBe(false);
  });

  it('33. negative values are never silently clamped to zero', () => {
    const result = run(
      [invoice({ buyerGstin: REGISTERED_GSTIN, items: [item({ taxableValue: 1_000, cgstAmount: 15, sgstAmount: 15, igstAmount: 0 })] })],
      [creditNote({ buyerGstin: REGISTERED_GSTIN, items: [{ ...creditNoteHsnLine, taxableValue: 9_000, cgstAmount: 135, sgstAmount: 135, igstAmount: 0 }] })],
    );
    expect(result.rows[0].taxableValue).toBe(-8_000);
  });

  it('34. no AATO/digit-compliance determination is fabricated', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN })]);
    expect(result.meta.hsnDigitCompliance).toBe('NOT_DETERMINED');
  });

  it('35. cess is never fabricated from a header-level figure', () => {
    const result = run([invoice({ buyerGstin: REGISTERED_GSTIN })]);
    expect(result.rows[0].cess).toBe(0);
    expect(result.rows[0].grossCess).toBe(0);
  });
});

describe('aggregateGstr1Table12 — call-level validation', () => {
  it('throws when gstRegistrationId is missing', () => {
    expect(() => aggregateGstr1Table12([], [], { gstRegistrationId: '', period: options().period }))
      .toThrow(Gstr1Table12AggregationAccessError);
  });
});
