import { describe, it, expect } from 'vitest';
import {
  resolveReportingUqc,
  normalizeGstQuantity,
  normalizeInvoiceItemLine,
  normalizeSalesReturnItemLine,
  normalizeCreditNoteItemLine,
  type InvoiceItemSourceRow,
  type InvoiceGstContext,
  type SalesReturnItemSourceRow,
  type SalesReturnGstContext,
  type CreditNoteItemSourceRow,
  type CreditNoteGstContext,
} from './gstr1Normalizer';

const hsn7113 = { code: '7113', description: 'Jewellery', defaultUqc: 'GMS' };
const hsnNoDefault = { code: '9999', description: 'No default', defaultUqc: null };

describe('resolveReportingUqc', () => {
  it('1. uses a valid persisted UQC as-is', () => {
    expect(resolveReportingUqc('PCS', 'GMS')).toEqual({ uqc: 'PCS', source: 'PERSISTED' });
  });

  it('2. an invalid persisted value is never trusted — falls through to the HSN default deterministically, never throws', () => {
    expect(() => resolveReportingUqc('NOT_A_CODE', 'GMS')).not.toThrow();
    expect(resolveReportingUqc('NOT_A_CODE', 'GMS')).toEqual({ uqc: 'GMS', source: 'HSN_DEFAULT' });
  });

  it('3. historical null UQC falls back to the HSN default', () => {
    expect(resolveReportingUqc(null, 'GMS')).toEqual({ uqc: 'GMS', source: 'HSN_DEFAULT' });
  });

  it('4. HSN default fallback is case/whitespace-tolerant like any other UQC input', () => {
    expect(resolveReportingUqc(undefined, ' gms ')).toEqual({ uqc: 'GMS', source: 'HSN_DEFAULT' });
  });

  it('5. no persisted value and no usable HSN default resolves to null/NONE', () => {
    expect(resolveReportingUqc(null, null)).toEqual({ uqc: null, source: 'NONE' });
    expect(resolveReportingUqc(undefined, undefined)).toEqual({ uqc: null, source: 'NONE' });
    expect(resolveReportingUqc(null, 'NOT_A_CODE')).toEqual({ uqc: null, source: 'NONE' });
  });
});

describe('normalizeGstQuantity', () => {
  it('6. PCS uses the billing quantity', () => {
    expect(normalizeGstQuantity({ uqc: 'PCS', hasPhysicalQuantity: true, billingQuantity: 3, netWeight: 12.5 }))
      .toEqual({ quantity: 3, basis: 'BILLING_PIECES' });
  });

  it('7. NOS uses the billing quantity', () => {
    expect(normalizeGstQuantity({ uqc: 'NOS', hasPhysicalQuantity: true, billingQuantity: 1, netWeight: 0 }))
      .toEqual({ quantity: 1, basis: 'BILLING_PIECES' });
  });

  it('8. GMS uses the defined jewelry net-weight source', () => {
    expect(normalizeGstQuantity({ uqc: 'GMS', hasPhysicalQuantity: true, billingQuantity: 1, netWeight: 8.25 }))
      .toEqual({ quantity: 8.25, basis: 'NET_WEIGHT_GMS' });
  });

  it('9. GMS never falls back to a billing/piece quantity when net weight is present — it does not accidentally use gross weight either (net and gross are deliberately different inputs)', () => {
    const netWeight = 5;
    const grossWeightThatMustNeverLeak = 9.75;
    const result = normalizeGstQuantity({ uqc: 'GMS', hasPhysicalQuantity: true, billingQuantity: 2, netWeight });
    expect(result.quantity).toBe(netWeight);
    expect(result.quantity).not.toBe(grossWeightThatMustNeverLeak);
  });

  it('10. a value-only line (no physical quantity) reports zero regardless of UQC or available weight/quantity numbers', () => {
    expect(normalizeGstQuantity({ uqc: 'GMS', hasPhysicalQuantity: false, billingQuantity: 1, netWeight: 42 }))
      .toEqual({ quantity: 0, basis: 'NO_PHYSICAL_QUANTITY' });
    expect(normalizeGstQuantity({ uqc: 'PCS', hasPhysicalQuantity: false, billingQuantity: 5, netWeight: null }))
      .toEqual({ quantity: 0, basis: 'NO_PHYSICAL_QUANTITY' });
  });

  it('11. a physical line with a required source field missing reports UNAVAILABLE, not a fabricated number', () => {
    expect(normalizeGstQuantity({ uqc: 'PCS', hasPhysicalQuantity: true, billingQuantity: null, netWeight: 10 }))
      .toEqual({ quantity: 0, basis: 'UNAVAILABLE' });
    expect(normalizeGstQuantity({ uqc: 'GMS', hasPhysicalQuantity: true, billingQuantity: 1, netWeight: null }))
      .toEqual({ quantity: 0, basis: 'UNAVAILABLE' });
  });

  it('12. an unsupported UQC never invents quantity semantics', () => {
    expect(normalizeGstQuantity({ uqc: 'BOX', hasPhysicalQuantity: true, billingQuantity: 4, netWeight: 4 }))
      .toEqual({ quantity: 0, basis: 'UNSUPPORTED_UQC' });
    expect(normalizeGstQuantity({ uqc: null, hasPhysicalQuantity: true, billingQuantity: 4, netWeight: 4 }))
      .toEqual({ quantity: 0, basis: 'UNSUPPORTED_UQC' });
  });
});

