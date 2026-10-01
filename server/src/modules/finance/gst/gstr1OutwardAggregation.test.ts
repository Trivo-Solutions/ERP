import { describe, it, expect } from 'vitest';
import {
  aggregateGstr1OutwardSupplies,
  Gstr1OutwardAggregationAccessError,
  type Gstr1OutwardSourceInvoice,
  type Gstr1OutwardAggregationOptions,
} from './gstr1OutwardAggregation';
import type { InvoiceItemSourceRow, CreditNoteItemSourceRow } from './gstr1Normalizer';
import type { Gstr1CreditNoteAggregationSourceDocument } from './gstr1CreditNoteAggregation';

const GUJARAT = '24';
const MAHARASHTRA = '27';
const HSN_7113 = { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' };
const HSN_9999 = { code: '9999', description: 'Other', defaultUqc: null };

const CURRENT_PERIOD_DATE = new Date('2026-09-15T00:00:00.000Z');
const HISTORICAL_PERIOD_DATE = new Date('2023-06-15T00:00:00.000Z');

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

function options(overrides: Partial<Gstr1OutwardAggregationOptions> = {}): Gstr1OutwardAggregationOptions {
  return {
    gstRegistrationId: 'reg_1',
    period: { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
    ...overrides,
  };
}

// Phase A — B2CS Credit Note net-off fixtures. Mirrors gstr1CreditNoteAggregation.test.ts's own
// `source()`/`hsn7113Line` fixtures exactly (same shape, same field defaults) so a credit note
// built here is directly comparable to one built there.
const creditNoteHsn7113Line: CreditNoteItemSourceRow = {
  id: 'cni_1', creditNoteId: 'cn_1', description: '22K Gold Chain',
  hsnCode: HSN_7113, hsnCodeId: 'hsn_7113', uqc: 'GMS',
  quantity: 1, taxRate: 0.03, taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0,
  totalValue: 10_300, netWeight: 2,
};

function creditNoteSource(overrides: Partial<Gstr1CreditNoteAggregationSourceDocument> = {}): Gstr1CreditNoteAggregationSourceDocument {
  return {
    id: 'cn_1',
    creditNoteNumber: 'CN-0001',
    creditNoteDate: CURRENT_PERIOD_DATE,
    status: 'ISSUED',
    invoiceId: 'inv_1',
    originalInvoiceNumber: 'INV-0001',
    originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 40_000,
    salesReturnId: null,
    sellerRegistrationId: 'reg_1',
    sellerStateCode: GUJARAT,
    buyerGstin: null,
    buyerCountry: 'India',
    placeOfSupply: GUJARAT,
    reasonCode: 'POST_SALE_DISCOUNT',
    reasonNotes: null,
    taxableAmount: 10_000,
    cgst: 150,
    sgst: 150,
    igst: 0,
    totalTax: 300,
    totalAmount: 10_300,
    items: [creditNoteHsn7113Line],
    branchId: 'branch_1',
    ...overrides,
  };
}

describe('aggregateGstr1OutwardSupplies — B2B', () => {
  it('1. registered buyer classifies into B2B', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5' })],
      options(),
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.b2cl).toHaveLength(0);
    expect(result.b2cs).toHaveLength(0);
    expect(result.b2b[0].category).toBe('B2B');
    expect(result.b2b[0].buyerGstin).toBe('27AAAAA0000A1Z5');
  });

  it('2. two invoices for the same buyer remain distinct — never collapsed', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', buyerGstin: '27AAAAA0000A1Z5' }),
        invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', buyerGstin: '27AAAAA0000A1Z5' }),
      ],
      options(),
    );
    expect(result.b2b).toHaveLength(2);
    expect(result.b2b.map((r) => r.invoiceNumber).sort()).toEqual(['INV-0001', 'INV-0002']);
  });

  it('3. multiple lines at different HSN/rates aggregate correctly under one invoice record', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({
          buyerGstin: '27AAAAA0000A1Z5',
          items: [
            item({ id: 'i1', hsnCode: HSN_7113, taxRate: 0.03, taxableValue: 100_000, cgstAmount: 1500, sgstAmount: 1500, igstAmount: 0, lineTotalTax: 3000 }),
            item({ id: 'i2', hsnCode: HSN_9999, taxRate: 0.18, taxableValue: 10_000, cgstAmount: 900, sgstAmount: 900, igstAmount: 0, lineTotalTax: 1800, uqc: null, netGoldWeight: 0 }),
          ],
        }),
      ],
      options(),
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.b2b[0].lines).toHaveLength(2);
    expect(result.b2b[0].totals.taxableValue).toBe(110_000);
    expect(result.b2b[0].totals.cgst).toBe(2400);
    expect(result.b2b[0].totals.sgst).toBe(2400);
  });

  it('4. uses the persisted tax snapshot directly — never recalculates from a rate', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', items: [item({ taxableValue: 77_777, cgstAmount: 1234.56, sgstAmount: 1234.56, igstAmount: 0 })] })],
      options(),
    );
    expect(result.b2b[0].totals.cgst).toBe(1234.56);
    expect(result.b2b[0].totals.sgst).toBe(1234.56);
    expect(result.b2b[0].totals.taxableValue).toBe(77_777);
  });
});

