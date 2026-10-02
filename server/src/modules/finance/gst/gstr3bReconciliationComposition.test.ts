import { describe, it, expect } from 'vitest';
import { composeGstr3bReconciliationReport } from './gstr3bReconciliationComposition';
import { aggregateGstr3bOutwardSupplies } from './gstr3bOutwardAggregation';
import { aggregateGstr3bInwardItc } from './gstr3bItcAggregation';
import { aggregateGstr3bRcm } from './gstr3bRcmAggregation';
import { reconcileGstr2b } from './gstr2bReconciliation';
import type { Gstr3bOutwardAggregationOptions, Gstr3bOutwardSourceInvoice } from './gstr3bOutward.types';
import type { Gstr3bItcAggregationOptions, Gstr3bItcSourceGrnLine, Gstr3bItcLineFacts } from './gstr3bItc.types';
import type { Gstr3bRcmAggregationOptions, Gstr3bRcmSourceLiabilityLine } from './gstr3bRcm.types';
import type { Gstr2bDocumentForMatch, Gstr2bBookInvoiceLine } from './gstr2b.types';
import type { Gstr3bReconciliationComposeInput, Gstr3bReconciliationFilingStatus } from './gstr3bReconciliation.types';

// G2g-7f — pure composition engine tests. Builds each of the four composed inputs through its OWN
// frozen pure aggregation/reconciliation engine (never hand-faked result shapes) so these tests also
// catch any accidental drift between the composer's assumptions and the real engines' output shapes.

const REG = 'reg-1';
const COMPANY = 'co-1';
const PERIOD = { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z'), financialYear: '2026-27', taxPeriod: '092026' };

const notStarted: Gstr3bReconciliationFilingStatus = {
  returnType: 'GSTR3B', status: 'NOT_STARTED', periodId: null, filedAt: null, lockedAt: null,
  note: 'No GSTR-3B return period record exists for this registration/period yet.',
};

function outwardReport(invoiceOverrides: Partial<Gstr3bOutwardSourceInvoice> = {}) {
  const options: Gstr3bOutwardAggregationOptions = {
    companyId: COMPANY, gstRegistrationId: REG, sellerGstin: '24AAAAA0000A1Z5', sellerStateCode: '24', period: PERIOD,
  };
  const invoice: Gstr3bOutwardSourceInvoice = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-001', invoiceDate: new Date('2026-09-15T10:00:00.000Z'),
    status: 'ISSUED', branchId: 'branch-1', totalAmount: 118000, otherCharges: 0, itemsCount: 1,
    taxDetails: {
      buyerGstin: null, placeOfSupply: '24', sellerStateCode: '24', sellerRegistrationId: REG,
      taxableAmount: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0, totalTax: 18000, reverseCharge: false,
    },
    ...invoiceOverrides,
  };
  return aggregateGstr3bOutwardSupplies([invoice], [], [], [], options);
}

const eligibleFacts: Gstr3bItcLineFacts = { buyerRegistrationId: REG, supplierGstin: '24AAAAA0000A1Z8', supplierIsComposition: false, taxCategory: 'TAXABLE' };

function itcReport(lineOverrides: Partial<Gstr3bItcSourceGrnLine> = {}) {
  const options: Gstr3bItcAggregationOptions = { companyId: COMPANY, gstRegistrationId: REG, buyerGstin: '24AAAAA0000A1Z8', buyerStateCode: '24', period: PERIOD };
  const line: Gstr3bItcSourceGrnLine = {
    id: 'grn-item-1', grnId: 'grn-1', grnNumber: 'GRN-0001', receivedDate: new Date('2026-09-10T00:00:00.000Z'),
    branchId: 'branch-1', invoiceNumber: 'SUP-INV-1', invoiceDate: new Date('2026-09-09T00:00:00.000Z'),
    supplierId: 'sup-1', supplierName: 'Test Supplier', taxableValue: 100000, cgst: 1500, sgst: 1500, igst: 0, cess: 0,
    facts: { ...eligibleFacts },
    ...lineOverrides,
  };
  return aggregateGstr3bInwardItc([line], [], [], options);
}

