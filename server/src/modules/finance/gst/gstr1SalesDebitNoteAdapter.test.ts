import { describe, it, expect } from 'vitest';
import {
  normalizeGstr1SalesDebitNote,
  aggregateGstr1SalesDebitNotes,
  applySalesDebitNotesToOutwardAggregation,
  applySalesDebitNotesToTable12,
  toTable13SalesDebitNoteDocument,
  Gstr1SalesDebitNoteAdapterAccessError,
  type Gstr1SalesDebitNoteSourceDocument,
  type Gstr1SalesDebitNoteAggregationSourceDocument,
  type Gstr1SalesDebitNoteAggregationOptions,
} from './gstr1SalesDebitNoteAdapter';
import type { Gstr1OutwardAggregation, Gstr1B2csGroup } from './gstr1OutwardAggregation';
import type { Gstr1Table12Aggregation, Gstr1Table12Row } from './gstr1Table12Aggregation';
import { aggregateGstr1Table13 } from './gstr1Table13Aggregation';

const GUJARAT = '24';
const MAHARASHTRA = '27';
const REGISTERED_GSTIN = '24AAAAA0000A1Z5';

const CURRENT_PERIOD_DATE = new Date('2026-09-15T00:00:00.000Z');
const PRE_AUG_2024_DATE = new Date('2024-06-15T00:00:00.000Z');

