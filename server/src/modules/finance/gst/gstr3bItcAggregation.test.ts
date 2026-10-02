import { describe, it, expect } from 'vitest';
import { aggregateGstr3bInwardItc } from './gstr3bItcAggregation';
import type {
  Gstr3bItcSourceGrnLine,
  Gstr3bItcSourcePurchaseReturnLine,
  Gstr3bItcSourceStandaloneDebitNoteLine,
  Gstr3bItcAggregationOptions,
  Gstr3bItcLineFacts,
} from './gstr3bItc.types';

// G2g-7c — pure aggregation engine tests. No Prisma, no DB — synthetic source rows only.

const REG = 'reg-1';
const PERIOD = { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z'), financialYear: '2026-27', taxPeriod: '092026' };

const baseOptions = (overrides: Partial<Gstr3bItcAggregationOptions> = {}): Gstr3bItcAggregationOptions => ({
  companyId: 'co-1',
  gstRegistrationId: REG,
  buyerGstin: '24AAAAA0000A1Z8',
  buyerStateCode: '24',
  period: PERIOD,
  ...overrides,
});

const eligibleFacts: Gstr3bItcLineFacts = {
  buyerRegistrationId: REG,
  supplierGstin: '24AAAAA0000A1Z8',
  supplierIsComposition: false,
  taxCategory: 'TAXABLE',
};

function grnLine(overrides: Partial<Gstr3bItcSourceGrnLine> = {}): Gstr3bItcSourceGrnLine {
  return {
    id: 'grn-item-1',
    grnId: 'grn-1',
    grnNumber: 'GRN-0001',
    receivedDate: new Date('2026-09-10T00:00:00.000Z'),
    branchId: 'branch-1',
    invoiceNumber: 'SUP-INV-1',
    invoiceDate: new Date('2026-09-09T00:00:00.000Z'),
    supplierId: 'sup-1',
    supplierName: 'Test Supplier',
    taxableValue: 100000,
    cgst: 1500,
    sgst: 1500,
    igst: 0,
    cess: 0,
    facts: { ...eligibleFacts },
    ...overrides,
  };
}

describe('G2g-7c: aggregateGstr3bInwardItc (pure, no Prisma)', () => {
  it('buckets a fully-eligible domestic purchase into the eligible total', () => {
    const result = aggregateGstr3bInwardItc([grnLine()], [], [], baseOptions());
    expect(result.table4A5.eligible).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
    expect(result.table4A5.unresolved).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.table4A5.ineligible).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.table4A5.documentCount).toBe(1);
    expect(result.table4A5.lineCount).toBe(1);
    expect(result.meta.supplierCount).toBe(1);
  });

  it('buckets a line with no buyerRegistrationId into unresolved, never eligible', () => {
    const line = grnLine({ facts: { ...eligibleFacts, buyerRegistrationId: null } });
    const result = aggregateGstr3bInwardItc([line], [], [], baseOptions());
    expect(result.table4A5.eligible.cgst).toBe(0);
    expect(result.table4A5.unresolved).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
    const diag = result.diagnostics.find((d) => d.code === 'BUYER_REGISTRATION_UNASSIGNED');
    expect(diag).toBeDefined();
    expect(diag?.documentType).toBe('GRN_LINE');
  });

  it('excludes (does not count anywhere) a line attributed to a different registration', () => {
    const line = grnLine({ facts: { ...eligibleFacts, buyerRegistrationId: 'other-reg' } });
    const result = aggregateGstr3bInwardItc([line], [], [], baseOptions());
    expect(result.table4A5.eligible.taxableValue).toBe(0);
    expect(result.table4A5.unresolved.taxableValue).toBe(0);
    expect(result.table4A5.ineligible.taxableValue).toBe(0);
    expect(result.meta.sourceCounts.grnLinesExcludedByScope).toBe(1);
    expect(result.meta.sourceCounts.grnLinesConsidered).toBe(0);
  });

  it('buckets a composition-scheme supplier line into ineligible', () => {
    const line = grnLine({ facts: { ...eligibleFacts, supplierIsComposition: true } });
    const result = aggregateGstr3bInwardItc([line], [], [], baseOptions());
    expect(result.table4A5.ineligible).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
  });

  it('excludes a line outside the requested period', () => {
    const line = grnLine({ receivedDate: new Date('2026-08-15T00:00:00.000Z') });
    const result = aggregateGstr3bInwardItc([line], [], [], baseOptions());
    expect(result.table4A5.eligible.taxableValue).toBe(0);
    expect(result.meta.sourceCounts.grnLinesExcludedByScope).toBe(1);
  });

  describe('branch scope', () => {
    it('full access (allBranches): no restriction, isCompleteGstinScope stays true', () => {
      const result = aggregateGstr3bInwardItc([grnLine()], [], [], baseOptions({ branchAccess: { allBranches: true, branchIds: [] } }));
      expect(result.meta.isCompleteGstinScope).toBe(true);
      expect(result.table4A5.eligible.taxableValue).toBe(100000);
    });

    it('restricted branchAccess excludes a line from another branch and flags PARTIAL_BRANCH_SCOPE', () => {
      const result = aggregateGstr3bInwardItc(
        [grnLine({ branchId: 'branch-2' })], [], [],
        baseOptions({ branchAccess: { allBranches: false, branchIds: ['branch-1'] } }),
      );
      expect(result.meta.isCompleteGstinScope).toBe(false);
      expect(result.meta.partialScopeReason).toBe('PARTIAL_BRANCH_SCOPE');
      expect(result.table4A5.eligible.taxableValue).toBe(0);
      expect(result.diagnostics.some((d) => d.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
    });

    it('explicit branchId filter takes precedence and includes a matching line', () => {
      const result = aggregateGstr3bInwardItc([grnLine({ branchId: 'branch-9' })], [], [], baseOptions({ branchId: 'branch-9' }));
      expect(result.meta.isCompleteGstinScope).toBe(false);
      expect(result.table4A5.eligible.taxableValue).toBe(100000);
    });
  });

  describe('purchase returns net into the SAME bucket as their source GRN line', () => {
    it('a return of a previously-ELIGIBLE line reduces the eligible bucket, not unresolved/ineligible', () => {
      const grn = grnLine();
      const ret: Gstr3bItcSourcePurchaseReturnLine = {
        id: 'pret-item-1', returnId: 'pret-1', returnNumber: 'PRET-0001',
        returnDate: new Date('2026-09-15T00:00:00.000Z'),
        sourceGrnLineId: grn.id, branchId: 'branch-1',
        amount: 20000, cgst: 300, sgst: 300, igst: 0, cess: 0,
        facts: { ...eligibleFacts }, // deliberately different (ignored) facts — parent's classification wins
      };
      const result = aggregateGstr3bInwardItc([grn], [ret], [], baseOptions());
      expect(result.table4A5.eligible).toEqual({ taxableValue: 80000, igst: 0, cgst: 1200, sgst: 1200, cess: 0 });
      expect(result.table4A5.unresolved.taxableValue).toBe(0);
    });

    it('a return of a previously-INELIGIBLE (composition) line reduces ineligible, not eligible', () => {
      const grn = grnLine({ facts: { ...eligibleFacts, supplierIsComposition: true } });
      const ret: Gstr3bItcSourcePurchaseReturnLine = {
        id: 'pret-item-2', returnId: 'pret-2', returnNumber: 'PRET-0002',
        returnDate: new Date('2026-09-20T00:00:00.000Z'),
        sourceGrnLineId: grn.id, branchId: 'branch-1',
        amount: 100000, cgst: 1500, sgst: 1500, igst: 0, cess: 0,
        facts: { ...eligibleFacts },
      };
      const result = aggregateGstr3bInwardItc([grn], [ret], [], baseOptions());
      expect(result.table4A5.ineligible).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
      expect(result.table4A5.eligible.taxableValue).toBe(0);
    });

    it('a return whose parent GRN line is outside the loaded set falls back to re-classifying its own facts', () => {
      const ret: Gstr3bItcSourcePurchaseReturnLine = {
        id: 'pret-item-3', returnId: 'pret-3', returnNumber: 'PRET-0003',
        returnDate: new Date('2026-09-20T00:00:00.000Z'),
        sourceGrnLineId: 'grn-item-not-loaded', branchId: 'branch-1',
        amount: 5000, cgst: 75, sgst: 75, igst: 0, cess: 0,
        facts: { ...eligibleFacts },
      };
      const result = aggregateGstr3bInwardItc([], [ret], [], baseOptions());
      expect(result.table4A5.eligible).toEqual({ taxableValue: -5000, igst: 0, cgst: -75, sgst: -75, cess: 0 });
      expect(result.diagnostics.some((d) => d.code === 'NEGATIVE_NET_ITC')).toBe(true);
    });
  });

  describe('standalone debit notes', () => {
    it('nets a standalone debit note into unresolved when it carries no tax-category snapshot', () => {
      const dn: Gstr3bItcSourceStandaloneDebitNoteLine = {
        id: 'dn-item-1', debitNoteId: 'dn-1', debitNoteNumber: 'DN-0001',
        debitNoteDate: new Date('2026-09-18T00:00:00.000Z'),
        grnId: 'grn-1', branchId: 'branch-1',
        taxableValue: 10000, cgst: 150, sgst: 150, igst: 0, cess: 0,
        facts: { buyerRegistrationId: REG, supplierGstin: '24AAAAA0000A1Z8', supplierIsComposition: false, taxCategory: null },
      };
      const result = aggregateGstr3bInwardItc([], [], [dn], baseOptions());
      expect(result.table4A5.unresolved).toEqual({ taxableValue: -10000, igst: 0, cgst: -150, sgst: -150, cess: 0 });
      expect(result.diagnostics.some((d) => d.code === 'TAX_CATEGORY_UNAVAILABLE' && d.documentType === 'STANDALONE_DEBIT_NOTE')).toBe(true);
    });
  });

  it('reports the fixed eligibility matrix with the four NOT_DETERMINABLE statutory conditions', () => {
    const result = aggregateGstr3bInwardItc([], [], [], baseOptions());
    const byCondition = new Map(result.eligibilityMatrix.map((e) => [e.condition, e.status]));
    expect(byCondition.get('Place of supply / state restriction')).toBe('NOT_DETERMINABLE');
    expect(byCondition.get('Section 16(4) time limit')).toBe('NOT_DETERMINABLE');
    expect(byCondition.get('Section 17(5) blocked credits')).toBe('NOT_DETERMINABLE');
    expect(byCondition.get('180-day payment condition')).toBe('NOT_DETERMINABLE');
    expect(byCondition.get('GSTR-2B availability')).toBe('NOT_DETERMINABLE');
    expect(byCondition.get('Buyer GST registration')).toBe('DETERMINABLE');
    expect(byCondition.get('Supplier GSTIN')).toBe('DETERMINABLE');
    expect(byCondition.get('Tax category')).toBe('DETERMINABLE');
  });

  it('always emits the five report-level capability-gap diagnostics exactly once each', () => {
    const result = aggregateGstr3bInwardItc([grnLine(), grnLine({ id: 'grn-item-2', grnId: 'grn-2' })], [], [], baseOptions());
    for (const code of ['POS_NOT_DETERMINABLE', 'SECTION_16_4_NOT_DETERMINABLE', 'SECTION_17_5_NOT_DETERMINABLE', 'ITC_180_DAY_STATUS_UNAVAILABLE', 'GSTR_2B_RECONCILIATION_UNAVAILABLE']) {
      expect(result.diagnostics.filter((d) => d.code === code)).toHaveLength(1);
    }
  });

  it('documentCount de-duplicates multiple lines from the same GRN', () => {
    const result = aggregateGstr3bInwardItc(
      [grnLine(), grnLine({ id: 'grn-item-2' })], [], [], baseOptions(),
    );
    expect(result.table4A5.documentCount).toBe(1); // same grnId
    expect(result.table4A5.lineCount).toBe(2);
  });

  it('throws when no gstRegistrationId is supplied', () => {
    expect(() => aggregateGstr3bInwardItc([], [], [], baseOptions({ gstRegistrationId: '' }))).toThrow();
  });
});