function rcmReport(lineOverrides: Partial<Gstr3bRcmSourceLiabilityLine> | null = null) {
  const options: Gstr3bRcmAggregationOptions = { companyId: COMPANY, gstRegistrationId: REG, buyerGstin: '24AAAAA0000A1Z8', buyerStateCode: '24', period: PERIOD };
  if (!lineOverrides) return aggregateGstr3bRcm([], options);
  const line: Gstr3bRcmSourceLiabilityLine = {
    id: 'liab-1', grnId: 'grn-2', grnNumber: 'GRN-0002', receivedDate: new Date('2026-09-11T00:00:00.000Z'),
    branchId: 'branch-1', supplierId: 'sup-2', supplierName: 'Freight Co', taxableValue: 5000, cgst: 450, sgst: 450, igst: 0, cess: 0,
    selfInvoiceRequirement: 'SELF_INVOICE_REQUIRED', paymentVoucherRequirement: 'PAYMENT_VOUCHER_REQUIRED', liabilityStatus: 'TAX_PAID',
    facts: { rcmCategory: 'GTA_FREIGHT', buyerRegistrationId: REG, taxCategory: 'TAXABLE' },
    ...lineOverrides,
  };
  return aggregateGstr3bRcm([line], options);
}

function twoBReport(docOverrides: Partial<Gstr2bDocumentForMatch> | null, bookOverrides: Partial<Gstr2bBookInvoiceLine> | null) {
  const docs: Gstr2bDocumentForMatch[] = docOverrides
    ? [{
        id: 'doc-1', section: 'B2B', documentType: 'INVOICE', supplierGstin: '24AAAAA0000A1Z8',
        documentNumber: 'SUP-INV-1', documentDate: new Date('2026-09-09'),
        taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0,
        reverseCharge: false, supportStatus: 'SUPPORTED', provenanceStatus: 'CURRENT',
        itcAvailability: 'AVAILABLE', ineligibilityReason: null,
        ...docOverrides,
      }]
    : [];
  const bookLines: Gstr2bBookInvoiceLine[] = bookOverrides
    ? [{
        grnId: 'grn-1', grnNumber: 'GRN-0001', supplierId: 'sup-1', supplierGstin: '24AAAAA0000A1Z8',
        invoiceNumber: 'SUP-INV-1', invoiceDate: new Date('2026-09-09'), branchId: 'branch-1',
        buyerRegistrationId: REG, taxableValue: 100000, cgst: 1500, sgst: 1500, igst: 0, hasRcmLiability: false,
        ...bookOverrides,
      }]
    : [];
  return reconcileGstr2b(docs, bookLines, [], {
    companyId: COMPANY, gstRegistrationId: REG, financialYear: PERIOD.financialYear, taxPeriod: PERIOD.taxPeriod,
    statementId: docOverrides ? 'stmt-1' : null, statementVersion: docOverrides ? 1 : null, statementImportedAt: docOverrides ? new Date('2026-10-12') : null,
  });
}

function compose(overrides: Partial<Gstr3bReconciliationComposeInput> = {}): ReturnType<typeof composeGstr3bReconciliationReport> {
  const input: Gstr3bReconciliationComposeInput = {
    companyId: COMPANY, gstRegistrationId: REG, gstin: '24AAAAA0000A1Z5', stateCode: '24', legalName: 'Test Co',
    financialYear: PERIOD.financialYear, taxPeriod: PERIOD.taxPeriod, period: { from: PERIOD.from, to: PERIOD.to },
    outward: outwardReport(), itc: itcReport(), rcm: rcmReport({ liabilityStatus: 'TAX_PAID' }),
    twoB: twoBReport({ itcAvailability: 'AVAILABLE' }, {}),
    statementAvailable: true,
    filingStatus: notStarted,
    ...overrides,
  };
  return composeGstr3bReconciliationReport(input);
}