describe('aggregateGstr1OutwardSupplies — B2CL threshold', () => {
  it('5. unregistered, interstate, exactly ₹1,00,000 → B2CS, not B2CL', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ totalAmount: 100_000 })], options());
    expect(result.b2cl).toHaveLength(0);
    expect(result.b2cs.length).toBeGreaterThan(0);
  });

  it('6. unregistered, interstate, ₹1,00,000.01 → B2CL', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ totalAmount: 100_000.01 })], options());
    expect(result.b2cl).toHaveLength(1);
    expect(result.b2cl[0].threshold).toBe(100_000);
    expect(result.b2cl[0].invoiceValue).toBe(100_000.01);
  });

  it('7. inter-state condition required — an intra-state high-value sale never reaches B2CL', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 500_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
    );
    expect(result.b2cl).toHaveLength(0);
    expect(result.b2cs.length).toBeGreaterThan(0);
  });

  it('8. pre-Aug-2024 ₹2,50,000 threshold applies for a historical invoice date', () => {
    const belowHistorical = aggregateGstr1OutwardSupplies(
      [invoice({ invoiceDate: HISTORICAL_PERIOD_DATE, totalAmount: 200_000 })],
      options({ period: { from: new Date('2023-01-01'), to: new Date('2023-12-31') } }),
    );
    expect(belowHistorical.b2cl).toHaveLength(0);

    const aboveHistorical = aggregateGstr1OutwardSupplies(
      [invoice({ invoiceDate: HISTORICAL_PERIOD_DATE, totalAmount: 260_000 })],
      options({ period: { from: new Date('2023-01-01'), to: new Date('2023-12-31') } }),
    );
    expect(aboveHistorical.b2cl).toHaveLength(1);
    expect(aboveHistorical.b2cl[0].threshold).toBe(250_000);
  });

  it('9. the historical threshold is selected from the TRANSACTION\'s own invoice date, not the current date', () => {
    // ₹150,000 is below the CURRENT ₹1,00,000... no — above current, but below the historical
    // ₹2,50,000 threshold. A historical-dated invoice at this value must land in B2CS, proving the
    // date-of-transaction (not today's rule) governs.
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ invoiceDate: HISTORICAL_PERIOD_DATE, totalAmount: 150_000 })],
      options({ period: { from: new Date('2023-01-01'), to: new Date('2023-12-31') } }),
    );
    expect(result.b2cl).toHaveLength(0);
    expect(result.b2cs.length).toBeGreaterThan(0);
  });
});

describe('aggregateGstr1OutwardSupplies — B2CS', () => {
  it('10. unregistered, interstate, exactly at threshold → B2CS group', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ totalAmount: 100_000 })], options());
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].isInterState).toBe(true);
  });

  it('11. unregistered, interstate, below threshold → B2CS group', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ totalAmount: 40_000 })], options());
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].isInterState).toBe(true);
  });

  it('12. unregistered, intra-state, high value → B2CS regardless of value', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 900_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].isInterState).toBe(false);
  });

  it('13. unregistered, intra-state, low value → B2CS', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 500, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].isInterState).toBe(false);
  });

  it('B2CS groups by place of supply + rate + HSN across multiple invoices, never by invoice identity', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', totalAmount: 40_000 }),
        invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', totalAmount: 30_000 }),
      ],
      options(),
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].recordCount).toBe(2);
    expect(result.b2cs[0].taxableValue).toBe(200_000); // 100,000 taxableValue per line × 2
  });
});

