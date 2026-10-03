import { describe, it, expect, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildCanonicalIrnRequest, formatDocumentDate, formatIrpDate } from './eInvoiceRequestBuilder';
import { EInvoiceSource } from './eInvoice.types';
import { makeGstin } from './eInvoice.testUtil';

// G8c hardening: invoice business date (IST calendar day) and unit-price / line-value reconciliation.
const SELLER = makeGstin('24', 'SELLR', '1111');
const BUYER = makeGstin('24', 'BUYER', '2222');
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Item = EInvoiceSource['items'][number];

function line(over: Partial<Item> & { id: string; quantity: number; taxableValue: string }): Item {
  const taxable = Number(over.taxableValue);
  const half = r2(taxable * 0.015);
  return { description: 'Gold ring', uqc: 'PCS', hsnCode: '7113', taxRate: '0.03', lineDiscountAmount: '0', cgstAmount: String(half), sgstAmount: String(half), igstAmount: '0', ...over };
}

function source(items: Item[], inv: Partial<EInvoiceSource['invoice']> = {}): EInvoiceSource {
  const taxable = items.reduce((a, i) => a + Number(i.taxableValue), 0);
  const tax = items.reduce((a, i) => a + Number(i.cgstAmount) + Number(i.sgstAmount) + Number(i.igstAmount), 0);
  return {
    documentType: 'INV',
    registration: { id: 'reg1', companyId: 'co1', gstin: SELLER, isActive: true },
    invoice: {
      id: 'inv1', companyId: 'co1', invoiceNumber: 'INV/2026/0001', invoiceDate: new Date('2026-09-15T00:00:00Z'), status: 'ISSUED', currency: 'INR',
      subtotal: String(taxable), discountAmount: '0', otherCharges: '0', taxAmount: String(r2(tax)), roundOff: '0', totalAmount: String(r2(taxable + tax)),
      branchGstRegistrationId: null, ...inv,
    },
    tax: {
      gstin: SELLER, placeOfSupply: '24', reverseCharge: false, cgst: String(r2(tax / 2)), sgst: String(r2(tax / 2)), igst: '0', cess: '0', irn: null,
      sellerRegistrationId: 'reg1', sellerLegalName: 'Seller Jewels Pvt Ltd', sellerTradeName: 'Seller Jewels', sellerStateCode: '24',
      sellerAddress: '12 Ring Road', sellerCity: 'Surat', sellerPincode: '395002',
      buyerName: 'Buyer Traders', buyerGstin: BUYER, buyerAddress: '5 Market Street', buyerCity: 'Ahmedabad', buyerStateCode: '24', buyerPincode: '380001', buyerCountry: 'India',
    },
    items,
  };
}

describe('G8c hardening — invoice business date', () => {
  const originalTz = process.env.TZ;
  afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

  it('a normal Indian business date (date picker → UTC midnight) keeps its calendar day', () => {
    const d = new Date('2026-09-15T00:00:00Z');
    expect(formatDocumentDate(d)).toBe('2026-09-15');
    expect(formatIrpDate(d)).toBe('15/09/2026');
  });

  it('IST midnight boundary: 00:30 IST is still that IST day (UTC would say the day before); 23:59 IST does not roll over', () => {
    const justAfterIstMidnight = new Date('2026-09-14T19:00:00Z'); // 00:30 IST on 15th
    expect(justAfterIstMidnight.toISOString().slice(0, 10)).toBe('2026-09-14'); // the old, wrong answer
    expect(formatDocumentDate(justAfterIstMidnight)).toBe('2026-09-15');
    expect(formatIrpDate(new Date('2026-09-15T18:29:59Z'))).toBe('15/09/2026'); // 23:59:59 IST
    expect(formatIrpDate(new Date('2026-09-15T18:30:00Z'))).toBe('16/09/2026'); // 00:00:00 IST next day
  });

  it('financial-year / month / year edges', () => {
    expect(formatIrpDate(new Date('2026-03-31T20:00:00Z'))).toBe('01/04/2026'); // 01:30 IST
    expect(formatIrpDate(new Date('2025-12-31T19:00:00Z'))).toBe('01/01/2026');
  });

  it('the builder uses it, from a real Prisma-returned DateTime (Date instance) for the persisted invoice', () => {
    const fromDb = new Date('2026-09-14T19:00:00.000Z'); // what Prisma hands back for a timestamptz
    expect(fromDb).toBeInstanceOf(Date);
    const req = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 1, taxableValue: '1000' })], { invoiceDate: fromDb }));
    expect(req.documentDate).toBe('2026-09-15');
  });

  it('is identical under every runtime timezone', () => {
    const instants = ['2026-09-14T19:00:00Z', '2026-09-15T00:00:00Z', '2026-09-15T18:29:59Z', '2026-03-31T20:00:00Z'].map((s) => new Date(s));
    const expected = instants.map((d) => formatIrpDate(d));
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect(instants.map((d) => formatIrpDate(d)), tz).toEqual(expected);
      expect(buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 1, taxableValue: '1000' })], { invoiceDate: instants[0] })).documentDate, tz).toBe('2026-09-15');
    }
  });
});

