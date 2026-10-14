import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayBookView, MoneyInCard, pageRows, money } from '../pages/Reports/DayBook';

// What GET /finance/reports/day-book returns for a busy day: 12 receipts (6 cash + 6 UPI) and 7 advances
// (4 card + 3 cash), so the lists need paging while the section totals and mode cards cover every row.
const receipts = Array.from({ length: 12 }, (_, i) => ({
  paymentNumber: `PMT-${String(i + 1).padStart(2, '0')}`, client: `Payer ${i + 1}`, mode: i % 2 ? 'UPI' : 'CASH',
  amount: 100 * (i + 1), invoiceNumber: i === 0 ? null : `INV-${i + 1}`,
}));
const advances = Array.from({ length: 7 }, (_, i) => ({
  advanceNumber: `ADV-${String(i + 1).padStart(2, '0')}`, client: `Depositor ${i + 1}`, mode: i % 2 ? 'CASH' : 'CARD',
  payments: [{ mode: i % 2 ? 'CASH' : 'CARD', amount: 50 * (i + 1) }], amount: 50 * (i + 1), applied: 0, available: 50 * (i + 1),
}));
// Six cross-day reversals of ₹50 cash advances taken on an earlier day: ₹300 money out today.
const reversals = Array.from({ length: 6 }, (_, i) => ({
  advanceNumber: `REV-${String(i + 1).padStart(2, '0')}`, client: `Canceller ${i + 1}`, amount: 50, payments: [{ mode: 'CASH', amount: 50 }],
  originalDate: '2026-08-09T06:30:00.000Z', reversedAt: '2026-08-10T05:00:00.000Z', reason: 'cancelled',
}));
const DATA = {
  net: { sales: 20000, salesDebitNotes: 0, returns: 0, creditNotes: 0, netSales: 20000, collected: 7800, metalExchanged: 0, balanceChange: 12200, advancesReceived: 1400, totalMoneyIn: 9200, totalMoneyOut: 300, netMoneyMovement: 8900 },
  moneyOut: { count: 6, total: 300, byMode: [{ mode: 'CASH', amount: 300 }], rows: reversals },
  moneyIn: {
    receiptsTotal: 7800, advancesTotal: 1400, total: 9200, otherModesTotal: 0,
    byMode: [
      { mode: 'CARD', receipts: 0, advances: 800, total: 800, out: 0, net: 800, recognised: true },
      { mode: 'CASH', receipts: 3600, advances: 600, total: 4200, out: 300, net: 3900, recognised: true },
      { mode: 'UPI', receipts: 4200, advances: 0, total: 4200, out: 0, net: 4200, recognised: true },
      { mode: 'CHEQUE', receipts: 0, advances: 0, total: 0, out: 0, net: 0, recognised: false },
    ],
  },
  sales: { count: 0, totalAmount: 0, rows: [] },
  payments: { count: 12, total: 7800, byMode: [], rows: receipts },
  advances: { count: 7, totalAmount: 1400, rows: advances },
  returns: { count: 0, totalAmount: 0, rows: [] },
  exchanges: { count: 0, totalAmount: 0, rows: [] },
  metalExchange: { count: 0, totalAmount: 0, byMetal: [] },
  creditNotes: { count: 0, totalAmount: 0, rows: [] },
};
const html = (data: any = DATA) => renderToStaticMarkup(<DayBookView data={data} />);

describe('Day Book — money in by mode', () => {
  it('shows payments and advances per mode, plus Total Money In = payments + advances', () => {
    const out = renderToStaticMarkup(<MoneyInCard data={DATA} />);
    expect(out).toContain('Money In by Mode');
    expect(out).toContain('₹4,200.00'); // CASH total (3,600 payments + 600 advances)
    expect(out).toContain('₹3,600.00');
    expect(out).toContain('₹800.00');   // CARD is advances only
    expect(out).toContain('Total Money In');
    expect(out).toContain('₹9,200.00');
    expect(out).toContain('Payments ₹7,800.00'); // payments + advances breakdown line
    expect(out).toContain('Advances ₹1,400.00');
    expect(out).toContain('other'); // a mode that is not Cash/UPI/Card is labelled, not folded in
  });

  it('keeps Payments Received and Advances Received as separate sections with their own counts and totals', () => {
    const out = html();
    expect(out).toContain('Payments Received (12)');
    expect(out).toContain('Advances Received (7)');
    expect(out).toContain('₹7,800.00'); // receipts-only total
    expect(out).toContain('₹1,400.00'); // advances-only total
  });
});