describe('aggregateGstr1OutwardSupplies — data-quality diagnostics', () => {
  it('14. missing seller registration → diagnostic, not silently dropped', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ sellerRegistrationId: null })], options());
    expect(result.b2b).toHaveLength(0);
    expect(result.b2cl).toHaveLength(0);
    expect(result.b2cs).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reportability).toBe('UNCLASSIFIED');
    expect(result.diagnostics[0].reason).toMatch(/registration/i);
  });

  it('15. missing invoice value → diagnostic', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ totalAmount: null })], options());
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reason).toMatch(/invoice value/i);
  });

  it('16. invalid/unresolved place of supply (unregistered) → diagnostic', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ placeOfSupply: 'Unresolved Free Text' })], options());
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reason).toMatch(/place of supply/i);
  });

  it('17. invalid/unresolved seller state (unregistered) → diagnostic', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ sellerStateCode: 'not-a-code' })], options());
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reason).toMatch(/seller state/i);
  });

  it('18. missing invoice date where the B2CL threshold decision needs it → diagnostic', () => {
    const result = aggregateGstr1OutwardSupplies([invoice({ invoiceDate: null })], options());
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reason).toMatch(/date/i);
  });

  it('19. malformed state data never silently falls back to a B2C classification', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ placeOfSupply: 'garbage', sellerStateCode: 'garbage' })],
      options(),
    );
    expect(result.b2cs).toHaveLength(0);
    expect(result.b2cl).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('aggregateGstr1OutwardSupplies — status/lifecycle', () => {
  it('20. a VOID invoice is excluded from every bucket, recorded as a diagnostic', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ status: 'VOID', buyerGstin: '27AAAAA0000A1Z5' })],
      options(),
    );
    expect(result.b2b).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reportability).toBe('EXCLUDED_VOID');
  });

  it('21. an active (non-VOID) invoice is included normally', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ status: 'ISSUED', buyerGstin: '27AAAAA0000A1Z5' })],
      options(),
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('22. this phase never consumes SalesReturn data — a return does not reduce the original outward supply', () => {
    // The aggregator's input contract has no SalesReturn field at all; passing only the invoice
    // itself proves nothing implicitly nets it down.
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', totalAmount: 103_000 })],
      options(),
    );
    expect(result.b2b[0].invoiceValue).toBe(103_000);
    expect(result.b2b[0].totals.taxableValue).toBe(100_000);
  });

  it('23. this phase never consumes a Path-A (return-wrapping) Credit Note — no reduction from it', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', totalAmount: 103_000 })],
      options(),
    );
    expect(result.b2b[0].invoiceValue).toBe(103_000);
  });

  it('24. this phase never consumes a Path-B (standalone) Credit Note — no reduction from it', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', totalAmount: 103_000 })],
      options(),
    );
    expect(result.b2b[0].invoiceValue).toBe(103_000);
  });

  it('25. a cancelled Credit Note has no bearing here either — CreditNote status is not a concept this module reads', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', totalAmount: 103_000 })],
      options(),
    );
    expect(result.b2b[0].invoiceValue).toBe(103_000);
  });
});

