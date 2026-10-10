import { describe, it, expect } from 'vitest';
import {
  buildInvoiceContext, resolveField, interpolate, buildTableData, placeholderKeys, financialYearLabel, sampleInvoiceForPreview,
} from '../utils/taxInvoiceData';
import { planPages } from '../utils/taxInvoicePaging';
import {
  TAX_INVOICE_FIELDS, TABLE_COLUMN_CATALOG, buildStandardLayout, computeTableWidthMm, scaleColumnsTo, defaultColumns,
} from '../types/taxInvoiceTemplate';

// jsdom is not configured for the client suite (environment: node) — the printer's DOM measuring is
// exercised by hand; everything that decides WHAT prints and WHERE rows break is pure and tested here.

const intra = () => sampleInvoiceForPreview();
const inter = () => {
  const inv = sampleInvoiceForPreview();
  for (const it of inv.items) { it.igstAmount = it.lineTotalTax; it.cgstAmount = 0; it.sgstAmount = 0; }
  inv.taxDetails = { ...inv.taxDetails, igst: inv.taxDetails.totalTax, cgst: 0, sgst: 0 };
  return inv;
};

describe('every bound field the designer offers resolves against a real invoice', () => {
  const ctx = buildInvoiceContext(intra(), 'ORIGINAL FOR RECIPIENT');
  it('has a sample and a resolver for each key (no field is a dead option)', () => {
    const blankAllowed = new Set(['einvoice.irn', 'einvoice.ackNumber', 'einvoice.ackDate', 'ewb.number', 'ewb.validUntil', 'invoice.dueDate', 'invoice.notes', 'totals.igstRate']);
    for (const f of TAX_INVOICE_FIELDS) {
      expect(f.sample, f.key).toBeTruthy();
      const v = resolveField(f.key, ctx, { number: 1, total: 1 });
      if (!blankAllowed.has(f.key)) expect(v, `${f.key} resolved to blank`).not.toBe('');
    }
  });
  it('field keys are unique', () => {
    const keys = TAX_INVOICE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveField — statutory values come straight from the invoice snapshot', () => {
  const inv = intra();
  const ctx = buildInvoiceContext(inv, 'DUPLICATE FOR TRANSPORTER');
  it('seller / buyer / invoice identity', () => {
    expect(resolveField('seller.gstin', ctx)).toBe('24SAMPL1234F1Z5');
    expect(resolveField('seller.pan', ctx)).toBe('SAMPL1234F');
    expect(resolveField('seller.fullAddress', ctx)).toBe('1 Sample Street, Ring Road, Ahmedabad, Ahmedabad - 380001');
    expect(resolveField('buyer.registrationType', ctx)).toBe('Registered');
    expect(resolveField('invoice.copyLabel', ctx)).toBe('DUPLICATE FOR TRANSPORTER');
    expect(resolveField('invoice.supplyType', ctx)).toBe('Intra-State (CGST + SGST)');
    expect(resolveField('invoice.reverseCharge', ctx)).toBe('No');
  });
  it('money, words and rates', () => {
    expect(resolveField('totals.grandTotal', ctx)).toBe(`₹ ${Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
    expect(resolveField('totals.grandTotal', ctx, undefined, false)).not.toContain('₹');
    expect(resolveField('totals.grandTotalInWords', ctx)).toMatch(/^Rupees .* Only$/);
    expect(resolveField('totals.cgstRate', ctx)).toBe('1.5%');
    expect(resolveField('totals.igstRate', ctx)).toBe('');
  });
  it('inter-state: IGST rate shows, CGST/SGST rate do not', () => {
    const c = buildInvoiceContext(inter());
    expect(c.isInterState).toBe(true);
    expect(resolveField('totals.igstRate', c)).toBe('3%');
    expect(resolveField('totals.cgstRate', c)).toBe('');
    expect(resolveField('invoice.supplyType', c)).toBe('Inter-State (IGST)');
  });
  it('a mixed-rate bill shows no single GST rate', () => {
    const i = intra(); i.items[1].taxRate = 0.05;
    const c = buildInvoiceContext(i);
    expect(c.singleRate).toBeNull();
    expect(resolveField('totals.cgstRate', c)).toBe('');
  });
  it('unregistered buyer, reversed payments excluded, payment status', () => {
    const i = intra();
    i.client.gstNumber = null; i.taxDetails.buyerGstin = null;
    i.payments[0].reversedAt = new Date().toISOString();
    i.paidAmount = 0; i.balanceDue = i.totalAmount;
    const c = buildInvoiceContext(i);
    expect(resolveField('buyer.registrationType', c)).toBe('Unregistered (B2C)');
    expect(resolveField('payment.modes', c)).toBe('UPI');
    expect(resolveField('payment.status', c)).toBe('UNPAID');
  });
  it('page fields', () => {
    expect(resolveField('page.label', ctx, { number: 2, total: 3 })).toBe('Page 2 of 3');
  });
  it('financial year runs April to March', () => {
    expect(financialYearLabel('2026-03-31T00:00:00')).toBe('2025-26');
    expect(financialYearLabel('2026-04-01T00:00:00')).toBe('2026-27');
  });
  it('an unknown key resolves to blank, never throws', () => {
    expect(resolveField('nope.nothing', ctx)).toBe('');
  });
});

describe('interpolate', () => {
  const ctx = buildInvoiceContext(intra());
  it('mixes words and values, drops unknown keys', () => {
    expect(interpolate('GSTIN: {{seller.gstin}} / {{ invoice.number }} {{bogus.key}}', ctx, { number: 1, total: 1 }, true))
      .toBe('GSTIN: 24SAMPL1234F1Z5 / INV-2026-000123 ');
  });
  it('placeholderKeys lists every key', () => {
    expect(placeholderKeys('{{a.b}} x {{c.d}}')).toEqual(['a.b', 'c.d']);
  });
});

describe('tables', () => {
  const ctx = buildInvoiceContext(intra());
  it('items: per-line cells, weights x quantity, total row sums only summable columns', () => {
    const cols = defaultColumns('items', ['srNo', 'description', 'hsnCode', 'quantity', 'netWeight', 'taxableValue', 'cgstAmount', 'totalPrice']);
    const t = buildTableData('items', cols, ctx, true);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0][0]).toBe('1');
    expect(t.rows[0][2]).toBe('7113');
    expect(t.total![1]).toBe('Total');       // label sits in the first wide text column, not the narrow Sr column
    expect(t.total![0]).toBe('');
    expect(t.total![3]).toBe('3');           // quantity
    expect(t.total![4]).toBe('44.800');      // 8.5 + 24.2 + 12.1
    expect(t.total![2]).toBe('');            // hsn is not summable
  });
  it('items: line CGST column equals the stored amount; IGST rate blank on an intra bill', () => {
    const cols = defaultColumns('items', ['cgstRate', 'igstRate', 'cgstAmount']);
    const t = buildTableData('items', cols, ctx, false);
    expect(t.rows[0][0]).toBe('1.5%');
    expect(t.rows[0][1]).toBe('');
    expect(t.total).toBeNull();
  });
  it('hsn summary groups by HSN + rate and its taxable total equals the invoice taxable value', () => {
    const cols = defaultColumns('hsnSummary', ['hsnCode', 'taxableValue', 'taxRate', 'totalTax']);
    const t = buildTableData('hsnSummary', cols, ctx, true);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][2]).toBe('3%');
    const taxable = Number(t.total![1].replace(/,/g, ''));
    expect(taxable).toBeCloseTo(ctx.totals.taxableValue, 1);
  });
  it('a second HSN/rate becomes its own summary row', () => {
    const i = intra(); i.items[2].hsnCode = { code: '7117' }; i.items[2].taxRate = 0.12;
    const t = buildTableData('hsnSummary', defaultColumns('hsnSummary', ['hsnCode', 'taxRate']), buildInvoiceContext(i), false);
    expect(t.rows.map((r) => r.join('/'))).toEqual(['7113/3%', '7117/12%']);
  });
  it('category summary and payments', () => {
    const cat = buildTableData('categorySummary', defaultColumns('categorySummary', ['category', 'pieces']), ctx, true);
    expect(cat.rows.map((r) => r[0]).sort()).toEqual(['Necklaces', 'Rings']);
    const pay = buildTableData('payments', defaultColumns('payments', ['mode', 'amount']), ctx, true);
    expect(pay.rows.map((r) => r[0])).toEqual(['CASH', 'UPI']);
  });
  it('every catalog column of every kind produces a cell', () => {
    for (const kind of Object.keys(TABLE_COLUMN_CATALOG) as (keyof typeof TABLE_COLUMN_CATALOG)[]) {
      const cols = defaultColumns(kind, TABLE_COLUMN_CATALOG[kind].map((c) => c.field));
      const t = buildTableData(kind, cols, ctx, true);
      expect(t.rows.length).toBeGreaterThan(0);
      cols.forEach((c, j) => {
        const anyValue = t.rows.some((r) => r[j] !== '');
        const blankOk = ['cgstRate', 'sgstRate', 'igstRate', 'igstAmount', 'wastagePercent', 'stoneValue', 'discountPercent'].includes(c.field);
        if (!blankOk) expect(anyValue, `${kind}.${c.field} is blank on every row`).toBe(true);
      });
    }
  });
  it('scaleColumnsTo keeps the proportions and lands near the target width', () => {
    const cols = defaultColumns('items', ['srNo', 'description', 'totalPrice']);
    const scaled = scaleColumnsTo(cols, 120);
    expect(Math.abs(computeTableWidthMm(scaled) - 120)).toBeLessThan(2);
  });
});

describe('jewellery detail columns', () => {
  const ctx = buildInvoiceContext(intra());
  it('VA, metal value and making-with-VA derive from the line', () => {
    const t = buildTableData('items', defaultColumns('items', ['wastagePercent', 'makingCharge', 'vaAmount', 'makingWithVa', 'metalValue', 'makingRate']), ctx, true);
    expect(t.rows[0]).toEqual(['8.00', '2,000.00', '3,944.00', '5,944.00', '49,300.00', '235.29']); // VA = 8% of the 49,300 metal value
    expect(t.total![2]).toBe('20,787.20'); // 8% of the 44.8 g x 5800 metal value (259,840)
  });
  it('a line billed from a material breakdown prints its real metal / MC / VA / stone split (not MC+VA lumped, VA 0)', () => {
    // The reference ring: 10 g @ 6000, ruby 1 ct @ 1500, MC 100/g, VA 10%. The stored line is a flat 68,500 with makingCharge = MC + VA.
    const inv = intra();
    inv.items = [{
      ...inv.items[0], quantity: 1, netGoldWeight: 10, rateType: 'FIXED', goldRate: 68500, makingCharge: 7000, wastagePercent: 0, stoneValue: 1500,
      unitPrice: 68500, totalPrice: 68500,
      materialBreakdown: {
        rows: [{ materialType: 'METAL', weight: 10, rate: 6000 }, { materialType: 'STONE', weight: 1, rate: 1500 }],
        mcRate: 100, vaPercent: 10,
      },
    }];
    const c = buildInvoiceContext(inv);
    const t = buildTableData('items', defaultColumns('items', ['rate', 'wastagePercent', 'makingCharge', 'vaAmount', 'makingWithVa', 'metalValue', 'makingRate', 'stoneValue']), c, true);
    expect(t.rows[0]).toEqual(['6,000.00', '10.00', '1,000.00', '6,000.00', '7,000.00', '60,000.00', '100.00', '1,500.00']);
    expect(c.totals.metalValue).toBe(60000);
    expect(c.totals.makingCharge).toBe(1000);
    expect(c.totals.stoneValue).toBe(1500);
  });
  it('stone details, rates and amounts line up one stone per line', () => {
    const t = buildTableData('items', defaultColumns('items', ['stoneDetails', 'stoneRates', 'stoneAmounts', 'materialDetails', 'materialRates', 'stoneWeights', 'stonePieces', 'materialWeights', 'materialPieces']), ctx, false);
    expect(t.rows[0][0]).toBe('DIA');
    expect(t.rows[0][1]).toBe('45,000.00');
    expect(t.rows[0][2]).toBe('11,250.00');
    expect(t.rows[0][3].split('\n')).toEqual(['GOLD22', 'DIA']);
    expect(t.rows[0][5]).toBe('0.250');
    expect(t.rows[0][6]).toBe('3');
    expect(t.rows[0][7].split('\n')).toEqual(['8.500', '0.250']);
    expect(t.rows[0][8].split('\n')).toEqual(['', '3']);
    expect(t.rows[0][4].split('\n')).toEqual(['5,800.00', '45,000.00']);
  });
  it('a free-text line (no tag) leaves the detail columns blank', () => {
    const i = intra(); delete i.items[0].tag;
    const t = buildTableData('items', defaultColumns('items', ['stoneDetails', 'tagName']), buildInvoiceContext(i), false);
    expect(t.rows[0]).toEqual(['', '']);
  });
});

describe('standard layout', () => {
  it('uses only fields/columns the designer offers, and its tables fit the page', () => {
    const l = buildStandardLayout();
    const keys = new Set(TAX_INVOICE_FIELDS.map((f) => f.key));
    for (const el of l.elements) {
      if (el.boundField) expect(keys.has(el.boundField), el.boundField).toBe(true);
      for (const k of placeholderKeys(el.literalText ?? '')) expect(keys.has(k), k).toBe(true);
      if (el.type === 'table') {
        const allowed = new Set(TABLE_COLUMN_CATALOG[el.tableKind!].map((c) => c.field));
        for (const c of el.columns!) expect(allowed.has(c.field), c.field).toBe(true);
        expect(el.xMm + computeTableWidthMm(el.columns)).toBeLessThanOrEqual(l.page.widthMm + 0.5);
      }
    }
    expect(l.elements.some((e) => e.type === 'table' && e.tableKind === 'items')).toBe(true);
  });
  it('carries over legacy title and item columns', () => {
    const l = buildStandardLayout({ title: 'BILL OF SUPPLY', itemFields: ['srNo', 'hsnCode'] });
    expect(l.elements.find((e) => e.literalText === 'BILL OF SUPPLY')).toBeTruthy();
    expect(l.elements.find((e) => e.tableKind === 'items')!.columns!.map((c) => c.field)).toEqual(['srNo', 'hsnCode']);
  });
});

describe('planPages', () => {
  const base = {
    pageHeightMm: 297, tableTopMm: 70, reservedMm: 110, headerMm: 6, totalRowMm: 6,
    contTopMm: 12, belowBottomMm: 292, bottomMarginMm: 8,
  };
  const rows = (n: number, h = 8) => Array(n).fill(h);

  it('few lines: one page, nothing moves, the grid is padded to its reserved bottom', () => {
    const [p, ...rest] = planPages({ ...base, rowMm: rows(3) });
    expect(rest).toHaveLength(0);
    expect(p).toMatchObject({ isFirst: true, isLast: true, rowStart: 0, rowEnd: 3, withTotal: true, shiftMm: 0 });
    expect(p.fillMm).toBeCloseTo(110 - (6 + 24 + 6), 5);
  });
  it('lines that overflow the reservation but still fit the page push the below block down by exactly the overflow', () => {
    // 6 + 14*8 + 6 = 124 > 110 reserved; below block bottom 292 + 14 = 306 > 297 → needs a smaller bottom for this case
    const [p, ...rest] = planPages({ ...base, belowBottomMm: 270, rowMm: rows(14) });
    expect(rest).toHaveLength(0);
    expect(p.shiftMm).toBeCloseTo(124 - 110, 5);
    expect(p.fillMm).toBe(0);
  });
  it('too many lines: continues on a further page, header/total handled, below block only on the last page', () => {
    const pages = planPages({ ...base, rowMm: rows(40) });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toMatchObject({ isFirst: true, isLast: false, withTotal: false, shiftMm: 0 });
    const last = pages[pages.length - 1];
    expect(last).toMatchObject({ isLast: true, withTotal: true });
    // every row is printed exactly once, in order
    let next = 0;
    for (const p of pages) { expect(p.rowStart).toBe(next); next = p.rowEnd; }
    expect(next).toBe(40);
    // no non-final page runs below the page's bottom margin
    for (const p of pages.filter((x) => !x.isLast)) expect(p.topMm + p.usedMm).toBeLessThanOrEqual(297 - 8 + 0.01);
    // the last page's below block fits on the page
    expect(base.belowBottomMm + last.shiftMm).toBeLessThanOrEqual(297 + 0.01);
  });
  it('zero lines still produces one page with the total row', () => {
    const pages = planPages({ ...base, rowMm: [] });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ rowStart: 0, rowEnd: 0, isLast: true });
  });
  it('a below block taller than any page terminates instead of looping', () => {
    const pages = planPages({ ...base, belowBottomMm: 900, rowMm: rows(5) });
    expect(pages.length).toBeLessThanOrEqual(8);
    expect(pages[pages.length - 1].isLast).toBe(true);
    expect(pages[pages.length - 1].rowEnd).toBe(5);
  });
  it('a single row taller than a page still makes progress', () => {
    const pages = planPages({ ...base, rowMm: [400, 400] });
    expect(pages[pages.length - 1].rowEnd).toBe(2);
  });
});
