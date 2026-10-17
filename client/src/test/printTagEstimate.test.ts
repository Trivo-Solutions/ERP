import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printTagEstimate } from '../utils/printTagEstimate';

// The suite runs in a node environment (no jsdom, no layout engine), so the few DOM calls the
// measuring iframe makes are faked: 4px per mm, a table is 6mm per <tr>, any other box is 4mm.
const PX = 4;
let popupHtml = '';

function fakeFrame() {
  let written = '';
  const doc = {
    open() {}, close() {},
    write(h: string) { written += h; },
    createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: 100 * PX }) }),
    body: { appendChild() {} },
    getElementById: () => {
      const inner = written.slice(written.indexOf('<div id="p"'));
      const kids = inner.split(/\n(?=<div style="position:absolute|<img )/).map((html) => ({
        getBoundingClientRect: () => ({ height: ((html.match(/<tr>/g)?.length ?? 0) * 6 || 4) * PX }),
      }));
      return { children: kids };
    },
  };
  return { style: {}, contentDocument: doc };
}

beforeEach(() => {
  popupHtml = '';
  vi.stubGlobal('document', {
    createElement: () => fakeFrame(),
    body: { appendChild() {}, removeChild() {} },
  });
  vi.stubGlobal('window', {
    open: () => ({ document: { write: (h: string) => { popupHtml += h; }, close() {} }, focus() {} }),
  });
});
afterEach(() => vi.unstubAllGlobals());

const template = {
  widthMm: 80, heightMm: 160,
  layout: { elements: [
    { id: 'n', type: 'text' as const, xMm: 4, yMm: 4, boundField: 'netPayableAmount' as const },
    { id: 'w', type: 'text' as const, xMm: 4, yMm: 10, boundField: 'netWeight' as const },
    { id: 't', type: 'materialsTable' as const, xMm: 4, yMm: 20, columns: [
      { field: 'name' as const, label: 'Item', widthMm: 30 }, { field: 'weight' as const, label: 'Wt', widthMm: 20 },
      { field: 'saleAmount' as const, label: 'Amount', widthMm: 26 },
    ] },
    { id: 'g', type: 'text' as const, xMm: 4, yMm: 118, boundField: 'gstAmount' as const },
  ] },
};
const estimate = (rows: number) => ({
  estimateNumber: 'EST-1', gstAmount: 3000, netPayableAmount: 103000, saleMcRate: 0, saleVaPercent: 0,
  items: Array.from({ length: rows }, (_, i) => ({ materialType: 'METAL', code: `M${i}`, weight: 1.2345, unit: 'GM', saleRate: 6000, saleAmount: 1234.5 })),
});
const pageHeight = () => Number(/@page \{ size: 80mm ([\d.]+)mm/.exec(popupHtml)![1]);

describe('printTagEstimate page height', () => {
  it('prints a short estimate short and a long one in full', () => {
    printTagEstimate(template, { netWeight: 12.3456 }, estimate(1));
    const short = pageHeight();
    const shortHtml = popupHtml;
    popupHtml = '';
    printTagEstimate(template, { netWeight: 12.3456 }, estimate(40));
    const long = pageHeight();
    expect(short).toBeLessThan(60);   // not the design-time 118mm GST slot
    expect(long).toBeGreaterThan(240); // 41 rows x 6mm, GST line below, nothing cut off
    expect(popupHtml).toContain('top:' + (20 + 41 * 6 + 3) + 'mm'); // GST sits just under the long table
    expect(shortHtml).toContain('₹3,000.00');
    expect(shortHtml).toContain('₹1,03,000.00');
    expect(shortHtml).toContain('12.346 g');
    expect(shortHtml).toContain('1.234');
  });
});