const hsn7113Item = {
  id: 'sdni_1', description: '22K Gold Chain — upward price correction',
  hsnCode: { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' }, hsnCodeId: 'hsn_7113', uqc: 'GMS',
  quantity: null, taxRate: 0.03, taxableValue: 1500, cgstAmount: 22.5, sgstAmount: 22.5, igstAmount: 0,
  totalValue: 1545, netWeight: 10.5,
};

function source(overrides: Partial<Gstr1SalesDebitNoteAggregationSourceDocument> = {}): Gstr1SalesDebitNoteAggregationSourceDocument {
  return {
    id: 'sdn_1',
    debitNoteNumber: 'SDN-0001',
    debitNoteDate: CURRENT_PERIOD_DATE,
    status: 'ISSUED',
    invoiceId: 'inv_1',
    originalInvoiceNumber: 'INV-0001',
    originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 50_000,
    sellerRegistrationId: 'reg_1',
    sellerStateCode: GUJARAT,
    buyerGstin: null,
    buyerCountry: 'India',
    placeOfSupply: MAHARASHTRA,
    reasonCode: 'PRICE_INCREASE',
    reasonNotes: null,
    taxableAmount: 1500,
    cgst: 0,
    sgst: 0,
    igst: 45,
    totalTax: 45,
    totalAmount: 1545,
    items: [hsn7113Item],
    branchId: 'branch_1',
    ...overrides,
  };
}

function options(overrides: Partial<Gstr1SalesDebitNoteAggregationOptions> = {}): Gstr1SalesDebitNoteAggregationOptions {
  return {
    gstRegistrationId: 'reg_1',
    period: { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
    ...overrides,
  };
}

function docSource(overrides: Partial<Gstr1SalesDebitNoteSourceDocument> = {}): Gstr1SalesDebitNoteSourceDocument {
  const { branchId, ...rest } = source(overrides as any);
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeGstr1SalesDebitNote — classification reuse + exclusion priority
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeGstr1SalesDebitNote', () => {
  it('registered recipient -> B2B original supply, CDNR reporting table, positive direction preserved', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT }));
    expect(n.reportable).toBe(true);
    expect(n.document.originalSupplyCategory).toBe('B2B');
    expect(n.document.reportingTable).toBe('CDNR');
    expect(n.document.noteValue).toBeCloseTo(1545, 2);
  });

  it('unregistered, inter-state, over current (post Aug-2024) B2CL threshold -> B2CL', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA,
      originalInvoiceValue: 150_000, originalInvoiceDate: CURRENT_PERIOD_DATE,
    }));
    expect(n.document.originalSupplyCategory).toBe('B2CL');
    expect(n.document.reportingTable).toBe('CDNUR');
  });

  it('unregistered, inter-state, under the HISTORICAL (pre Aug-2024) ₹2,50,000 threshold -> B2CS, not B2CL', () => {
    // ₹1,80,000 is over today's ₹1,00,000 threshold but under the historical ₹2,50,000 one — the
    // original supply's own date (pre-Aug-2024) must select the historical rule.
    const n = normalizeGstr1SalesDebitNote(docSource({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA,
      originalInvoiceValue: 180_000, originalInvoiceDate: PRE_AUG_2024_DATE,
    }));
    expect(n.document.originalSupplyCategory).toBe('B2CS');
  });

  it('unregistered, intra-state -> B2CS regardless of value (no threshold involved)', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 9_00_000,
    }));
    expect(n.document.originalSupplyCategory).toBe('B2CS');
    expect(n.document.reportingTable).toBe('CDNUR');
  });

  it('CANCELLED is excluded, never reportable', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({ status: 'CANCELLED', buyerGstin: REGISTERED_GSTIN }));
    expect(n.reportable).toBe(false);
    expect(n.exclusionReason).toBe('CANCELLED');
  });

  it('missing seller registration is excluded, not silently guessed', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({ sellerRegistrationId: null, buyerGstin: REGISTERED_GSTIN }));
    expect(n.reportable).toBe(false);
    expect(n.exclusionReason).toBe('MISSING_SELLER_REGISTRATION');
  });

  it('a malformed buyer GSTIN is excluded, never silently treated as unregistered', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({ buyerGstin: 'NOT-A-GSTIN' }));
    expect(n.reportable).toBe(false);
    expect(n.exclusionReason).toBe('INVALID_RECIPIENT_GSTIN');
  });

  it('a likely export (non-India buyer country) unregistered recipient is excluded, never guessed', () => {
    const n = normalizeGstr1SalesDebitNote(docSource({ buyerGstin: null, buyerCountry: 'USA' }));
    expect(n.reportable).toBe(false);
    expect(n.exclusionReason).toBe('EXPORT_CLASSIFICATION_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregateGstr1SalesDebitNotes — Table 9B (positive CDNR/CDNUR)
// ─────────────────────────────────────────────────────────────────────────────
describe('aggregateGstr1SalesDebitNotes (Table 9B)', () => {
  it('B2B-origin -> CDNR document, positive sign, DEBIT_NOTE type', () => {
    const result = aggregateGstr1SalesDebitNotes([source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.cdnr.documents[0].documentType).toBe('DEBIT_NOTE');
    expect(result.cdnr.documents[0].sign).toBe(1);
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    expect(result.b2csAddOn.documents).toHaveLength(0);
  });

  it('B2CL-origin -> CDNUR b2cl bucket', () => {
    const result = aggregateGstr1SalesDebitNotes(
      [source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 })],
      options(),
    );
    expect(result.cdnur.b2cl.documents).toHaveLength(1);
    expect(result.b2csAddOn.documents).toHaveLength(0);
  });

  it('B2CS-origin -> b2csAddOn, NEVER a CDNUR bucket (no "CDNUR B2CS" category exists)', () => {
    const result = aggregateGstr1SalesDebitNotes(
      [source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 })],
      options(),
    );
    expect(result.b2csAddOn.documents).toHaveLength(1);
    expect(result.cdnur.b2cl.documents).toHaveLength(0);
    expect((result.cdnur as Record<string, unknown>).b2cs).toBeUndefined();
  });

  it('a duplicate source id is counted once only', () => {
    const one = source({ buyerGstin: REGISTERED_GSTIN });
    const result = aggregateGstr1SalesDebitNotes([one, { ...one }], options());
    expect(result.cdnr.documents).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.reason === 'DUPLICATE_SOURCE_ID')).toBe(true);
  });

  it('a different seller registration is silently out of scope', () => {
    const result = aggregateGstr1SalesDebitNotes(
      [source({ buyerGstin: REGISTERED_GSTIN, sellerRegistrationId: 'reg_other' })],
      options({ gstRegistrationId: 'reg_1' }),
    );
    expect(result.cdnr.documents).toHaveLength(0);
    expect(result.meta.notesExcludedByScope).toBe(1);
  });

  it('an unauthorized explicit branchId is rejected, not silently aggregated without it', () => {
    expect(() => aggregateGstr1SalesDebitNotes(
      [source()],
      options({ branchAccess: { allBranches: false, branchIds: ['branch_1'] }, branchId: 'branch_other' }),
    )).toThrow(Gstr1SalesDebitNoteAdapterAccessError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applySalesDebitNotesToOutwardAggregation — Table 7 "Gross + Sales Debit Notes - Credit Notes"
// ─────────────────────────────────────────────────────────────────────────────
describe('applySalesDebitNotesToOutwardAggregation (Table 7)', () => {
  function emptyBase(): Gstr1OutwardAggregation {
    return {
      b2b: [], b2cl: [], b2cs: [], diagnostics: [], b2csCreditNoteDiagnostics: [],
      totals: {
        b2b: { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0, invoiceCount: 0 },
        b2cl: { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0, invoiceCount: 0 },
        b2cs: { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0, recordCount: 0 },
        grandTotal: { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0 },
      },
      meta: { gstRegistrationId: 'reg_1', period: options().period, invoicesConsidered: 0, invoicesExcludedByScope: 0, creditNotesConsideredForNetOff: 0, creditNotesExcludedByScope: 0 },
    };
  }

  function b2csGroup(overrides: Partial<Gstr1B2csGroup> = {}): Gstr1B2csGroup {
    return {
      placeOfSupply: GUJARAT, isInterState: false, gstRate: 0.03, hsnCode: '7113', uqc: 'GMS',
      taxableValue: 10_000, cgst: 150, sgst: 150, igst: 0, cess: 0, quantity: 50, recordCount: 2,
      grossTaxableValue: 10_000, grossCgst: 150, grossSgst: 150, grossIgst: 0, grossCess: 0, grossQuantity: 50,
      creditNoteTaxableReduction: 0, creditNoteCgstReduction: 0, creditNoteSgstReduction: 0,
      creditNoteIgstReduction: 0, creditNoteCessReduction: 0, creditNoteQuantityReduction: 0,
      creditNoteRecordCount: 0, filingEligible: true,
      ...overrides,
    };
  }

  it('adds a B2CS-origin debit note on top of an existing gross B2CS bucket at the same dimension', () => {
    const base = { ...emptyBase(), b2cs: [b2csGroup()] };
    const dnSource = source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 });
    const result = applySalesDebitNotesToOutwardAggregation(base, [dnSource], options());

    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].debitNoteTaxableAddition).toBeCloseTo(1500, 2);
    // net = gross (10000) + debit note addition (1500) - credit note reduction (0)
    expect(result.b2cs[0].taxableValue).toBeCloseTo(11_500, 2);
  });

  it('creates a new bucket at zero gross when no matching gross B2CS group exists yet', () => {
    const dnSource = source({ buyerGstin: null, sellerStateCode: MAHARASHTRA, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 500_000 });
    const result = applySalesDebitNotesToOutwardAggregation(emptyBase(), [dnSource], options());
    expect(result.b2cs).toHaveLength(1);
    expect(result.b2cs[0].grossTaxableValue).toBe(0);
    expect(result.b2cs[0].taxableValue).toBeCloseTo(1500, 2);
  });

  it('never touches B2B/B2CL buckets — a B2B-origin or B2CL-origin debit note is NOT added to Table 7 at all', () => {
    const base = emptyBase();
    const b2bDn = source({ id: 'sdn_b2b', buyerGstin: REGISTERED_GSTIN });
    const b2clDn = source({ id: 'sdn_b2cl', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 });
    const result = applySalesDebitNotesToOutwardAggregation(base, [b2bDn, b2clDn], options());
    expect(result.b2cs).toHaveLength(0);
    expect(result.b2b).toBe(base.b2b); // untouched reference
    expect(result.b2cl).toBe(base.b2cl);
  });

  it('a CANCELLED debit note contributes no addition', () => {
    const base = { ...emptyBase(), b2cs: [b2csGroup()] };
    const dnSource = source({ status: 'CANCELLED', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 });
    const result = applySalesDebitNotesToOutwardAggregation(base, [dnSource], options());
    expect(result.b2cs[0].taxableValue).toBeCloseTo(10_000, 2); // unchanged from gross
    expect(result.b2csSalesDebitNoteDiagnostics.some((d) => d.reason === 'SALES_DEBIT_NOTE_EXCLUDED')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applySalesDebitNotesToTable12 — positive addition into the matching HSN/rate/UQC bucket
// ─────────────────────────────────────────────────────────────────────────────
describe('applySalesDebitNotesToTable12', () => {
  function emptyTable12Base(): Gstr1Table12Aggregation {
    return {
      rows: [], diagnostics: [],
      summary: { b2bRows: 0, b2cRows: 0, diagnosticCount: 0 },
      meta: { gstRegistrationId: 'reg_1', period: options().period, invoicesConsidered: 0, invoicesExcludedByScope: 0, creditNotesConsidered: 0, creditNotesExcludedByScope: 0, hsnDigitCompliance: 'NOT_DETERMINED' },
    };
  }

  function table12Row(overrides: Partial<Gstr1Table12Row> = {}): Gstr1Table12Row {
    return {
      reportingTab: 'B2C_SUPPLIES', hsnCode: '7113', description: 'Jewellery', uqc: 'GMS', gstRate: 0.03,
      quantity: 50, taxableValue: 10_000, cgst: 150, sgst: 150, igst: 0, cess: 0,
      grossQuantity: 50, creditNoteQuantityReduction: 0, grossTaxableValue: 10_000, creditNoteTaxableReduction: 0,
      grossCgst: 150, creditNoteCgstReduction: 0, grossSgst: 150, creditNoteSgstReduction: 0,
      grossIgst: 0, creditNoteIgstReduction: 0, grossCess: 0, creditNoteCessReduction: 0,
      filingEligible: true, recordCount: 2, creditNoteRecordCount: 0,
      ...overrides,
    };
  }

  it('a B2C-origin (B2CS) debit note adds into the matching B2C_SUPPLIES bucket', () => {
    const base = { ...emptyTable12Base(), rows: [table12Row()] };
    const dnSource = source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 });
    const result = applySalesDebitNotesToTable12(base, [dnSource], options());
    const row = result.rows.find((r) => r.reportingTab === 'B2C_SUPPLIES')!;
    expect(row.debitNoteTaxableAddition).toBeCloseTo(1500, 2);
    expect(row.taxableValue).toBeCloseTo(11_500, 2);
  });

  it('a B2B-origin debit note adds into B2B_SUPPLIES, a separate bucket from B2C_SUPPLIES', () => {
    const base = { ...emptyTable12Base(), rows: [table12Row(), table12Row({ reportingTab: 'B2B_SUPPLIES', taxableValue: 20_000 })] };
    const dnSource = source({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT });
    const result = applySalesDebitNotesToTable12(base, [dnSource], options());
    const b2b = result.rows.find((r) => r.reportingTab === 'B2B_SUPPLIES')!;
    const b2c = result.rows.find((r) => r.reportingTab === 'B2C_SUPPLIES')!;
    expect(b2b.debitNoteTaxableAddition).toBeCloseTo(1500, 2);
    expect(b2c.debitNoteTaxableAddition).toBe(0);
  });

  it('never corrupts the base row\'s own invoice-line recordCount — tracked separately as debitNoteRecordCount', () => {
    const base = { ...emptyTable12Base(), rows: [table12Row({ recordCount: 7 })] };
    const dnSource = source({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 500_000 });
    const result = applySalesDebitNotesToTable12(base, [dnSource], options());
    const row = result.rows.find((r) => r.reportingTab === 'B2C_SUPPLIES')!;
    expect(row.recordCount).toBe(7); // unchanged
    expect(row.debitNoteRecordCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toTable13SalesDebitNoteDocument + the FROZEN Table 13 engine — proves OUTWARD_DEBIT_NOTE is
// already supported with zero engine change, and that a procurement DebitNote is never involved
// (this file never imports or references the procurement DebitNote model/loader at all).
// ─────────────────────────────────────────────────────────────────────────────
describe('toTable13SalesDebitNoteDocument + aggregateGstr1Table13', () => {
  it('maps onto Table13Document with documentType OUTWARD_DEBIT_NOTE and is accepted by the frozen engine', () => {
    const doc = toTable13SalesDebitNoteDocument({
      id: 'sdn_1', debitNoteNumber: 'SDN-2026-000001', debitNoteDate: CURRENT_PERIOD_DATE,
      status: 'ISSUED', sellerRegistrationId: 'reg_1', branchId: 'branch_1',
    });
    expect(doc.documentType).toBe('OUTWARD_DEBIT_NOTE');

    const result = aggregateGstr1Table13([doc]);
    expect(result.series).toHaveLength(1);
    expect(result.series[0].category).toBe('OUTWARD_DEBIT_NOTE');
    expect(result.series[0].totalDocuments).toBe(1);
    expect(result.series[0].cancelledDocuments).toBe(0);
  });

  it('a CANCELLED sales debit note is reported as a cancelled document, not a gap', () => {
    const doc = toTable13SalesDebitNoteDocument({
      id: 'sdn_2', debitNoteNumber: 'SDN-2026-000002', debitNoteDate: CURRENT_PERIOD_DATE,
      status: 'CANCELLED', sellerRegistrationId: 'reg_1', branchId: 'branch_1',
    });
    const result = aggregateGstr1Table13([doc]);
    expect(result.series[0].cancelledDocuments).toBe(1);
    expect(result.series[0].netIssued).toBe(0);
  });

  it('a sales debit note series is a wholly separate category from an outward invoice/credit note series sharing the same registration', () => {
    const sdn = toTable13SalesDebitNoteDocument({
      id: 'sdn_3', debitNoteNumber: 'SDN-2026-000001', debitNoteDate: CURRENT_PERIOD_DATE,
      status: 'ISSUED', sellerRegistrationId: 'reg_1', branchId: 'branch_1',
    });
    const invoice = {
      id: 'inv_1', documentNumber: 'INV-2026-000001', documentDate: CURRENT_PERIOD_DATE,
      status: 'ISSUED', documentType: 'SALES_INVOICE', sellerRegistrationId: 'reg_1', branchId: 'branch_1',
    };
    const result = aggregateGstr1Table13([sdn, invoice]);
    expect(result.series).toHaveLength(2);
    const categories = result.series.map((s) => s.category).sort();
    expect(categories).toEqual(['OUTWARD_DEBIT_NOTE', 'OUTWARD_INVOICE'].sort());
  });

  it('a procurement-style document (documentType "OUTWARD_DEBIT_NOTE" is the ONLY category this file ever produces) never collides with the procurement DebitNote domain — this test never touches that model/table at all', () => {
    // This file imports nothing from debitNote.service.ts / the procurement DebitNote model —
    // confirmed structurally: toTable13SalesDebitNoteDocument's own input/output never reference
    // grnId/supplierId or any procurement-only field. See gstr1Table13Aggregation.test.ts's own
    // "procurement DebitNote excluded" regression for the frozen engine's own guarantee.
    const doc = toTable13SalesDebitNoteDocument({
      id: 'sdn_4', debitNoteNumber: 'SDN-2026-000003', debitNoteDate: CURRENT_PERIOD_DATE,
      status: 'ISSUED', sellerRegistrationId: 'reg_1', branchId: 'branch_1',
    });
    expect(Object.keys(doc)).not.toContain('grnId');
    expect(Object.keys(doc)).not.toContain('supplierId');
  });
});
