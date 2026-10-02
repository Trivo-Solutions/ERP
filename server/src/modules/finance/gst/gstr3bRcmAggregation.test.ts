import { describe, it, expect } from 'vitest';
import { aggregateGstr3bRcm, Gstr3bRcmAggregationError } from './gstr3bRcmAggregation';
import type { Gstr3bRcmSourceLiabilityLine, Gstr3bRcmAggregationOptions } from './gstr3bRcm.types';

const REG = 'reg-1';

const period = { from: new Date('2026-04-01'), to: new Date('2026-06-30'), financialYear: '2026-27', taxPeriod: '052026' };

function baseOptions(overrides: Partial<Gstr3bRcmAggregationOptions> = {}): Gstr3bRcmAggregationOptions {
  return { companyId: 'c1', gstRegistrationId: REG, buyerGstin: '24AAAAA0000A1Z8', buyerStateCode: '24', period, ...overrides };
}

function baseLine(overrides: Partial<Gstr3bRcmSourceLiabilityLine> = {}): Gstr3bRcmSourceLiabilityLine {
  return {
    id: 'liab-1', grnId: 'grn-1', grnNumber: 'GRN-2026-000001', receivedDate: new Date('2026-05-15'),
    branchId: 'branch-1', supplierId: 'sup-1', supplierName: 'Acme Logistics',
    taxableValue: 1000, cgst: 90, sgst: 90, igst: 0, cess: 0,
    selfInvoiceRequirement: 'SELF_INVOICE_REQUIRED', paymentVoucherRequirement: 'PAYMENT_VOUCHER_REQUIRED',
    liabilityStatus: 'LIABILITY_RECOGNIZED',
    facts: { rcmCategory: 'GTA_FREIGHT', buyerRegistrationId: REG, taxCategory: 'TAXABLE' },
    ...overrides,
  };
}

