import { describe, it, expect } from 'vitest';
import {
  serializeGstr1ToGstnJson,
  Gstr1GstnSerializationError,
  type Gstr1GstnSerializationErrorCode,
} from './gstr1GstnSerializer';
import { GSTR1_GSTN_WIRE_HASH_PLACEHOLDER } from './gstr1GstnWire.types';
import type {
  Gstr1GstnExportDto,
  Gstr1GstnCapabilityMetadata,
  Gstr1GstnB2bInvoice,
  Gstr1GstnB2clInvoice,
  Gstr1GstnB2csRecord,
  Gstr1GstnCdnrNote,
  Gstr1GstnCdnurNote,
  Gstr1GstnHsnSummaryRow,
  Gstr1GstnDocumentSeries,
  Gstr1AatoVerificationState,
} from './gstr1GstnExport.types';

// ─────────────────────────────────────────────────────────────────────────────
// Pure, hand-built DTO fixtures — the serializer consumes only `Gstr1GstnExportDto`, exactly like
// gstr1GstnValidator.test.ts's own fixtures; this never goes through the real frozen aggregators
// (that's gstr1GstnAdapter.test.ts's job). Unlike the validator's fixtures, every tax-bearing document
// here is kept internally CONSISTENT (seller state vs. place of supply vs. which of cgst/sgst/igst is
// non-zero) — the serializer actively derives which wire key set to emit from that relationship, so an
// inconsistent fixture would test nothing meaningful.
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_GSTIN = '24AAAAA0000A1Z8'; // Gujarat (state code 24) — checksum-valid.
const GUJARAT = '24';
const MAHARASHTRA = '27';
const RECIPIENT_GSTIN = '27BBBBB1111B1Z1';

const CAPABILITIES: Gstr1GstnCapabilityMetadata = {
  b2b: 'SUPPORTED', b2cl: 'SUPPORTED', b2cs: 'SUPPORTED', cdnr: 'SUPPORTED', cdnur: 'SUPPORTED',
  hsnB2b: 'SUPPORTED', hsnB2c: 'SUPPORTED', documentsIssued: 'SUPPORTED',
  exports: 'UNSUPPORTED', advances: 'UNSUPPORTED', nilExemptNonGst: 'UNSUPPORTED',
  amendments: 'UNSUPPORTED', ecommerce: 'UNSUPPORTED',
};

function aatoFigure(overrides: Partial<{ financialYear: string | null; amount: number | null; verificationState: Gstr1AatoVerificationState; source: string | null }> = {}) {
  return { financialYear: '2025-26', amount: null, verificationState: 'MISSING' as Gstr1AatoVerificationState, source: null, ...overrides };
}

function baseDto(overrides: Partial<Gstr1GstnExportDto> = {}): Gstr1GstnExportDto {
  return {
    metadata: {
      gstin: COMPANY_GSTIN,
      legalName: 'Test Jewellers Pvt Ltd',
      tradeName: null,
      period: {
        internalFrom: new Date('2026-09-01T00:00:00.000Z'),
        internalTo: new Date('2026-09-30T23:59:59.999Z'),
        filingPeriodMmYYYY: '092026',
      },
      schemaVersion: 'GST3.2.4',
      aato: { precedingFy: aatoFigure(), currentFy: aatoFigure() },
      isPartialBranchExport: false,
      capabilities: CAPABILITIES,
    },
    b2b: [], b2cl: [], b2cs: [], cdnr: [], cdnur: [], hsnB2b: [], hsnB2c: [], documentsIssued: [],
    traceability: {
      sourceRegistrationId: 'reg_1',
      b2bInvoiceIds: [], b2clInvoiceIds: [], cdnrCreditNoteIds: [], cdnurCreditNoteIds: [],
      cdnrDebitNoteIds: [], cdnurDebitNoteIds: [],
    },
    diagnostics: [],
    ...overrides,
  };
}