describe('aggregateGstr1OutwardSupplies — tenant/security', () => {
  it('26. only the selected GST registration is aggregated; others are silently out of scope', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', sellerRegistrationId: 'reg_1', buyerGstin: '27AAAAA0000A1Z5' }),
        invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', sellerRegistrationId: 'reg_2', buyerGstin: '27AAAAA0000A1Z5' }),
      ],
      options({ gstRegistrationId: 'reg_1' }),
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.b2b[0].invoiceNumber).toBe('INV-0001');
    expect(result.diagnostics).toHaveLength(0);
    expect(result.meta.invoicesExcludedByScope).toBe(1);
  });

  it('27. an unauthorized requested branch is rejected outright, not silently excluded', () => {
    expect(() =>
      aggregateGstr1OutwardSupplies(
        [invoice()],
        options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] }, branchId: 'branch_2' }),
      ),
    ).toThrow(Gstr1OutwardAggregationAccessError);
  });

  it('28. a branch-restricted caller only aggregates their accessible branches', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', branchId: 'branch_1', buyerGstin: '27AAAAA0000A1Z5' }),
        invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', branchId: 'branch_2', buyerGstin: '27AAAAA0000A1Z5' }),
      ],
      options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] } }),
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.b2b[0].invoiceNumber).toBe('INV-0001');
    expect(result.meta.invoicesExcludedByScope).toBe(1);
  });

  it('29. a source row carrying a foreign registration id cannot enter the report for a different selected registration', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ sellerRegistrationId: 'reg_belongs_to_another_company', buyerGstin: '27AAAAA0000A1Z5' })],
      options({ gstRegistrationId: 'reg_1' }),
    );
    expect(result.b2b).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0); // out of scope, not a data-quality diagnostic
    expect(result.meta.invoicesExcludedByScope).toBe(1);
  });

  it('30. an empty period/input returns zero totals cleanly, with no crash', () => {
    const result = aggregateGstr1OutwardSupplies([], options());
    expect(result.b2b).toEqual([]);
    expect(result.b2cl).toEqual([]);
    expect(result.b2cs).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.totals.grandTotal).toEqual({ taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0 });

    const outOfRange = aggregateGstr1OutwardSupplies(
      [invoice({ invoiceDate: new Date('2026-01-01'), buyerGstin: '27AAAAA0000A1Z5' })],
      options(),
    );
    expect(outOfRange.b2b).toEqual([]);
    expect(outOfRange.meta.invoicesExcludedByScope).toBe(1);
  });
});

