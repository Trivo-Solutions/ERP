import { describe, it, expect } from 'vitest';
import {
  aggregateGstr3bOutwardSupplies,
  Gstr3bAggregationError,
} from './gstr3bOutwardAggregation';
import type {
  Gstr3bOutwardSourceInvoice,
  Gstr3bOutwardSourceCreditNote,
  Gstr3bOutwardSourceSalesDebitNote,
  Gstr3bOutwardSourceSalesReturn,
  Gstr3bOutwardAggregationOptions,
} from './gstr3bOutward.types';

describe('G2g-7b: GSTR-3B Outward Tax Liability Pure Aggregation Engine', () => {
  const defaultOptions: Gstr3bOutwardAggregationOptions = {
    companyId: 'comp-1',
    gstRegistrationId: 'reg-gujarat',
    sellerGstin: '24AAAAA0000A1Z5',
    sellerStateCode: '24', // Gujarat
    period: {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      financialYear: '2026-27',
      taxPeriod: '092026',
    },
  };

  function makeInvoice(overrides: Partial<Gstr3bOutwardSourceInvoice> = {}): Gstr3bOutwardSourceInvoice {
    return {
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-001',
      invoiceDate: new Date('2026-09-15T10:00:00.000Z'),
      status: 'ISSUED',
      branchId: 'branch-1',
      totalAmount: 103000,
      otherCharges: 0,
      taxDetails: {
        buyerGstin: null,
        placeOfSupply: '24',
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 100000,
        cgst: 1500,
        sgst: 1500,
        igst: 0,
        cess: 0,
        totalTax: 3000,
        reverseCharge: false,
      },
      itemsCount: 1,
      ...overrides,
    };
  }

  function makeCreditNote(overrides: Partial<Gstr3bOutwardSourceCreditNote> = {}): Gstr3bOutwardSourceCreditNote {
    return {
      id: 'cn-1',
      creditNoteNumber: 'CN-001',
      creditNoteDate: new Date('2026-09-20T10:00:00.000Z'),
      status: 'ISSUED',
      branchId: 'branch-1',
      invoiceId: 'inv-1',
      salesReturnId: null, // Path B standalone by default
      sellerRegistrationId: 'reg-gujarat',
      sellerStateCode: '24',
      buyerGstin: null,
      placeOfSupply: '24',
      taxableAmount: 10000,
      cgst: 150,
      sgst: 150,
      igst: 0,
      cess: 0,
      totalTax: 300,
      totalAmount: 10300,
      ...overrides,
    };
  }

  function makeSalesDebitNote(overrides: Partial<Gstr3bOutwardSourceSalesDebitNote> = {}): Gstr3bOutwardSourceSalesDebitNote {
    return {
      id: 'dn-1',
      debitNoteNumber: 'SDN-001',
      debitNoteDate: new Date('2026-09-22T10:00:00.000Z'),
      status: 'ISSUED',
      branchId: 'branch-1',
      invoiceId: 'inv-1',
      sellerRegistrationId: 'reg-gujarat',
      sellerStateCode: '24',
      buyerGstin: null,
      placeOfSupply: '24',
      taxableAmount: 20000,
      cgst: 300,
      sgst: 300,
      igst: 0,
      cess: 0,
      totalTax: 600,
      totalAmount: 20600,
      ...overrides,
    };
  }

  function makeSalesReturn(overrides: Partial<Gstr3bOutwardSourceSalesReturn> = {}): Gstr3bOutwardSourceSalesReturn {
    return {
      id: 'sret-1',
      returnNumber: 'SRET-001',
      returnDate: new Date('2026-09-18T10:00:00.000Z'),
      branchId: 'branch-1',
      invoiceId: 'inv-1',
      sellerRegistrationId: 'reg-gujarat',
      sellerStateCode: '24',
      buyerGstin: null,
      placeOfSupply: '24',
      totalAmount: 10300,
      taxableAmount: 10000,
      cgst: 150,
      sgst: 150,
      igst: 0,
      cess: 0,
      creditNoteId: null,
      ...overrides,
    };
  }

  it('1. throws if gstRegistrationId is empty', () => {
    expect(() =>
      aggregateGstr3bOutwardSupplies([], [], [], [], {
        ...defaultOptions,
        gstRegistrationId: '',
      })
    ).toThrow(Gstr3bAggregationError);
  });

  it('2. aggregates single intra-State taxable invoice into Table 3.1(a) (not Table 3.2)', () => {
    const inv = makeInvoice();
    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], defaultOptions);

    expect(result.table31.table31a.status).toBe('IMPLEMENTED');
    expect(result.table31.table31a.taxableValue).toBe(100000);
    expect(result.table31.table31a.cgst).toBe(1500);
    expect(result.table31.table31a.sgst).toBe(1500);
    expect(result.table31.table31a.igst).toBe(0);
    expect(result.table31.table31a.cess).toBe(0);
    expect(result.table31.table31a.documentCounts.activeInvoices).toBe(1);

    // Intra-State supply must NOT appear in Table 3.2
    expect(result.table32.unregisteredPersons.supplies).toHaveLength(0);
    expect(result.table32.unregisteredPersons.totalTaxableValue).toBe(0);
    expect(result.table32.unregisteredPersons.totalIgst).toBe(0);
  });

  it('3. aggregates inter-State invoice to unregistered customer into Table 3.1(a) AND Table 3.2', () => {
    const inv = makeInvoice({
      totalAmount: 206000,
      taxDetails: {
        buyerGstin: null, // unregistered
        placeOfSupply: '27', // Maharashtra (inter-State from 24)
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 200000,
        cgst: 0,
        sgst: 0,
        igst: 6000,
        cess: 0,
        totalTax: 6000,
        reverseCharge: false,
      },
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(200000);
    expect(result.table31.table31a.igst).toBe(6000);

    // Must appear in Table 3.2 under POS 27
    expect(result.table32.unregisteredPersons.supplies).toHaveLength(1);
    const pos27 = result.table32.unregisteredPersons.supplies[0];
    expect(pos27.placeOfSupply).toBe('27');
    expect(pos27.taxableValue).toBe(200000);
    expect(pos27.igst).toBe(6000);
    expect(pos27.documentCounts.invoices).toBe(1);
  });

  it('4. excludes registered B2B inter-State invoice from Table 3.2', () => {
    const inv = makeInvoice({
      totalAmount: 206000,
      taxDetails: {
        buyerGstin: '27ABCDE1234F1Z5', // Registered B2B
        placeOfSupply: '27',
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 200000,
        cgst: 0,
        sgst: 0,
        igst: 6000,
        cess: 0,
        totalTax: 6000,
        reverseCharge: false,
      },
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(200000);
    expect(result.table31.table31a.igst).toBe(6000);

    // Registered B2B is NOT in Table 3.2
    expect(result.table32.unregisteredPersons.supplies).toHaveLength(0);
    expect(result.table32.unregisteredPersons.totalTaxableValue).toBe(0);
  });

  it('5. handles otherCharges explicitly, including in taxableAmount and emitting diagnostic', () => {
    const inv = makeInvoice({
      otherCharges: 500,
      totalAmount: 103515,
      taxDetails: {
        buyerGstin: null,
        placeOfSupply: '24',
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 100500, // 100000 goods + 500 otherCharges
        cgst: 1507.5,
        sgst: 1507.5,
        igst: 0,
        cess: 0,
        totalTax: 3015,
        reverseCharge: false,
      },
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(100500);
    expect(result.table31.table31a.cgst).toBe(1507.5);
    expect(result.table31.table31a.sgst).toBe(1507.5);
    expect(result.meta.otherChargesBreakdown.invoiceCountWithOtherCharges).toBe(1);
    expect(result.meta.otherChargesBreakdown.totalOtherChargesTaxable).toBe(500);

    const otherDiag = result.diagnostics.find((d) => d.code === 'OUTWARD_OTHER_CHARGES_INCLUDED');
    expect(otherDiag).toBeDefined();
    expect(otherDiag?.amountDetails?.otherCharges).toBe(500);
  });

  it('6. applies SalesDebitNote as positive liability addition in Table 3.1(a) and Table 3.2', () => {
    const inv = makeInvoice({
      taxDetails: {
        buyerGstin: null,
        placeOfSupply: '29', // Karnataka inter-State
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 100000,
        cgst: 0,
        sgst: 0,
        igst: 3000,
        cess: 0,
        totalTax: 3000,
        reverseCharge: false,
      },
    });

    const sdn = makeSalesDebitNote({
      placeOfSupply: '29',
      buyerGstin: null,
      taxableAmount: 20000,
      cgst: 0,
      sgst: 0,
      igst: 600,
      cess: 0,
      totalTax: 600,
      totalAmount: 20600,
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [sdn], [], defaultOptions);

    // Net Table 3.1(a) = 100000 + 20000 = 120000 taxable, 3000 + 600 = 3600 IGST
    expect(result.table31.table31a.taxableValue).toBe(120000);
    expect(result.table31.table31a.igst).toBe(3600);
    expect(result.table31.table31a.salesDebitNoteAdditions.taxableValue).toBe(20000);
    expect(result.table31.table31a.salesDebitNoteAdditions.igst).toBe(600);
    expect(result.table31.table31a.documentCounts.salesDebitNotes).toBe(1);

    // Table 3.2 Karnataka bucket
    const pos29 = result.table32.unregisteredPersons.supplies.find((s) => s.placeOfSupply === '29');
    expect(pos29).toBeDefined();
    expect(pos29?.taxableValue).toBe(120000);
    expect(pos29?.igst).toBe(3600);
    expect(pos29?.documentCounts.invoices).toBe(1);
    expect(pos29?.documentCounts.salesDebitNotes).toBe(1);
  });

  it('7. applies standalone Path B CreditNote as liability reduction in Table 3.1(a) and Table 3.2', () => {
    const inv = makeInvoice({
      taxDetails: {
        buyerGstin: null,
        placeOfSupply: '27',
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 100000,
        cgst: 0,
        sgst: 0,
        igst: 3000,
        cess: 0,
        totalTax: 3000,
        reverseCharge: false,
      },
    });

    const cn = makeCreditNote({
      salesReturnId: null, // Standalone Path B
      placeOfSupply: '27',
      buyerGstin: null,
      taxableAmount: 10000,
      cgst: 0,
      sgst: 0,
      igst: 300,
      cess: 0,
      totalTax: 300,
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [cn], [], [], defaultOptions);

    // Net = 100000 - 10000 = 90000 taxable, 3000 - 300 = 2700 IGST
    expect(result.table31.table31a.taxableValue).toBe(90000);
    expect(result.table31.table31a.igst).toBe(2700);
    expect(result.table31.table31a.creditNoteReductions.taxableValue).toBe(10000);
    expect(result.table31.table31a.creditNoteReductions.igst).toBe(300);
    expect(result.table31.table31a.documentCounts.pathBStandaloneCreditNotes).toBe(1);

    // Table 3.2 net reduction
    const pos27 = result.table32.unregisteredPersons.supplies.find((s) => s.placeOfSupply === '27');
    expect(pos27).toBeDefined();
    expect(pos27?.taxableValue).toBe(90000);
    expect(pos27?.igst).toBe(2700);
  });

  it('8. deduplicates Path A CreditNote against wrapped SalesReturn to avoid double-counting', () => {
    const inv = makeInvoice();

    // Path A CreditNote pointing to sret-1
    const cn = makeCreditNote({
      id: 'cn-path-a',
      salesReturnId: 'sret-1',
      taxableAmount: 15000,
      cgst: 225,
      sgst: 225,
    });

    // SalesReturn already wrapped by cn-path-a
    const sret = makeSalesReturn({
      id: 'sret-1',
      creditNoteId: 'cn-path-a',
      taxableAmount: 15000,
      cgst: 225,
      sgst: 225,
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [cn], [], [sret], defaultOptions);

    // Must be reduced ONCE by 15000, NOT twice (30000)
    expect(result.table31.table31a.taxableValue).toBe(85000);
    expect(result.table31.table31a.cgst).toBe(1275);
    expect(result.table31.table31a.sgst).toBe(1275);
    expect(result.table31.table31a.creditNoteReductions.taxableValue).toBe(15000);
    expect(result.table31.table31a.salesReturnReductions.taxableValue).toBe(0); // deduplicated!

    expect(result.table31.table31a.documentCounts.pathACreditNotes).toBe(1);
    expect(result.table31.table31a.documentCounts.deduplicatedSalesReturns).toBe(1);
    expect(result.table31.table31a.documentCounts.unwrappedSalesReturns).toBe(0);

    const dupDiag = result.diagnostics.find((d) => d.code === 'SALES_RETURN_WRAPPED_BY_CREDIT_NOTE');
    expect(dupDiag).toBeDefined();
  });

  it('9. handles unwrapped SalesReturn (no Credit Note issued) with warning diagnostic', () => {
    const inv = makeInvoice();

    const sret = makeSalesReturn({
      id: 'sret-unwrapped',
      creditNoteId: null,
      taxableAmount: 5000,
      cgst: 75,
      sgst: 75,
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [sret], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(95000);
    expect(result.table31.table31a.cgst).toBe(1425);
    expect(result.table31.table31a.sgst).toBe(1425);
    expect(result.table31.table31a.salesReturnReductions.taxableValue).toBe(5000);
    expect(result.table31.table31a.documentCounts.unwrappedSalesReturns).toBe(1);

    const unnotedDiag = result.diagnostics.find((d) => d.code === 'UNWRAPPED_SALES_RETURN_NO_CREDIT_NOTE');
    expect(unnotedDiag).toBeDefined();
  });

  it('10. excludes VOID invoice and emits EXCLUDED_VOID diagnostic', () => {
    const voidInv = makeInvoice({
      status: 'VOID',
    });

    const result = aggregateGstr3bOutwardSupplies([voidInv], [], [], [], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(0);
    expect(result.table31.table31a.documentCounts.activeInvoices).toBe(0);
    expect(result.table31.table31a.documentCounts.voidInvoices).toBe(1);

    const voidDiag = result.diagnostics.find((d) => d.code === 'EXCLUDED_VOID');
    expect(voidDiag).toBeDefined();
  });

  it('11. excludes CANCELLED CreditNote and SalesDebitNote and emits EXCLUDED_CANCELLED', () => {
    const inv = makeInvoice();
    const cancelledCn = makeCreditNote({ status: 'CANCELLED' });
    const cancelledSdn = makeSalesDebitNote({ status: 'CANCELLED' });

    const result = aggregateGstr3bOutwardSupplies([inv], [cancelledCn], [cancelledSdn], [], defaultOptions);

    expect(result.table31.table31a.taxableValue).toBe(100000);
    expect(result.table31.table31a.creditNoteReductions.taxableValue).toBe(0);
    expect(result.table31.table31a.salesDebitNoteAdditions.taxableValue).toBe(0);
    expect(result.table31.table31a.documentCounts.cancelledCreditNotes).toBe(1);
    expect(result.table31.table31a.documentCounts.cancelledSalesDebitNotes).toBe(1);

    const cancelDiags = result.diagnostics.filter((d) => d.code === 'EXCLUDED_CANCELLED');
    expect(cancelDiags).toHaveLength(2);
  });

  it('12. enforces multi-GSTIN attribution (excludes different registration, diagnoses missing registration)', () => {
    const differentRegInv = makeInvoice({
      invoiceId: 'inv-diff',
      taxDetails: {
        ...makeInvoice().taxDetails!,
        sellerRegistrationId: 'reg-maharashtra', // Different GSTIN!
      },
    });

    const missingRegInv = makeInvoice({
      invoiceId: 'inv-missing',
      taxDetails: {
        ...makeInvoice().taxDetails!,
        sellerRegistrationId: null, // Legacy / unassigned
      },
    });

    const result = aggregateGstr3bOutwardSupplies([differentRegInv, missingRegInv], [], [], [], defaultOptions);

    // Neither contributes to liability
    expect(result.table31.table31a.taxableValue).toBe(0);
    expect(result.meta.sourceCounts.invoicesExcludedByScope).toBe(1); // differentRegInv silently excluded
    expect(result.meta.sourceCounts.invoicesConsidered).toBe(1); // missingRegInv considered

    // missingRegInv produces explicit diagnostic
    const missingDiag = result.diagnostics.find((d) => d.code === 'MISSING_SELLER_REGISTRATION');
    expect(missingDiag).toBeDefined();
    expect(missingDiag?.documentId).toBe('inv-missing');
  });

  it('13. detects branch restriction and flags PARTIAL_BRANCH_SCOPE', () => {
    const inv = makeInvoice({ branchId: 'branch-1' });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], {
      ...defaultOptions,
      branchId: 'branch-1',
    });

    expect(result.meta.isCompleteGstinScope).toBe(false);
    expect(result.meta.partialScopeReason).toBe('PARTIAL_BRANCH_SCOPE');

    const branchDiag = result.diagnostics.find((d) => d.code === 'PARTIAL_BRANCH_SCOPE');
    expect(branchDiag).toBeDefined();
  });

  it('14. retains negative net liability and emits NEGATIVE_NET_TAXABLE_LIABILITY diagnostic', () => {
    const inv = makeInvoice({
      taxDetails: {
        ...makeInvoice().taxDetails!,
        taxableAmount: 10000,
        cgst: 150,
        sgst: 150,
      },
    });

    const largeCn = makeCreditNote({
      taxableAmount: 25000, // Exceeds invoice!
      cgst: 375,
      sgst: 375,
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [largeCn], [], [], defaultOptions);

    // Net taxable: 10000 - 25000 = -15000
    expect(result.table31.table31a.taxableValue).toBe(-15000);
    expect(result.table31.table31a.cgst).toBe(-225);
    expect(result.table31.table31a.sgst).toBe(-225);

    const negDiag = result.diagnostics.find((d) => d.code === 'NEGATIVE_NET_TAXABLE_LIABILITY');
    expect(negDiag).toBeDefined();
    expect(negDiag?.amountDetails?.netTaxableValue).toBe(-15000);
  });

  it('15. verifies all unsupported sections are strictly marked UNSUPPORTED with statutory reason', () => {
    const result = aggregateGstr3bOutwardSupplies([], [], [], [], defaultOptions);

    expect(result.table31.table31b.status).toBe('UNSUPPORTED');
    expect(result.table31.table31b.reason).toBe('ZERO_RATED_SUPPLIES_UNSUPPORTED');

    expect(result.table31.table31c.status).toBe('UNSUPPORTED');
    expect(result.table31.table31c.reason).toBe('NIL_RATED_EXEMPT_SALES_UNSUPPORTED');

    expect(result.table31.table31d.status).toBe('UNSUPPORTED');
    expect(result.table31.table31d.reason).toBe('INWARD_RCM_EXCLUDED_IN_G2G7B');

    expect(result.table31.table31e.status).toBe('UNSUPPORTED');
    expect(result.table31.table31e.reason).toBe('NON_GST_OUTWARD_UNSUPPORTED');

    expect(result.table31.table311.status).toBe('UNSUPPORTED');
    expect(result.table31.table311.reason).toBe('SECTION_9_5_ECO_SUPPLIES_UNSUPPORTED');

    expect(result.table32.compositionPersons.status).toBe('UNSUPPORTED');
    expect(result.table32.compositionPersons.reason).toBe('CLIENT_COMPOSITION_CLASSIFICATION_UNAVAILABLE');

    expect(result.table32.uinHolders.status).toBe('UNSUPPORTED');
    expect(result.table32.uinHolders.reason).toBe('CLIENT_UIN_CLASSIFICATION_UNAVAILABLE');
  });

  it('16. invalid buyer GSTIN produces diagnostic and is excluded from Table 3.2', () => {
    const inv = makeInvoice({
      taxDetails: {
        buyerGstin: 'INVALID-GSTIN-123',
        placeOfSupply: '27',
        sellerStateCode: '24',
        sellerRegistrationId: 'reg-gujarat',
        taxableAmount: 50000,
        cgst: 0,
        sgst: 0,
        igst: 1500,
        cess: 0,
        totalTax: 1500,
        reverseCharge: false,
      },
    });

    const result = aggregateGstr3bOutwardSupplies([inv], [], [], [], defaultOptions);

    // Contributes to 3.1(a)
    expect(result.table31.table31a.taxableValue).toBe(50000);

    // But excluded from Table 3.2 because we cannot determine recipient status
    expect(result.table32.unregisteredPersons.supplies).toHaveLength(0);

    const invalidDiag = result.diagnostics.find((d) => d.code === 'INVALID_BUYER_GSTIN');
    expect(invalidDiag).toBeDefined();
  });
});
