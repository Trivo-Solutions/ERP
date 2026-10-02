import { describe, it, expect } from 'vitest';
import { validateGstr1GstnExport, type Gstr1GstnValidationIssue } from './gstr1GstnValidator';
import type {
  Gstr1GstnExportDto,
  Gstr1GstnDiagnostic,
  Gstr1GstnCapabilityMetadata,
  Gstr1AatoVerificationState,
} from './gstr1GstnExport.types';

// ─────────────────────────────────────────────────────────────────────────────
// Pure, hand-built DTO fixtures — the validator consumes only `Gstr1GstnExportDto`, so these never
// go through the real frozen aggregators/adapter (that's gstr1GstnAdapter.test.ts's job). Every
// fixture here is a deliberately minimal, directly-constructed instance of the canonical type.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_GSTIN = '24AAAAA0000A1Z8';

const CAPABILITIES: Gstr1GstnCapabilityMetadata = {
  b2b: 'SUPPORTED', b2cl: 'SUPPORTED', b2cs: 'SUPPORTED', cdnr: 'SUPPORTED', cdnur: 'SUPPORTED',
  hsnB2b: 'SUPPORTED', hsnB2c: 'SUPPORTED', documentsIssued: 'SUPPORTED',
  exports: 'UNSUPPORTED', advances: 'UNSUPPORTED', nilExemptNonGst: 'UNSUPPORTED',
  amendments: 'UNSUPPORTED', ecommerce: 'UNSUPPORTED',
};

function aatoFigure(overrides: Partial<{ financialYear: string | null; amount: number | null; verificationState: Gstr1AatoVerificationState; source: string | null }> = {}) {
  return { financialYear: '2025-26', amount: 10_000_000, verificationState: 'VERIFIED' as Gstr1AatoVerificationState, source: 'MANUAL', ...overrides };
}

/** The realistic, always-present diagnostic set the real adapter emits on every single export
 *  (see gstr1GstnAdapter.ts's `adaptGstr1ToGstnExport` — the B2B invoiceType note, the amendments
 *  note, and one UNSUPPORTED_SECTION per unsupported capability) — included in the base fixture so
 *  the "golden path" test proves these everyday, unconditional diagnostics never themselves block a
 *  structurally clean export. */
function realisticDiagnostics(): Gstr1GstnDiagnostic[] {
  return [
    { code: 'MISSING_EXPORT_FIELD', message: 'invoiceType is always null in this phase.', section: 'B2B', field: 'invoiceType' },
    { code: 'AMENDMENT_DATA_UNAVAILABLE', message: 'No amendment dataset.', section: 'AMENDMENTS' },
    { code: 'UNSUPPORTED_SECTION', message: 'GSTR-1 section "exports" is not implemented in this phase.', section: 'exports' },
    { code: 'UNSUPPORTED_SECTION', message: 'GSTR-1 section "advances" is not implemented in this phase.', section: 'advances' },
    { code: 'UNSUPPORTED_SECTION', message: 'GSTR-1 section "nilExemptNonGst" is not implemented in this phase.', section: 'nilExemptNonGst' },
    { code: 'UNSUPPORTED_SECTION', message: 'GSTR-1 section "ecommerce" is not implemented in this phase.', section: 'ecommerce' },
  ];
}

