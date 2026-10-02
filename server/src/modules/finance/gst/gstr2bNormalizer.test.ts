import { describe, it, expect } from 'vitest';
import { normalizeGstr2bPayload, Gstr2bNormalizationError } from './gstr2bNormalizer';

function b2bPayload(overrides: Record<string, unknown> = {}) {
  return {
    gstin: '24AAAAA0000A1Z5',
    fp: '092026',
    data: {
      gendt: '14-10-2026',
      gstin: '24AAAAA0000A1Z5',
      rtnprd: '092026',
      docdata: {
        b2b: [
          {
            ctin: '27BBBBB1111B1Z1',
            trdnm: 'Acme Metals',
            inv: [
              {
                inum: 'INV/001', dt: '05-09-2026', val: 118000, pos: '24', rev: 'N', itcavl: 'Y',
                itms: [{ rt: 18, txval: 100000, iamt: 18000, camt: 0, samt: 0, csamt: 0 }],
                ...overrides,
              },
            ],
          },
        ],
      },
    },
  };
}

describe('G2g-7e: normalizeGstr2bPayload', () => {
  it('normalizes a well-formed B2B invoice with converging field names', () => {
    const result = normalizeGstr2bPayload(b2bPayload());
    expect(result.meta.gstin).toBe('24AAAAA0000A1Z5');
    expect(result.meta.taxPeriod).toBe('092026');
    expect(result.meta.generatedAt).not.toBeNull();
    expect(result.documents).toHaveLength(1);
    const d = result.documents[0];
    expect(d.section).toBe('B2B');
    expect(d.documentType).toBe('INVOICE');
    expect(d.supplierGstin).toBe('27BBBBB1111B1Z1');
    expect(d.supplierTradeName).toBe('Acme Metals');
    expect(d.documentNumber).toBe('INV/001');
    expect(d.documentDate?.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect(d.taxableValue).toBe(100000);
    expect(d.igst).toBe(18000);
    expect(d.cgst).toBe(0);
    expect(d.reverseCharge).toBe(false);
    expect(d.itcAvailability).toBe('AVAILABLE');
    expect(d.supportStatus).toBe('SUPPORTED');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('sums multiple rate-bucket items into one document total', () => {
    const payload = b2bPayload();
    (payload.data.docdata.b2b[0].inv[0] as any).itms = [
      { rt: 18, txval: 50000, iamt: 9000 },
      { rt: 12, txval: 20000, iamt: 2400 },
    ];
    const result = normalizeGstr2bPayload(payload);
    expect(result.documents[0].taxableValue).toBe(70000);
    expect(result.documents[0].igst).toBe(11400);
  });

  it('flags a reverse-charge invoice correctly', () => {
    const result = normalizeGstr2bPayload(b2bPayload({ rev: 'Y' }));
    expect(result.documents[0].reverseCharge).toBe(true);
  });

  it('normalizes CDNR (credit note) and B2BA (amendment) sections with their own document types', () => {
    const payload = {
      gstin: '24AAAAA0000A1Z5', fp: '092026',
      data: {
        docdata: {
          cdnr: [{ ctin: '27BBBBB1111B1Z1', trdnm: 'Acme', nt: [{ inum: 'CN/001', dt: '10-09-2026', val: 5000, itms: [{ txval: 4237, iamt: 763 }] }] }],
          b2ba: [{ ctin: '27BBBBB1111B1Z1', inv: [{ inum: 'INV/001-A', dt: '06-09-2026', og_num: 'INV/001', og_dt: '05-09-2026', itms: [{ txval: 105000, iamt: 18900 }] }] }],
        },
      },
    };
    const result = normalizeGstr2bPayload(payload);
    const cdnr = result.documents.find((d) => d.section === 'CDNR');
    const b2ba = result.documents.find((d) => d.section === 'B2BA');
    expect(cdnr?.documentType).toBe('CREDIT_NOTE');
    expect(b2ba?.documentType).toBe('INVOICE');
    expect(b2ba?.amendsDocumentNumber).toBe('INV/001');
    expect(b2ba?.amendsDocumentDate?.toISOString().slice(0, 10)).toBe('2026-09-05');
  });

  it('preserves ISD and IMPG entries with the correct supportStatus, never silently dropped', () => {
    const payload = {
      gstin: '24AAAAA0000A1Z5', fp: '092026',
      data: { docdata: { isd: [{ ctin: '27ISDISD000I1Z1', inum: 'ISD/01', val: 1000 }], impg: [{ boe_num: 'BOE123', boe_dt: '01-09-2026', val: 20000, itms: [{ txval: 20000, iamt: 3600 }] }] } },
    };
    const result = normalizeGstr2bPayload(payload);
    const isd = result.documents.find((d) => d.section === 'ISD');
    const impg = result.documents.find((d) => d.section === 'IMPG');
    expect(isd?.supportStatus).toBe('ISD_NOT_SUPPORTED');
    expect(impg?.supportStatus).toBe('IMPORTS_NOT_RECONCILABLE');
    expect(impg?.documentNumber).toBe('BOE123');
    expect(impg?.taxableValue).toBe(20000);
  });

  it('flags a missing document number rather than dropping the record', () => {
    const payload = b2bPayload();
    delete (payload.data.docdata.b2b[0].inv[0] as any).inum;
    const result = normalizeGstr2bPayload(payload);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].documentNumber).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'MISSING_DOCUMENT_NUMBER')).toBe(true);
  });

  it('flags an all-zero document rather than guessing amounts', () => {
    const payload = b2bPayload();
    (payload.data.docdata.b2b[0].inv[0] as any).itms = [];
    delete (payload.data.docdata.b2b[0].inv[0] as any).txval;
    const result = normalizeGstr2bPayload(payload);
    expect(result.documents[0].taxableValue).toBe(0);
    expect(result.diagnostics.some((d) => d.code === 'MISSING_TAXABLE_AMOUNTS')).toBe(true);
  });

  it('flags an unresolved tax period/GSTIN rather than guessing one', () => {
    const result = normalizeGstr2bPayload({ data: { docdata: {} } });
    expect(result.meta.gstin).toBeNull();
    expect(result.meta.taxPeriod).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'GSTIN_META_UNRESOLVED')).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'TAX_PERIOD_UNRESOLVED')).toBe(true);
    expect(result.documents).toHaveLength(0);
  });

  it('throws Gstr2bNormalizationError for a non-object payload, never silently returns empty', () => {
    expect(() => normalizeGstr2bPayload('not json')).toThrow(Gstr2bNormalizationError);
    expect(() => normalizeGstr2bPayload(null)).toThrow(Gstr2bNormalizationError);
    expect(() => normalizeGstr2bPayload([1, 2, 3])).toThrow(Gstr2bNormalizationError);
  });

  it('skips a non-object record inside a section with a diagnostic instead of crashing', () => {
    const payload = { data: { docdata: { b2b: [{ ctin: '27X', inv: ['not-an-object'] }] } } };
    const result = normalizeGstr2bPayload(payload);
    expect(result.documents).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === 'UNRECOGNIZED_RECORD_SHAPE')).toBe(true);
  });
});
