import { describe, it, expect } from 'vitest';
import { buildEscPosRaster, buildEposXml, isValidPrinterHost, parseEposReply } from '../utils/networkReceiptPrinter';

describe('buildEscPosRaster', () => {
  it('emits init, banded GS v 0 raster, feed and partial cut', () => {
    const w = 16, h = 300; // 2 bytes/row -> bands of 256 + 44 rows
    const out = buildEscPosRaster(new Uint8Array(2 * h).fill(0xff), w, h, 96);
    expect([...out.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...out.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 0x00, 0x01]); // 256 rows
    const second = 10 + 2 * 256;
    expect([...out.subarray(second, second + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 44, 0]);
    expect([...out.subarray(out.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect([...out.subarray(out.length - 7, out.length - 4)]).toEqual([0x1b, 0x4a, 96]);
    expect(out.length).toBe(2 + 8 + 512 + 8 + 88 + 3 + 4);
  });
});

describe('ePOS-Print XML', () => {
  it('wraps the bytes as a hex <command>', () => {
    const xml = buildEposXml(Uint8Array.from([0x1b, 0x40, 0x0a]));
    expect(xml).toContain('<command>1b400a</command>');
    expect(xml).toContain('xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"');
  });
  it('reads success and error code from the reply', () => {
    const ok = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><response xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print" success="true" code="" status="251658262" battery="0"/></s:Body></s:Envelope>';
    const bad = ok.replace('success="true" code=""', 'success="false" code="EPTR_COVER_OPEN"');
    expect(parseEposReply(ok)).toEqual({ success: true, code: '' });
    expect(parseEposReply(bad)).toEqual({ success: false, code: 'EPTR_COVER_OPEN' });
    expect(() => parseEposReply('<html/>')).toThrow();
  });
});

describe('isValidPrinterHost', () => {
  it('accepts an IP / hostname and rejects URLs and junk', () => {
    expect(isValidPrinterHost('192.168.1.50')).toBe(true);
    expect(isValidPrinterHost('epson-counter.local')).toBe(true);
    expect(isValidPrinterHost('https://192.168.1.50')).toBe(false);
    expect(isValidPrinterHost('192.168.1.50/evil?x')).toBe(false);
    expect(isValidPrinterHost('')).toBe(false);
  });
});