describe('Day Book — money out (advance reversals)', () => {
  it('the mode card adds Money Out and Net per mode and the three totals; gross Money In is not reduced', () => {
    const out = renderToStaticMarkup(<MoneyInCard data={DATA} />);
    expect(out).toContain('Money Out');
    expect(out).toContain('Net');
    expect(out).toContain('₹300.00');   // CASH out
    expect(out).toContain('₹3,900.00'); // CASH net = 4,200 - 300
    expect(out).toContain('Total Money In');
    expect(out).toContain('₹9,200.00'); // gross, unchanged by the reversal
    expect(out).toContain('Total Money Out');
    expect(out).toContain('Net Money Movement');
    expect(out).toContain('₹8,900.00'); // 9,200 - 300
  });

  it('lists each reversal once with its reference, customer, original mode, original date and amount, 5 per page', () => {
    const out = html();
    expect(out).toContain('Advance Reversals (Money Out) (6)');
    expect(out).toContain('REV-01');
    expect(out).toContain('REV-05');
    expect(out).not.toContain('REV-06'); // page 2
    expect(out).toContain('Canceller 1');
    expect(out).toContain('09/08/2026');  // taken on (India date of the original advance)
    expect(out).toContain('1–5 of 6');
    expect(out).toContain('₹300.00');     // total of all six, not just the five shown
  });

  it('a reversed advance stays in Advances Received, marked Reversed', () => {
    const marked = { ...DATA, advances: { ...DATA.advances, rows: [{ ...advances[0], reversed: true, available: 0 }, ...advances.slice(1)] } };
    const out = html(marked);
    expect(out).toContain('Reversed');
    expect(out).toContain('Advances Received (7)'); // gross: the reversal does not remove it
  });

  it('a day with more out than in shows a negative net as -₹x, not ₹-x', () => {
    expect(money(-9666)).toBe('-₹9,666.00');
    expect(money(9666)).toBe('₹9,666.00');
    expect(money(0)).toBe('₹0.00');
    const crossDay = { ...DATA, moneyIn: { ...DATA.moneyIn, total: 333 }, moneyOut: { ...DATA.moneyOut, total: 9999 }, net: { ...DATA.net, totalMoneyOut: 9999, netMoneyMovement: -9666 } };
    expect(renderToStaticMarkup(<MoneyInCard data={crossDay} />)).toContain('-₹9,666.00');
  });

  it('with no reversals the list says so and the net equals Money In', () => {
    const none = { ...DATA, moneyOut: { count: 0, total: 0, byMode: [], rows: [] }, net: { ...DATA.net, totalMoneyOut: 0, netMoneyMovement: 9200 } };
    const out = html(none);
    expect(out).toContain('No advances reversed');
    expect(renderToStaticMarkup(<MoneyInCard data={none} />)).toContain('₹9,200.00');
  });
});

describe('Day Book — paging', () => {
  it('shows 5 rows per list by default, with the count and totals covering every row', () => {
    const out = html();
    for (const n of ['PMT-01', 'PMT-05']) expect(out).toContain(n);
    for (const n of ['PMT-06', 'PMT-12']) expect(out).not.toContain(n);
    for (const n of ['ADV-01', 'ADV-05']) expect(out).toContain(n);
    for (const n of ['ADV-06', 'ADV-07']) expect(out).not.toContain(n);
    expect(out).toContain('Payments Received (12)');
    expect(out).toContain('₹7,800.00'); // not the five visible rows' sum (1,500)
    expect(out).toContain('₹9,200.00'); // mode cards unaffected by the page
    expect(out).toContain('1–5 of 12');
    expect(out).toContain('1–5 of 7');
  });

  it('a list that fits one page has no pager', () => {
    const out = html({ ...DATA, payments: { ...DATA.payments, count: 3, rows: receipts.slice(0, 3) }, advances: { count: 0, totalAmount: 0, rows: [] } });
    expect(out).not.toContain('of 3');
    expect(out).toContain('No advances');
  });

  it('pageRows slices the requested page and leaves the source untouched', () => {
    expect(pageRows(receipts, 0, 5).map((r) => r.paymentNumber)).toEqual(['PMT-01', 'PMT-02', 'PMT-03', 'PMT-04', 'PMT-05']);
    expect(pageRows(receipts, 2, 5).map((r) => r.paymentNumber)).toEqual(['PMT-11', 'PMT-12']);
    expect(pageRows(receipts, 1, 10)).toHaveLength(2);
    expect(receipts).toHaveLength(12);
  });
});

describe('Day Book — rows', () => {
  it('labels a payment with no invoice "On account" and shows an advance\'s unused amount', () => {
    const out = html();
    expect(out).toContain('On account');
    expect(out).toContain('Unused');
    expect(out).toContain('INV-2');
  });

  it('shows a split advance by its legs', () => {
    const split = { advanceNumber: 'ADV-S', client: 'Split Payer', mode: 'SPLIT', payments: [{ mode: 'CASH', amount: 1500 }, { mode: 'UPI', amount: 2500 }], amount: 4000, applied: 0, available: 4000 };
    expect(html({ ...DATA, advances: { count: 1, totalAmount: 4000, rows: [split] } })).toContain('CASH + UPI');
  });
});
