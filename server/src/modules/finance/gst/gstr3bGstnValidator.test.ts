import { describe, it, expect } from 'vitest';
import { validateGstr3bGstnExport } from './gstr3bGstnValidator';
import type { Gstr3bGstnExportDto, Gstr3bExportAmounts } from './gstr3bGstnWire.types';

// G2g-7g — pure validator tests. Builds a hand-typed, fully-resolved `Gstr3bGstnExportDto` fixture
// (deliberately with zero blockers) to prove `isFilingReady: true` IS achievable in this system for a
// clean period — then perturbs individual fields to prove each specific BLOCKING/WARNING/
// INFORMATIONAL rule fires independently. See gstr3bGstnValidator.ts's own header for why the
// permanent structural gaps (imports/ISD/4B/4D1/4C-partial) are WARNING, never BLOCKING.

const amounts = (taxableValue = 0, igst = 0, cgst = 0, sgst = 0, cess = 0): Gstr3bExportAmounts => ({ taxableValue, igst, cgst, sgst, cess });
const ZERO = amounts();

const unsupported = (code: string): { status: 'NOT_SUPPORTED'; amounts: null; diagnosticCode: string; note: string } => ({ status: 'NOT_SUPPORTED', amounts: null, diagnosticCode: code, note: `stub: ${code}` });
const notDeterminable = (code: string): { status: 'NOT_DETERMINABLE'; amounts: null; diagnosticCode: string; note: string } => ({ status: 'NOT_DETERMINABLE', amounts: null, diagnosticCode: code, note: `stub: ${code}` });

function resolvedDto(): Gstr3bGstnExportDto {
  return {
    metadata: {
      companyId: 'co1', gstRegistrationId: 'reg1', gstin: '24AAAAA0000A1Z5', legalName: 'Acme Co', stateCode: '24',
      financialYear: '2026-27', taxPeriod: '092026', periodFrom: new Date('2026-09-01'), periodTo: new Date('2026-09-30'),
      schemaVersion: 'g2g-7g-1', isCompleteGstinScope: true, partialScopeReason: null,
    },
    table31: {
      outwardTaxableOther: { status: 'SUPPORTED', amounts: amounts(100000, 0, 1500, 1500, 0), diagnosticCode: null, note: 'ok' },
      outwardZeroRated: unsupported('TABLE31_SECTION_UNSUPPORTED'),
      outwardNilExemptNonGst: unsupported('TABLE31_SECTION_UNSUPPORTED'),
      inwardReverseCharge: { status: 'SUPPORTED', amounts: amounts(20000, 0, 600, 600, 0), diagnosticCode: null, note: 'ok' },
      nonGstOutward: unsupported('TABLE31_SECTION_UNSUPPORTED'),
    },
    table32: {
      unregisteredPersons: { status: 'SUPPORTED', rows: [], totalTaxableValue: 0, totalIgst: 0 },
      compositionPersons: unsupported('TABLE32_COMPOSITION_UNSUPPORTED'),
      uinHolders: unsupported('TABLE32_UIN_UNSUPPORTED'),
    },
    table4: {
      table4A: {
        importOfGoods: unsupported('IMPORT_ITC_NOT_SUPPORTED'),
        importOfServices: unsupported('IMPORT_ITC_NOT_SUPPORTED'),
        inwardReverseCharge: { status: 'PARTIALLY_SUPPORTED', eligible: ZERO, unresolved: ZERO, ineligible: ZERO, note: 'ok' },
        isd: unsupported('ISD_ITC_NOT_SUPPORTED'),
        allOtherItc: { status: 'PARTIALLY_SUPPORTED', eligible: amounts(100000, 0, 1500, 1500, 0), unresolved: ZERO, ineligible: ZERO, note: 'ok' },
      },
      table4B: { rule42And43: notDeterminable('RULE_42_43_NOT_DETERMINABLE'), others: notDeterminable('SECTION_17_5_NOT_DETERMINABLE') },
      table4C: { status: 'PARTIALLY_SUPPORTED', netItcAvailable: amounts(100000, 0, 1500, 1500, 0), componentsIncluded: ['4(A)(3)', '4(A)(5)'], componentsExcluded: ['4(A)(1)', '4(A)(2)'], note: 'partial' },
      table4D: { itcReclaimed: notDeterminable('ITC_RECLAIM_NOT_DETERMINABLE'), ineligibleItc: { status: 'PARTIALLY_SUPPORTED', amounts: ZERO, diagnosticCode: null, note: 'narrower than full 17(5)' } },
    },
    netPosition: {
      bookPosition: { outputTaxLiability: 3000, rcmLiabilityRecognized: 1200, bookItcEligible: 3000, netAmount: 1200 },
      statutoryReportingPosition: { status: 'NOT_DETERMINABLE', reason: 'Omits imports/ISD/Rule 42-43/full 16(4)/17(5)/180-day/GSTR-2B finality.' },
    },
    diagnostics: [],
  };
}

