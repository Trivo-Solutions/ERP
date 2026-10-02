import { describe, it, expect } from 'vitest';
import { reconcileGstr2b } from './gstr2bReconciliation';
import type { Gstr2bBookInvoiceLine, Gstr2bBookReturnLine, Gstr2bDocumentForMatch } from './gstr2b.types';

const baseOptions = {
  companyId: 'co1',
  gstRegistrationId: 'reg1',
  financialYear: '2026-27',
  taxPeriod: '092026',
  statementId: 'stmt1',
  statementVersion: 1,
  statementImportedAt: new Date('2026-10-14'),
};

function doc(overrides: Partial<Gstr2bDocumentForMatch> = {}): Gstr2bDocumentForMatch {
  return {
    id: 'doc1', section: 'B2B', documentType: 'INVOICE', supplierGstin: '27BBBBB1111B1Z1',
    documentNumber: 'INV/001', documentDate: new Date('2026-09-05'),
    taxableValue: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0,
    reverseCharge: false, supportStatus: 'SUPPORTED', provenanceStatus: 'CURRENT',
    itcAvailability: null, ineligibilityReason: null,
    ...overrides,
  };
}

function bookLine(overrides: Partial<Gstr2bBookInvoiceLine> = {}): Gstr2bBookInvoiceLine {
  return {
    grnId: 'grn1', grnNumber: 'GRN-0001', supplierId: 'sup1', supplierGstin: '27BBBBB1111B1Z1',
    invoiceNumber: 'INV/001', invoiceDate: new Date('2026-09-05'), branchId: 'branch1',
    buyerRegistrationId: 'reg1', taxableValue: 100000, cgst: 0, sgst: 0, igst: 18000,
    hasRcmLiability: false,
    ...overrides,
  };
}

