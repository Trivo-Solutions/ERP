import { describe, it, expect } from 'vitest';
import { generateTsplForTag, mmToDots, TagForPrint, TagTemplateForPrint } from './tsplGenerator';

const tag: TagForPrint = {
  tagNumber: 'RRNG00001',
  name: 'Diamond Ring',
  metalKarat: '18K',
  grossWeight: 5.234 as any,
  netWeight: 4.9 as any,
  stoneWeight: 0.334 as any,
  huid: 'HUID12345',
  sellingPrice: 45000 as any,
  branch: { name: 'Main Branch' },
};

const template: TagTemplateForPrint = {
  widthMm: 50,
  heightMm: 30,
  gapMm: 2,
  layout: {
    elements: [
      { id: 'el1', wing: 'front', type: 'barcode', xMm: 4, yMm: 2, boundField: 'tagNumber', heightMm: 10, humanReadable: true },
      { id: 'el2', wing: 'front', type: 'text', xMm: 4, yMm: 14, boundField: 'name', fontSize: 9 },
      { id: 'el3', wing: 'front', type: 'text', xMm: 4, yMm: 24, boundField: 'sellingPrice', fontSize: 10 },
      { id: 'el4', wing: 'back', type: 'text', xMm: 4, yMm: 32, literalText: 'Handle with care', fontSize: 8, rotation: 90 },
      { id: 'el5', wing: 'front', type: 'qrcode', xMm: 30, yMm: 2, boundField: 'tagNumber' },
      { id: 'el6', wing: 'front', type: 'box', xMm: 0, yMm: 0, widthMm: 50, heightMm: 30 },
      { id: 'el7', wing: 'front', type: 'line', xMm: 0, yMm: 13, widthMm: 50 },
    ],
  },
};

describe('mmToDots', () => {
  it('converts mm to dots at 8 dots/mm (203 dpi)', () => {
    expect(mmToDots(1)).toBe(8);
    expect(mmToDots(5)).toBe(40);
    expect(mmToDots(2.5)).toBe(20);
  });
});

describe('generateTsplForTag', () => {
  const tspl = generateTsplForTag(template, tag);
  const lines = tspl.split('\r\n');

  it('emits SIZE/GAP/DIRECTION/CLS header from the template dimensions', () => {
    expect(lines[0]).toBe('SIZE 50 mm,30 mm');
    expect(lines[1]).toBe('GAP 2 mm,0 mm');
    expect(lines[2]).toBe('DIRECTION 1');
    expect(lines[3]).toBe('CLS');
  });

  it('renders a bound-field barcode with the real tag number and mm->dot coordinates', () => {
    expect(tspl).toContain('BARCODE 32,16,"128",80,1,0,2,2,"RRNG00001"');
  });

  it('renders a bound-field text element with content resolved from the tag', () => {
    expect(tspl).toContain('TEXT 32,112,"3",0,1,1,"Diamond Ring"');
  });

  it('formats a currency bound field and scales font size to an integer multiplier', () => {
    expect(tspl).toContain('TEXT 32,192,"3",0,1,1,"Rs.45,000"');
  });

  it('renders both wings in one program, at their own element coordinates', () => {
    expect(tspl).toContain('TEXT 32,256,"3",90,1,1,"Handle with care"');
  });

  it('renders a bound-field QR code', () => {
    expect(tspl).toContain('QRCODE 240,16,M,4,A,0,"RRNG00001"');
  });

  it('renders a box from its mm width/height', () => {
    expect(tspl).toContain('BOX 0,0,400,240,2');
  });

  it('renders a line as a thin filled bar', () => {
    expect(tspl).toContain('BAR 0,104,400,2');
  });

  it('ends with a single-copy PRINT command', () => {
    expect(lines[lines.length - 2]).toBe('PRINT 1,1');
  });

  it('formats an optional field left blank on the tag as an empty string, not an error', () => {
    const tagNoHuid = { ...tag, huid: null };
    const t = generateTsplForTag(
      { ...template, layout: { elements: [{ id: 'e', wing: 'front', type: 'text', xMm: 0, yMm: 0, boundField: 'huid' }] } },
      tagNoHuid,
    );
    expect(t).toContain('TEXT 0,0,"3",0,1,1,""');
  });

  it('throws a clear error for an unrecognized bound field instead of silently blanking it', () => {
    const bad = { ...template, layout: { elements: [{ id: 'e', wing: 'front' as const, type: 'text' as const, xMm: 0, yMm: 0, boundField: 'notAField' as any }] } };
    expect(() => generateTsplForTag(bad, tag)).toThrow(/Unknown tag template bound field/);
  });

  it('throws a clear error for an unrecognized element type', () => {
    const bad = { ...template, layout: { elements: [{ id: 'e', wing: 'front' as const, type: 'sparkle' as any, xMm: 0, yMm: 0 }] } };
    expect(() => generateTsplForTag(bad, tag)).toThrow(/Unknown tag template element type/);
  });
});