describe('G2g-7f: composeGstr3bReconciliationReport (pure composition over real frozen engines)', () => {
  it('composes outward/RCM/ITC verbatim into table4A without reclassifying anything', () => {
    const report = compose();
    expect(report.inputTaxCredit.presentation.table4A.allOtherItc.eligible).toEqual(report.inputTaxCredit.book.table4A5.eligible);
    expect(report.inputTaxCredit.presentation.table4A.inwardSuppliesLiableToRcm.eligible).toEqual(report.reverseCharge.report.table4A3.eligible);
    expect(report.outwardLiability.report.table31.table31a.cgst).toBe(9000);
  });

  it('marks imports/ISD as NOT_SUPPORTED and 4(B) as NOT_DETERMINABLE, never a fabricated zero total', () => {
    const report = compose();
    const { table4A, table4B } = report.inputTaxCredit.presentation;
    expect(table4A.importOfGoods.status).toBe('NOT_SUPPORTED');
    expect(table4A.importOfGoods.taxableValue).toBeNull();
    expect(table4A.importOfServices.status).toBe('NOT_SUPPORTED');
    expect(table4A.inwardSuppliesFromIsd.status).toBe('NOT_SUPPORTED');
    expect(table4B.rule42And43.status).toBe('NOT_DETERMINABLE');
    expect(table4B.others.status).toBe('NOT_DETERMINABLE');
  });

  it('table4C nets only the two supported eligible buckets, flagged PARTIALLY_SUPPORTED', () => {
    const report = compose();
    const { table4C } = report.inputTaxCredit.presentation;
    expect(table4C.status).toBe('PARTIALLY_SUPPORTED');
    // itc eligible (cgst 1500 + sgst 1500) + rcm eligible (cgst 450 + sgst 450) = 3900
    expect(table4C.netItcAvailable.cgst).toBe(1950);
    expect(table4C.netItcAvailable.sgst).toBe(1950);
  });

  it('table4D ineligibleItc sums the ITC/RCM engines\' own INELIGIBLE buckets, not a reinvented classifier', () => {
    const ineligibleLine = { facts: { ...eligibleFacts, supplierIsComposition: true } };
    const report = compose({ itc: itcReport(ineligibleLine) });
    expect(report.inputTaxCredit.presentation.table4D.ineligibleItc.taxableValue).toBe(100000);
    expect(report.inputTaxCredit.presentation.table4D.itcReclaimed.status).toBe('NOT_DETERMINABLE');
  });

  it('2B-derived ITC distinguishes matched/available/not-available/unknown as separate totals', () => {
    const reportAvailable = compose({ twoB: twoBReport({ itcAvailability: 'AVAILABLE' }, {}) });
    expect(reportAvailable.inputTaxCredit.twoBDerived.twoBItcAvailable.cgst).toBe(1500);
    expect(reportAvailable.inputTaxCredit.twoBDerived.twoBItcNotAvailable.cgst).toBe(0);
    expect(reportAvailable.inputTaxCredit.twoBDerived.twoBItcMatched.cgst).toBe(1500);

    const reportNotAvailable = compose({ twoB: twoBReport({ itcAvailability: 'NOT_AVAILABLE', ineligibilityReason: 'Sec 16(4)' }, {}) });
    expect(reportNotAvailable.inputTaxCredit.twoBDerived.twoBItcAvailable.cgst).toBe(0);
    expect(reportNotAvailable.inputTaxCredit.twoBDerived.twoBItcNotAvailable.cgst).toBe(1500);
    // still matched (identity matched), independent of availability
    expect(reportNotAvailable.inputTaxCredit.twoBDerived.twoBItcMatched.cgst).toBe(1500);
  });

  it('bookItc totals mirror the ITC engine\'s eligible+unresolved+ineligible sum exactly', () => {
    const report = compose();
    const expectedTax = report.inputTaxCredit.book.table4A5.eligible.cgst + report.inputTaxCredit.book.table4A5.unresolved.cgst + report.inputTaxCredit.book.table4A5.ineligible.cgst;
    expect(report.inputTaxCredit.twoBDerived.bookItc.cgst).toBe(expectedTax);
  });

  describe('reconciliation matrix', () => {
    it('an EXACT_MATCH with AVAILABLE 2B availability lands in MATCHED_AVAILABLE', () => {
      const report = compose({ twoB: twoBReport({ itcAvailability: 'AVAILABLE' }, {}) });
      const entry = report.twoBReconciliation.matrix.find((m) => m.category === 'MATCHED_AVAILABLE');
      expect(entry).toBeDefined();
      expect(entry!.documentCount).toBe(1);
    });

    it('an EXACT_MATCH with NOT_AVAILABLE 2B availability lands in MATCHED_NOT_AVAILABLE, never MATCHED_AVAILABLE', () => {
      const report = compose({ twoB: twoBReport({ itcAvailability: 'NOT_AVAILABLE', ineligibilityReason: 'x' }, {}) });
      expect(report.twoBReconciliation.matrix.some((m) => m.category === 'MATCHED_AVAILABLE')).toBe(false);
      expect(report.twoBReconciliation.matrix.find((m) => m.category === 'MATCHED_NOT_AVAILABLE')?.documentCount).toBe(1);
    });

    it('a book-only line (no 2B statement) lands in BOOK_ONLY', () => {
      const report = compose({ twoB: twoBReport(null, {}), statementAvailable: false });
      expect(report.twoBReconciliation.matrix.find((m) => m.category === 'BOOK_ONLY')?.documentCount).toBe(1);
    });

    it('a 2B-only document (no book line) lands in TWO_B_ONLY_AVAILABLE/NOT_AVAILABLE correctly', () => {
      const report = compose({ twoB: twoBReport({ itcAvailability: 'AVAILABLE', supplierGstin: '24ZZZZZ9999Z1Z1' }, null) });
      expect(report.twoBReconciliation.matrix.find((m) => m.category === 'TWO_B_ONLY_AVAILABLE')?.documentCount).toBe(1);
    });

    it('a RCM_MISMATCH match lands in its own RCM_MISMATCH category, not folded into MATCHED', () => {
      const report = compose({ twoB: twoBReport({ itcAvailability: 'AVAILABLE', reverseCharge: true }, { hasRcmLiability: false }) });
      expect(report.twoBReconciliation.matrix.find((m) => m.category === 'RCM_MISMATCH')?.documentCount).toBe(1);
      expect(report.twoBReconciliation.matrix.some((m) => m.category === 'MATCHED_AVAILABLE')).toBe(false);
    });

    it('never produces a SUPPLIER_MISMATCH matrix category, and documents why in diagnostics', () => {
      const report = compose();
      const categories = report.twoBReconciliation.matrix.map((m) => m.category);
      expect(categories).not.toContain('SUPPLIER_MISMATCH');
      expect(report.diagnostics.some((d) => d.code === 'SUPPLIER_MISMATCH_NOT_DETECTABLE' && d.source === 'COMPOSITION')).toBe(true);
    });
  });

  describe('diagnostics and completeness — no false completeness', () => {
    it('always emits the standing capability-gap diagnostics regardless of input', () => {
      const report = compose();
      const codes = report.diagnostics.map((d) => d.code);
      expect(codes).toContain('IMPORT_ITC_NOT_SUPPORTED');
      expect(codes).toContain('ISD_ITC_NOT_SUPPORTED');
      expect(codes).toContain('RULE_42_43_NOT_DETERMINABLE');
      expect(codes).toContain('SECTION_17_5_NOT_DETERMINABLE');
      expect(codes).toContain('ITC_RECLAIM_NOT_DETERMINABLE');
      expect(codes).toContain('POS_RESTRICTION_NOT_DETERMINABLE');
      expect(codes).toContain('STATUTORY_POSITION_NOT_DETERMINABLE');
    });

    it('passes through each frozen engine\'s own diagnostics, tagged by source', () => {
      const report = compose({ rcm: rcmReport({ liabilityStatus: 'LIABILITY_RECOGNIZED' }) });
      expect(report.diagnostics.some((d) => d.source === 'RCM' && d.code === 'RCM_PAYMENT_NOT_RECORDED')).toBe(true);
      expect(report.diagnostics.some((d) => d.source === 'RCM' && d.code === 'RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE')).toBe(true);
    });

    it('flags FILING_PERIOD_NOT_STARTED when no GstReturnPeriod row exists', () => {
      const report = compose();
      expect(report.filingStatus.status).toBe('NOT_STARTED');
      expect(report.diagnostics.some((d) => d.code === 'FILING_PERIOD_NOT_STARTED')).toBe(true);
    });

    it('carries a FILED filing status through verbatim without altering any figure', () => {
      const filed: Gstr3bReconciliationFilingStatus = { returnType: 'GSTR3B', status: 'FILED', periodId: 'period-1', filedAt: new Date('2026-10-15'), lockedAt: null, note: 'filed' };
      const report = compose({ filingStatus: filed });
      expect(report.filingStatus).toEqual(filed);
      expect(report.diagnostics.some((d) => d.code === 'FILING_PERIOD_NOT_STARTED')).toBe(false);
    });

    it('statutory reporting position is always NOT_DETERMINABLE — never claims the book position is the filing figure', () => {
      const report = compose();
      expect(report.summary.statutoryReportingPosition.status).toBe('NOT_DETERMINABLE');
      expect(report.summary.bookPosition.outputTaxLiability).toBe(18000);
    });
  });

  it('book position: output tax + RCM liability - eligible ITC', () => {
    const report = compose();
    const { bookPosition } = report.summary;
    expect(bookPosition.outputTaxLiability).toBe(18000); // 9000 + 9000
    expect(bookPosition.rcmLiabilityRecognized).toBe(900); // 450 + 450
    expect(bookPosition.bookItcEligible).toBe(3900); // 1950 + 1950
    expect(bookPosition.estimatedNetPosition).toBe(18000 + 900 - 3900);
  });
});