function b2bInvoice(overrides: Partial<Gstr1GstnB2bInvoice> = {}): Gstr1GstnB2bInvoice {
  return {
    recipientGstin: RECIPIENT_GSTIN,
    invoiceNumber: 'INV-000001',
    invoiceDate: new Date('2026-09-15T00:00:00.000Z'),
    invoiceValue: 103_000,
    placeOfSupply: GUJARAT,
    reverseCharge: false,
    invoiceType: null,
    rateGroups: [{ rate: 3, taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 }],
    taxableValue: 100_000, cgst: 1500, sgst: 1500, igst: 0, cess: 0,
    ...overrides,
  };
}

function b2clInvoice(overrides: Partial<Gstr1GstnB2clInvoice> = {}): Gstr1GstnB2clInvoice {
  return {
    placeOfSupply: MAHARASHTRA,
    invoiceNumber: 'INV-000002',
    invoiceDate: new Date('2026-09-16T00:00:00.000Z'),
    invoiceValue: 206_000,
    rateGroups: [{ rate: 3, taxableValue: 200_000, igst: 6000, cgst: 0, sgst: 0, cess: 0 }],
    taxableValue: 200_000, igst: 6000, cess: 0,
    ...overrides,
  };
}

function b2csRecord(overrides: Partial<Gstr1GstnB2csRecord> = {}): Gstr1GstnB2csRecord {
  return {
    ecommerceSupplyType: 'OE', supplyType: 'INTRA_STATE', placeOfSupply: GUJARAT, rate: 3,
    taxableValue: 5000, igst: 0, cgst: 75, sgst: 75, cess: 0,
    ...overrides,
  };
}

function cdnrNote(overrides: Partial<Gstr1GstnCdnrNote> = {}): Gstr1GstnCdnrNote {
  return {
    noteType: 'C',
    recipientGstin: RECIPIENT_GSTIN,
    noteNumber: 'CN-000001',
    noteDate: new Date('2026-09-18T00:00:00.000Z'),
    noteValue: 10_300,
    placeOfSupply: GUJARAT,
    rateGroups: [{ rate: 3, taxableValue: 10_000, igst: 0, cgst: 150, sgst: 150, cess: 0 }],
    taxableValue: 10_000, cgst: 150, sgst: 150, igst: 0, cess: 0,
    ...overrides,
  };
}

function cdnurNote(overrides: Partial<Gstr1GstnCdnurNote> = {}): Gstr1GstnCdnurNote {
  return {
    noteType: 'C',
    noteNumber: 'CNUR-000001',
    noteDate: new Date('2026-09-19T00:00:00.000Z'),
    noteValue: 5_150,
    placeOfSupply: MAHARASHTRA,
    rateGroups: [{ rate: 3, taxableValue: 5_000, igst: 150, cgst: 0, sgst: 0, cess: 0 }],
    taxableValue: 5_000, igst: 150, cess: 0,
    ...overrides,
  };
}

function hsnRow(overrides: Partial<Gstr1GstnHsnSummaryRow> = {}): Gstr1GstnHsnSummaryRow {
  return {
    hsnCode: '7113', description: 'Jewellery', uqc: 'GMS', quantity: 10, rate: 3,
    taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0, totalValue: null,
    ...overrides,
  };
}

function docSeries(overrides: Partial<Gstr1GstnDocumentSeries> = {}): Gstr1GstnDocumentSeries {
  return {
    documentCategory: 'INVOICES_FOR_OUTWARD_SUPPLY', sellerRegistrationId: 'reg_1', seriesPrefix: 'INV',
    financialYear: 2026, fromDocumentNumber: 'INV-000001', toDocumentNumber: 'INV-000010',
    fromSerial: 1, toSerial: 10, totalIssued: 10, cancelled: 0, netIssued: 10, filingEligible: true,
    ...overrides,
  };
}