describe('extended bound fields', () => {
  const full: TagForPrint = {
    ...tag,
    makeType: 'GOLD', metalType: 'GOLD', settingType: 'PRONG', costPrice: 30000 as any,
    saleMcRate: 450 as any, saleVaPercent: 12 as any, notes: 'Gift box', createdAt: new Date(2026, 9, 2),
    branch: { name: 'Main Branch', branchCode: 'MB01' },
    category: { name: 'Rings' }, subCategory: { name: 'Solitaire' }, collection: { name: 'Bridal' },
    stockType: { name: 'Regular' }, manufacturer: { name: 'ABC Gold' },
    materials: [
      { materialType: 'METAL', weight: 4.9 as any, pieces: null },
      { materialType: 'DIAMOND', weight: 0.2 as any, pieces: 3 },
      { materialType: 'STONE', weight: 0.134 as any, pieces: 2 },
    ],
  };
  const one = (boundField: string) => generateTsplForTag(
    { ...template, layout: { elements: [{ id: 'e', wing: 'front', type: 'text', xMm: 0, yMm: 0, boundField: boundField as any }] } },
    full,
  );

  it.each([
    ['makeType', 'GOLD'], ['metalType', 'GOLD'], ['settingType', 'PRONG'],
    ['categoryName', 'Rings'], ['subCategoryName', 'Solitaire'], ['collectionName', 'Bridal'],
    ['stockTypeName', 'Regular'], ['manufacturerName', 'ABC Gold'], ['branchCode', 'MB01'],
    ['diamondWeight', '0.200ct'], ['colorStoneWeight', '0.134ct'], ['stonePieces', '5'],
    ['saleMcRate', '450.00/g'], ['saleVaPercent', '12.00%'], ['costPrice', 'Rs.30,000'],
    ['notes', 'Gift box'], ['taggedDate', '02-10-2026'],
  ])('resolves %s', (field, expected) => {
    expect(one(field)).toContain(`"${expected}"`);
  });

  it('prints an absent optional value as empty rather than throwing', () => {
    const lean = generateTsplForTag(
      { ...template, layout: { elements: [{ id: 'e', wing: 'front', type: 'text', xMm: 0, yMm: 0, boundField: 'categoryName' }] } },
      tag,
    );
    expect(lean).toContain(',""');
  });
});

describe('font + image elements', () => {
  const make = (el: any) => generateTsplForTag(
    { widthMm: 50, heightMm: 30, gapMm: 2, layout: { elements: [{ id: 'e', wing: 'front', xMm: 1, yMm: 1, ...el }] } },
    tag,
  );
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('sends font family, style and an unquantized size (pt -> mm) ahead of the TEXT line', () => {
    const out = make({ type: 'text', literalText: 'Hi', fontSize: 12, fontFamily: 'Times New Roman', bold: true });
    expect(out).toContain('REM TRIVO-TEXT {"font":"Times New Roman","bold":true,"italic":false,"sizeMm":4.23}');
    // sizes 8 and 11 used to collapse to the same multiplier-1 print; now they differ
    expect(make({ type: 'text', literalText: 'Hi', fontSize: 11 })).not.toEqual(make({ type: 'text', literalText: 'Hi', fontSize: 8 }));
  });

  it('falls back to Arial for a font outside the whitelist', () => {
    expect(make({ type: 'text', literalText: 'Hi', fontFamily: 'Evil"Font' })).toContain('"font":"Arial"');
  });

  it('emits an image element as a REM TRIVO-IMG line in dots', () => {
    const out = make({ type: 'image', xMm: 2, yMm: 3, widthMm: 10, heightMm: 5, imageData: PNG });
    expect(out).toContain('REM TRIVO-IMG {"x":16,"y":24,"w":80,"h":40,"rot":0,"data":"iVBORw0KGgo="}');
  });

  it('rejects an image that is not a PNG/JPEG data URL', () => {
    expect(() => make({ type: 'image', imageData: 'javascript:alert(1)' })).toThrow();
    expect(() => make({ type: 'image' })).toThrow();
  });
});