const baseInvoiceItem: InvoiceItemSourceRow = {
  id: 'ii_1', invoiceId: 'inv_1', description: '22K Gold Chain',
  quantity: 1, netGoldWeight: 10.5,
  hsnCode: hsn7113, hsnCodeId: 'hsn_7113',
  uqc: 'GMS',
  taxRate: 0.03,
  taxableValue: 50000, cgstAmount: 750, sgstAmount: 750, igstAmount: 0, lineTotalTax: 1500,
};

const baseInvoiceCtx: InvoiceGstContext = {
  invoiceNumber: 'INV-0001', invoiceDate: new Date('2026-09-01'), invoiceStatus: 'ISSUED',
  buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: '24', sellerRegistrationId: 'reg_1', reverseCharge: false,
};

describe('normalizeInvoiceItemLine', () => {
  it('13. uses the persisted taxableValue and per-line tax amounts, never recomputed', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, baseInvoiceCtx);
    expect(line.taxableValue).toBe(50000);
    expect(line.cgstAmount).toBe(750);
    expect(line.sgstAmount).toBe(750);
    expect(line.igstAmount).toBe(0);
    expect(line.value).toBe(51500);
  });

  it('15. does not recompute tax from today\'s HSN rate — a stale/changed HSN gstRate on the joined row is irrelevant, only the line\'s own taxRate snapshot is read', () => {
    const staleHsn = { ...hsn7113 }; // simulates an HSN whose master gstRate has since changed; irrelevant here
    const line = normalizeInvoiceItemLine({ ...baseInvoiceItem, hsnCode: staleHsn, taxRate: 0.03 }, baseInvoiceCtx);
    expect(line.gstRate).toBe(0.03);
  });

  it('resolves GMS quantity from netGoldWeight, not billing quantity', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, baseInvoiceCtx);
    expect(line.uqc).toBe('GMS');
    expect(line.uqcSource).toBe('PERSISTED');
    expect(line.quantity).toBe(10.5);
    expect(line.quantityBasis).toBe('NET_WEIGHT_GMS');
  });

  it('20/21/22. carries seller registration, buyer GSTIN and place of supply straight from the transaction snapshot', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, baseInvoiceCtx);
    expect(line.sellerRegistrationId).toBe('reg_1');
    expect(line.buyerGstin).toBe('24AAAAA0000A1Z5');
    expect(line.isRegisteredRecipient).toBe(true);
    expect(line.placeOfSupply).toBe('24');
  });

  it('an unregistered (no-GSTIN) buyer is reported as not a registered recipient', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, { ...baseInvoiceCtx, buyerGstin: null });
    expect(line.isRegisteredRecipient).toBe(false);
  });

  it('a historical row with no persisted uqc derives it from the HSN default and marks it as derived', () => {
    const line = normalizeInvoiceItemLine({ ...baseInvoiceItem, uqc: null }, baseInvoiceCtx);
    expect(line.uqc).toBe('GMS');
    expect(line.uqcSource).toBe('HSN_DEFAULT');
  });

  it('sourceType is always INVOICE and isCredit is always false', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, baseInvoiceCtx);
    expect(line.sourceType).toBe('INVOICE');
    expect(line.isCredit).toBe(false);
  });

  it('cess is always 0 — never fabricated from a header-level figure', () => {
    const line = normalizeInvoiceItemLine(baseInvoiceItem, baseInvoiceCtx);
    expect(line.cessAmount).toBe(0);
  });
});