// Phase A (GSTR-1 readiness) — B2CS Credit Note net-off. `creditNoteSources` is the aggregator's
// optional third argument; omitting it (every test above this point) reproduces exact pre-Phase-A
// gross-only behavior, which is why none of those tests needed to change.
describe('aggregateGstr1OutwardSupplies — Phase A B2CS Credit Note net-off', () => {
  it('1. B2CS invoice without a credit note -> Table 7 = gross', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [],
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].taxableValue).toBe(100_000);
    expect(result.b2cs[0].grossTaxableValue).toBe(100_000);
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(0);
    expect(result.b2csCreditNoteDiagnostics).toEqual([]);
  });

  it('2. B2CS invoice + one credit note -> Table 7 = gross - credit note', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [creditNoteSource()],
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].grossTaxableValue).toBe(100_000);
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(10_000);
    expect(result.b2cs[0].taxableValue).toBe(90_000);
    expect(result.b2cs[0].creditNoteCgstReduction).toBe(150);
    expect(result.b2cs[0].creditNoteSgstReduction).toBe(150);
    expect(result.b2cs[0].cgst).toBe(1350); // gross 1500 - 150
    expect(result.b2cs[0].filingEligible).toBe(true);
    expect(result.meta.creditNotesConsideredForNetOff).toBe(1);
    expect(result.meta.creditNotesExcludedByScope).toBe(0);
  });

  it('3. B2CS invoice + multiple credit notes -> Table 7 = gross - sum(eligible credit notes)', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [
        creditNoteSource({ id: 'cn_1', creditNoteNumber: 'CN-0001' }),
        creditNoteSource({ id: 'cn_2', creditNoteNumber: 'CN-0002', taxableAmount: 5_000, cgst: 75, sgst: 75, totalTax: 150, totalAmount: 5_150, items: [{ ...creditNoteHsn7113Line, id: 'cni_2', taxableValue: 5_000, cgstAmount: 75, sgstAmount: 75, totalValue: 5_150 }] }),
      ],
    );
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].grossTaxableValue).toBe(100_000);
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(15_000); // 10,000 + 5,000
    expect(result.b2cs[0].taxableValue).toBe(85_000);
    expect(result.meta.creditNotesConsideredForNetOff).toBe(2);
  });

  it('4. registered B2B invoice + credit note -> credit note is never netted against B2CS', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5' })], // B2B, no B2CS invoice at all in this run
      options(),
      [creditNoteSource({ buyerGstin: '27AAAAA0000A1Z5', originalInvoiceValue: 100_000 })], // original supply is B2B
    );
    expect(result.b2b).toHaveLength(1);
    expect(result.b2cs).toEqual([]); // nothing to net against, and nothing fabricated either
    expect(result.b2csCreditNoteDiagnostics).toEqual([]); // not excluded, not netted — simply not a B2CS-original note
  });

  it('5. B2CL invoice + credit note -> credit note is never netted against B2CS', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 150_000 })], // unregistered, interstate, above threshold -> B2CL
      options(),
      [creditNoteSource({ originalInvoiceValue: 150_000, placeOfSupply: MAHARASHTRA })], // original supply is B2CL
    );
    expect(result.b2cl).toHaveLength(1);
    expect(result.b2cs).toEqual([]);
    expect(result.b2csCreditNoteDiagnostics).toEqual([]);
  });

  it('6. a B2CS credit note is never reported as its own record — this module has no CDNUR/CDNR shape at all', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [creditNoteSource()],
    );
    expect(result).not.toHaveProperty('cdnr');
    expect(result).not.toHaveProperty('cdnur');
    // Its only trace is as a REDUCTION inside the matching b2cs group — never a separate record.
    expect(result.b2cs).toHaveLength(1);
  });

  it('7. multiple HSN/rate/UQC buckets -> a credit note only reduces its OWN matching bucket', () => {
    const line5pct: CreditNoteItemSourceRow = {
      ...creditNoteHsn7113Line, id: 'cni_5pct', hsnCode: HSN_9999, hsnCodeId: 'hsn_9999', uqc: null,
      taxRate: 0.05, taxableValue: 2_000, cgstAmount: 50, sgstAmount: 50, totalValue: 2_100,
    };
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT }),
        invoice({
          invoiceId: 'inv_2', invoiceNumber: 'INV-0002', totalAmount: 20_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT,
          items: [item({ id: 'item_2', hsnCode: HSN_9999, hsnCodeId: 'hsn_9999', uqc: null, taxRate: 0.05, taxableValue: 20_000, cgstAmount: 500, sgstAmount: 500 })],
        }),
      ],
      options(),
      [creditNoteSource({ items: [line5pct] })], // this credit note's own line is the 5% HSN 9999 bucket
    );
    const bucket7113 = result.b2cs.find((g) => g.hsnCode === '7113')!;
    const bucket9999 = result.b2cs.find((g) => g.hsnCode === '9999')!;
    expect(bucket7113.creditNoteTaxableReduction).toBe(0); // untouched — the credit note wasn't for this bucket
    expect(bucket7113.taxableValue).toBe(bucket7113.grossTaxableValue);
    expect(bucket9999.creditNoteTaxableReduction).toBe(2_000);
    expect(bucket9999.taxableValue).toBe(bucket9999.grossTaxableValue - 2_000);
  });

  it('8a. a cancelled credit note cannot silently net off — preserved as a diagnostic, no fabricated reduction', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [creditNoteSource({ status: 'CANCELLED' })],
    );
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(0);
    expect(result.b2csCreditNoteDiagnostics).toHaveLength(1);
    expect(result.b2csCreditNoteDiagnostics[0].reason).toBe('CREDIT_NOTE_EXCLUDED');
    expect(result.b2csCreditNoteDiagnostics[0].detail).toMatch(/CANCELLED/);
  });

  it('8b. missing seller registration on the credit note cannot silently net off — diagnostic instead', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [creditNoteSource({ sellerRegistrationId: null })],
    );
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(0);
    expect(result.b2csCreditNoteDiagnostics).toHaveLength(1);
    expect(result.b2csCreditNoteDiagnostics[0].reason).toBe('CREDIT_NOTE_EXCLUDED');
    expect(result.b2csCreditNoteDiagnostics[0].detail).toMatch(/MISSING_SELLER_REGISTRATION/);
  });

  it('9. netting never produces a silently clamped negative bucket — flagged via diagnostic instead', () => {
    // No matching gross B2CS supply at all in this run — the credit note still nets, producing a
    // genuine negative bucket, which must be visible (not clamped to zero) and flagged.
    const result = aggregateGstr1OutwardSupplies([], options(), [creditNoteSource()]);
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].grossTaxableValue).toBe(0);
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(10_000);
    expect(result.b2cs[0].taxableValue).toBe(-10_000); // never clamped to 0
    expect(result.b2cs[0].filingEligible).toBe(false);
    expect(result.b2csCreditNoteDiagnostics.some((d) => d.reason === 'NEGATIVE_NET_B2CS_BUCKET')).toBe(true);
  });

  it('10. a credit note out of the selected registration scope is silently excluded, not netted', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options({ gstRegistrationId: 'reg_1' }),
      [creditNoteSource({ sellerRegistrationId: 'reg_belongs_to_another_company' })],
    );
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(0);
    expect(result.meta.creditNotesExcludedByScope).toBe(1);
    expect(result.meta.creditNotesConsideredForNetOff).toBe(0);
    expect(result.b2csCreditNoteDiagnostics).toEqual([]); // scope-excluded, not a diagnostic
  });

  it('11. a credit note with the same id supplied twice cannot double-net', () => {
    const dup = creditNoteSource();
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
      [dup, dup],
    );
    expect(result.b2cs[0].creditNoteTaxableReduction).toBe(10_000); // not 20,000
    expect(result.b2csCreditNoteDiagnostics.some((d) => d.reason === 'DUPLICATE_CREDIT_NOTE_ID')).toBe(true);
  });

  it('12. omitting creditNoteSources entirely reproduces exact pre-Phase-A gross-only behavior', () => {
    const withoutArg = aggregateGstr1OutwardSupplies(
      [invoice({ totalAmount: 40_000, placeOfSupply: GUJARAT, sellerStateCode: GUJARAT })],
      options(),
    );
    expect(withoutArg.b2cs[0].taxableValue).toBe(100_000);
    expect(withoutArg.b2cs[0].creditNoteTaxableReduction).toBe(0);
    expect(withoutArg.meta.creditNotesConsideredForNetOff).toBe(0);
    expect(withoutArg.meta.creditNotesExcludedByScope).toBe(0);
    expect(withoutArg.b2csCreditNoteDiagnostics).toEqual([]);
  });
});

