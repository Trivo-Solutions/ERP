import { describe, it, expect } from 'vitest';
import {
  aggregateGstr1Table13,
  parseDocumentNumber,
  getGstFinancialYear,
  resolveDocumentCategory,
  isDocumentVoidOrCancelled,
  isKnownValidStatus,
  type Table13Document,
  type Table13AggregationOptions,
} from './gstr1Table13Aggregation';

const REG_A = 'reg_gstin_A';
const REG_B = 'reg_gstin_B';
const DATE_FY_2026 = new Date('2026-06-15T10:00:00.000Z'); // In FY 2026-27 (starts 2026)
const DATE_FY_2025 = new Date('2026-02-15T10:00:00.000Z'); // In FY 2025-26 (starts 2025)

function makeDoc(overrides: Partial<Table13Document> = {}): Table13Document {
  return {
    id: 'doc_1',
    documentNumber: 'INV-2026-000001',
    documentDate: DATE_FY_2026,
    status: 'ISSUED',
    documentType: 'SALES_INVOICE',
    sellerRegistrationId: REG_A,
    branchId: 'branch_1',
    ...overrides,
  };
}

describe('GSTR-1 Table 13 Pure Document Range Engine', () => {
  describe('Document Number Parser', () => {
    it('parses standard TRIVO invoice format (INV-2026-000001)', () => {
      const parsed = parseDocumentNumber('INV-2026-000001');
      expect(parsed).toEqual({
        originalNumber: 'INV-2026-000001',
        prefix: 'INV',
        financialYear: 2026,
        financialYearRaw: '2026',
        serial: 1,
        formattedSerial: '000001',
      });
    });

    it('parses standard TRIVO credit note format (CN-2026-000001)', () => {
      const parsed = parseDocumentNumber('CN-2026-000001');
      expect(parsed).toEqual({
        originalNumber: 'CN-2026-000001',
        prefix: 'CN',
        financialYear: 2026,
        financialYearRaw: '2026',
        serial: 1,
        formattedSerial: '000001',
      });
    });

    it('parses standard TRIVO debit note format (DN-2026-000001)', () => {
      const parsed = parseDocumentNumber('DN-2026-000001');
      expect(parsed).toEqual({
        originalNumber: 'DN-2026-000001',
        prefix: 'DN',
        financialYear: 2026,
        financialYearRaw: '2026',
        serial: 1,
        formattedSerial: '000001',
      });
    });

    it('parses slash-delimited format (INV/2026/000001)', () => {
      const parsed = parseDocumentNumber('INV/2026/000001');
      expect(parsed).toEqual({
        originalNumber: 'INV/2026/000001',
        prefix: 'INV',
        financialYear: 2026,
        financialYearRaw: '2026',
        serial: 1,
        formattedSerial: '000001',
      });
    });

    it('parses combined financial year format (INV/2025-26/001)', () => {
      const parsed = parseDocumentNumber('INV/2025-26/001');
      expect(parsed).toEqual({
        originalNumber: 'INV/2025-26/001',
        prefix: 'INV',
        financialYear: 2025,
        financialYearRaw: '2025-26',
        serial: 1,
        formattedSerial: '001',
      });
    });

    it('parses number with prefix and serial but no encoded FY (INV-000042)', () => {
      const parsed = parseDocumentNumber('INV-000042');
      expect(parsed).toEqual({
        originalNumber: 'INV-000042',
        prefix: 'INV',
        financialYear: null,
        financialYearRaw: null,
        serial: 42,
        formattedSerial: '000042',
      });
    });

    it('parses purely numeric serial (000005)', () => {
      const parsed = parseDocumentNumber('000005');
      expect(parsed).toEqual({
        originalNumber: '000005',
        prefix: '',
        financialYear: null,
        financialYearRaw: null,
        serial: 5,
        formattedSerial: '000005',
      });
    });

    it('returns null for unparseable or ambiguous numbers (no delimiters, invalid formats)', () => {
      expect(parseDocumentNumber('')).toBeNull();
      expect(parseDocumentNumber('   ')).toBeNull();
      expect(parseDocumentNumber('INVALID')).toBeNull();
      expect(parseDocumentNumber('INV2026000001')).toBeNull(); // Missing delimiter; guessing prohibited
      expect(parseDocumentNumber('INV-0')).toBeNull(); // Serial 0 is invalid under Rule 46
      expect(parseDocumentNumber('A'.repeat(17))).toBeNull(); // Exceeds 16 characters
    });
  });

  describe('Indian GST Financial Year helper', () => {
    it('correctly derives starting year of FY', () => {
      // April 1, 2026 -> FY 2026-27 (2026)
      expect(getGstFinancialYear(new Date('2026-04-01T00:00:00.000Z'))).toBe(2026);
      // Dec 31, 2026 -> FY 2026-27 (2026)
      expect(getGstFinancialYear(new Date('2026-12-31T00:00:00.000Z'))).toBe(2026);
      // Jan 15, 2026 -> FY 2025-26 (2025)
      expect(getGstFinancialYear(new Date('2026-01-15T00:00:00.000Z'))).toBe(2025);
      // March 31, 2026 -> FY 2025-26 (2025)
      expect(getGstFinancialYear(new Date('2026-03-31T00:00:00.000Z'))).toBe(2025);
    });
  });

  describe('Category and Status helpers', () => {
    it('maps supported outward document types to statutory categories', () => {
      expect(resolveDocumentCategory('SALES_INVOICE')).toBe('OUTWARD_INVOICE');
      expect(resolveDocumentCategory('OUTWARD_INVOICE')).toBe('OUTWARD_INVOICE');
      expect(resolveDocumentCategory('CREDIT_NOTE')).toBe('CREDIT_NOTE');
      expect(resolveDocumentCategory('OUTWARD_DEBIT_NOTE')).toBe('OUTWARD_DEBIT_NOTE');
      expect(resolveDocumentCategory('DELIVERY_CHALLAN')).toBe('DELIVERY_CHALLAN');
      expect(resolveDocumentCategory('RECEIPT_VOUCHER')).toBe('RECEIPT_VOUCHER');
      expect(resolveDocumentCategory('PAYMENT_VOUCHER')).toBe('PAYMENT_VOUCHER');
      expect(resolveDocumentCategory('REFUND_VOUCHER')).toBe('REFUND_VOUCHER');
      expect(resolveDocumentCategory('OTHER')).toBe('OTHER');
    });

    it('rejects procurement debit notes and internal documents from GSTR-1 outward categories', () => {
      // Procurement debit notes and internal documents must NOT be inferred as outward documents
      expect(resolveDocumentCategory('DEBIT_NOTE')).toBeNull();
      expect(resolveDocumentCategory('PURCHASE_DEBIT_NOTE')).toBeNull();
      expect(resolveDocumentCategory('MEMO_OUT')).toBeNull();
      expect(resolveDocumentCategory('BRANCH_TRANSFER')).toBeNull();
      expect(resolveDocumentCategory('PURCHASE_ORDER')).toBeNull();
    });

    it('correctly identifies void/cancelled statuses', () => {
      expect(isDocumentVoidOrCancelled('VOID')).toBe(true);
      expect(isDocumentVoidOrCancelled('void')).toBe(true);
      expect(isDocumentVoidOrCancelled('CANCELLED')).toBe(true);
      expect(isDocumentVoidOrCancelled('cancelled')).toBe(true);
      expect(isDocumentVoidOrCancelled('ISSUED')).toBe(false);
      expect(isDocumentVoidOrCancelled('DRAFT')).toBe(false);
      expect(isDocumentVoidOrCancelled('PAID')).toBe(false);
    });

    it('validates known statuses', () => {
      expect(isKnownValidStatus('ISSUED')).toBe(true);
      expect(isKnownValidStatus('DRAFT')).toBe(true);
      expect(isKnownValidStatus('VOID')).toBe(true);
      expect(isKnownValidStatus('CANCELLED')).toBe(true);
      expect(isKnownValidStatus('PAID')).toBe(true);
      expect(isKnownValidStatus('PARTIALLY_PAID')).toBe(true);
      expect(isKnownValidStatus('CORRUPTED')).toBe(false);
      expect(isKnownValidStatus('')).toBe(false);
    });
  });

  describe('Contiguous Ranges and Basic Aggregation', () => {
    it('aggregates a basic contiguous invoice range', () => {
      const docs = [
        makeDoc({ id: 'inv_1', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'ISSUED' }),
        makeDoc({ id: 'inv_3', documentNumber: 'INV-2026-000003', status: 'ISSUED' }),
        makeDoc({ id: 'inv_4', documentNumber: 'INV-2026-000004', status: 'ISSUED' }),
        makeDoc({ id: 'inv_5', documentNumber: 'INV-2026-000005', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.category).toBe('OUTWARD_INVOICE');
      expect(s.sellerRegistrationId).toBe(REG_A);
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000005');
      expect(s.fromDocumentNumber).toBe('INV-2026-000001');
      expect(s.toDocumentNumber).toBe('INV-2026-000005');
      expect(s.totalDocuments).toBe(5);
      expect(s.cancelledDocuments).toBe(0);
      expect(s.netIssued).toBe(5);
      expect(s.documentCount).toBe(5);
      expect(s.filingEligible).toBe(true);
      expect(s.diagnostics).toHaveLength(0);

      expect(result.summary).toEqual({
        seriesCount: 1,
        filingEligibleSeries: 1,
        nonFilingEligibleSeries: 0,
        documentCount: 5,
        cancelledDocumentCount: 0,
      });
    });

    it('splits into multiple contiguous ranges when sequence gaps exist (000001->000003 and 000005->000006)', () => {
      const docs = [
        makeDoc({ id: 'inv_1', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'ISSUED' }),
        makeDoc({ id: 'inv_3', documentNumber: 'INV-2026-000003', status: 'ISSUED' }),
        // 000004 is missing
        makeDoc({ id: 'inv_5', documentNumber: 'INV-2026-000005', status: 'ISSUED' }),
        makeDoc({ id: 'inv_6', documentNumber: 'INV-2026-000006', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(2);

      const r1 = result.series[0];
      expect(r1.from).toBe('000001');
      expect(r1.to).toBe('000003');
      expect(r1.totalDocuments).toBe(3);
      expect(r1.cancelledDocuments).toBe(0);
      expect(r1.netIssued).toBe(3);
      expect(r1.documentCount).toBe(3);

      const r2 = result.series[1];
      expect(r2.from).toBe('000005');
      expect(r2.to).toBe('000006');
      expect(r2.totalDocuments).toBe(2);
      expect(r2.cancelledDocuments).toBe(0);
      expect(r2.netIssued).toBe(2);
      expect(r2.documentCount).toBe(2);

      // Verify gap diagnostic
      const gapDiag = result.diagnostics.find((d) => d.code === 'UNEXPLAINED_SEQUENCE_GAP');
      expect(gapDiag).toBeDefined();
      expect(gapDiag?.previousSerial).toBe(3);
      expect(gapDiag?.nextSerial).toBe(5);
      expect(gapDiag?.missingFrom).toBe(4);
      expect(gapDiag?.missingTo).toBe(4);
      expect(gapDiag?.missingCount).toBe(1);

      // Crucial: 000004 was NOT manufactured as cancelled
      expect(result.summary.cancelledDocumentCount).toBe(0);
      expect(result.summary.documentCount).toBe(5);
      expect(result.summary.seriesCount).toBe(2);
    });
  });

  describe('Gap vs Cancelled Semantics', () => {
    it('counts actual recorded VOID documents within a contiguous range', () => {
      // Range with recorded VOID: 1 ISSUED, 2 VOID, 3 ISSUED
      const docs = [
        makeDoc({ id: 'inv_1', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'VOID' }),
        makeDoc({ id: 'inv_3', documentNumber: 'INV-2026-000003', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000003');
      expect(s.totalDocuments).toBe(3);
      expect(s.cancelledDocuments).toBe(1);
      expect(s.netIssued).toBe(2);
      expect(s.documentCount).toBe(3);
      expect(s.filingEligible).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('NEVER manufactures a cancelled document from a sequence gap (1 ISSUED, 3 ISSUED)', () => {
      // 1 ISSUED, 2 MISSING, 3 ISSUED
      const docs = [
        makeDoc({ id: 'inv_1', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_3', documentNumber: 'INV-2026-000003', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      // Must split into 1->1 and 3->3 rather than 1->3 with cancelled=1
      expect(result.series).toHaveLength(2);

      expect(result.series[0].from).toBe('000001');
      expect(result.series[0].to).toBe('000001');
      expect(result.series[0].totalDocuments).toBe(1);
      expect(result.series[0].cancelledDocuments).toBe(0);
      expect(result.series[0].netIssued).toBe(1);

      expect(result.series[1].from).toBe('000003');
      expect(result.series[1].to).toBe('000003');
      expect(result.series[1].totalDocuments).toBe(1);
      expect(result.series[1].cancelledDocuments).toBe(0);
      expect(result.series[1].netIssued).toBe(1);

      // Gap diagnostic
      const gapDiag = result.diagnostics.find((d) => d.code === 'UNEXPLAINED_SEQUENCE_GAP');
      expect(gapDiag).toMatchObject({
        previousSerial: 1,
        nextSerial: 3,
        missingFrom: 2,
        missingTo: 2,
        missingCount: 1,
      });

      // No cancellations in summary
      expect(result.summary.cancelledDocumentCount).toBe(0);
    });

    it('represents large block gaps as a single diagnostic (previous=10, next=15, missingFrom=11, missingTo=14)', () => {
      const docs = [
        makeDoc({ id: 'inv_10', documentNumber: 'INV-2026-000010', status: 'ISSUED' }),
        makeDoc({ id: 'inv_15', documentNumber: 'INV-2026-000015', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(2);
      const gapDiag = result.diagnostics.find((d) => d.code === 'UNEXPLAINED_SEQUENCE_GAP');
      expect(gapDiag).toMatchObject({
        previousSerial: 10,
        nextSerial: 15,
        missingFrom: 11,
        missingTo: 14,
        missingCount: 4,
      });
    });

    it('correctly handles a series where all documents are VOID', () => {
      const docs = [
        makeDoc({ id: 'inv_1', documentNumber: 'INV-2026-000001', status: 'VOID' }),
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'VOID' }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000002');
      expect(s.totalDocuments).toBe(2);
      expect(s.cancelledDocuments).toBe(2);
      expect(s.netIssued).toBe(0);
      expect(s.documentCount).toBe(2);
    });
  });

  describe('Duplicate Detection', () => {
    it('detects duplicate document IDs and does not double-count them', () => {
      const docs = [
        makeDoc({ id: 'inv_dup', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_dup', documentNumber: 'INV-2026-000001', status: 'ISSUED' }), // Duplicate ID
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      const dupDiag = result.diagnostics.find((d) => d.code === 'DUPLICATE_DOCUMENT_ID');
      expect(dupDiag).toBeDefined();
      expect(dupDiag?.documentId).toBe('inv_dup');

      // Total count is 2 (inv_dup only counted once), not 3
      expect(result.summary.documentCount).toBe(2);
      // Duplicate ID renders series unsafe for filing
      expect(result.series[0].filingEligible).toBe(false);
    });

    it('detects duplicate serial numbers with different document IDs and marks series unsafe for filing', () => {
      const docs = [
        makeDoc({ id: 'inv_1a', documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'inv_1b', documentNumber: 'INV-2026-000001', status: 'ISSUED' }), // Collision on serial 1
        makeDoc({ id: 'inv_2', documentNumber: 'INV-2026-000002', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      const dupSerialDiag = result.diagnostics.find((d) => d.code === 'DUPLICATE_DOCUMENT_SERIAL');
      expect(dupSerialDiag).toBeDefined();
      expect(dupSerialDiag?.serial).toBe(1);
      expect(dupSerialDiag?.conflictingDocumentIds).toEqual(['inv_1a', 'inv_1b']);

      expect(result.series[0].filingEligible).toBe(false);
      expect(result.summary.filingEligibleSeries).toBe(0);
      expect(result.summary.nonFilingEligibleSeries).toBe(1);
    });
  });

  describe('Multi-GSTIN Isolation', () => {
    it('isolates document series across different GSTIN registrations and does not manufacture cancellations (Mandatory Test)', () => {
      // Interleaved documents across registrations:
      // Reg A: INV-2026-000001, INV-2026-000003
      // Reg B: INV-2026-000002, INV-2026-000004
      const docs = [
        makeDoc({ id: 'a1', sellerRegistrationId: REG_A, documentNumber: 'INV-2026-000001', status: 'ISSUED' }),
        makeDoc({ id: 'b2', sellerRegistrationId: REG_B, documentNumber: 'INV-2026-000002', status: 'ISSUED' }),
        makeDoc({ id: 'a3', sellerRegistrationId: REG_A, documentNumber: 'INV-2026-000003', status: 'ISSUED' }),
        makeDoc({ id: 'b4', sellerRegistrationId: REG_B, documentNumber: 'INV-2026-000004', status: 'ISSUED' }),
      ];

      const result = aggregateGstr1Table13(docs);

      // Must produce separate series for Reg A and Reg B
      const regASeries = result.series.filter((s) => s.sellerRegistrationId === REG_A);
      const regBSeries = result.series.filter((s) => s.sellerRegistrationId === REG_B);

      // Reg A: 000001->000001 and 000003->000003 (with gap 2)
      expect(regASeries).toHaveLength(2);
      expect(regASeries[0].from).toBe('000001');
      expect(regASeries[0].to).toBe('000001');
      expect(regASeries[0].cancelledDocuments).toBe(0);
      expect(regASeries[1].from).toBe('000003');
      expect(regASeries[1].to).toBe('000003');
      expect(regASeries[1].cancelledDocuments).toBe(0);

      // Reg B: 000002->000002 and 000004->000004 (with gap 3)
      expect(regBSeries).toHaveLength(2);
      expect(regBSeries[0].from).toBe('000002');
      expect(regBSeries[0].to).toBe('000002');
      expect(regBSeries[0].cancelledDocuments).toBe(0);
      expect(regBSeries[1].from).toBe('000004');
      expect(regBSeries[1].to).toBe('000004');
      expect(regBSeries[1].cancelledDocuments).toBe(0);

      // Critical check: Neither registration merged with the other, neither treated the other's number as cancelled
      expect(result.summary.cancelledDocumentCount).toBe(0);
      expect(result.summary.seriesCount).toBe(4);
    });
  });

  describe('Credit Notes & G2g-3g-0.1 Uniqueness', () => {
    it('accepts same Credit Note serial across different GST registrations as separate series (Mandatory Test)', () => {
      // Reflects G2g-3g-0.1 registration-scoped CreditNote uniqueness model
      // Registration A: CN-2026-000001
      // Registration B: CN-2026-000001
      const docs = [
        makeDoc({
          id: 'cn_a1',
          sellerRegistrationId: REG_A,
          documentType: 'CREDIT_NOTE',
          documentNumber: 'CN-2026-000001',
          status: 'ISSUED',
        }),
        makeDoc({
          id: 'cn_b1',
          sellerRegistrationId: REG_B,
          documentType: 'CREDIT_NOTE',
          documentNumber: 'CN-2026-000001',
          status: 'ISSUED',
        }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(2);

      const cnA = result.series.find((s) => s.sellerRegistrationId === REG_A);
      const cnB = result.series.find((s) => s.sellerRegistrationId === REG_B);

      expect(cnA).toBeDefined();
      expect(cnA?.category).toBe('CREDIT_NOTE');
      expect(cnA?.from).toBe('000001');
      expect(cnA?.to).toBe('000001');
      expect(cnA?.filingEligible).toBe(true);

      expect(cnB).toBeDefined();
      expect(cnB?.category).toBe('CREDIT_NOTE');
      expect(cnB?.from).toBe('000001');
      expect(cnB?.to).toBe('000001');
      expect(cnB?.filingEligible).toBe(true);

      // No collision or duplicate serial diagnostic
      expect(result.diagnostics).toHaveLength(0);
    });

    it('aggregates both Path A and Path B Credit Notes and counts CANCELLED status', () => {
      const docs = [
        makeDoc({
          id: 'cn_1',
          documentType: 'CREDIT_NOTE',
          documentNumber: 'CN-2026-000001',
          status: 'ISSUED', // Path A return wrapper
        }),
        makeDoc({
          id: 'cn_2',
          documentType: 'CREDIT_NOTE',
          documentNumber: 'CN-2026-000002',
          status: 'CANCELLED', // Path B cancelled note
        }),
        makeDoc({
          id: 'cn_3',
          documentType: 'CREDIT_NOTE',
          documentNumber: 'CN-2026-000003',
          status: 'ISSUED', // Path B active standalone
        }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.category).toBe('CREDIT_NOTE');
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000003');
      expect(s.totalDocuments).toBe(3);
      expect(s.cancelledDocuments).toBe(1);
      expect(s.netIssued).toBe(2);
    });
  });

  describe('Legacy Null Registration', () => {
    it('supports sellerRegistrationId = null as distinct legacy series with diagnostics and filingEligible = false', () => {
      const docs = [
        makeDoc({
          id: 'leg_1',
          sellerRegistrationId: null,
          documentNumber: 'INV-2026-000001',
          status: 'ISSUED',
        }),
        makeDoc({
          id: 'leg_2',
          sellerRegistrationId: null,
          documentNumber: 'INV-2026-000002',
          status: 'ISSUED',
        }),
      ];

      const result = aggregateGstr1Table13(docs);

      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.sellerRegistrationId).toBeNull();
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000002');
      expect(s.totalDocuments).toBe(2);
      expect(s.cancelledDocuments).toBe(0);
      expect(s.netIssued).toBe(2);
      expect(s.filingEligible).toBe(false);

      expect(s.diagnostics.some((d) => d.code === 'MISSING_SELLER_REGISTRATION')).toBe(true);
      expect(s.diagnostics.some((d) => d.code === 'LEGACY_SERIES')).toBe(true);
    });
  });

  describe('Financial Year Mismatch Validation', () => {
    it('flags DOCUMENT_FY_MISMATCH when document date FY disagrees with encoded FY and marks series unsafe', () => {
      // Document number encodes 2026 (FY 2026-27), but date is in Feb 2026 (FY 2025-26)
      const doc = makeDoc({
        id: 'inv_mismatch',
        documentNumber: 'INV-2026-000001',
        documentDate: DATE_FY_2025, // Feb 2026 -> FY 2025
      });

      const result = aggregateGstr1Table13([doc]);

      const diag = result.diagnostics.find((d) => d.code === 'DOCUMENT_FY_MISMATCH');
      expect(diag).toBeDefined();
      expect(diag?.encodedFinancialYear).toBe(2026);
      expect(diag?.dateFinancialYear).toBe(2025);

      expect(result.series[0].filingEligible).toBe(false);
    });
  });

  describe('Unparseable Numbers and Data Integrity', () => {
    it('produces UNPARSEABLE_DOCUMENT_NUMBER diagnostic and does not create an unparseable range', () => {
      const doc = makeDoc({
        id: 'inv_bad',
        documentNumber: 'INVALID_NUMBER_XYZ',
      });

      const result = aggregateGstr1Table13([doc]);

      expect(result.series).toHaveLength(0);
      const diag = result.diagnostics.find((d) => d.code === 'UNPARSEABLE_DOCUMENT_NUMBER');
      expect(diag).toBeDefined();
      expect(diag?.documentNumber).toBe('INVALID_NUMBER_XYZ');
    });

    it('produces UNSUPPORTED_DOCUMENT_TYPE when unsupported document type is passed', () => {
      const doc = makeDoc({
        id: 'inv_unsupported',
        documentType: 'PURCHASE_DEBIT_NOTE', // Procurement-side, not outward
      });

      const result = aggregateGstr1Table13([doc]);

      expect(result.series).toHaveLength(0);
      const diag = result.diagnostics.find((d) => d.code === 'UNSUPPORTED_DOCUMENT_TYPE');
      expect(diag).toBeDefined();
    });

    it('produces INVALID_DOCUMENT_STATUS when document has unrecognized status', () => {
      const doc = makeDoc({
        id: 'inv_invalid_status',
        status: 'SOME_RANDOM_STATUS',
      });

      const result = aggregateGstr1Table13([doc]);

      const diag = result.diagnostics.find((d) => d.code === 'INVALID_DOCUMENT_STATUS');
      expect(diag).toBeDefined();
      expect(result.series[0].filingEligible).toBe(false);
    });
  });

  describe('Branch Metadata Handling', () => {
    it('preserves branchId as metadata without splitting statutory series', () => {
      const docs = [
        makeDoc({ id: 'inv_1', branchId: 'branch_mum', documentNumber: 'INV-2026-000001' }),
        makeDoc({ id: 'inv_2', branchId: 'branch_pune', documentNumber: 'INV-2026-000002' }),
      ];

      const result = aggregateGstr1Table13(docs);

      // Both belong to the same statutory series under Rule 46
      expect(result.series).toHaveLength(1);
      const s = result.series[0];
      expect(s.from).toBe('000001');
      expect(s.to).toBe('000002');
      expect(s.totalDocuments).toBe(2);
      expect(s.branchIds).toEqual(expect.arrayContaining(['branch_mum', 'branch_pune']));
    });
  });

  describe('Options Filtering', () => {
    it('filters by seller registration when gstRegistrationId option is supplied', () => {
      const docs = [
        makeDoc({ id: 'a1', sellerRegistrationId: REG_A, documentNumber: 'INV-2026-000001' }),
        makeDoc({ id: 'b1', sellerRegistrationId: REG_B, documentNumber: 'INV-2026-000001' }),
      ];

      const result = aggregateGstr1Table13(docs, { gstRegistrationId: REG_A });

      expect(result.series).toHaveLength(1);
      expect(result.series[0].sellerRegistrationId).toBe(REG_A);
    });

    it('filters by period date boundaries when period option is supplied', () => {
      const docInPeriod = makeDoc({
        id: 'in_period',
        documentDate: new Date('2026-06-15T00:00:00.000Z'),
        documentNumber: 'INV-2026-000001',
      });
      const docOutOfPeriod = makeDoc({
        id: 'out_of_period',
        documentDate: new Date('2026-07-15T00:00:00.000Z'),
        documentNumber: 'INV-2026-000002',
      });

      const options: Table13AggregationOptions = {
        period: {
          from: new Date('2026-06-01T00:00:00.000Z'),
          to: new Date('2026-06-30T23:59:59.999Z'),
        },
      };

      const result = aggregateGstr1Table13([docInPeriod, docOutOfPeriod], options);

      expect(result.series).toHaveLength(1);
      expect(result.series[0].from).toBe('000001');
      expect(result.series[0].to).toBe('000001');
    });

    it('filters by branchId when branchId option is supplied', () => {
      const docBranch1 = makeDoc({ id: 'b1', branchId: 'branch_1', documentNumber: 'INV-2026-000001' });
      const docBranch2 = makeDoc({ id: 'b2', branchId: 'branch_2', documentNumber: 'INV-2026-000002' });

      const result = aggregateGstr1Table13([docBranch1, docBranch2], { branchId: 'branch_1' });

      expect(result.series).toHaveLength(1);
      expect(result.series[0].from).toBe('000001');
      expect(result.series[0].to).toBe('000001');
    });
  });

  describe('Deterministic Ordering and Summary Consistency', () => {
    it('produces deterministically sorted series and coherent summary metrics', () => {
      const docs = [
        makeDoc({ id: 'b1', sellerRegistrationId: REG_B, documentNumber: 'INV-2026-000001' }),
        makeDoc({ id: 'a2', sellerRegistrationId: REG_A, documentNumber: 'INV-2026-000002' }),
        makeDoc({ id: 'a1', sellerRegistrationId: REG_A, documentNumber: 'INV-2026-000001' }),
        makeDoc({ id: 'cn1', sellerRegistrationId: REG_A, documentType: 'CREDIT_NOTE', documentNumber: 'CN-2026-000001' }),
      ];

      const result1 = aggregateGstr1Table13(docs);
      const result2 = aggregateGstr1Table13([...docs].reverse());

      expect(result1.series).toEqual(result2.series);
      expect(result1.summary).toEqual(result2.summary);
    });
  });
});