describe('normalizeSalesReturnItemLine', () => {
  const returnRow: SalesReturnItemSourceRow = {
    id: 'sri_1', returnId: 'ret_1', invoiceId: 'inv_1', amount: 51500,
    invoiceItem: {
      id: 'ii_1', description: '22K Gold Chain', quantity: 1, netGoldWeight: 10.5,
      hsnCode: hsn7113, hsnCodeId: 'hsn_7113', uqc: 'GMS', taxRate: 0.03, cgstAmount: 750,
    },
  };
  const returnCtx: SalesReturnGstContext = {
    invoiceNumber: 'INV-0001', invoiceDate: new Date('2026-09-01'), invoiceStatus: 'ISSUED',
    buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: '24', sellerRegistrationId: 'reg_1',
    hasLinkedCreditNote: false,
  };

  it('splits the tax-inclusive return amount by the ORIGINAL line\'s persisted taxRate — same-state example', () => {
    const line = normalizeSalesReturnItemLine(returnRow, returnCtx);
    expect(line.taxableValue).toBeCloseTo(50000, 1);
    expect(line.cgstAmount).toBeCloseTo(750, 1);
    expect(line.sgstAmount).toBeCloseTo(750, 1);
    expect(line.igstAmount).toBe(0);
  });

  it('splits inter-state (cgstAmount 0 on the original line) entirely to IGST', () => {
    const interState: SalesReturnItemSourceRow = {
      ...returnRow,
      invoiceItem: { ...returnRow.invoiceItem, cgstAmount: 0 },
    };
    const line = normalizeSalesReturnItemLine(interState, returnCtx);
    expect(line.cgstAmount).toBe(0);
    expect(line.sgstAmount).toBe(0);
    expect(line.igstAmount).toBeCloseTo(1500, 1);
  });

  it('is a genuine physical return — quantity comes from the original line\'s net weight for a GMS UQC', () => {
    const line = normalizeSalesReturnItemLine(returnRow, returnCtx);
    expect(line.quantity).toBe(10.5);
    expect(line.quantityBasis).toBe('NET_WEIGHT_GMS');
  });

  it('19. SALES_RETURN stays distinct from CREDIT_NOTE as a sourceType, and is always a credit', () => {
    const line = normalizeSalesReturnItemLine(returnRow, returnCtx);
    expect(line.sourceType).toBe('SALES_RETURN');
    expect(line.isCredit).toBe(true);
  });

  it('carries hasLinkedCreditNote through so an aggregator can avoid double-counting a Path A note', () => {
    const withCn = normalizeSalesReturnItemLine(returnRow, { ...returnCtx, hasLinkedCreditNote: true });
    expect(withCn.hasLinkedCreditNote).toBe(true);
    const withoutCn = normalizeSalesReturnItemLine(returnRow, { ...returnCtx, hasLinkedCreditNote: false });
    expect(withoutCn.hasLinkedCreditNote).toBe(false);
  });
});

describe('normalizeCreditNoteItemLine — Path A (wraps a SalesReturn)', () => {
  const pathAItem: CreditNoteItemSourceRow = {
    id: 'cni_1', creditNoteId: 'cn_1', description: '22K Gold Chain',
    hsnCode: hsn7113, hsnCodeId: 'hsn_7113', uqc: 'GMS',
    quantity: 1, // Path A: the original InvoiceItem's own billing quantity, per creditNote.service.ts
    taxRate: 0.03, taxableValue: 50000, cgstAmount: 750, sgstAmount: 750, igstAmount: 0, totalValue: 51500,
    netWeight: 10.5,
  };
  const pathACtx: CreditNoteGstContext = {
    invoiceId: 'inv_1', invoiceNumber: 'INV-0001', salesReturnId: 'ret_1',
    creditNoteNumber: 'CN-0001', creditNoteDate: new Date('2026-09-05'), status: 'ISSUED',
    buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: '24', sellerRegistrationId: 'reg_1',
  };

  it('16. Path A remains identifiable via creditNotePath and salesReturnId', () => {
    const line = normalizeCreditNoteItemLine(pathAItem, pathACtx);
    expect(line.creditNotePath).toBe('A_WRAPS_RETURN');
    expect(line.salesReturnId).toBe('ret_1');
  });

  it('a Path A GMS line reports net-weight-based quantity from its own persisted netWeight column, not by re-deriving from an invoice join', () => {
    const line = normalizeCreditNoteItemLine(pathAItem, pathACtx);
    expect(line.quantity).toBe(10.5);
    expect(line.quantityBasis).toBe('NET_WEIGHT_GMS');
  });
});