describe('aggregateGstr1OutwardSupplies — normalizer integration (UQC/quantity/Decimal)', () => {
  it('GMS quantity uses the line\'s persisted net weight', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', items: [item({ uqc: 'GMS', netGoldWeight: 8.25 })] })],
      options(),
    );
    expect(result.b2b[0].lines[0].quantity).toBe(8.25);
    expect(result.b2b[0].lines[0].quantityBasis).toBe('NET_WEIGHT_GMS');
  });

  it('PCS quantity uses the line\'s billing quantity', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', items: [item({ uqc: 'PCS', quantity: 3 })] })],
      options(),
    );
    expect(result.b2b[0].lines[0].quantity).toBe(3);
    expect(result.b2b[0].lines[0].quantityBasis).toBe('BILLING_PIECES');
  });

  it('missing UQC falls back to the HSN default, distinguishing the source', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', items: [item({ uqc: null, hsnCode: HSN_7113 })] })],
      options(),
    );
    expect(result.b2b[0].lines[0].uqc).toBe('GMS');
    expect(result.b2b[0].lines[0].uqcSource).toBe('HSN_DEFAULT');
  });

  it('an unsupported UQC reports zero quantity via UNSUPPORTED_UQC, not a fabricated mapping', () => {
    const result = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: '27AAAAA0000A1Z5', items: [item({ uqc: 'BAG', hsnCode: HSN_9999 })] })],
      options(),
    );
    expect(result.b2b[0].lines[0].quantity).toBe(0);
    expect(result.b2b[0].lines[0].quantityBasis).toBe('UNSUPPORTED_UQC');
  });

  it('sums many fractional-paise lines without floating-point drift', () => {
    const result = aggregateGstr1OutwardSupplies(
      [
        invoice({
          buyerGstin: '27AAAAA0000A1Z5',
          totalAmount: 300.03,
          items: [
            item({ id: 'i1', taxableValue: 100.01, cgstAmount: 1.11, sgstAmount: 1.11, igstAmount: 0, lineTotalTax: 2.22 }),
            item({ id: 'i2', taxableValue: 100.01, cgstAmount: 1.11, sgstAmount: 1.11, igstAmount: 0, lineTotalTax: 2.22 }),
            item({ id: 'i3', taxableValue: 100.01, cgstAmount: 1.11, sgstAmount: 1.11, igstAmount: 0, lineTotalTax: 2.22 }),
          ],
        }),
      ],
      options(),
    );
    expect(result.b2b[0].totals.taxableValue).toBe(300.03);
    expect(result.b2b[0].totals.cgst).toBe(3.33);
    expect(result.b2b[0].totals.sgst).toBe(3.33);
  });
});