function baseDto(overrides: Partial<Gstr1GstnExportDto> = {}): Gstr1GstnExportDto {
  return {
    metadata: {
      gstin: VALID_GSTIN,
      legalName: 'Test Jewellers Pvt Ltd',
      tradeName: null,
      period: {
        internalFrom: new Date('2026-09-01T00:00:00.000Z'),
        internalTo: new Date('2026-09-30T23:59:59.999Z'),
        filingPeriodMmYYYY: '092026',
      },
      schemaVersion: 'UNSPECIFIED',
      aato: { precedingFy: aatoFigure(), currentFy: aatoFigure({ financialYear: '2026-27' }) },
      isPartialBranchExport: false,
      capabilities: CAPABILITIES,
    },
    b2b: [{
      recipientGstin: VALID_GSTIN,
      invoiceNumber: 'INV-000001',
      invoiceDate: new Date('2026-09-15T00:00:00.000Z'),
      invoiceValue: 103_000,
      placeOfSupply: '27',
      reverseCharge: false,
      invoiceType: null,
      rateGroups: [{ rate: 3, taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 }],
      taxableValue: 100_000, cgst: 1500, sgst: 1500, igst: 0, cess: 0,
    }],
    b2cl: [],
    b2cs: [{
      ecommerceSupplyType: 'OE', supplyType: 'INTRA_STATE', placeOfSupply: '27', rate: 3,
      taxableValue: 5000, igst: 0, cgst: 75, sgst: 75, cess: 0,
    }],
    cdnr: [],
    cdnur: [],
    hsnB2b: [{
      hsnCode: '7113', description: 'Jewellery', uqc: 'GMS', quantity: 10, rate: 3,
      taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0, totalValue: null,
    }],
    hsnB2c: [{
      hsnCode: '7113', description: 'Jewellery', uqc: 'GMS', quantity: 1, rate: 3,
      taxableValue: 5000, igst: 0, cgst: 75, sgst: 75, cess: 0, totalValue: null,
    }],
    documentsIssued: [{
      documentCategory: 'INVOICES_FOR_OUTWARD_SUPPLY', sellerRegistrationId: 'reg_1', seriesPrefix: 'INV',
      financialYear: 2026, fromDocumentNumber: 'INV-000001', toDocumentNumber: 'INV-000010',
      fromSerial: 1, toSerial: 10, totalIssued: 10, cancelled: 0, netIssued: 10, filingEligible: true,
    }],
    traceability: {
      sourceRegistrationId: 'reg_1',
      b2bInvoiceIds: ['inv_1'], b2clInvoiceIds: [],
      cdnrCreditNoteIds: [], cdnurCreditNoteIds: [], cdnrDebitNoteIds: [], cdnurDebitNoteIds: [],
    },
    diagnostics: realisticDiagnostics(),
    ...overrides,
  };
}

