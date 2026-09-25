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