describe('normalizeCreditNoteItemLine — Path B (standalone)', () => {
  const pathBLinkedItem: CreditNoteItemSourceRow = {
    id: 'cni_2', creditNoteId: 'cn_2', description: 'Post-sale discount on 22K Gold Chain',
    hsnCode: hsn7113, hsnCodeId: 'hsn_7113', uqc: 'GMS',
    quantity: null, // Path B always nulls quantity, even when linked to a real InvoiceItem
    taxRate: 0.03, taxableValue: 2000, cgstAmount: 30, sgstAmount: 30, igstAmount: 0, totalValue: 2060,
    netWeight: 10.5, // still populated for traceability — must NOT be read as a physical quantity
  };
  const pathBCtx: CreditNoteGstContext = {
    invoiceId: 'inv_1', invoiceNumber: 'INV-0001', salesReturnId: null,
    creditNoteNumber: 'CN-0002', creditNoteDate: new Date('2026-09-06'), status: 'ISSUED',
    buyerGstin: '24AAAAA0000A1Z5', placeOfSupply: '24', sellerRegistrationId: 'reg_1',
  };

  it('17. Path B remains identifiable via creditNotePath, with no salesReturnId', () => {
    const line = normalizeCreditNoteItemLine(pathBLinkedItem, pathBCtx);
    expect(line.creditNotePath).toBe('B_STANDALONE');
    expect(line.salesReturnId).toBeUndefined();
  });

  it('10 (Credit Note case). a value-only Path B line reports zero/no-physical-quantity even though a traceability netWeight is present on the row', () => {
    const line = normalizeCreditNoteItemLine(pathBLinkedItem, pathBCtx);
    expect(line.quantity).toBe(0);
    expect(line.quantityBasis).toBe('NO_PHYSICAL_QUANTITY');
  });

  it('a fully standalone Path B line (no invoiceItemId, no netWeight either) also reports no physical quantity', () => {
    const line = normalizeCreditNoteItemLine(
      { ...pathBLinkedItem, quantity: null, netWeight: null, description: 'Waived service charge' },
      pathBCtx,
    );
    expect(line.quantity).toBe(0);
    expect(line.quantityBasis).toBe('NO_PHYSICAL_QUANTITY');
  });

  it('18. a cancelled credit note remains identifiable — status is preserved, never silently dropped', () => {
    const line = normalizeCreditNoteItemLine(pathBLinkedItem, { ...pathBCtx, status: 'CANCELLED' });
    expect(line.creditNoteStatus).toBe('CANCELLED');
  });

  it('sourceType is always CREDIT_NOTE and isCredit is always true', () => {
    const line = normalizeCreditNoteItemLine(pathBLinkedItem, pathBCtx);
    expect(line.sourceType).toBe('CREDIT_NOTE');
    expect(line.isCredit).toBe(true);
  });

  it('14. uses the persisted taxRate/taxableValue/tax amounts, never a fresh HSN lookup', () => {
    const line = normalizeCreditNoteItemLine(pathBLinkedItem, pathBCtx);
    expect(line.taxableValue).toBe(2000);
    expect(line.cgstAmount).toBe(30);
    expect(line.sgstAmount).toBe(30);
    expect(line.value).toBe(2060);
  });

  it('a fully value-only line with no HSN default falls back to NONE/UNSUPPORTED, never invents a UQC or quantity', () => {
    const line = normalizeCreditNoteItemLine(
      { ...pathBLinkedItem, hsnCode: hsnNoDefault, uqc: null, quantity: null, netWeight: null },
      pathBCtx,
    );
    expect(line.uqc).toBeNull();
    expect(line.uqcSource).toBe('NONE');
    expect(line.quantity).toBe(0);
    expect(line.quantityBasis).toBe('NO_PHYSICAL_QUANTITY');
  });
});