describe('G2g-7e: reconcileGstr2b', () => {
  it('EXACT_MATCH when GSTIN, document number, date, and amounts all agree', () => {
    const result = reconcileGstr2b([doc()], [bookLine()], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('EXACT_MATCH');
    expect(result.summary.exactMatch).toBe(1);
  });

  it('MATCHED_WITH_NORMALIZATION when the document number differs only by formatting', () => {
    const result = reconcileGstr2b([doc({ documentNumber: 'INV-001' })], [bookLine({ invoiceNumber: 'INV/001' })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('MATCHED_WITH_NORMALIZATION');
  });

  it('POSSIBLE_MATCH when only GSTIN and date agree, never escalated even if amounts also agree', () => {
    const result = reconcileGstr2b([doc({ documentNumber: 'TOTALLY-DIFFERENT-99' })], [bookLine({ invoiceNumber: 'INV/001' })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('POSSIBLE_MATCH');
  });

  it('AMOUNT_MISMATCH when taxable value differs beyond tolerance', () => {
    const result = reconcileGstr2b([doc({ taxableValue: 100000 })], [bookLine({ taxableValue: 90000, igst: 16200 })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('AMOUNT_MISMATCH');
  });

  it('TAX_MISMATCH when taxable value agrees but tax amount differs beyond tolerance', () => {
    const result = reconcileGstr2b([doc({ taxableValue: 100000, igst: 18000 })], [bookLine({ taxableValue: 100000, igst: 9000, cgst: 0, sgst: 0 })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('TAX_MISMATCH');
  });

  it('a ₹1 rounding difference is still EXACT_MATCH, never flagged', () => {
    const result = reconcileGstr2b([doc({ taxableValue: 100000.5 })], [bookLine({ taxableValue: 100000 })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('EXACT_MATCH');
  });

  it('BOOK_MISSING for a book GRN with no corresponding 2B document', () => {
    const result = reconcileGstr2b([], [bookLine({ grnId: 'grn-orphan', invoiceNumber: 'NOTHING-IN-2B' })], [], baseOptions);
    expect(result.matches.some((m) => m.status === 'BOOK_MISSING' && m.bookReferenceId === 'grn-orphan')).toBe(true);
  });

  it('TWO_B_MISSING for a 2B document with no corresponding book GRN', () => {
    const result = reconcileGstr2b([doc({ supplierGstin: '27NOBOOK000N1Z1' })], [], [], baseOptions);
    expect(result.matches.some((m) => m.status === 'TWO_B_MISSING' && m.twoBDocumentId === 'doc1')).toBe(true);
  });

  it('RCM_MISMATCH when the reverse-charge flag disagrees between 2B and books', () => {
    const result = reconcileGstr2b([doc({ reverseCharge: true })], [bookLine({ hasRcmLiability: false })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('RCM_MISMATCH');
    expect(result.rcmSummary.mismatched).toBe(1);
  });

  it('a matching RCM flag does not trigger RCM_MISMATCH', () => {
    const result = reconcileGstr2b([doc({ reverseCharge: true })], [bookLine({ hasRcmLiability: true })], [], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
    expect(m?.status).toBe('EXACT_MATCH');
  });

  it('NOT_SUPPORTED for ISD/import documents, never compared against books', () => {
    const result = reconcileGstr2b(
      [doc({ id: 'isd1', section: 'ISD', documentType: 'ISD_INVOICE', supportStatus: 'ISD_NOT_SUPPORTED' }),
       doc({ id: 'impg1', section: 'IMPG', documentType: 'IMPORT_BOE', supportStatus: 'IMPORTS_NOT_RECONCILABLE' })],
      [], [], baseOptions,
    );
    expect(result.matches.find((m) => m.twoBDocumentId === 'isd1')?.status).toBe('NOT_SUPPORTED');
    expect(result.matches.find((m) => m.twoBDocumentId === 'impg1')?.status).toBe('NOT_SUPPORTED');
    expect(result.diagnostics.some((d) => d.code === 'ISD_NOT_SUPPORTED')).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'IMPORTS_NOT_RECONCILABLE')).toBe(true);
  });

  it('CDNR matching never exceeds POSSIBLE_MATCH confidence, and emits the data-model-limitation diagnostic', () => {
    const cdnrDoc = doc({ id: 'cdnr1', section: 'CDNR', documentType: 'CREDIT_NOTE', taxableValue: 5000, igst: 900 });
    const returnLine: Gstr2bBookReturnLine = {
      returnId: 'ret1', returnNumber: 'PRET-0001', supplierId: 'sup1', supplierGstin: '27BBBBB1111B1Z1',
      returnDate: new Date('2026-09-10'), amount: 5000, cgst: 0, sgst: 0, igst: 900,
      originalInvoiceNumber: 'INV/001', originalInvoiceDate: new Date('2026-09-05'),
    };
    const result = reconcileGstr2b([cdnrDoc], [], [returnLine], baseOptions);
    const m = result.matches.find((x) => x.twoBDocumentId === 'cdnr1');
    expect(m?.status).toBe('POSSIBLE_MATCH');
    expect(result.diagnostics.some((d) => d.code === 'CDNR_MATCHING_LIMITED_TO_POSSIBLE')).toBe(true);
  });

  it('flags an unresolved amendment link rather than guessing it', () => {
    const b2ba = doc({ id: 'b2ba1', section: 'B2BA', provenanceStatus: 'CURRENT' });
    const result = reconcileGstr2b([b2ba], [bookLine({ invoiceNumber: b2ba.documentNumber! })], [], baseOptions);
    expect(result.diagnostics.some((d) => d.code === 'AMENDMENT_LINK_NOT_RESOLVED' && d.documentId === 'b2ba1')).toBe(true);
  });

  it('a resolved amendment (provenanceStatus AMENDED) is not flagged as unresolved', () => {
    const b2ba = doc({ id: 'b2ba2', section: 'B2BA', provenanceStatus: 'AMENDED' });
    const result = reconcileGstr2b([b2ba], [bookLine({ invoiceNumber: b2ba.documentNumber! })], [], baseOptions);
    expect(result.diagnostics.some((d) => d.code === 'AMENDMENT_LINK_NOT_RESOLVED')).toBe(false);
  });

  it('excludes a SUPERSEDED document from matching and totals entirely', () => {
    const superseded = doc({ id: 'orig1', provenanceStatus: 'SUPERSEDED', taxableValue: 999999 });
    const result = reconcileGstr2b([superseded], [bookLine()], [], baseOptions);
    expect(result.matches.some((m) => m.twoBDocumentId === 'orig1')).toBe(false);
    expect(result.twoBTotals.taxableValue).toBe(0);
    // The book line it would otherwise have matched is now unclaimed -> BOOK_MISSING.
    expect(result.matches.some((m) => m.status === 'BOOK_MISSING' && m.bookReferenceId === 'grn1')).toBe(true);
  });

  it('a branch-restricted caller excludes out-of-scope book lines and emits PARTIAL_BRANCH_SCOPE', () => {
    const result = reconcileGstr2b([doc()], [bookLine({ branchId: 'other-branch' })], [], {
      ...baseOptions, branchAccess: { allBranches: false, branchIds: ['branch1'] },
    });
    expect(result.diagnostics.some((d) => d.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
    // The book line lives in a branch the caller cannot see, so it is invisible -> 2B doc reports missing.
    expect(result.matches.find((m) => m.twoBDocumentId === 'doc1')?.status).toBe('TWO_B_MISSING');
  });

  it('always emits the standing statutory-posture diagnostics', () => {
    const result = reconcileGstr2b([], [], [], baseOptions);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('SOURCE_FIELD_MAPPING_UNVERIFIED');
    expect(codes).toContain('GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY');
  });

  it('never claims the same book GRN for two different 2B documents', () => {
    const d1 = doc({ id: 'd1' });
    const d2 = doc({ id: 'd2' });
    const result = reconcileGstr2b([d1, d2], [bookLine()], [], baseOptions);
    const claimed = result.matches.filter((m) => m.bookReferenceId === 'grn1' && m.status !== 'TWO_B_MISSING');
    expect(claimed).toHaveLength(1);
  });

  // G2g-7e correction: GSTR-2B's own Table 3 (ITC Available) vs. Table 4 (ITC Not Available)
  // distinction must survive into the reconciliation output as a field independent of matchStatus
  // — a document can be an identity/amount match and still be NOT_AVAILABLE for ITC.
  describe('twoBItcAvailability — independent of matchStatus', () => {
    it('EXACT_MATCH + AVAILABLE: matchStatus and availability are both reported, uncoupled', () => {
      const result = reconcileGstr2b([doc({ itcAvailability: 'AVAILABLE' })], [bookLine()], [], baseOptions);
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('EXACT_MATCH');
      expect(m?.twoBItcAvailability).toBe('AVAILABLE');
      expect(m?.twoBIneligibilityReason).toBeNull();
    });

    it('EXACT_MATCH + NOT_AVAILABLE: a confirmed book/2B match must NOT be silently treated as available ITC', () => {
      const result = reconcileGstr2b(
        [doc({ itcAvailability: 'NOT_AVAILABLE', ineligibilityReason: 'Supplier under composition scheme' })],
        [bookLine()], [], baseOptions,
      );
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('EXACT_MATCH');
      expect(m?.twoBItcAvailability).toBe('NOT_AVAILABLE');
      expect(m?.twoBIneligibilityReason).toBe('Supplier under composition scheme');
    });

    it('MATCHED_WITH_NORMALIZATION + NOT_AVAILABLE: the identity-normalization tier does not affect availability', () => {
      const result = reconcileGstr2b(
        [doc({ documentNumber: 'INV-001', itcAvailability: 'NOT_AVAILABLE', ineligibilityReason: 'Blocked credit - Section 17(5)' })],
        [bookLine({ invoiceNumber: 'INV/001' })], [], baseOptions,
      );
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('MATCHED_WITH_NORMALIZATION');
      expect(m?.twoBItcAvailability).toBe('NOT_AVAILABLE');
      expect(m?.twoBIneligibilityReason).toBe('Blocked credit - Section 17(5)');
    });

    it('POSSIBLE_MATCH + UNKNOWN: a low-confidence match with no source availability flag is UNKNOWN, not AVAILABLE', () => {
      const result = reconcileGstr2b(
        [doc({ documentNumber: 'TOTALLY-DIFFERENT-99', itcAvailability: null })],
        [bookLine({ invoiceNumber: 'INV/001' })], [], baseOptions,
      );
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('POSSIBLE_MATCH');
      expect(m?.twoBItcAvailability).toBe('UNKNOWN');
      expect(m?.twoBIneligibilityReason).toBeNull();
    });

    it('missing/unknown source availability never silently becomes AVAILABLE, even on an EXACT_MATCH', () => {
      const result = reconcileGstr2b([doc({ itcAvailability: null })], [bookLine()], [], baseOptions);
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('EXACT_MATCH');
      expect(m?.twoBItcAvailability).toBe('UNKNOWN');
      expect(m?.twoBItcAvailability).not.toBe('AVAILABLE');
    });

    it('a BOOK_MISSING match (no 2B document at all) reports UNKNOWN, never AVAILABLE', () => {
      const result = reconcileGstr2b([], [bookLine({ grnId: 'grn-orphan', invoiceNumber: 'NOTHING-IN-2B' })], [], baseOptions);
      const m = result.matches.find((x) => x.status === 'BOOK_MISSING' && x.bookReferenceId === 'grn-orphan');
      expect(m?.twoBItcAvailability).toBe('UNKNOWN');
      expect(m?.twoBIneligibilityReason).toBeNull();
    });

    it('twoBIneligibilityReason is dropped (null) when availability is AVAILABLE, never leaked from a stale field', () => {
      const result = reconcileGstr2b(
        [doc({ itcAvailability: 'AVAILABLE', ineligibilityReason: 'should not surface' })],
        [bookLine()], [], baseOptions,
      );
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.twoBItcAvailability).toBe('AVAILABLE');
      expect(m?.twoBIneligibilityReason).toBeNull();
    });

    it('does not change the frozen GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY diagnostic or any existing matchStatus semantics', () => {
      const result = reconcileGstr2b([doc({ itcAvailability: 'NOT_AVAILABLE' })], [bookLine()], [], baseOptions);
      expect(result.diagnostics.some((d) => d.code === 'GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY')).toBe(true);
      const m = result.matches.find((x) => x.twoBDocumentId === 'doc1');
      expect(m?.status).toBe('EXACT_MATCH');
    });
  });
});