describe('G2g-7d: aggregateGstr3bRcm (pure, no Prisma)', () => {
  it('throws without a gstRegistrationId', () => {
    expect(() => aggregateGstr3bRcm([], baseOptions({ gstRegistrationId: '' }))).toThrow(Gstr3bRcmAggregationError);
  });

  it('returns zero totals and the standing capability-gap diagnostics for an empty input', () => {
    const result = aggregateGstr3bRcm([], baseOptions());
    expect(result.table3_1d.recognized).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.table3_1d.lineCount).toBe(0);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE');
    expect(codes).toContain('RCM_SECTION_17_5_NOT_DETERMINABLE');
    expect(codes).toContain('GSTR_2B_RCM_RECONCILIATION_UNAVAILABLE');
  });

  it('nets a confirmed RCM_APPLICABLE, unpaid line into recognized liability and unresolved ITC', () => {
    const result = aggregateGstr3bRcm([baseLine()], baseOptions());
    expect(result.table3_1d.recognized).toEqual({ taxableValue: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 });
    expect(result.table3_1d.unresolved).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.table4A3.unresolved).toEqual({ taxableValue: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 });
    expect(result.table4A3.eligible.taxableValue).toBe(0);
    expect(result.diagnostics.find((d) => d.code === 'RCM_PAYMENT_NOT_RECORDED')).toBeTruthy();
  });

  it('nets a confirmed RCM_APPLICABLE, PAID line into recognized liability and ELIGIBLE ITC', () => {
    const result = aggregateGstr3bRcm([baseLine({ liabilityStatus: 'TAX_PAID' })], baseOptions());
    expect(result.table4A3.eligible).toEqual({ taxableValue: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 });
    expect(result.table4A3.unresolved.taxableValue).toBe(0);
  });

  it('never merges an RCM_UNRESOLVED amount into the recognized liability bucket (no false compliance)', () => {
    const unresolvedLine = baseLine({ facts: { rcmCategory: 'GTA_FREIGHT', buyerRegistrationId: null, taxCategory: 'TAXABLE' } });
    const result = aggregateGstr3bRcm([unresolvedLine], baseOptions());
    expect(result.table3_1d.recognized.taxableValue).toBe(0);
    expect(result.table3_1d.unresolved).toEqual({ taxableValue: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 });
    expect(result.table4A3.unresolved.taxableValue).toBe(1000);
    expect(result.diagnostics.find((d) => d.code === 'RCM_REGISTRATION_UNASSIGNED')).toMatchObject({ documentType: 'RCM_LIABILITY', documentId: 'liab-1' });
  });

  it('excludes (not counts as unresolved) a line attributed to a different registration', () => {
    const otherRegLine = baseLine({ facts: { rcmCategory: 'GTA_FREIGHT', buyerRegistrationId: 'other-reg', taxCategory: 'TAXABLE' } });
    const result = aggregateGstr3bRcm([otherRegLine], baseOptions());
    expect(result.table3_1d.recognized.taxableValue).toBe(0);
    expect(result.table3_1d.unresolved.taxableValue).toBe(0);
    expect(result.meta.sourceCounts.liabilityLinesExcludedByScope).toBe(1);
    expect(result.meta.sourceCounts.liabilityLinesConsidered).toBe(0);
  });

  it('excludes a line outside the requested date range', () => {
    const result = aggregateGstr3bRcm([baseLine({ receivedDate: new Date('2026-01-01') })], baseOptions());
    expect(result.meta.sourceCounts.liabilityLinesExcludedByScope).toBe(1);
  });

  it('restricts to a single branch when branchId is given, and flags PARTIAL_BRANCH_SCOPE', () => {
    const lineA = baseLine({ id: 'liab-a', branchId: 'branch-1' });
    const lineB = baseLine({ id: 'liab-b', branchId: 'branch-2' });
    const result = aggregateGstr3bRcm([lineA, lineB], baseOptions({ branchId: 'branch-1' }));
    expect(result.meta.sourceCounts.liabilityLinesConsidered).toBe(1);
    expect(result.meta.isCompleteGstinScope).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
  });

  it('restricts to a branchAccess allow-list when not allBranches', () => {
    const lineA = baseLine({ id: 'liab-a', branchId: 'branch-1' });
    const lineB = baseLine({ id: 'liab-b', branchId: 'branch-2' });
    const result = aggregateGstr3bRcm([lineA, lineB], baseOptions({ branchAccess: { allBranches: false, branchIds: ['branch-2'] } }));
    expect(result.meta.sourceCounts.liabilityLinesConsidered).toBe(1);
    expect(result.table3_1d.recognized.taxableValue).toBe(1000); // only lineB counted
  });

  it('counts self-invoice and payment-voucher requirements across all in-scope lines', () => {
    const lines = [
      baseLine({ id: 'l1', selfInvoiceRequirement: 'SELF_INVOICE_REQUIRED', paymentVoucherRequirement: 'PAYMENT_VOUCHER_REQUIRED' }),
      baseLine({ id: 'l2', selfInvoiceRequirement: 'SELF_INVOICE_NOT_REQUIRED', paymentVoucherRequirement: 'PAYMENT_VOUCHER_REQUIRED' }),
      baseLine({ id: 'l3', selfInvoiceRequirement: 'SELF_INVOICE_NOT_DETERMINED', paymentVoucherRequirement: 'PAYMENT_VOUCHER_NOT_DETERMINED',
        facts: { rcmCategory: 'UNRESOLVED', buyerRegistrationId: REG, taxCategory: 'TAXABLE' } }),
    ];
    const result = aggregateGstr3bRcm(lines, baseOptions());
    expect(result.selfInvoice).toEqual({ required: 1, notRequired: 1, notDetermined: 1 });
    expect(result.paymentVoucher).toEqual({ required: 2, notRequired: 0, notDetermined: 1 });
  });

  it('counts distinct suppliers and documents', () => {
    const lines = [baseLine({ id: 'l1', grnId: 'g1', supplierId: 's1' }), baseLine({ id: 'l2', grnId: 'g1', supplierId: 's1' }), baseLine({ id: 'l3', grnId: 'g2', supplierId: 's2' })];
    const result = aggregateGstr3bRcm(lines, baseOptions());
    expect(result.meta.supplierCount).toBe(2);
    expect(result.table3_1d.documentCount).toBe(2); // 2 distinct GRNs
    expect(result.table3_1d.lineCount).toBe(3);
  });
});
