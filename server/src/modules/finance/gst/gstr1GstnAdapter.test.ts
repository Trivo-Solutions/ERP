import { describe, it, expect } from 'vitest';
import {
  adaptGstr1ToGstnExport,
  type Gstr1GstnAdapterInput,
  type Gstr1GstnAdapterMetadataInput,
} from './gstr1GstnAdapter';
import { GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED } from './gstr1GstnExport.types';
import {
  aggregateGstr1OutwardSupplies,
  type Gstr1OutwardSourceInvoice,
  type Gstr1OutwardAggregationOptions,
} from './gstr1OutwardAggregation';
import {
  aggregateGstr1CreditNotes,
  type Gstr1CreditNoteAggregationSourceDocument,
  type Gstr1CreditNoteAggregationOptions,
} from './gstr1CreditNoteAggregation';
import {
  aggregateGstr1SalesDebitNotes,
  applySalesDebitNotesToOutwardAggregation,
  type Gstr1SalesDebitNoteAggregationSourceDocument,
  type Gstr1SalesDebitNoteAggregationOptions,
} from './gstr1SalesDebitNoteAdapter';
import { aggregateGstr1Table12 } from './gstr1Table12Aggregation';
import { aggregateGstr1Table13, type Table13Document } from './gstr1Table13Aggregation';
import type { InvoiceItemSourceRow, CreditNoteItemSourceRow } from './gstr1Normalizer';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — these feed the REAL frozen aggregator functions (pure, no I/O) to produce genuine
// frozen-engine output, exactly as gstr1Reporting.service.ts would hand it to this adapter. This
// also means every test here implicitly double-checks the adapter never reclassifies/recomputes:
// the frozen engines did that work, the adapter only reshapes their own output.
// ─────────────────────────────────────────────────────────────────────────────

const GUJARAT = '24';
const MAHARASHTRA = '27';
const REGISTERED_GSTIN = '27AAAAA0000A1Z5';
const REG_ID = 'reg_1';