describe('G8c hardening — unit price / line value reconciliation', () => {
  it('integer quantity + decimal unit price: the persisted 2-dp unit price is kept and reproduces the line value', () => {
    const req = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 3, unitPrice: new Prisma.Decimal('3333.33'), taxableValue: '9999.99' })]));
    expect(req.lines[0]).toMatchObject({ unitPrice: 3333.33, grossAmount: 9999.99, unitPriceDrift: 0 });
    expect(r2(req.lines[0].quantity * req.lines[0].unitPrice)).toBe(req.lines[0].grossAmount);
  });

  it('quantity x unit-price drift: persisted 2-dp price does not reproduce the line, so a 3-dp price that does is chosen', () => {
    // qty 7, persisted line value 100.00, persisted unit 14.29 (7 x 14.29 = 100.03) — the old r3(gross/qty) = 14.286 case
    const req = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 7, unitPrice: '14.29', taxableValue: '100' })]));
    expect(req.lines[0].unitPrice).toBe(14.286);
    expect(req.lines[0].unitPriceDrift).toBe(0);
    expect(r2(7 * 14.286)).toBe(100);
    expect(req.lines[0].grossAmount).toBe(100); // value untouched
  });

  it('unreconcilable at 3 dp: the paisa gap is reported, the persisted value is never altered', () => {
    const req = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 100, taxableValue: '100.01' })]));
    expect(req.lines[0].grossAmount).toBe(100.01);
    expect(req.lines[0].unitPrice).toBe(1);
    expect(req.lines[0].unitPriceDrift).toBe(0.01);
    expect(r2(req.lines[0].quantity * req.lines[0].unitPrice + req.lines[0].unitPriceDrift)).toBe(100.01);
  });

  it('fractional quantity (not persisted today — InvoiceItem.quantity is Int — but the maths must hold)', () => {
    const req = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 2.5, unitPrice: '400', taxableValue: '1000' })]));
    expect(req.lines[0]).toMatchObject({ unitPrice: 400, unitPriceDrift: 0, grossAmount: 1000 });
  });

  it('discount: gross = persisted taxable + persisted discount share; tax is the persisted tax, never recomputed', () => {
    const req = buildCanonicalIrnRequest(source(
      [line({ id: 'a', quantity: 2, unitPrice: '5000', taxableValue: '9500', lineDiscountAmount: '500', cgstAmount: '142.5', sgstAmount: '142.5' })],
      { discountAmount: '500', subtotal: '10000', taxAmount: '285', totalAmount: '9785' },
    ));
    expect(req.lines[0]).toMatchObject({ grossAmount: 10000, discountAmount: 500, taxableValue: 9500, unitPrice: 5000, unitPriceDrift: 0, cgstAmount: 142.5, sgstAmount: 142.5 });
  });

  it('multiple lines with other charges and round-off: totals reconcile to the persisted invoice total', () => {
    const items = [
      line({ id: 'a', quantity: 3, unitPrice: '3333.33', taxableValue: '9999.99' }),
      line({ id: 'b', quantity: 7, unitPrice: '14.29', taxableValue: '100' }),
      line({ id: 'c', quantity: 1, unitPrice: '2500.5', taxableValue: '2500.5' }),
    ];
    const taxable = r2(9999.99 + 100 + 2500.5);
    const tax = items.reduce((a, i) => a + Number(i.cgstAmount) + Number(i.sgstAmount), 0);
    const total = r2(taxable + tax + 20 + 0.31);
    const req = buildCanonicalIrnRequest(source(items, { otherCharges: '20', roundOff: '0.31', subtotal: String(taxable), taxAmount: String(r2(tax)), totalAmount: String(total) }));

    expect(req.totals.taxableValue).toBe(taxable);
    expect(req.totals.otherCharges).toBe(20);
    expect(req.totals.roundOff).toBe(0.31);
    expect(req.totals.invoiceTotal).toBe(total);
    // internal consistency of the canonical request against the persisted values
    expect(r2(req.totals.taxableValue + req.totals.cgst + req.totals.sgst + req.totals.igst + req.totals.otherCharges + req.totals.roundOff)).toBe(req.totals.invoiceTotal);
    for (const l of req.lines) {
      expect(r2(l.grossAmount - l.discountAmount)).toBe(l.taxableValue);
      expect(r2(l.quantity * l.unitPrice + l.unitPriceDrift)).toBe(l.grossAmount);
      expect(l.totalAmount).toBe(r2(l.taxableValue + l.cgstAmount + l.sgstAmount + l.igstAmount));
    }
  });

  it('no persisted unit price supplied → falls back deterministically and still reconciles', () => {
    const a = buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 3, taxableValue: '1000' })]));
    expect(a.lines[0].unitPrice).toBe(333.333);
    expect(a.lines[0].unitPriceDrift).toBe(0);
    expect(r2(3 * a.lines[0].unitPrice + a.lines[0].unitPriceDrift)).toBe(1000);
    expect(buildCanonicalIrnRequest(source([line({ id: 'a', quantity: 3, taxableValue: '1000' })]))).toEqual(a);
  });
});