function errorCodeOf(fn: () => unknown): Gstr1GstnSerializationErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof Gstr1GstnSerializationError) return e.code;
    throw e;
  }
  throw new Error('expected serializeGstr1ToGstnJson to throw');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Top-level metadata
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: top-level metadata', () => {
  it('emits gstin, fp, version, and the literal hash placeholder on an otherwise-empty export', () => {
    const wire = serializeGstr1ToGstnJson(baseDto());
    expect(wire.gstin).toBe(COMPANY_GSTIN);
    expect(wire.fp).toBe('092026');
    expect(wire.version).toBe('GST3.2.4');
    expect(wire.hash).toBe('hash');
    expect(wire.hash).toBe(GSTR1_GSTN_WIRE_HASH_PLACEHOLDER);
  });

  it('emits gt/cur_gt only when the corresponding AATO figure is VERIFIED with a non-null amount', () => {
    const noneVerified = serializeGstr1ToGstnJson(baseDto());
    expect(noneVerified.gt).toBeUndefined();
    expect(noneVerified.cur_gt).toBeUndefined();

    const bothVerified = serializeGstr1ToGstnJson(baseDto({
      metadata: {
        ...baseDto().metadata,
        aato: {
          precedingFy: aatoFigure({ amount: 60_000_000, verificationState: 'VERIFIED' }),
          currentFy: aatoFigure({ amount: 72_000_000, verificationState: 'VERIFIED' }),
        },
      },
    }));
    expect(bothVerified.gt).toBe(60_000_000);
    expect(bothVerified.cur_gt).toBe(72_000_000);

    const unverifiedOnly = serializeGstr1ToGstnJson(baseDto({
      metadata: {
        ...baseDto().metadata,
        aato: { precedingFy: aatoFigure({ amount: 1000, verificationState: 'UNVERIFIED' }), currentFy: aatoFigure() },
      },
    }));
    expect(unverifiedOnly.gt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2-5. B2B — Table 4
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: B2B', () => {
  it('serializes an intra-state B2B invoice with camt/samt/csamt and no iamt key', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice()] }));
    const item = wire.b2b![0].inv[0].itms[0];
    expect(item.itm_det).toEqual({ txval: 100_000, rt: 3, camt: 1500, samt: 1500, csamt: 0 });
    expect('iamt' in item.itm_det).toBe(false);
  });

  it('serializes an inter-state B2B invoice with iamt/csamt and no camt/samt keys', () => {
    const inv = b2bInvoice({
      placeOfSupply: MAHARASHTRA,
      rateGroups: [{ rate: 3, taxableValue: 100_000, igst: 3000, cgst: 0, sgst: 0, cess: 0 }],
    });
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [inv] }));
    const item = wire.b2b![0].inv[0].itms[0];
    expect(item.itm_det).toEqual({ txval: 100_000, rt: 3, iamt: 3000, csamt: 0 });
    expect('camt' in item.itm_det).toBe(false);
    expect('samt' in item.itm_det).toBe(false);
  });

  it('computes a distinct, GST-rate-derived item num per rate group on a multi-rate invoice', () => {
    const inv = b2bInvoice({
      rateGroups: [
        { rate: 3, taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 },
        { rate: 5, taxableValue: 20_000, igst: 0, cgst: 500, sgst: 500, cess: 0 },
      ],
    });
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [inv] }));
    const nums = wire.b2b![0].inv[0].itms.map((i) => i.num);
    expect(nums).toEqual([301, 501]);
  });

  it('defaults a null invoiceType to "R" and passes through a real, verified non-"R" value as-is', () => {
    const defaulted = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceType: null })] }));
    expect(defaulted.b2b![0].inv[0].inv_typ).toBe('R');

    const explicit = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceType: 'SEWP' })] }));
    expect(explicit.b2b![0].inv[0].inv_typ).toBe('SEWP');
  });

  it('maps reverseCharge to the wire Y/N string, defaulting an unset (null) fact to N', () => {
    const yes = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ reverseCharge: true })] }));
    expect(yes.b2b![0].inv[0].rchrg).toBe('Y');
    const no = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ reverseCharge: false })] }));
    expect(no.b2b![0].inv[0].rchrg).toBe('N');
    const unset = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ reverseCharge: null })] }));
    expect(unset.b2b![0].inv[0].rchrg).toBe('N');
  });

  it('groups multiple invoices for the same recipient under one ctin entry, sorted by ctin', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      b2b: [
        b2bInvoice({ recipientGstin: '27ZZZZZ0000Z1Z1', invoiceNumber: 'INV-A' }),
        b2bInvoice({ recipientGstin: '24AAAAA0000A1Z1', invoiceNumber: 'INV-B' }),
        b2bInvoice({ recipientGstin: '27ZZZZZ0000Z1Z1', invoiceNumber: 'INV-C' }),
      ],
    }));
    expect(wire.b2b!.map((r) => r.ctin)).toEqual(['24AAAAA0000A1Z1', '27ZZZZZ0000Z1Z1']);
    expect(wire.b2b!.find((r) => r.ctin === '27ZZZZZ0000Z1Z1')!.inv.map((i) => i.inum)).toEqual(['INV-A', 'INV-C']);
  });

  it('rejects a B2B invoice with no invoice date', () => {
    const code = errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: null })] })));
    expect(code).toBe('MISSING_INVOICE_DATE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6-7. B2CL — Table 5
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: B2CL', () => {
  it('groups invoices by place of supply, sorted by pos', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      b2cl: [
        b2clInvoice({ placeOfSupply: '29', invoiceNumber: 'B2CL-A' }),
        b2clInvoice({ placeOfSupply: '06', invoiceNumber: 'B2CL-B' }),
        b2clInvoice({ placeOfSupply: '29', invoiceNumber: 'B2CL-C' }),
      ],
    }));
    expect(wire.b2cl!.map((g) => g.pos)).toEqual(['06', '29']);
    expect(wire.b2cl!.find((g) => g.pos === '29')!.inv.map((i) => i.inum)).toEqual(['B2CL-A', 'B2CL-C']);
  });

  it('emits only iamt/csamt (never camt/samt) and never an inv_typ or per-invoice pos key', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2cl: [b2clInvoice()] }));
    const inv = wire.b2cl![0].inv[0];
    expect(inv.itms[0].itm_det).toEqual({ txval: 200_000, rt: 3, iamt: 6000, csamt: 0 });
    expect('camt' in inv.itms[0].itm_det).toBe(false);
    expect('samt' in inv.itms[0].itm_det).toBe(false);
    expect('inv_typ' in inv).toBe(false);
    expect('pos' in inv).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8-10. B2CS — Table 7
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: B2CS', () => {
  it('serializes an intra-state record with the wire sply_ty "INTRA" (not the DTO\'s own "INTRA_STATE")', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2cs: [b2csRecord({ supplyType: 'INTRA_STATE' })] }));
    const r = wire.b2cs![0];
    expect(r.sply_ty).toBe('INTRA');
    expect(r).toEqual({ sply_ty: 'INTRA', typ: 'OE', pos: GUJARAT, rt: 3, txval: 5000, camt: 75, samt: 75, csamt: 0 });
  });

  it('serializes an inter-state record with "INTER" and iamt/csamt only', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      b2cs: [b2csRecord({ supplyType: 'INTER_STATE', placeOfSupply: MAHARASHTRA, igst: 150, cgst: 0, sgst: 0 })],
    }));
    const r = wire.b2cs![0];
    expect(r).toEqual({ sply_ty: 'INTER', typ: 'OE', pos: MAHARASHTRA, rt: 3, txval: 5000, iamt: 150, csamt: 0 });
  });

  it('preserves a negative taxable/tax value (a B2CS adjustment) rather than clamping or rejecting it', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      b2cs: [b2csRecord({ taxableValue: -1000, cgst: -15, sgst: -15 })],
    }));
    expect(wire.b2cs![0]).toMatchObject({ txval: -1000, camt: -15, samt: -15 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-13. CDNR — Table 9B
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: CDNR', () => {
  it('groups notes by recipient ctin', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      cdnr: [
        cdnrNote({ recipientGstin: '27ZZZZZ0000Z1Z1', noteNumber: 'CN-A' }),
        cdnrNote({ recipientGstin: '24AAAAA0000A1Z1', noteNumber: 'CN-B' }),
      ],
    }));
    expect(wire.cdnr!.map((r) => r.ctin)).toEqual(['24AAAAA0000A1Z1', '27ZZZZZ0000Z1Z1']);
  });

  it('serializes a Credit Note with ntty "C" and the fixed domestic rchrg/inv_typ', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ cdnr: [cdnrNote({ noteType: 'C' })] }));
    const note = wire.cdnr![0].nt[0];
    expect(note.ntty).toBe('C');
    expect(note.rchrg).toBe('N');
    expect(note.inv_typ).toBe('R');
    expect(note.itms[0].itm_det).toEqual({ txval: 10_000, rt: 3, camt: 150, samt: 150, csamt: 0 });
  });

  it('serializes a Sales Debit Note with ntty "D" in the same CDNR table', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ cdnr: [cdnrNote({ noteType: 'D', noteNumber: 'SDN-000001' })] }));
    expect(wire.cdnr![0].nt[0].ntty).toBe('D');
    expect(wire.cdnr![0].nt[0].nt_num).toBe('SDN-000001');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. CDNUR — Table 9B
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: CDNUR', () => {
  it('serializes a B2CL-origin note with typ "B2CL" and the correct inter/intra tax keys', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ cdnur: [cdnurNote()] }));
    const note = wire.cdnur![0];
    expect(note.typ).toBe('B2CL');
    expect(note.itms[0].itm_det).toEqual({ txval: 5_000, rt: 3, iamt: 150, csamt: 0 });
    expect('ctin' in note).toBe(false);
    expect('rchrg' in note).toBe(false);
  });

  it('always serializes typ as "B2CL" regardless of noteType — the canonical DTO carries no origin field to validate against (a documented structural limitation, not a business rule)', () => {
    const credit = serializeGstr1ToGstnJson(baseDto({ cdnur: [cdnurNote({ noteType: 'C' })] }));
    const debit = serializeGstr1ToGstnJson(baseDto({ cdnur: [cdnurNote({ noteType: 'D' })] }));
    expect(credit.cdnur![0].typ).toBe('B2CL');
    expect(debit.cdnur![0].typ).toBe('B2CL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15-17. HSN — Table 12
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: HSN summary', () => {
  it('serializes hsn_b2b rows with sequential 1-based num and all four tax keys together', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ hsnB2b: [hsnRow(), hsnRow({ rate: 5, hsnCode: '7114' })] }));
    expect(wire.hsn!.hsn_b2b!.map((r) => r.num)).toEqual([1, 2]);
    expect(wire.hsn!.hsn_b2b![0]).toEqual({
      num: 1, hsn_sc: '7113', desc: 'Jewellery', uqc: 'GMS', qty: 10, rt: 3,
      txval: 100_000, iamt: 0, camt: 1500, samt: 1500, csamt: 0,
    });
  });

  it('numbers hsn_b2c independently of hsn_b2b (each section restarts at 1)', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ hsnB2b: [hsnRow(), hsnRow({ hsnCode: '7114' })], hsnB2c: [hsnRow({ hsnCode: '7115' })] }));
    expect(wire.hsn!.hsn_b2b!.map((r) => r.num)).toEqual([1, 2]);
    expect(wire.hsn!.hsn_b2c!.map((r) => r.num)).toEqual([1]);
  });

  it('never emits a "val" key on any HSN row', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ hsnB2b: [hsnRow()] }));
    expect('val' in wire.hsn!.hsn_b2b![0]).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18-19. Table 13 — Documents Issued
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: Documents Issued', () => {
  it('maps the three supported categories to their exact official doc_num/doc_typ', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({
      documentsIssued: [
        docSeries({ documentCategory: 'INVOICES_FOR_OUTWARD_SUPPLY' }),
        docSeries({ documentCategory: 'DEBIT_NOTE', fromDocumentNumber: 'SDN-001', toDocumentNumber: 'SDN-010' }),
        docSeries({ documentCategory: 'CREDIT_NOTE', fromDocumentNumber: 'CN-001', toDocumentNumber: 'CN-010' }),
      ],
    }));
    const byNum = new Map(wire.doc_issue!.doc_det.map((d) => [d.doc_num, d.doc_typ]));
    expect(byNum.get(1)).toBe('Invoices for outward supply');
    expect(byNum.get(4)).toBe('Debit Note');
    expect(byNum.get(5)).toBe('Credit Note');
    // Ascending by doc_num.
    expect(wire.doc_issue!.doc_det.map((d) => d.doc_num)).toEqual([1, 4, 5]);
  });

  it('uses the exact wire key names "cancel" and "net_issue" (never the internal TRIVO names)', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ documentsIssued: [docSeries({ cancelled: 2, netIssued: 8 })] }));
    const series = wire.doc_issue!.doc_det[0].docs[0];
    expect(series).toEqual({ num: 1, from: 'INV-000001', to: 'INV-000010', totnum: 10, cancel: 2, net_issue: 8 });
    expect('cancelled' in series).toBe(false);
    expect('netIssued' in series).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. Empty-section behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: empty-section behavior', () => {
  it('omits every optional top-level key entirely on a completely empty export', () => {
    const wire = serializeGstr1ToGstnJson(baseDto());
    expect(Object.keys(wire).sort()).toEqual(['fp', 'gstin', 'hash', 'version']);
  });

  it('omits "hsn" entirely when both hsn_b2b and hsn_b2c are empty', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ hsnB2b: [], hsnB2c: [] }));
    expect(wire.hsn).toBeUndefined();
  });

  it('omits "doc_issue" entirely when documentsIssued is empty', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ documentsIssued: [] }));
    expect(wire.doc_issue).toBeUndefined();
  });

  it('emits only the populated sections on a mixed export (b2b present, b2cl/cdnr/cdnur absent)', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice()] }));
    expect(wire.b2b).toBeDefined();
    expect(wire.b2cl).toBeUndefined();
    expect(wire.cdnr).toBeUndefined();
    expect(wire.cdnur).toBeUndefined();
    expect(wire.b2cs).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21-22. Dates
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: date formatting (IST, DD-MM-YYYY)', () => {
  it('formats a plain UTC-midnight date as the same IST calendar day plus the +5:30 shift', () => {
    // 2026-09-15T00:00:00Z is 05:30 IST on 2026-09-15 — same calendar day.
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: new Date('2026-09-15T00:00:00.000Z') })] }));
    expect(wire.b2b![0].inv[0].idt).toBe('15-09-2026');
  });

  it('rolls a date just before IST midnight to the PREVIOUS day, and at/after IST midnight to the NEXT day', () => {
    // 18:29:59.999 UTC on 2026-09-14 = 23:59:59.999 IST on 2026-09-14 (still the 14th).
    const before = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: new Date('2026-09-14T18:29:59.999Z') })] }));
    expect(before.b2b![0].inv[0].idt).toBe('14-09-2026');
    // 18:30:00.000 UTC on 2026-09-14 = 00:00:00.000 IST on 2026-09-15 (rolls to the 15th).
    const atMidnight = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: new Date('2026-09-14T18:30:00.000Z') })] }));
    expect(atMidnight.b2b![0].inv[0].idt).toBe('15-09-2026');
  });

  it('rolls correctly across a month boundary (31 March IST midnight -> 1 April)', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: new Date('2026-03-31T18:30:00.000Z') })] }));
    expect(wire.b2b![0].inv[0].idt).toBe('01-04-2026');
  });

  it('rolls correctly across a year boundary (31 December IST midnight -> 1 January)', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ invoiceDate: new Date('2026-12-31T18:30:00.000Z') })] }));
    expect(wire.b2b![0].inv[0].idt).toBe('01-01-2027');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23-24. Numeric rounding and tax-key omission (unit-level, beyond the per-section tests above)
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: numeric rounding', () => {
  it('rounds a taxable value to exactly 2 decimal places using round-half-away-from-zero at the cent boundary', () => {
    const inv = b2bInvoice({ rateGroups: [{ rate: 3, taxableValue: 100.456, igst: 0, cgst: 1.506, sgst: 1.506, cess: 0 }] });
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [inv] }));
    const det = wire.b2b![0].inv[0].itms[0].itm_det as { txval: number; camt: number; samt: number };
    expect(det.txval).toBe(100.46);
    expect(det.camt).toBe(1.51);
    expect(det.samt).toBe(1.51);
  });

  it('never fabricates a 0 for the opposite tax-key set rather than omitting it', () => {
    const wire = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice()] }));
    const keys = Object.keys(wire.b2b![0].inv[0].itms[0].itm_det).sort();
    expect(keys).toEqual(['camt', 'csamt', 'rt', 'samt', 'txval']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 25-26. Immutability and determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: purity', () => {
  it('never mutates the input DTO', () => {
    const dto = baseDto({ b2b: [b2bInvoice()], b2cs: [b2csRecord()], hsnB2b: [hsnRow()], documentsIssued: [docSeries()] });
    const before = JSON.parse(JSON.stringify(dto));
    serializeGstr1ToGstnJson(dto);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(before);
  });

  it('produces byte-identical (deep-equal) output for the same input, called twice', () => {
    const dto = baseDto({ b2b: [b2bInvoice()], cdnr: [cdnrNote()], hsnB2b: [hsnRow()] });
    const first = serializeGstr1ToGstnJson(dto);
    const second = serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice()], cdnr: [cdnrNote()], hsnB2b: [hsnRow()] }));
    expect(first).toEqual(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27-30. Validation / rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('gstr1GstnSerializer: validation', () => {
  it('rejects a missing GSTIN', () => {
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ metadata: { ...baseDto().metadata, gstin: '' } })))).toBe('MISSING_GSTIN');
  });

  it('rejects an invalid (checksum-failing) GSTIN', () => {
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ metadata: { ...baseDto().metadata, gstin: '24AAAAA0000A1Z9' } })))).toBe('INVALID_GSTIN');
  });

  it('rejects a missing filing period', () => {
    const dto = baseDto();
    dto.metadata.period.filingPeriodMmYYYY = null;
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(dto))).toBe('MISSING_FILING_PERIOD');
  });

  it('rejects a malformed filing period', () => {
    const dto = baseDto();
    dto.metadata.period.filingPeriodMmYYYY = '132026';
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(dto))).toBe('MALFORMED_FILING_PERIOD');
  });

  it('rejects a malformed place of supply', () => {
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ placeOfSupply: null })] })))).toBe('MALFORMED_PLACE_OF_SUPPLY');
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ b2b: [b2bInvoice({ placeOfSupply: '9' })] })))).toBe('MALFORMED_PLACE_OF_SUPPLY');
  });

  it('rejects a non-finite numeric value', () => {
    const inv = b2bInvoice({ rateGroups: [{ rate: 3, taxableValue: NaN, igst: 0, cgst: 0, sgst: 0, cess: 0 }] });
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ b2b: [inv] })))).toBe('NON_FINITE_VALUE');
  });

  it('rejects an invalid document number under Rule 46(b)', () => {
    const series = docSeries({ fromDocumentNumber: 'THIS-DOCUMENT-NUMBER-IS-WAY-TOO-LONG' });
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ documentsIssued: [series] })))).toBe('INVALID_DOCUMENT_NUMBER');
  });

  it('rejects an item-sequence collision (two distinct rates rounding to the same wire num)', () => {
    // 2.999 -> round(299.9) = 300 -> num 301; 3.001 -> round(300.1) = 300 -> num 301. Same num, distinct rates.
    const inv = b2bInvoice({
      rateGroups: [
        { rate: 2.999, taxableValue: 100_000, igst: 0, cgst: 1500, sgst: 1500, cess: 0 },
        { rate: 3.001, taxableValue: 50_000, igst: 0, cgst: 750, sgst: 750, cess: 0 },
      ],
    });
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ b2b: [inv] })))).toBe('ITEM_SEQUENCE_COLLISION');
  });

  it('rejects an unsupported document category', () => {
    const series = docSeries({ documentCategory: 'NOT_A_REAL_CATEGORY' as unknown as Gstr1GstnDocumentSeries['documentCategory'] });
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ documentsIssued: [series] })))).toBe('UNSUPPORTED_DOCUMENT_CATEGORY');
  });

  it('rejects an invalid HSN code', () => {
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ hsnB2b: [hsnRow({ hsnCode: null })] })))).toBe('INVALID_HSN_CODE');
  });

  it('rejects an unsupported UQC', () => {
    expect(errorCodeOf(() => serializeGstr1ToGstnJson(baseDto({ hsnB2b: [hsnRow({ uqc: 'BOGUS' })] })))).toBe('INVALID_UQC');
  });
});