const HSN_7113 = { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' };
const HSN_9999 = { code: '9999', description: 'Other Jewellery Items', defaultUqc: 'GMS' };

const CURRENT_PERIOD_DATE = new Date('2026-09-15T00:00:00.000Z');
const PERIOD = { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') };

const OUTWARD_OPTIONS: Gstr1OutwardAggregationOptions = { gstRegistrationId: REG_ID, period: PERIOD };
const CREDIT_NOTE_OPTIONS: Gstr1CreditNoteAggregationOptions = { gstRegistrationId: REG_ID, period: PERIOD };
const DEBIT_NOTE_OPTIONS: Gstr1SalesDebitNoteAggregationOptions = { gstRegistrationId: REG_ID, period: PERIOD };

function item(overrides: Partial<InvoiceItemSourceRow> = {}): InvoiceItemSourceRow {
  return {
    id: 'item_1', invoiceId: 'inv_1', description: 'Gold ring', quantity: 1, netGoldWeight: 10,
    hsnCode: HSN_7113, hsnCodeId: 'hsn_7113', uqc: 'GMS', taxRate: 0.03, taxableValue: 100_000,
    cgstAmount: 1500, sgstAmount: 1500, igstAmount: 0, lineTotalTax: 3000,
    ...overrides,
  };
}

function invoice(overrides: Partial<Gstr1OutwardSourceInvoice> = {}): Gstr1OutwardSourceInvoice {
  return {
    invoiceId: 'inv_1', invoiceNumber: 'INV-0001', invoiceDate: CURRENT_PERIOD_DATE, status: 'ISSUED',
    branchId: 'branch_1', totalAmount: 103_000, buyerGstin: null, placeOfSupply: MAHARASHTRA,
    sellerStateCode: GUJARAT, sellerRegistrationId: REG_ID, reverseCharge: false, items: [item()],
    ...overrides,
  };
}

function creditNoteSource(overrides: Partial<Gstr1CreditNoteAggregationSourceDocument> = {}): Gstr1CreditNoteAggregationSourceDocument {
  return {
    id: 'cn_1', creditNoteNumber: 'CN-0001', creditNoteDate: CURRENT_PERIOD_DATE, status: 'ISSUED',
    invoiceId: 'inv_1', originalInvoiceNumber: 'INV-0001', originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 103_000, salesReturnId: null, sellerRegistrationId: REG_ID, sellerStateCode: GUJARAT,
    buyerGstin: null, buyerCountry: 'India', placeOfSupply: MAHARASHTRA, reasonCode: 'POST_SALE_DISCOUNT',
    reasonNotes: null, taxableAmount: 10_000, cgst: 0, sgst: 0, igst: 300, totalTax: 300, totalAmount: 10_300,
    items: [{
      id: 'cni_1', creditNoteId: 'cn_1', description: '22K Gold Chain', hsnCode: HSN_7113, hsnCodeId: 'hsn_7113',
      uqc: 'GMS', quantity: 1, taxRate: 0.03, taxableValue: 10_000, cgstAmount: 0, sgstAmount: 0, igstAmount: 300,
      totalValue: 10_300, netWeight: 2,
    } as CreditNoteItemSourceRow],
    branchId: 'branch_1',
    ...overrides,
  };
}

function debitNoteSource(overrides: Partial<Gstr1SalesDebitNoteAggregationSourceDocument> = {}): Gstr1SalesDebitNoteAggregationSourceDocument {
  return {
    id: 'sdn_1', debitNoteNumber: 'SDN-0001', debitNoteDate: CURRENT_PERIOD_DATE, status: 'ISSUED',
    invoiceId: 'inv_1', originalInvoiceNumber: 'INV-0001', originalInvoiceDate: CURRENT_PERIOD_DATE,
    originalInvoiceValue: 103_000, sellerRegistrationId: REG_ID, sellerStateCode: GUJARAT, buyerGstin: null,
    buyerCountry: 'India', placeOfSupply: MAHARASHTRA, reasonCode: 'PRICE_INCREASE', reasonNotes: null,
    taxableAmount: 5_000, cgst: 0, sgst: 0, igst: 150, totalTax: 150, totalAmount: 5_150,
    items: [{
      id: 'sdni_1', description: 'Making-charge correction', hsnCode: HSN_7113, hsnCodeId: 'hsn_7113',
      uqc: 'GMS', quantity: null, taxRate: 0.03, taxableValue: 5_000, cgstAmount: 0, sgstAmount: 0,
      igstAmount: 150, totalValue: 5_150, netWeight: null,
    }],
    branchId: 'branch_1',
    ...overrides,
  };
}

function metadata(overrides: Partial<Gstr1GstnAdapterMetadataInput> = {}): Gstr1GstnAdapterMetadataInput {
  return {
    gstin: '24AAAAA0000A1Z5', legalName: 'Test Jewellers Pvt Ltd', tradeName: 'Test Jewellers',
    period: PERIOD, isPartialBranchExport: false,
    ...overrides,
  };
}

const EMPTY_TABLE13 = aggregateGstr1Table13([], { gstRegistrationId: REG_ID, period: PERIOD });
const EMPTY_CREDIT_NOTES = aggregateGstr1CreditNotes([], CREDIT_NOTE_OPTIONS);
const EMPTY_TABLE12 = aggregateGstr1Table12([], [], { gstRegistrationId: REG_ID, period: PERIOD });

function buildInput(overrides: Partial<Gstr1GstnAdapterInput> = {}): Gstr1GstnAdapterInput {
  return {
    metadata: metadata(),
    outward: aggregateGstr1OutwardSupplies([], OUTWARD_OPTIONS),
    creditNotes: EMPTY_CREDIT_NOTES,
    table12: EMPTY_TABLE12,
    table13: EMPTY_TABLE13,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2B
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — B2B', () => {
  it('maps one recipient with one invoice', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: MAHARASHTRA })],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2b).toHaveLength(1);
    expect(dto.b2b[0].recipientGstin).toBe(REGISTERED_GSTIN);
    expect(dto.b2b[0].invoiceNumber).toBe('INV-0001');
    expect(dto.b2b[0].invoiceValue).toBe(103_000);
    expect(dto.b2b[0].placeOfSupply).toBe(MAHARASHTRA);
  });

  it('keeps multiple invoices for the same recipient as separate entries', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        invoice({ invoiceId: 'inv_1', invoiceNumber: 'INV-0001', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'i1', invoiceId: 'inv_1' })] }),
        invoice({ invoiceId: 'inv_2', invoiceNumber: 'INV-0002', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'i2', invoiceId: 'inv_2' })] }),
      ],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2b).toHaveLength(2);
    expect(dto.b2b.every((inv) => inv.recipientGstin === REGISTERED_GSTIN)).toBe(true);
    expect(dto.b2b.map((inv) => inv.invoiceNumber).sort()).toEqual(['INV-0001', 'INV-0002']);
  });

  it('collapses multiple rate groups within one invoice, keeping different rates separate', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [invoice({
        buyerGstin: REGISTERED_GSTIN,
        totalAmount: 206_000,
        items: [
          item({ id: 'i1', taxRate: 0.03, taxableValue: 100_000, cgstAmount: 1500, sgstAmount: 1500, igstAmount: 0, lineTotalTax: 3000 }),
          item({ id: 'i2', hsnCode: HSN_9999, hsnCodeId: 'hsn_9999', taxRate: 0.05, taxableValue: 100_000, cgstAmount: 2500, sgstAmount: 2500, igstAmount: 0, lineTotalTax: 5000 }),
        ],
      })],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2b).toHaveLength(1);
    expect(dto.b2b[0].rateGroups).toHaveLength(2);
    expect(dto.b2b[0].rateGroups.map((r) => r.rate).sort()).toEqual([0.03, 0.05]);
  });

  it('preserves tax fields exactly as computed by the frozen engine', () => {
    const outward = aggregateGstr1OutwardSupplies([invoice({ buyerGstin: REGISTERED_GSTIN })], OUTWARD_OPTIONS);
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2b[0].taxableValue).toBe(outward.b2b[0].totals.taxableValue);
    expect(dto.b2b[0].cgst).toBe(outward.b2b[0].totals.cgst);
    expect(dto.b2b[0].sgst).toBe(outward.b2b[0].totals.sgst);
    expect(dto.b2b[0].igst).toBe(outward.b2b[0].totals.igst);
  });

  it('never carries TRIVO internal ids on the GSTN-facing B2B object', () => {
    const outward = aggregateGstr1OutwardSupplies([invoice({ buyerGstin: REGISTERED_GSTIN })], OUTWARD_OPTIONS);
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    const record = dto.b2b[0] as unknown as Record<string, unknown>;
    expect(record.invoiceId).toBeUndefined();
    expect(record.branchId).toBeUndefined();
    expect(record.sellerRegistrationId).toBeUndefined();
    // Internal invoice id is still recoverable, but only via the separate traceability block.
    expect(dto.traceability.b2bInvoiceIds).toContain('inv_1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2CL
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — B2CL', () => {
  // Unregistered, inter-state, above the ₹1,00,000 threshold -> B2CL.
  function b2clInvoice(overrides: Partial<Gstr1OutwardSourceInvoice> = {}): Gstr1OutwardSourceInvoice {
    return invoice({
      buyerGstin: null,
      totalAmount: 150_000,
      items: [item({ taxableValue: 145_000, cgstAmount: 0, sgstAmount: 0, igstAmount: 4_500, lineTotalTax: 4_500 })],
      ...overrides,
    });
  }

  it('preserves place of supply, invoice value, rate groups, and carries no internal ids', () => {
    const outward = aggregateGstr1OutwardSupplies([b2clInvoice()], OUTWARD_OPTIONS);
    expect(outward.b2cl).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2cl).toHaveLength(1);
    const record = dto.b2cl[0];
    expect(record.placeOfSupply).toBe(MAHARASHTRA);
    expect(record.invoiceValue).toBe(150_000);
    expect(record.rateGroups).toHaveLength(1);
    expect(record.rateGroups[0].igst).toBe(4_500);

    const asRecord = record as unknown as Record<string, unknown>;
    expect(asRecord.invoiceId).toBeUndefined();
    expect(asRecord.branchId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2CS — GSTN aggregation-dimension collapsing
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — B2CS', () => {
  // Unregistered, intra-state (sellerStateCode === placeOfSupply) -> B2CS.
  function b2csInvoice(overrides: Partial<Gstr1OutwardSourceInvoice> = {}): Gstr1OutwardSourceInvoice {
    return invoice({
      buyerGstin: null,
      placeOfSupply: GUJARAT,
      totalAmount: 10_300,
      items: [item({ taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })],
      ...overrides,
    });
  }

  it('collapses two different internal HSN/UQC groups at the same POS+rate+inter-state into one GSTN record, with no HSN/UQC leakage', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        b2csInvoice({ invoiceId: 'inv_a', invoiceNumber: 'INV-A', items: [item({ id: 'a1', invoiceId: 'inv_a', hsnCode: HSN_7113, taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })] }),
        b2csInvoice({ invoiceId: 'inv_b', invoiceNumber: 'INV-B', items: [item({ id: 'b1', invoiceId: 'inv_b', hsnCode: HSN_9999, hsnCodeId: 'hsn_9999', taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })] }),
      ],
      OUTWARD_OPTIONS,
    );
    // Internally still two distinct HSN-keyed groups.
    expect(outward.b2cs).toHaveLength(2);

    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));

    expect(dto.b2cs).toHaveLength(1);
    expect(dto.b2cs[0].taxableValue).toBe(20_000);
    expect(dto.b2cs[0].cgst).toBe(300);
    expect(dto.b2cs[0].sgst).toBe(300);
    const asRecord = dto.b2cs[0] as unknown as Record<string, unknown>;
    expect(asRecord.hsnCode).toBeUndefined();
    expect(asRecord.uqc).toBeUndefined();
  });

  it('keeps the same GSTN bucket combined when internal HSN/UQC already match', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        b2csInvoice({ invoiceId: 'inv_a', invoiceNumber: 'INV-A' }),
        b2csInvoice({ invoiceId: 'inv_b', invoiceNumber: 'INV-B', items: [item({ id: 'b1', invoiceId: 'inv_b', taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })] }),
      ],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));
    expect(dto.b2cs).toHaveLength(1);
    expect(dto.b2cs[0].taxableValue).toBe(20_000);
  });

  it('keeps different place-of-supply records separate', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        b2csInvoice({ invoiceId: 'inv_a', invoiceNumber: 'INV-A', placeOfSupply: GUJARAT }),
        b2csInvoice({ invoiceId: 'inv_b', invoiceNumber: 'INV-B', placeOfSupply: GUJARAT, sellerStateCode: MAHARASHTRA, items: [item({ id: 'b1', invoiceId: 'inv_b', taxableValue: 10_000, cgstAmount: 0, sgstAmount: 0, igstAmount: 300, lineTotalTax: 300 })] }),
      ],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));
    // Same placeOfSupply (Gujarat) but one intra-state and one inter-state -> two distinct records.
    expect(dto.b2cs).toHaveLength(2);
    const pos = new Set(dto.b2cs.map((r) => r.placeOfSupply));
    expect(pos.size).toBe(1);
    const supplyTypes = new Set(dto.b2cs.map((r) => r.supplyType));
    expect(supplyTypes).toEqual(new Set(['INTRA_STATE', 'INTER_STATE']));
  });

  it('keeps different rates separate', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        b2csInvoice({ invoiceId: 'inv_a', invoiceNumber: 'INV-A' }),
        b2csInvoice({
          invoiceId: 'inv_b', invoiceNumber: 'INV-B',
          items: [item({ id: 'b1', invoiceId: 'inv_b', taxRate: 0.05, taxableValue: 10_000, cgstAmount: 250, sgstAmount: 250, igstAmount: 0, lineTotalTax: 500 })],
        }),
      ],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));
    expect(dto.b2cs).toHaveLength(2);
    expect(dto.b2cs.map((r) => r.rate).sort()).toEqual([0.03, 0.05]);
  });

  it('keeps intra-state and inter-state records separate even at the same rate and a shared place of supply', () => {
    const outward = aggregateGstr1OutwardSupplies(
      [
        b2csInvoice({ invoiceId: 'inv_a', invoiceNumber: 'INV-A', sellerStateCode: GUJARAT, placeOfSupply: GUJARAT }),
        b2csInvoice({
          invoiceId: 'inv_b', invoiceNumber: 'INV-B', sellerStateCode: MAHARASHTRA, placeOfSupply: GUJARAT,
          items: [item({ id: 'b1', invoiceId: 'inv_b', taxableValue: 10_000, cgstAmount: 0, sgstAmount: 0, igstAmount: 300, lineTotalTax: 300 })],
        }),
      ],
      OUTWARD_OPTIONS,
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));
    expect(dto.b2cs).toHaveLength(2);
    expect(new Set(dto.b2cs.map((r) => r.supplyType))).toEqual(new Set(['INTRA_STATE', 'INTER_STATE']));
  });

  it('always reports e-commerce supply type OE (TRIVO has no e-commerce-operator flow)', () => {
    const outward = aggregateGstr1OutwardSupplies([b2csInvoice()], OUTWARD_OPTIONS);
    const dto = adaptGstr1ToGstnExport(buildInput({ outward }));
    expect(dto.b2cs.every((r) => r.ecommerceSupplyType === 'OE')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credit Notes (CDNR / CDNUR)
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — Credit Notes', () => {
  it('registered recipient -> CDNR, noteType C', () => {
    const creditNotes = aggregateGstr1CreditNotes(
      [creditNoteSource({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      CREDIT_NOTE_OPTIONS,
    );
    expect(creditNotes.cdnr.documents).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ creditNotes }));

    expect(dto.cdnr).toHaveLength(1);
    expect(dto.cdnr[0].noteType).toBe('C');
    expect(dto.cdnr[0].recipientGstin).toBe(REGISTERED_GSTIN);
    expect(dto.cdnur).toHaveLength(0);
  });

  it('B2CL-origin unregistered recipient -> CDNUR', () => {
    // Original supply: unregistered, inter-state, above the B2CL threshold.
    const creditNotes = aggregateGstr1CreditNotes(
      [creditNoteSource({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 })],
      CREDIT_NOTE_OPTIONS,
    );
    expect(creditNotes.cdnur.b2cl.documents).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ creditNotes }));

    expect(dto.cdnur).toHaveLength(1);
    expect(dto.cdnur[0].noteType).toBe('C');
    expect(dto.cdnr).toHaveLength(0);
  });

  it('B2CS-origin credit note nets into B2CS and is never reported as a CDNUR document', () => {
    const cnSource = creditNoteSource({
      buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 10_300,
    });
    const creditNotes = aggregateGstr1CreditNotes([cnSource], CREDIT_NOTE_OPTIONS);
    expect(creditNotes.b2csNetOff.documents).toHaveLength(1);
    expect(creditNotes.cdnur.b2cl.documents).toHaveLength(0);

    // Original outward supply (same dimension) so the net-off has something to reduce.
    const outward = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, totalAmount: 10_300, items: [item({ taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })] })],
      OUTWARD_OPTIONS,
      [cnSource],
    );

    const dto = adaptGstr1ToGstnExport(buildInput({ outward, creditNotes }));
    expect(dto.cdnr).toHaveLength(0);
    expect(dto.cdnur).toHaveLength(0);
    // Net B2CS = gross taxableValue (10,000) - credit note taxableValue (10,000) = 0.
    expect(dto.b2cs[0]?.taxableValue ?? 0).toBe(0);
  });

  it('cancelled credit note is excluded from the active export representation', () => {
    const creditNotes = aggregateGstr1CreditNotes(
      [creditNoteSource({ status: 'CANCELLED', buyerGstin: REGISTERED_GSTIN })],
      CREDIT_NOTE_OPTIONS,
    );
    expect(creditNotes.excluded).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ creditNotes }));
    expect(dto.cdnr).toHaveLength(0);
    expect(dto.cdnur).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sales Debit Notes (CDNR / CDNUR, noteType D)
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — Sales Debit Notes', () => {
  it('registered recipient -> CDNR, noteType D', () => {
    const salesDebitNotes = aggregateGstr1SalesDebitNotes(
      [debitNoteSource({ buyerGstin: REGISTERED_GSTIN, placeOfSupply: GUJARAT })],
      DEBIT_NOTE_OPTIONS,
    );
    expect(salesDebitNotes.cdnr.documents).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ salesDebitNotes }));

    expect(dto.cdnr).toHaveLength(1);
    expect(dto.cdnr[0].noteType).toBe('D');
    expect(dto.cdnr[0].recipientGstin).toBe(REGISTERED_GSTIN);
  });

  it('B2CL-origin unregistered recipient -> CDNUR, noteType D', () => {
    const salesDebitNotes = aggregateGstr1SalesDebitNotes(
      [debitNoteSource({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA, originalInvoiceValue: 150_000 })],
      DEBIT_NOTE_OPTIONS,
    );
    expect(salesDebitNotes.cdnur.b2cl.documents).toHaveLength(1);
    const dto = adaptGstr1ToGstnExport(buildInput({ salesDebitNotes }));

    expect(dto.cdnur).toHaveLength(1);
    expect(dto.cdnur[0].noteType).toBe('D');
  });

  it('B2CS-origin debit note adds into B2CS as a positive adjustment, never a CDNUR document', () => {
    const dnSource = debitNoteSource({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, originalInvoiceValue: 10_300 });
    const base = aggregateGstr1OutwardSupplies(
      [invoice({ buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, totalAmount: 10_300, items: [item({ taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })] })],
      OUTWARD_OPTIONS,
    );
    const outward = applySalesDebitNotesToOutwardAggregation(base, [dnSource], DEBIT_NOTE_OPTIONS);
    const salesDebitNotes = aggregateGstr1SalesDebitNotes([dnSource], DEBIT_NOTE_OPTIONS);
    expect(salesDebitNotes.b2csAddOn.documents).toHaveLength(1);
    expect(salesDebitNotes.cdnur.b2cl.documents).toHaveLength(0);

    const dto = adaptGstr1ToGstnExport(buildInput({ outward, salesDebitNotes }));
    expect(dto.cdnr).toHaveLength(0);
    expect(dto.cdnur).toHaveLength(0);
    // Gross 10,000 + debit note 5,000 = 15,000.
    expect(dto.b2cs[0].taxableValue).toBe(15_000);
  });

  it('a procurement DebitNote can never enter the adapter — omitting salesDebitNotes yields zero D notes', () => {
    const outward = aggregateGstr1OutwardSupplies([invoice({ buyerGstin: REGISTERED_GSTIN })], OUTWARD_OPTIONS);
    const creditNotes = aggregateGstr1CreditNotes([creditNoteSource({ buyerGstin: REGISTERED_GSTIN })], CREDIT_NOTE_OPTIONS);
    const dto = adaptGstr1ToGstnExport(buildInput({ outward, creditNotes })); // salesDebitNotes omitted entirely

    expect(dto.cdnr.filter((n) => n.noteType === 'D')).toHaveLength(0);
    expect(dto.cdnur.filter((n) => n.noteType === 'D')).toHaveLength(0);
    expect(dto.traceability.cdnrDebitNoteIds).toEqual([]);
    expect(dto.traceability.cdnurDebitNoteIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Table 12 — HSN summary
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — Table 12', () => {
  it('routes a B2B row to hsnB2b and a B2C row to hsnB2c, preserving UQC/quantity/tax without recomputation', () => {
    const b2bInvoice = invoice({ invoiceId: 'inv_b2b', invoiceNumber: 'INV-B2B', buyerGstin: REGISTERED_GSTIN, items: [item({ id: 'ib2b', invoiceId: 'inv_b2b' })] });
    const b2cInvoice = invoice({
      invoiceId: 'inv_b2c', invoiceNumber: 'INV-B2C', buyerGstin: null, sellerStateCode: GUJARAT, placeOfSupply: GUJARAT,
      totalAmount: 10_300, items: [item({ id: 'ib2c', invoiceId: 'inv_b2c', hsnCode: HSN_9999, hsnCodeId: 'hsn_9999', taxableValue: 10_000, cgstAmount: 150, sgstAmount: 150, igstAmount: 0, lineTotalTax: 300 })],
    });
    const table12 = aggregateGstr1Table12([b2bInvoice, b2cInvoice], [], { gstRegistrationId: REG_ID, period: PERIOD });

    const dto = adaptGstr1ToGstnExport(buildInput({ table12 }));

    expect(dto.hsnB2b).toHaveLength(1);
    expect(dto.hsnB2c).toHaveLength(1);
    expect(dto.hsnB2b[0].hsnCode).toBe('7113');
    expect(dto.hsnB2b[0].uqc).toBe('GMS');
    expect(dto.hsnB2b[0].quantity).toBe(table12.rows.find((r) => r.reportingTab === 'B2B_SUPPLIES')!.quantity);
    expect(dto.hsnB2b[0].taxableValue).toBe(table12.rows.find((r) => r.reportingTab === 'B2B_SUPPLIES')!.taxableValue);
    expect(dto.hsnB2c[0].hsnCode).toBe('9999');
    // Never derived — no authoritative total-value figure exists at this layer.
    expect(dto.hsnB2b[0].totalValue).toBeNull();
    expect(dto.diagnostics.some((d) => d.code === 'MISSING_EXPORT_FIELD' && d.field === 'totalValue')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Table 13 — Documents Issued
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — Table 13', () => {
  function doc(overrides: Partial<Table13Document> = {}): Table13Document {
    return {
      id: 'doc_1', documentNumber: 'INV-2026-000001', documentDate: CURRENT_PERIOD_DATE, status: 'ISSUED',
      documentType: 'SALES_INVOICE', sellerRegistrationId: REG_ID, branchId: 'branch_1',
      ...overrides,
    };
  }

  it('maps active documents into a series with documentCategory INVOICES_FOR_OUTWARD_SUPPLY', () => {
    const table13 = aggregateGstr1Table13(
      [doc({ id: 'd1', documentNumber: 'INV-2026-000001' }), doc({ id: 'd2', documentNumber: 'INV-2026-000002' })],
      { gstRegistrationId: REG_ID, period: PERIOD },
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ table13 }));

    expect(dto.documentsIssued).toHaveLength(1);
    expect(dto.documentsIssued[0].documentCategory).toBe('INVOICES_FOR_OUTWARD_SUPPLY');
    expect(dto.documentsIssued[0].totalIssued).toBe(2);
    expect(dto.documentsIssued[0].cancelled).toBe(0);
    expect(dto.documentsIssued[0].netIssued).toBe(2);
  });

  it('preserves cancelled count from real VOID/CANCELLED documents', () => {
    const table13 = aggregateGstr1Table13(
      [
        doc({ id: 'd1', documentNumber: 'INV-2026-000001' }),
        doc({ id: 'd2', documentNumber: 'INV-2026-000002', status: 'VOID' }),
      ],
      { gstRegistrationId: REG_ID, period: PERIOD },
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ table13 }));

    expect(dto.documentsIssued[0].totalIssued).toBe(2);
    expect(dto.documentsIssued[0].cancelled).toBe(1);
    expect(dto.documentsIssued[0].netIssued).toBe(1);
  });

  it('never converts an unexplained sequence gap into a cancellation', () => {
    const table13 = aggregateGstr1Table13(
      [
        doc({ id: 'd1', documentNumber: 'INV-2026-000001' }),
        doc({ id: 'd2', documentNumber: 'INV-2026-000002' }),
        // Gap: 000003/000004 missing.
        doc({ id: 'd5', documentNumber: 'INV-2026-000005' }),
      ],
      { gstRegistrationId: REG_ID, period: PERIOD },
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ table13 }));

    const totalCancelled = dto.documentsIssued.reduce((s, series) => s + series.cancelled, 0);
    const totalIssued = dto.documentsIssued.reduce((s, series) => s + series.totalIssued, 0);
    expect(totalCancelled).toBe(0);
    expect(totalIssued).toBe(3); // the gap itself produces no document entry at all
  });

  it('excludes a document category with no established GSTN mapping, with an INVALID_MAPPING diagnostic', () => {
    const table13 = aggregateGstr1Table13(
      [doc({ id: 'd1', documentNumber: 'DC-2026-000001', documentType: 'DELIVERY_CHALLAN' })],
      { gstRegistrationId: REG_ID, period: PERIOD },
    );
    const dto = adaptGstr1ToGstnExport(buildInput({ table13 }));

    expect(dto.documentsIssued).toHaveLength(0);
    expect(dto.diagnostics.some((d) => d.code === 'INVALID_MAPPING' && d.section === 'TABLE_13')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — metadata', () => {
  it('preserves GSTIN, legal name, trade name, and period', () => {
    const dto = adaptGstr1ToGstnExport(buildInput({ metadata: metadata({ gstin: '27BBBBB1111B1Z1', legalName: 'ACME Jewels', tradeName: 'Acme' }) }));
    expect(dto.metadata.gstin).toBe('27BBBBB1111B1Z1');
    expect(dto.metadata.legalName).toBe('ACME Jewels');
    expect(dto.metadata.tradeName).toBe('Acme');
    expect(dto.metadata.period.internalFrom).toEqual(PERIOD.from);
    expect(dto.metadata.period.internalTo).toEqual(PERIOD.to);
  });

  it('never silently converts an arbitrary date range into a filing period', () => {
    const dto = adaptGstr1ToGstnExport(buildInput());
    expect(dto.metadata.period.filingPeriodMmYYYY).toBeNull();
  });

  it('passes through an explicitly supplied filing period unchanged', () => {
    const dto = adaptGstr1ToGstnExport(buildInput({ metadata: metadata({ filingPeriodMmYYYY: '092026' }) }));
    expect(dto.metadata.period.filingPeriodMmYYYY).toBe('092026');
  });

  it('defaults the schema version to the typed placeholder, never a hard-coded real version', () => {
    const dto = adaptGstr1ToGstnExport(buildInput());
    expect(dto.metadata.schemaVersion).toBe(GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED);
  });

  it('passes through an explicitly supplied schema version', () => {
    const dto = adaptGstr1ToGstnExport(buildInput({ metadata: metadata({ schemaVersion: 'GST3.2' }) }));
    expect(dto.metadata.schemaVersion).toBe('GST3.2');
  });

  describe('AATO', () => {
    it('is MISSING (not a fabricated verified 0) when no AATO was supplied at all', () => {
      const dto = adaptGstr1ToGstnExport(buildInput());
      expect(dto.metadata.aato.currentFy.verificationState).toBe('MISSING');
      expect(dto.metadata.aato.currentFy.amount).toBeNull();
      expect(dto.metadata.aato.precedingFy.verificationState).toBe('MISSING');
      expect(dto.diagnostics.some((d) => d.code === 'AATO_NOT_VERIFIED')).toBe(true);
    });

    it('is UNVERIFIED when a record exists but has not been confirmed', () => {
      const dto = adaptGstr1ToGstnExport(buildInput({
        metadata: metadata({
          aato: { currentFy: { financialYear: '2026-27', turnover: 5_000_000, verificationStatus: 'UNVERIFIED', source: 'MANUAL' } },
        }),
      }));
      expect(dto.metadata.aato.currentFy.verificationState).toBe('UNVERIFIED');
      expect(dto.metadata.aato.currentFy.amount).toBe(5_000_000);
      expect(dto.diagnostics.some((d) => d.code === 'AATO_NOT_VERIFIED')).toBe(true);
    });

    it('is VERIFIED when explicitly confirmed, and suppresses the AATO_NOT_VERIFIED diagnostic', () => {
      const dto = adaptGstr1ToGstnExport(buildInput({
        metadata: metadata({
          aato: {
            currentFy: { financialYear: '2026-27', turnover: 5_000_000, verificationStatus: 'VERIFIED', source: 'GST_PORTAL' },
            precedingFy: { financialYear: '2025-26', turnover: 4_000_000, verificationStatus: 'VERIFIED', source: 'GST_PORTAL' },
          },
        }),
      }));
      expect(dto.metadata.aato.currentFy.verificationState).toBe('VERIFIED');
      expect(dto.metadata.aato.precedingFy.verificationState).toBe('VERIFIED');
      expect(dto.metadata.aato.precedingFy.amount).toBe(4_000_000);
      expect(dto.diagnostics.some((d) => d.code === 'AATO_NOT_VERIFIED')).toBe(false);
    });
  });

  it('represents a partial-branch export explicitly, with a PARTIAL_BRANCH_SCOPE diagnostic', () => {
    const dto = adaptGstr1ToGstnExport(buildInput({ metadata: metadata({ isPartialBranchExport: true }) }));
    expect(dto.metadata.isPartialBranchExport).toBe(true);
    expect(dto.diagnostics.some((d) => d.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
  });

  it('does not flag partial-branch scope when the export is registration-wide', () => {
    const dto = adaptGstr1ToGstnExport(buildInput());
    expect(dto.metadata.isPartialBranchExport).toBe(false);
    expect(dto.diagnostics.some((d) => d.code === 'PARTIAL_BRANCH_SCOPE')).toBe(false);
  });

  it('marks every out-of-scope capability as explicitly UNSUPPORTED, never an implied "zero this period"', () => {
    const dto = adaptGstr1ToGstnExport(buildInput());
    expect(dto.metadata.capabilities.exports).toBe('UNSUPPORTED');
    expect(dto.metadata.capabilities.advances).toBe('UNSUPPORTED');
    expect(dto.metadata.capabilities.nilExemptNonGst).toBe('UNSUPPORTED');
    expect(dto.metadata.capabilities.amendments).toBe('UNSUPPORTED');
    expect(dto.metadata.capabilities.ecommerce).toBe('UNSUPPORTED');
    expect(dto.metadata.capabilities.b2b).toBe('SUPPORTED');

    expect(dto.diagnostics.some((d) => d.code === 'UNSUPPORTED_SECTION' && d.section === 'exports')).toBe(true);
    expect(dto.diagnostics.some((d) => d.code === 'UNSUPPORTED_SECTION' && d.section === 'advances')).toBe(true);
    expect(dto.diagnostics.some((d) => d.code === 'UNSUPPORTED_SECTION' && d.section === 'nilExemptNonGst')).toBe(true);
    expect(dto.diagnostics.some((d) => d.code === 'UNSUPPORTED_SECTION' && d.section === 'ecommerce')).toBe(true);
    expect(dto.diagnostics.some((d) => d.code === 'AMENDMENT_DATA_UNAVAILABLE')).toBe(true);
  });

  it('never fabricates an amendment record', () => {
    const dto = adaptGstr1ToGstnExport(buildInput());
    expect(dto).not.toHaveProperty('amendments');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('adaptGstr1ToGstnExport — immutability', () => {
  it('never mutates its input report objects', () => {
    const outward = aggregateGstr1OutwardSupplies([invoice({ buyerGstin: REGISTERED_GSTIN })], OUTWARD_OPTIONS);
    const creditNotes = aggregateGstr1CreditNotes([creditNoteSource({ buyerGstin: REGISTERED_GSTIN })], CREDIT_NOTE_OPTIONS);
    const salesDebitNotes = aggregateGstr1SalesDebitNotes([debitNoteSource({ buyerGstin: REGISTERED_GSTIN })], DEBIT_NOTE_OPTIONS);
    const table12 = aggregateGstr1Table12([invoice({ buyerGstin: REGISTERED_GSTIN })], [], { gstRegistrationId: REG_ID, period: PERIOD });
    const table13 = aggregateGstr1Table13(
      [{ id: 'd1', documentNumber: 'INV-2026-000001', documentDate: CURRENT_PERIOD_DATE, status: 'ISSUED', documentType: 'SALES_INVOICE', sellerRegistrationId: REG_ID, branchId: 'branch_1' }],
      { gstRegistrationId: REG_ID, period: PERIOD },
    );
    const input = buildInput({ outward, creditNotes, salesDebitNotes, table12, table13 });

    const before = JSON.stringify(input);
    adaptGstr1ToGstnExport(input);
    const after = JSON.stringify(input);

    expect(after).toBe(before);
  });
});
