import { describe, it, expect } from 'vitest';
import { serializeGstr3bToGstnExport, GSTR3B_EXPORT_SCHEMA_VERSION } from './gstr3bGstnWire';
import type { Gstr3bReconciliationReport } from './gstr3bReconciliation.types';

// G2g-7g — pure serializer tests. Builds a hand-typed, fully-shaped `Gstr3bReconciliationReport`
// fixture (TypeScript enforces every field is present) rather than re-running the four frozen
// pure engines here — those engines' own correctness is already proven by their own frozen test
// suites (G2g-7b/7c/7d/7e) and by gstr3bReconciliationComposition.test.ts (G2g-7f). This file only
// proves gstr3bGstnWire.ts reshapes an already-correct report into the export DTO faithfully.

const money = (taxableValue = 0, igst = 0, cgst = 0, sgst = 0, cess = 0) => ({ taxableValue, igst, cgst, sgst, cess });
const ZERO = money();

function baseReport(overrides: Partial<Gstr3bReconciliationReport> = {}): Gstr3bReconciliationReport {
  const report: Gstr3bReconciliationReport = {
    meta: {
      companyId: 'co1', gstRegistrationId: 'reg1', gstin: '24AAAAA0000A1Z5', stateCode: '24', legalName: 'Acme Co',
      financialYear: '2026-27', taxPeriod: '092026', period: { from: new Date('2026-09-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
      isCompleteGstinScope: true, partialScopeReason: null,
    },
    filingStatus: { returnType: 'GSTR3B', status: 'NOT_STARTED', periodId: null, filedAt: null, lockedAt: null, note: 'none' },
    outwardLiability: {
      completeness: 'SUPPORTED',
      report: {
        meta: {
          companyId: 'co1', gstRegistrationId: 'reg1', sellerGstin: '24AAAAA0000A1Z5', sellerStateCode: '24',
          financialYear: '2026-27', taxPeriod: '092026', period: { from: new Date('2026-09-01'), to: new Date('2026-09-30') },
          isCompleteGstinScope: true, partialScopeReason: null,
          otherChargesBreakdown: { invoiceCountWithOtherCharges: 0, totalOtherChargesTaxable: 0 },
          sourceCounts: { invoicesConsidered: 1, invoicesExcludedByScope: 0, creditNotesConsidered: 0, creditNotesExcludedByScope: 0, salesDebitNotesConsidered: 0, salesDebitNotesExcludedByScope: 0, salesReturnsConsidered: 0, salesReturnsExcludedByScope: 0 },
        },
        table31: {
          table31a: { status: 'IMPLEMENTED', ...money(100000, 0, 1500, 1500, 0), grossTaxableValue: 100000, grossIgst: 0, grossCgst: 1500, grossSgst: 1500, grossCess: 0, creditNoteReductions: ZERO, salesReturnReductions: ZERO, salesDebitNoteAdditions: ZERO, documentCounts: { activeInvoices: 1, salesDebitNotes: 0, pathBStandaloneCreditNotes: 0, pathACreditNotes: 0, unwrappedSalesReturns: 0, deduplicatedSalesReturns: 0, voidInvoices: 0, cancelledCreditNotes: 0, cancelledSalesDebitNotes: 0 } },
          table31b: { status: 'UNSUPPORTED', reason: 'Zero-rated supplies are not modeled in this codebase.', ...ZERO },
          table31c: { status: 'UNSUPPORTED', reason: 'Nil-rated/exempt/non-GST classification is not modeled in this codebase.', ...ZERO },
          table31d: { status: 'UNSUPPORTED', reason: 'Outward-engine placeholder — superseded by the RCM engine\'s own table3_1d.', ...ZERO },
          table31e: { status: 'UNSUPPORTED', reason: 'Non-GST outward supplies are not modeled in this codebase.', ...ZERO },
          table311: { status: 'UNSUPPORTED', reason: 'n/a', ...ZERO },
        },
        table32: {
          unregisteredPersons: { status: 'IMPLEMENTED', totalTaxableValue: 5000, totalIgst: 150, supplies: [{ placeOfSupply: '27', stateName: 'Maharashtra', taxableValue: 5000, igst: 150, documentCounts: { invoices: 1, salesDebitNotes: 0, creditNotes: 0, unwrappedSalesReturns: 0 } }] },
          compositionPersons: { status: 'UNSUPPORTED', reason: 'Composition-person supply classification is not modeled.', totalTaxableValue: 0, totalIgst: 0, supplies: [] },
          uinHolders: { status: 'UNSUPPORTED', reason: 'UIN-holder supply classification is not modeled.', totalTaxableValue: 0, totalIgst: 0, supplies: [] },
        },
        diagnostics: [],
      },
    },
    reverseCharge: {
      completeness: 'PARTIALLY_SUPPORTED',
      report: {
        meta: { companyId: 'co1', gstRegistrationId: 'reg1', buyerGstin: '24AAAAA0000A1Z5', buyerStateCode: '24', financialYear: '2026-27', taxPeriod: '092026', period: { from: new Date('2026-09-01'), to: new Date('2026-09-30') }, isCompleteGstinScope: true, partialScopeReason: null, calculationVersion: 'v1', supplierCount: 1, sourceCounts: { liabilityLinesConsidered: 1, liabilityLinesExcludedByScope: 0 } },
        table3_1d: { status: 'IMPLEMENTED', recognized: money(20000, 0, 600, 600, 0), unresolved: ZERO, documentCount: 1, lineCount: 1 },
        table4A3: { status: 'IMPLEMENTED', eligible: ZERO, unresolved: money(20000, 0, 600, 600, 0), ineligible: ZERO, documentCount: 1, lineCount: 1 },
        selfInvoice: { required: 0, notRequired: 1, notDetermined: 0 },
        paymentVoucher: { required: 0, notRequired: 1, notDetermined: 0 },
        diagnostics: [],
      },
    },
    inputTaxCredit: {
      completeness: 'PARTIALLY_SUPPORTED',
      book: {
        meta: { companyId: 'co1', gstRegistrationId: 'reg1', buyerGstin: '24AAAAA0000A1Z5', buyerStateCode: '24', financialYear: '2026-27', taxPeriod: '092026', period: { from: new Date('2026-09-01'), to: new Date('2026-09-30') }, isCompleteGstinScope: true, partialScopeReason: null, calculationVersion: 'v1', supplierCount: 1, sourceCounts: { grnLinesConsidered: 1, grnLinesExcludedByScope: 0, purchaseReturnLinesConsidered: 0, purchaseReturnLinesExcludedByScope: 0, standaloneDebitNoteLinesConsidered: 0, standaloneDebitNoteLinesExcludedByScope: 0 } },
        table4A5: { status: 'IMPLEMENTED', eligible: money(100000, 0, 1500, 1500, 0), unresolved: ZERO, ineligible: ZERO, documentCount: 1, lineCount: 1 },
        eligibilityMatrix: [],
        diagnostics: [],
      },
      presentation: {
        table4A: {
          importOfGoods: { status: 'NOT_SUPPORTED', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'IMPORT_ITC_NOT_SUPPORTED', reason: 'No Bill-of-Entry model exists.' },
          importOfServices: { status: 'NOT_SUPPORTED', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'IMPORT_ITC_NOT_SUPPORTED', reason: 'No import-of-services model exists.' },
          inwardSuppliesLiableToRcm: { status: 'PARTIALLY_SUPPORTED', source: 'G2G-7D_RCM_ENGINE', eligible: ZERO, unresolved: money(20000, 0, 600, 600, 0), ineligible: ZERO, documentCount: 1, lineCount: 1, note: 'RCM passthrough.' },
          inwardSuppliesFromIsd: { status: 'NOT_SUPPORTED', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'ISD_ITC_NOT_SUPPORTED', reason: 'No ISD model exists.' },
          allOtherItc: { status: 'PARTIALLY_SUPPORTED', source: 'G2G-7C_ITC_ENGINE', eligible: money(100000, 0, 1500, 1500, 0), unresolved: ZERO, ineligible: ZERO, documentCount: 1, lineCount: 1, note: 'ITC passthrough.' },
        },
        table4B: {
          rule42And43: { status: 'NOT_DETERMINABLE', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'RULE_42_43_NOT_DETERMINABLE', reason: 'No exempt-supply attribution data.' },
          others: { status: 'NOT_DETERMINABLE', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'SECTION_17_5_NOT_DETERMINABLE', reason: 'No Section 17(5) category data beyond INELIGIBLE buckets.' },
        },
        table4C: { status: 'PARTIALLY_SUPPORTED', netItcAvailable: money(100000, 0, 1500, 1500, 0), componentsIncluded: ['4(A)(3) RCM eligible', '4(A)(5) all-other eligible'], componentsExcluded: ['4(A)(1) import of goods', '4(A)(2) import of services'], note: 'Partial sum.' },
        table4D: { itcReclaimed: { status: 'NOT_DETERMINABLE', taxableValue: null, igst: null, cgst: null, sgst: null, cess: null, diagnosticCode: 'ITC_RECLAIM_NOT_DETERMINABLE', reason: 'No reclaim lifecycle tracked.' }, ineligibleItc: { status: 'PARTIALLY_SUPPORTED', taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, note: 'Narrower than full 17(5).' } },
      },
      twoBDerived: { bookItc: money(100000, 0, 1500, 1500, 0), bookItcUnresolved: ZERO, bookItcIneligible: ZERO, twoBItcMatched: ZERO, twoBItcAvailable: ZERO, twoBItcNotAvailable: ZERO, twoBItcUnknownAvailability: ZERO },
    },
    twoBReconciliation: {
      statementAvailable: false,
      report: { meta: { companyId: 'co1', gstRegistrationId: 'reg1', financialYear: '2026-27', taxPeriod: '092026', statementId: null, statementVersion: null, statementImportedAt: null, amountToleranceRupees: 1 }, summary: { totalTwoBDocuments: 0, totalBookDocuments: 1, exactMatch: 0, matchedWithNormalization: 0, possibleMatch: 0, bookMissing: 1, twoBMissing: 0, amountMismatch: 0, taxMismatch: 0, rcmMismatch: 0, notSupported: 0, unresolved: 0 }, rcmSummary: { matched: 0, bookMissing: 0, twoBMissing: 0, mismatched: 0 }, matches: [], twoBTotals: ZERO, bookTotals: ZERO, diagnostics: [] },
      matrix: [],
    },
    summary: {
      bookPosition: { outputTaxLiability: 3000, rcmLiabilityRecognized: 1200, bookItcEligible: 3000, estimatedNetPosition: 1200 },
      statutoryReportingPosition: { status: 'NOT_DETERMINABLE', reason: 'Omits imports, ISD, Rule 42/43, full 16(4)/17(5)/180-day, GSTR-2B finality.' },
    },
    diagnostics: [{ source: 'COMPOSITION', code: 'FILING_PERIOD_NOT_STARTED', reason: 'no period yet' }],
  };
  return { ...report, ...overrides };
}

describe('G2g-7g: serializeGstr3bToGstnExport (pure)', () => {
  it('carries metadata verbatim, including the export-phase schema version', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.metadata.gstin).toBe('24AAAAA0000A1Z5');
    expect(dto.metadata.gstRegistrationId).toBe('reg1');
    expect(dto.metadata.financialYear).toBe('2026-27');
    expect(dto.metadata.taxPeriod).toBe('092026');
    expect(dto.metadata.schemaVersion).toBe(GSTR3B_EXPORT_SCHEMA_VERSION);
    expect(dto.metadata.isCompleteGstinScope).toBe(true);
  });

  it('3.1(a): SUPPORTED when outward completeness is SUPPORTED, with real amounts', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table31.outwardTaxableOther.status).toBe('SUPPORTED');
    expect(dto.table31.outwardTaxableOther.amounts).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
  });

  it('3.1(a): PARTIALLY_SUPPORTED when outward completeness is PARTIALLY_SUPPORTED, amounts still present (never null)', () => {
    const report = baseReport({ outwardLiability: { completeness: 'PARTIALLY_SUPPORTED', report: baseReport().outwardLiability.report } });
    const dto = serializeGstr3bToGstnExport(report);
    expect(dto.table31.outwardTaxableOther.status).toBe('PARTIALLY_SUPPORTED');
    expect(dto.table31.outwardTaxableOther.amounts).not.toBeNull();
  });

  it('3.1(b)/(c)/(e): always NOT_SUPPORTED with amounts null and the engine\'s own reason carried as note', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table31.outwardZeroRated).toEqual({ status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: 'TABLE31_SECTION_UNSUPPORTED', note: 'Zero-rated supplies are not modeled in this codebase.' });
    expect(dto.table31.outwardNilExemptNonGst.status).toBe('NOT_SUPPORTED');
    expect(dto.table31.nonGstOutward.status).toBe('NOT_SUPPORTED');
  });

  it('3.1(d): sourced from the RCM engine\'s table3_1d, not the outward engine\'s own always-unsupported stub', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    // recognized = 20000/0/600/600/0 from the RCM fixture; if this ever reads the outward stub
    // instead it would be null/NOT_SUPPORTED.
    expect(dto.table31.inwardReverseCharge.amounts).toEqual({ taxableValue: 20000, igst: 0, cgst: 600, sgst: 600, cess: 0 });
  });

  it('3.1(d): SUPPORTED with no unresolved RCM lines; PARTIALLY_SUPPORTED and notes the excluded amount when unresolved lines exist', () => {
    const report = baseReport();
    expect(serializeGstr3bToGstnExport(report).table31.inwardReverseCharge.status).toBe('SUPPORTED');

    const withUnresolved = baseReport();
    withUnresolved.reverseCharge.report.table3_1d.unresolved = money(5000, 0, 150, 150, 0);
    const dto = serializeGstr3bToGstnExport(withUnresolved);
    expect(dto.table31.inwardReverseCharge.status).toBe('PARTIALLY_SUPPORTED');
    expect(dto.table31.inwardReverseCharge.note).toContain('RCM_UNRESOLVED');
  });

  it('3.2: unregistered-person rows pass through; composition/UIN buckets are NOT_SUPPORTED with amounts null', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table32.unregisteredPersons.status).toBe('SUPPORTED');
    expect(dto.table32.unregisteredPersons.rows).toEqual([{ placeOfSupply: '27', stateName: 'Maharashtra', taxableValue: 5000, igst: 150 }]);
    expect(dto.table32.compositionPersons).toEqual({ status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: 'TABLE32_COMPOSITION_UNSUPPORTED', note: 'Composition-person supply classification is not modeled.' });
    expect(dto.table32.uinHolders.amounts).toBeNull();
  });

  it('4(A)(1)/(2)/(4): unsupported lines pass through verbatim (status/diagnosticCode/note), amounts always null', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table4.table4A.importOfGoods).toEqual({ status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: 'IMPORT_ITC_NOT_SUPPORTED', note: 'No Bill-of-Entry model exists.' });
    expect(dto.table4.table4A.importOfServices.diagnosticCode).toBe('IMPORT_ITC_NOT_SUPPORTED');
    expect(dto.table4.table4A.isd.diagnosticCode).toBe('ISD_ITC_NOT_SUPPORTED');
  });

  it('4(A)(3)/(5): never collapse eligible/unresolved/ineligible into one number', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table4.table4A.inwardReverseCharge.eligible).toEqual(ZERO);
    expect(dto.table4.table4A.inwardReverseCharge.unresolved).toEqual({ taxableValue: 20000, igst: 0, cgst: 600, sgst: 600, cess: 0 });
    expect(dto.table4.table4A.allOtherItc.eligible).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
    expect(dto.table4.table4A.allOtherItc.status).toBe('PARTIALLY_SUPPORTED');
  });

  it('4(B): both NOT_DETERMINABLE with amounts null, verbatim diagnostic codes', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table4.table4B.rule42And43).toEqual({ status: 'NOT_DETERMINABLE', amounts: null, diagnosticCode: 'RULE_42_43_NOT_DETERMINABLE', note: 'No exempt-supply attribution data.' });
    expect(dto.table4.table4B.others.diagnosticCode).toBe('SECTION_17_5_NOT_DETERMINABLE');
  });

  it('4(C): PARTIALLY_SUPPORTED net figure with components lists carried verbatim', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table4.table4C.status).toBe('PARTIALLY_SUPPORTED');
    expect(dto.table4.table4C.netItcAvailable).toEqual({ taxableValue: 100000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 });
    expect(dto.table4.table4C.componentsIncluded).toEqual(['4(A)(3) RCM eligible', '4(A)(5) all-other eligible']);
  });

  it('4(D): reclaim is NOT_DETERMINABLE/null; ineligible carries real (possibly zero) amounts', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.table4.table4D.itcReclaimed.amounts).toBeNull();
    expect(dto.table4.table4D.ineligibleItc.status).toBe('PARTIALLY_SUPPORTED');
    expect(dto.table4.table4D.ineligibleItc.amounts).toEqual(ZERO);
  });

  it('net position: book figures mapped, netAmount = estimatedNetPosition, statutory position always NOT_DETERMINABLE', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.netPosition.bookPosition).toEqual({ outputTaxLiability: 3000, rcmLiabilityRecognized: 1200, bookItcEligible: 3000, netAmount: 1200 });
    expect(dto.netPosition.statutoryReportingPosition.status).toBe('NOT_DETERMINABLE');
    expect(dto.netPosition.statutoryReportingPosition.reason).toContain('imports');
  });

  it('never exposes a field literally named finalTaxLiability', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(JSON.stringify(dto)).not.toContain('finalTaxLiability');
  });

  it('diagnostics pass through verbatim, with undefined documentId/documentNumber coerced to null', () => {
    const dto = serializeGstr3bToGstnExport(baseReport());
    expect(dto.diagnostics).toEqual([{ source: 'COMPOSITION', code: 'FILING_PERIOD_NOT_STARTED', documentId: null, documentNumber: null, reason: 'no period yet' }]);
  });

  it('is deterministic: identical input always serializes to byte-identical JSON', () => {
    const a = JSON.stringify(serializeGstr3bToGstnExport(baseReport()));
    const b = JSON.stringify(serializeGstr3bToGstnExport(baseReport()));
    expect(a).toBe(b);
  });
});