describe('G2g-7g: validateGstr3bGstnExport (pure)', () => {
  it('a fully-resolved period IS filing-ready — zero blockers', () => {
    const result = validateGstr3bGstnExport(resolvedDto());
    expect(result.isFilingReady).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('even when filing-ready, the statutory-position caveat is ALWAYS present as informational', () => {
    const result = validateGstr3bGstnExport(resolvedDto());
    expect(result.informational.some((i) => i.code === 'STATUTORY_POSITION_NOT_DETERMINABLE')).toBe(true);
  });

  it('BLOCKING: missing GSTIN', () => {
    const dto = resolvedDto();
    dto.metadata.gstin = '';
    const result = validateGstr3bGstnExport(dto);
    expect(result.isFilingReady).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('MISSING_GSTIN');
  });

  it('BLOCKING: structurally invalid GSTIN', () => {
    const dto = resolvedDto();
    dto.metadata.gstin = 'not-a-gstin';
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('INVALID_GSTIN');
  });

  it('BLOCKING: malformed tax period', () => {
    const dto = resolvedDto();
    dto.metadata.taxPeriod = 'notaperiod';
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('MALFORMED_TAX_PERIOD');
  });

  it('BLOCKING: partial branch scope', () => {
    const dto = resolvedDto();
    dto.metadata.isCompleteGstinScope = false;
    dto.metadata.partialScopeReason = 'branch-restricted';
    const result = validateGstr3bGstnExport(dto);
    expect(result.isFilingReady).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('PARTIAL_BRANCH_SCOPE');
  });

  it('BLOCKING: unresolved book ITC (4(A)(5))', () => {
    const dto = resolvedDto();
    dto.table4.table4A.allOtherItc.unresolved = amounts(5000, 0, 75, 75, 0);
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('UNRESOLVED_BOOK_ITC');
  });

  it('BLOCKING: unresolved RCM ITC (4(A)(3))', () => {
    const dto = resolvedDto();
    dto.table4.table4A.inwardReverseCharge.unresolved = amounts(2000, 0, 60, 60, 0);
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('UNRESOLVED_RCM_ITC');
  });

  it('BLOCKING: unresolved RCM liability (3.1(d) PARTIALLY_SUPPORTED)', () => {
    const dto = resolvedDto();
    dto.table31.inwardReverseCharge.status = 'PARTIALLY_SUPPORTED';
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('UNRESOLVED_RCM_LIABILITY');
  });

  it('BLOCKING: non-finite amount (defensive)', () => {
    const dto = resolvedDto();
    dto.table31.outwardTaxableOther.amounts = amounts(NaN, 0, 0, 0, 0);
    const result = validateGstr3bGstnExport(dto);
    expect(result.blockers.map((b) => b.code)).toContain('NON_FINITE_VALUE');
  });

  it('WARNING, not BLOCKING: negative amount', () => {
    const dto = resolvedDto();
    dto.table31.outwardTaxableOther.amounts = amounts(-500, 0, -7.5, -7.5, 0);
    const result = validateGstr3bGstnExport(dto);
    expect(result.isFilingReady).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('NEGATIVE_AMOUNT');
  });

  it('WARNING, never BLOCKING: the permanent structural gaps (imports/ISD/4B/4D1/partial 4C/table 3.2)', () => {
    const result = validateGstr3bGstnExport(resolvedDto());
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('UNSUPPORTED_IMPORTS');
    expect(codes).toContain('UNSUPPORTED_ISD');
    expect(codes).toContain('INCOMPLETE_TABLE_4B');
    expect(codes).toContain('INCOMPLETE_TABLE_4D1');
    expect(codes).toContain('PARTIAL_TABLE_4C');
    expect(codes).toContain('INCOMPLETE_TABLE_32');
    expect(result.isFilingReady).toBe(true); // none of these ever block
  });

  it('is deterministic: identical input always validates to the identical result', () => {
    const a = JSON.stringify(validateGstr3bGstnExport(resolvedDto()));
    const b = JSON.stringify(validateGstr3bGstnExport(resolvedDto()));
    expect(a).toBe(b);
  });
});