function codes(issues: Gstr1GstnValidationIssue[]): string[] {
  return issues.map((i) => i.code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Golden path
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: golden path', () => {
  it('validates a realistic, structurally clean export as filing-grade (zero blockers) despite the everyday diagnostics every real export carries', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(result.blockers).toEqual([]);
    expect(result.isValid).toBe(true);
    // The 6 always-present diagnostics all resolve to warnings, not blockers, under this DTO shape.
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata — GSTIN, AATO, branch scope
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: metadata', () => {
  it('blocks a missing GSTIN', () => {
    const result = validateGstr1GstnExport(baseDto({ metadata: { ...baseDto().metadata, gstin: '' } }));
    expect(codes(result.blockers)).toContain('MISSING_GSTIN');
  });

  it('blocks a structurally invalid GSTIN', () => {
    const result = validateGstr1GstnExport(baseDto({ metadata: { ...baseDto().metadata, gstin: 'NOT_A_GSTIN' } }));
    expect(codes(result.blockers)).toContain('INVALID_GSTIN');
  });

  it('passes with a verified preceding-FY AATO', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('AATO_PRECEDING_FY_NOT_VERIFIED');
  });

  it('blocks a missing preceding-FY AATO', () => {
    const dto = baseDto();
    dto.metadata.aato.precedingFy = aatoFigure({ amount: null, verificationState: 'MISSING' });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('AATO_PRECEDING_FY_NOT_VERIFIED');
  });

  it('blocks an unverified preceding-FY AATO', () => {
    const dto = baseDto();
    dto.metadata.aato.precedingFy = aatoFigure({ verificationState: 'UNVERIFIED' });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('AATO_PRECEDING_FY_NOT_VERIFIED');
  });

  it('passes with a complete (non-partial-branch) registration scope', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('PARTIAL_BRANCH_SCOPE');
  });

  it('blocks a partial branch export scope', () => {
    const dto = baseDto();
    dto.metadata.isPartialBranchExport = true;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('PARTIAL_BRANCH_SCOPE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filing period
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: filing period', () => {
  it('passes a valid single-month MMYYYY period (exact reporting period)', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('FILING_PERIOD_MISMATCH');
    expect(codes(result.blockers)).not.toContain('MALFORMED_FILING_PERIOD');
  });

  it('blocks a malformed filing period', () => {
    const dto = baseDto();
    dto.metadata.period.filingPeriodMmYYYY = 'NOT-A-PERIOD';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('MALFORMED_FILING_PERIOD');
  });

  it('blocks a missing filing period', () => {
    const dto = baseDto();
    dto.metadata.period.filingPeriodMmYYYY = null;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('MISSING_FILING_PERIOD');
  });

  it('blocks a mismatched from/to vs the declared filing period', () => {
    const dto = baseDto();
    dto.metadata.period.filingPeriodMmYYYY = '032026'; // March, but internalTo is in September
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('FILING_PERIOD_MISMATCH');
  });

  it('accepts an arbitrary multi-month (quarterly) period anchored on its terminal month', () => {
    const dto = baseDto();
    dto.metadata.period.internalFrom = new Date('2026-01-01T00:00:00.000Z');
    dto.metadata.period.internalTo = new Date('2026-03-31T23:59:59.999Z');
    dto.metadata.period.filingPeriodMmYYYY = '032026';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).not.toContain('FILING_PERIOD_MISMATCH');
  });

  it('blocks an internally inconsistent from/to range (from after to)', () => {
    const dto = baseDto();
    dto.metadata.period.internalFrom = new Date('2026-09-30T00:00:00.000Z');
    dto.metadata.period.internalTo = new Date('2026-09-01T00:00:00.000Z');
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_FILING_PERIOD_RANGE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2CS — Table 7
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: B2CS', () => {
  it('passes a positive B2CS bucket', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('NEGATIVE_B2CS_BUCKET');
  });

  it('passes a zero B2CS bucket', () => {
    const dto = baseDto();
    dto.b2cs[0].taxableValue = 0;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).not.toContain('NEGATIVE_B2CS_BUCKET');
  });

  it('blocks a negative B2CS bucket', () => {
    const dto = baseDto();
    dto.b2cs[0].taxableValue = -100;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NEGATIVE_B2CS_BUCKET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Table 12 — HSN summary
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: Table 12', () => {
  it('passes a valid HSN code', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('MISSING_HSN');
    expect(codes(result.blockers)).not.toContain('INVALID_HSN');
  });

  it('blocks a short/below-mandate HSN code for B2B under a >5Cr preceding AATO', () => {
    const dto = baseDto();
    dto.metadata.aato.precedingFy = aatoFigure({ amount: 60_000_000 }); // > 5 Cr -> 6-digit mandate
    dto.hsnB2b[0].hsnCode = '7113'; // only 4 digits
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('HSN_DIGIT_LENGTH_BELOW_MANDATE');
  });

  it('blocks a non-numeric/invalid HSN code', () => {
    const dto = baseDto();
    dto.hsnB2b[0].hsnCode = 'ABCD';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_HSN');
  });

  it('passes a valid UQC', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('UNSUPPORTED_UQC');
  });

  it('blocks an unsupported UQC', () => {
    const dto = baseDto();
    dto.hsnB2b[0].uqc = 'NONE';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('UNSUPPORTED_UQC');
  });

  it('blocks a negative taxable value in a Table 12 bucket', () => {
    const dto = baseDto();
    dto.hsnB2b[0].taxableValue = -500;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NEGATIVE_TABLE12_BUCKET');
  });

  it('blocks a negative quantity in a Table 12 bucket', () => {
    const dto = baseDto();
    dto.hsnB2b[0].quantity = -5;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NEGATIVE_TABLE12_BUCKET');
  });

  it('does not mandate a minimum HSN digit length for B2C supplies at/under the ₹5 Cr preceding AATO', () => {
    const dto = baseDto();
    dto.metadata.aato.precedingFy = aatoFigure({ amount: 10_000_000 }); // <= 5 Cr
    dto.hsnB2c[0].hsnCode = '7113'; // 4 digits is fine for B2C at this tier
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).not.toContain('HSN_DIGIT_LENGTH_BELOW_MANDATE');
  });

  it('blocks a duplicate HSN/UQC/rate bucket within one reporting tab', () => {
    const dto = baseDto();
    dto.hsnB2b.push({ ...dto.hsnB2b[0] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('DUPLICATE_HSN_BUCKET');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Documents Issued — Table 13
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: documents issued', () => {
  it('passes a valid document number', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('INVALID_DOCUMENT_NUMBER');
  });

  it('blocks a document number over 16 characters', () => {
    const dto = baseDto();
    dto.documentsIssued[0].toDocumentNumber = 'INV-0000000000000999';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_DOCUMENT_NUMBER');
  });

  it('blocks a document number with unsupported characters', () => {
    const dto = baseDto();
    dto.documentsIssued[0].toDocumentNumber = 'INV#0001';
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_DOCUMENT_NUMBER');
  });

  it('blocks a document series the source aggregation marked not filing-eligible (duplicate serial)', () => {
    const dto = baseDto();
    dto.documentsIssued[0].filingEligible = false;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('DOCUMENT_SERIES_NOT_FILING_ELIGIBLE');
  });

  it('warns (never blocks) on an unexplained sequence gap between two ranges in the same series identity', () => {
    const dto = baseDto();
    dto.documentsIssued.push({
      ...dto.documentsIssued[0],
      fromDocumentNumber: 'INV-000015', toDocumentNumber: 'INV-000020',
      fromSerial: 15, toSerial: 20, totalIssued: 6, cancelled: 0, netIssued: 6,
    });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.warnings)).toContain('UNEXPLAINED_SEQUENCE_GAP');
    expect(codes(result.blockers)).not.toContain('UNEXPLAINED_SEQUENCE_GAP');
  });

  it('blocks overlapping/duplicate serial ranges within the same series identity', () => {
    const dto = baseDto();
    dto.documentsIssued.push({
      ...dto.documentsIssued[0],
      fromDocumentNumber: 'INV-000005', toDocumentNumber: 'INV-000012',
      fromSerial: 5, toSerial: 12, totalIssued: 8, cancelled: 0, netIssued: 8,
    });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('DUPLICATE_DOCUMENT_SERIAL');
  });

  it('blocks an inconsistent netIssued/totalIssued/cancelled triple (never a manufactured cancellation)', () => {
    const dto = baseDto();
    dto.documentsIssued[0].netIssued = 999;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INCONSISTENT_DOCUMENT_COUNTS');
  });

  it('blocks a negative document count', () => {
    const dto = baseDto();
    dto.documentsIssued[0].cancelled = -1;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NEGATIVE_DOCUMENT_COUNT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credit / Debit Notes — CDNR / CDNUR
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: credit/debit notes', () => {
  function cdnrNote(overrides: Partial<Gstr1GstnExportDto['cdnr'][number]> = {}): Gstr1GstnExportDto['cdnr'][number] {
    return {
      noteType: 'C', recipientGstin: VALID_GSTIN, noteNumber: 'CN-0001', noteDate: new Date('2026-09-10T00:00:00.000Z'),
      noteValue: 10_300, placeOfSupply: '27', rateGroups: [{ rate: 3, taxableValue: 10_000, igst: 0, cgst: 150, sgst: 150, cess: 0 }],
      taxableValue: 10_000, igst: 0, cgst: 150, sgst: 150, cess: 0,
      ...overrides,
    };
  }
  function cdnurNote(overrides: Partial<Gstr1GstnExportDto['cdnur'][number]> = {}): Gstr1GstnExportDto['cdnur'][number] {
    return {
      noteType: 'C', noteNumber: 'CN-0002', noteDate: new Date('2026-09-10T00:00:00.000Z'),
      noteValue: 10_300, placeOfSupply: '27', rateGroups: [{ rate: 3, taxableValue: 10_000, igst: 300, cgst: 0, sgst: 0, cess: 0 }],
      taxableValue: 10_000, igst: 300, cess: 0,
      ...overrides,
    };
  }

  it('accepts a registered credit note (noteType C) in CDNR', () => {
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ noteType: 'C' })];
    const result = validateGstr1GstnExport(dto);
    expect(result.blockers).toEqual([]);
  });

  it('accepts a registered sales debit note (noteType D) in CDNR', () => {
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ noteType: 'D', noteNumber: 'SDN-0001' })];
    const result = validateGstr1GstnExport(dto);
    expect(result.blockers).toEqual([]);
  });

  it('accepts a B2CL-origin unregistered credit note in CDNUR', () => {
    const dto = baseDto();
    dto.cdnur = [cdnurNote({ noteType: 'C' })];
    const result = validateGstr1GstnExport(dto);
    expect(result.blockers).toEqual([]);
  });

  it('accepts a B2CL-origin unregistered sales debit note in CDNUR', () => {
    const dto = baseDto();
    dto.cdnur = [cdnurNote({ noteType: 'D', noteNumber: 'SDN-0002' })];
    const result = validateGstr1GstnExport(dto);
    expect(result.blockers).toEqual([]);
  });

  it('accepts a B2CS-origin adjustment represented purely through the B2CS bucket (no CDNUR B2CS line)', () => {
    // Per gstr1CreditNoteAggregation.ts's own design, a B2CS-origin note nets directly into Table 7
    // upstream of this DTO — there is no "cdnur.b2cs" shape at all. This test documents that the
    // validator has nothing special to check here: a B2CS bucket on its own is already covered by
    // the B2CS checks above, and CDNUR carries no B2CS-origin notes by construction.
    const dto = baseDto();
    const result = validateGstr1GstnExport(dto);
    expect(result.blockers).toEqual([]);
  });

  it('never treats a sales debit note as a procurement DebitNote (structurally impossible on this type)', () => {
    // Gstr1GstnCdnrNote/Gstr1GstnCdnurNote carry no field that could identify a procurement
    // DebitNote at all — this is an inherited guarantee from the frozen adapter's own input
    // contract (see gstr1GstnAdapter.ts's header), not something re-derivable from the DTO. This
    // test only confirms an ordinary 'D' note validates cleanly, consistent with that guarantee.
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ noteType: 'D' })];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).not.toContain('INVALID_NOTE_TYPE');
  });

  it('blocks a CDNR note missing its recipient GSTIN', () => {
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ recipientGstin: '' })];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('MISSING_CDNR_RECIPIENT_GSTIN');
  });

  it('blocks a CDNR note with a malformed recipient GSTIN', () => {
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ recipientGstin: 'NOT_A_GSTIN' })];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_CDNR_RECIPIENT_GSTIN');
  });

  it('blocks an unrecognized note type on a CDNR/CDNUR entry', () => {
    const dto = baseDto();
    dto.cdnr = [cdnrNote({ noteType: 'X' as unknown as 'C' })];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_NOTE_TYPE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unsupported capabilities — relevance determination
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: unsupported capabilities', () => {
  it('treats an unsupported export section as non-blocking when no export records exist', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('UNSUPPORTED_SECTION');
    expect(codes(result.warnings)).toContain('UNSUPPORTED_SECTION');
  });

  it('blocks an unsupported export section when the DTO carries actual export-type evidence', () => {
    const dto = baseDto();
    dto.b2b[0].invoiceType = 'SEWP'; // SEZ-with-payment — an export-adjacent invoice type
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('UNSUPPORTED_SECTION');
  });

  it('treats unsupported amendments as non-blocking when no amendment evidence exists', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.blockers)).not.toContain('AMENDMENT_DATA_UNAVAILABLE');
    expect(codes(result.warnings)).toContain('AMENDMENT_DATA_UNAVAILABLE');
  });

  it('treats unsupported ecommerce as non-blocking (Gstr1GstnB2csEcommerceType has no evidence channel — it is the single literal \'OE\', not a real union)', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.warnings)).toContain('UNSUPPORTED_SECTION');
    expect(codes(result.blockers)).not.toContain('UNSUPPORTED_SECTION');
  });

  it('treats unsupported advances as non-blocking (no DTO-native evidence channel exists)', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.warnings)).toContain('UNSUPPORTED_SECTION');
    expect(codes(result.blockers)).not.toContain('UNSUPPORTED_SECTION');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adapter diagnostic severity mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: adapter diagnostic severity mapping', () => {
  it('maps INVALID_MAPPING to a blocker', () => {
    const dto = baseDto({ diagnostics: [{ code: 'INVALID_MAPPING', message: 'bad mapping', section: 'TABLE_13' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('INVALID_MAPPING');
  });

  it('maps a per-document MISSING_EXPORT_FIELD (with a documentNumber) to a blocker', () => {
    const dto = baseDto({ diagnostics: [{ code: 'MISSING_EXPORT_FIELD', message: 'no invoice date', section: 'B2B', field: 'invoiceDate', documentNumber: 'INV-0001' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('MISSING_EXPORT_FIELD');
  });

  it('maps a phase-wide MISSING_EXPORT_FIELD (no documentNumber) to a warning', () => {
    const dto = baseDto({ diagnostics: [{ code: 'MISSING_EXPORT_FIELD', message: 'invoiceType always null', section: 'B2B', field: 'invoiceType' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).not.toContain('MISSING_EXPORT_FIELD');
    expect(codes(result.warnings)).toContain('MISSING_EXPORT_FIELD');
  });

  it('maps AATO_NOT_VERIFIED (the adapter\'s own current-FY diagnostic) to a blocker', () => {
    const dto = baseDto({ diagnostics: [{ code: 'AATO_NOT_VERIFIED', message: 'current FY AATO unverified', section: 'AATO' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('AATO_NOT_VERIFIED');
  });

  it('maps PARTIAL_BRANCH_SCOPE to no duplicate blocker (already surfaced from metadata directly)', () => {
    const dto = baseDto();
    dto.metadata.isPartialBranchExport = true;
    dto.diagnostics = [...dto.diagnostics, { code: 'PARTIAL_BRANCH_SCOPE', message: 'partial', section: 'SCOPE' }];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers).filter((c) => c === 'PARTIAL_BRANCH_SCOPE')).toHaveLength(1);
  });

  it('maps UNSUPPORTED_SECTION to a warning when irrelevant', () => {
    const dto = baseDto({ diagnostics: [{ code: 'UNSUPPORTED_SECTION', message: 'advances unsupported', section: 'advances' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.warnings)).toContain('UNSUPPORTED_SECTION');
    expect(codes(result.blockers)).not.toContain('UNSUPPORTED_SECTION');
  });

  it('maps AMENDMENT_DATA_UNAVAILABLE to a warning', () => {
    const dto = baseDto({ diagnostics: [{ code: 'AMENDMENT_DATA_UNAVAILABLE', message: 'no amendment dataset', section: 'AMENDMENTS' }] });
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.warnings)).toContain('AMENDMENT_DATA_UNAVAILABLE');
    expect(codes(result.blockers)).not.toContain('AMENDMENT_DATA_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Numeric validation
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: numeric validation', () => {
  it('blocks a non-finite (NaN) monetary value', () => {
    const dto = baseDto();
    dto.b2b[0].taxableValue = NaN;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NON_FINITE_VALUE');
  });

  it('blocks an Infinity monetary value', () => {
    const dto = baseDto();
    dto.hsnB2b[0].taxableValue = Infinity;
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.blockers)).toContain('NON_FINITE_VALUE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Traceability
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: traceability', () => {
  it('passes complete traceability', () => {
    const result = validateGstr1GstnExport(baseDto());
    expect(codes(result.warnings)).not.toContain('PARTIAL_TRACEABILITY');
  });

  it('warns (never blocks) on incomplete internal traceability', () => {
    const dto = baseDto();
    dto.traceability.b2bInvoiceIds = [];
    const result = validateGstr1GstnExport(dto);
    expect(codes(result.warnings)).toContain('PARTIAL_TRACEABILITY');
    expect(codes(result.blockers)).not.toContain('PARTIAL_TRACEABILITY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnValidator: immutability', () => {
  it('never mutates the input DTO', () => {
    const dto = baseDto();
    const snapshot = JSON.parse(JSON.stringify(dto));
    validateGstr1GstnExport(dto);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(snapshot);
  });
});
