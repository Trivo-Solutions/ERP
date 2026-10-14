import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // fixtures act as the platform role; the code under test uses the runtime client
import { getDayBook } from './finance.service';
import { createCustomerAdvance, reverseCustomerAdvance } from '../sales/customerAdvance.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Day Book "money in": Cash / UPI / Card (and any other mode) = receipts + advances taken that day.
// Rows are written directly so each case can pin its own India business day; every `it` uses a day
// of its own (a May 2026 date) so no case sees another's rows.
describe('getDayBook — money in by payment mode (receipts + advances)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let clientA: string; let clientB: string;
  let n = 0;
  const invoiceIds: string[] = [];
  const serviceAdvanceIds: string[] = [];

  /** Noon IST of May `d` 2026 — the instant a test passes to getDayBook / uses for its rows. */
  const noon = (d: number) => new Date(`2026-05-${String(d).padStart(2, '0')}T12:00:00.000+05:30`);

  const receipt = (mode: string, amount: number, at: Date, extra: Record<string, unknown> = {}, t = A, clientId = clientA) =>
    prisma.invoicePayment.create({
      data: { companyId: t.company.id, paymentNumber: `TSTPMT-MI-${suffix}-${n++}`, clientId, paymentDate: at, amount, mode, ...extra },
    });
  const advance = (legs: Array<[string, number]>, at: Date, extra: Record<string, unknown> = {}, t = A, clientId = clientA) =>
    prisma.customerAdvance.create({
      data: {
        companyId: t.company.id, branchId: t.branch.id, clientId, advanceNumber: `TSTADV-MI-${suffix}-${n++}`, advanceDate: at,
        amount: legs.reduce((s, [, a]) => s + a, 0), mode: legs.length === 1 ? legs[0][0] : 'SPLIT', createdById: t.user.id,
        payments: { create: legs.map(([mode, amount]) => ({ mode, amount })) },
        ...extra,
      },
    });

  type Book = Awaited<ReturnType<typeof getDayBook>>;
  const mode = (r: Book, m: string) => r.moneyIn.byMode.find((x) => x.mode === m);
  // The invariant every case must hold: nothing double-counted, nothing dropped.
  function expectReconciled(r: Book) {
    expect(r.moneyIn.total).toBeCloseTo(r.payments.total + r.advances.totalAmount, 2);
    expect(r.net.totalMoneyIn).toBeCloseTo(r.moneyIn.total, 2);
    expect(r.moneyIn.receiptsTotal).toBeCloseTo(r.payments.total, 2);
    expect(r.moneyIn.advancesTotal).toBeCloseTo(r.advances.totalAmount, 2);
    expect(r.moneyIn.byMode.reduce((s, m) => s + m.total, 0)).toBeCloseTo(r.moneyIn.total, 2);
    for (const m of r.moneyIn.byMode) expect(m.total).toBeCloseTo(m.receipts + m.advances, 2);
    // Money out (reversed advances) and net movement: every mode row nets, and the rows add up to the overall net.
    expect(r.net.totalMoneyIn).toBeCloseTo(r.moneyIn.total, 2);
    expect(r.net.totalMoneyOut).toBeCloseTo(r.moneyOut.total, 2);
    expect(r.net.netMoneyMovement).toBeCloseTo(r.moneyIn.total - r.moneyOut.total, 2);
    expect(r.moneyIn.byMode.reduce((s, m) => s + m.out, 0)).toBeCloseTo(r.moneyOut.total, 2);
    expect(r.moneyIn.byMode.reduce((s, m) => s + m.net, 0)).toBeCloseTo(r.net.netMoneyMovement, 2);
    for (const m of r.moneyIn.byMode) expect(m.net).toBeCloseTo(m.total - m.out, 2);
    expect(r.moneyOut.rows.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(r.moneyOut.total, 2);
  }

  beforeAll(async () => {
    A = await createTestTenant(`MIA${suffix}`, []);
    B = await createTestTenant(`MIB${suffix}`, []);
    clientA = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `TSTCL-MI-A-${suffix}`, name: 'Money-in Client A', type: 'RETAIL' } })).id;
    clientB = (await prisma.client.create({ data: { companyId: B.company.id, clientCode: `TSTCL-MI-B-${suffix}`, name: 'Money-in Client B', type: 'RETAIL' } })).id;
  }, 60_000);

  afterAll(async () => {
    await cleanupJournalEntries(serviceAdvanceIds);
    await prisma.customerAdvanceApplication.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.invoicePayment.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.customerAdvancePayment.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.customerAdvance.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientA, clientB] } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  it.each([['CASH', 5000], ['UPI', 3200.5], ['CARD', 1800]])('a %s receipt alone is that mode\'s whole money in', async (m, amt) => {
    const day = m === 'CASH' ? 1 : m === 'UPI' ? 2 : 3;
    await receipt(m, amt, noon(day));
    const r = await getDayBook(A.company.id, noon(day));
    expect(r.moneyIn.byMode).toEqual([{ mode: m, receipts: amt, advances: 0, total: amt, out: 0, net: amt, recognised: true }]);
    expect(r.moneyOut).toMatchObject({ count: 0, total: 0, rows: [], byMode: [] });
    expect(r.payments.total).toBeCloseTo(amt);
    expect(r.advances.count).toBe(0);
    expectReconciled(r);
  });

  it('cash, UPI and card advances each land in their own mode, with no receipts', async () => {
    await advance([['CASH', 10000]], noon(4));
    await advance([['UPI', 20000]], noon(4));
    await advance([['CARD', 30000]], noon(4));
    const r = await getDayBook(A.company.id, noon(4));
    expect(mode(r, 'CASH')).toMatchObject({ receipts: 0, advances: 10000, total: 10000 });
    expect(mode(r, 'UPI')).toMatchObject({ receipts: 0, advances: 20000, total: 20000 });
    expect(mode(r, 'CARD')).toMatchObject({ receipts: 0, advances: 30000, total: 30000 });
    expect(r.payments.count).toBe(0);
    expect(r.payments.total).toBe(0);
    expect(r.advances.count).toBe(3);
    expect(r.advances.totalAmount).toBe(60000);
    expect(r.moneyIn.total).toBe(60000);
    expectReconciled(r);
  });

  it('a receipt and an advance in the same mode on the same day add up, yet stay separate sections', async () => {
    await receipt('CASH', 5000, noon(5));
    await advance([['CASH', 2000]], noon(5));
    const r = await getDayBook(A.company.id, noon(5));
    expect(mode(r, 'CASH')).toMatchObject({ receipts: 5000, advances: 2000, total: 7000 });
    // Payments Received stays receipts-only — an advance is never reported as an invoice receipt.
    expect(r.payments.total).toBe(5000);
    expect(r.payments.count).toBe(1);
    expect(r.payments.byMode).toEqual([{ mode: 'CASH', total: 5000 }]);
    expect(r.payments.rows).toHaveLength(1);
    expect(r.advances.totalAmount).toBe(2000);
    expect(r.advances.rows).toHaveLength(1);
    expect(r.moneyIn.total).toBe(7000);
    expectReconciled(r);
  });

  it('mixed modes across receipts and advances, a split advance by its legs, and an unusual mode kept explicit', async () => {
    await receipt('CASH', 1000, noon(6));
    await receipt('upi', 4000, noon(6));            // stored lower-case: grouped with UPI, not a separate row
    await receipt('CHEQUE', 700, noon(6));          // not Cash/UPI/Card — must stay its own row
    await advance([['CASH', 1500], ['UPI', 2500]], noon(6)); // header mode 'SPLIT'
    await advance([['CARD', 900]], noon(6));
    const r = await getDayBook(A.company.id, noon(6));

    expect(mode(r, 'CASH')).toMatchObject({ receipts: 1000, advances: 1500, total: 2500, recognised: true });
    expect(mode(r, 'UPI')).toMatchObject({ receipts: 4000, advances: 2500, total: 6500, recognised: true });
    expect(mode(r, 'CARD')).toMatchObject({ receipts: 0, advances: 900, total: 900, recognised: true });
    expect(mode(r, 'CHEQUE')).toMatchObject({ receipts: 700, advances: 0, total: 700, recognised: false });
    expect(r.moneyIn.byMode.map((m) => m.mode)).toEqual(['CARD', 'CASH', 'UPI', 'CHEQUE']); // recognised first, then others
    expect(r.moneyIn.otherModesTotal).toBe(700);
    expect(r.moneyIn.total).toBe(1000 + 4000 + 700 + 4000 + 900);
    expect(r.advances.rows.find((a) => a.mode === 'SPLIT')!.payments).toEqual([{ mode: 'CASH', amount: 1500 }, { mode: 'UPI', amount: 2500 }]);
    expectReconciled(r);
  });

  // SUPERSEDES "a reversed advance is excluded" (J3 Decision 1, for customer advances): the receipt stays on its own
  // day as gross money in, and the reversal is reported once as money out on the day it happened.
  it('keeps a same-day reversed advance as money in AND shows the reversal as money out, netting to zero', async () => {
    const live = await advance([['CASH', 8000]], noon(7));
    const rev = await advance([['UPI', 9999]], noon(7), { reversedAt: new Date('2026-05-07T15:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'entered twice' });
    const r = await getDayBook(A.company.id, noon(7));
    // gross receipts: both advances were taken that day
    expect(r.advances.count).toBe(2);
    expect(r.advances.totalAmount).toBe(17999);
    expect(r.advances.rows.find((x) => x.advanceNumber === rev.advanceNumber)).toMatchObject({ reversed: true, amount: 9999, available: 0 });
    expect(r.advances.rows.find((x) => x.advanceNumber === live.advanceNumber)).toMatchObject({ reversed: false, amount: 8000 });
    expect(r.moneyIn.total).toBe(17999);
    expect(r.payments.total).toBe(0); // receipts-only fields untouched
    // the reversal, once, with its reference, customer, amount, original mode and reversal time
    expect(r.moneyOut.rows).toHaveLength(1);
    expect(r.moneyOut.rows[0]).toMatchObject({
      advanceNumber: rev.advanceNumber, client: 'Money-in Client A', amount: 9999, reason: 'entered twice',
      payments: [{ mode: 'UPI', amount: 9999 }],
    });
    expect(new Date(r.moneyOut.rows[0].reversedAt).toISOString()).toBe('2026-05-07T09:30:00.000Z');
    expect(r.moneyOut.total).toBe(9999);
    expect(mode(r, 'UPI')).toMatchObject({ advances: 9999, total: 9999, out: 9999, net: 0 });
    expect(mode(r, 'CASH')).toMatchObject({ advances: 8000, out: 0, net: 8000 });
    expect(r.net.netMoneyMovement).toBe(8000);
    expectReconciled(r);
  });

  it('a same-day reversal alone nets to zero overall', async () => {
    await advance([['CASH', 3000]], noon(16), { reversedAt: new Date('2026-05-16T14:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'wrong customer' });
    const r = await getDayBook(A.company.id, noon(16));
    expect(r.moneyIn.total).toBe(3000);
    expect(r.moneyOut.total).toBe(3000);
    expect(r.net.netMoneyMovement).toBe(0);
    expect(mode(r, 'CASH')).toMatchObject({ advances: 3000, out: 3000, net: 0 });
    expect(r.payments).toMatchObject({ count: 0, total: 0, byMode: [] });
    expectReconciled(r);
  });

  it('a cross-day reversal never changes the original day, and shows once as money out on the reversal day', async () => {
    const a = await advance([['UPI', 5000]], noon(17));
    const before = await getDayBook(A.company.id, noon(17));
    expect(before.moneyIn.total).toBe(5000);

    await prisma.customerAdvance.update({ where: { id: a.id }, data: { reversedAt: new Date('2026-05-18T11:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'customer cancelled' } });

    const after = await getDayBook(A.company.id, noon(17));
    // the original day's money figures are exactly what they were before the reversal
    expect(after.moneyIn).toEqual(before.moneyIn);
    expect(after.net).toEqual(before.net);
    expect(after.payments).toEqual(before.payments);
    expect(after.moneyOut.total).toBe(0);
    expect(after.net.netMoneyMovement).toBe(5000);
    expectReconciled(after);

    const next = await getDayBook(A.company.id, noon(18));
    expect(next.advances.count).toBe(0); // not received that day
    expect(next.moneyIn.total).toBe(0);
    expect(next.moneyOut.total).toBe(5000);
    expect(next.moneyOut.count).toBe(1);
    expect(next.moneyOut.rows[0]).toMatchObject({ advanceNumber: a.advanceNumber, client: 'Money-in Client A', amount: 5000, payments: [{ mode: 'UPI', amount: 5000 }] });
    expect(new Date(next.moneyOut.rows[0].originalDate).toISOString()).toBe(noon(17).toISOString());
    expect(next.net.netMoneyMovement).toBe(-5000);
    expect(next.moneyIn.byMode).toEqual([{ mode: 'UPI', receipts: 0, advances: 0, total: 0, out: 5000, net: -5000, recognised: true }]);
    expectReconciled(next);
  });

  it('mixed day: gross in, same-day and earlier-advance reversals out, every mode and the overall net reconcile', async () => {
    await advance([['UPI', 700]], noon(20), { reversedAt: new Date('2026-05-21T09:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'earlier advance, reversed today' });
    await receipt('CASH', 1000, noon(21));
    await advance([['UPI', 2000]], noon(21));
    await advance([['CASH', 600], ['CARD', 400]], noon(21), { reversedAt: new Date('2026-05-21T13:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'split, reversed same day' });
    const r = await getDayBook(A.company.id, noon(21));
    expect(r.moneyIn.total).toBe(4000); // gross: 1000 receipt + 2000 + 1000 advances (reversals do not reduce it)
    expect(r.moneyOut.total).toBe(1700); // 1000 same-day split + 700 earlier advance
    expect(r.net.netMoneyMovement).toBe(2300);
    expect(r.moneyOut.byMode).toEqual(expect.arrayContaining([{ mode: 'CASH', amount: 600 }, { mode: 'CARD', amount: 400 }, { mode: 'UPI', amount: 700 }]));
    expect(mode(r, 'CASH')).toMatchObject({ receipts: 1000, advances: 600, out: 600, net: 1000 });
    expect(mode(r, 'UPI')).toMatchObject({ advances: 2000, out: 700, net: 1300 });
    expect(mode(r, 'CARD')).toMatchObject({ advances: 400, out: 400, net: 0 });
    expect(r.moneyOut.rows.find((x) => x.reason === 'split, reversed same day')!.payments).toEqual([{ mode: 'CASH', amount: 600 }, { mode: 'CARD', amount: 400 }]);
    expectReconciled(r);
    // the earlier advance's own day is untouched by today's reversal
    const d20 = await getDayBook(A.company.id, noon(20));
    expect(d20.moneyIn.total).toBe(700);
    expect(d20.moneyOut.total).toBe(0);
  });

  it('puts a reversal on the India day of its reversal time: 23:59:59.999 IST is the 22nd, 00:00:00.000 IST is the 23rd', async () => {
    const meta = (at: string) => ({ reversedAt: new Date(at), reversedById: A.user.id, reversalReason: 'boundary' });
    await advance([['CASH', 50]], noon(22), meta('2026-05-22T23:59:59.999+05:30'));
    await advance([['CASH', 70]], noon(22), meta('2026-05-23T00:00:00.000+05:30'));
    const d22 = await getDayBook(A.company.id, noon(22));
    expect(d22.moneyIn.total).toBe(120);
    expect(d22.moneyOut.total).toBe(50);
    const d23 = await getDayBook(A.company.id, noon(23));
    expect(d23.moneyIn.total).toBe(0);
    expect(d23.moneyOut.total).toBe(70);
    expect(d23.moneyOut.rows[0].amount).toBe(70);
    expectReconciled(d22); expectReconciled(d23);
  });

  it("never leaks another company's reversal into money out", async () => {
    await advance([['CASH', 111]], noon(24), { reversedAt: new Date('2026-05-24T13:00:00.000+05:30'), reversedById: A.user.id, reversalReason: 'a' });
    await advance([['UPI', 9000]], noon(24), { reversedAt: new Date('2026-05-24T13:00:00.000+05:30'), reversedById: B.user.id, reversalReason: 'b' }, B, clientB);
    const a = await getDayBook(A.company.id, noon(24));
    const b = await getDayBook(B.company.id, noon(24));
    expect(a.moneyOut.total).toBe(111);
    expect(a.moneyOut.rows.map((x) => x.client)).toEqual(['Money-in Client A']);
    expect(b.moneyOut.total).toBe(9000);
    expect(b.moneyOut.rows.map((x) => x.client)).toEqual(['Money-in Client B']);
    expectReconciled(a); expectReconciled(b);
  });

  it('does not invent a mode: an advance with no payment lines uses its single header mode, or is reported as UNKNOWN', async () => {
    const legacy = (amount: number, mode: string, at: string, reason: string) => prisma.customerAdvance.create({ data: {
      companyId: A.company.id, branchId: A.branch.id, clientId: clientA, advanceNumber: `TSTADV-MI-${suffix}-${n++}`, advanceDate: noon(25),
      amount, mode, createdById: A.user.id, reversedAt: new Date(at), reversedById: A.user.id, reversalReason: reason } });
    const plain = await legacy(400, 'CASH', '2026-05-25T16:00:00.000+05:30', 'legacy');
    const unknown = await legacy(600, 'SPLIT', '2026-05-25T16:30:00.000+05:30', 'legacy split');
    const r = await getDayBook(A.company.id, noon(25));
    expect(r.moneyOut.rows.find((x) => x.advanceNumber === plain.advanceNumber)!.payments).toEqual([{ mode: 'CASH', amount: 400 }]);
    expect(r.moneyOut.rows.find((x) => x.advanceNumber === unknown.advanceNumber)!.payments).toEqual([{ mode: 'UNKNOWN', amount: 600 }]);
    expect(mode(r, 'CASH')).toMatchObject({ advances: 400, out: 400, net: 0 });
    expect(mode(r, 'UNKNOWN')).toMatchObject({ advances: 600, out: 600, net: 0, recognised: false });
    expect(r.moneyOut.total).toBe(1000); // CASH 400 + UNKNOWN 600 — nothing silently assigned to Cash
    expectReconciled(r);
  });

  it('real service: one reversal = one money-out row and one journal; a second attempt is refused and adds nothing', async () => {
    const created = await createCustomerAdvance({ clientId: clientA, branchId: A.branch.id, amount: 1234, mode: 'CASH' }, A.ctx, A.user.id);
    const id = created.advance.id; serviceAdvanceIds.push(id);
    await reverseCustomerAdvance(id, A.ctx, A.user.id, 'taken on the wrong customer');
    await expect(reverseCustomerAdvance(id, A.ctx, A.user.id, 'again')).rejects.toMatchObject({ statusCode: 409 });

    expect(await prisma.journalEntry.count({ where: { referenceId: id, referenceType: 'CustomerAdvanceReversal' } })).toBe(1);
    const r = await getDayBook(A.company.id, new Date());
    const out = r.moneyOut.rows.filter((x) => x.advanceNumber === created.advance.advanceNumber);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: 1234, payments: [{ mode: 'CASH', amount: 1234 }], reason: 'taken on the wrong customer' });
    expect(r.advances.rows.find((x) => x.advanceNumber === created.advance.advanceNumber)).toMatchObject({ reversed: true, amount: 1234 });
    expect(r.net.netMoneyMovement).toBe(0); // same day: in 1234, out 1234
    expectReconciled(r);
  });

  it('applying an advance taken on an earlier day to a bill today is not new money in', async () => {
    const earlier = await advance([['UPI', 10000]], noon(8), { appliedAmount: 4000 });
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: A.company.id, branchId: A.branch.id, invoiceNumber: `TSTINV-MI-${suffix}-${n++}`, clientId: clientA, invoiceDate: noon(9),
        invoiceType: 'RETAIL', subtotal: 4000, totalAmount: 4000, balanceDue: 0, paidAmount: 4000, status: 'PAID',
      },
    });
    invoiceIds.push(inv.id);
    // What applyCustomerAdvance writes: an InvoicePayment of mode CUSTOMER_ADVANCE, dated the day it was applied.
    const pay = await receipt('CUSTOMER_ADVANCE', 4000, noon(9), { invoiceId: inv.id, referenceNo: earlier.advanceNumber });
    await prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: earlier.id, clientId: clientA, invoiceId: inv.id, invoicePaymentId: pay.id, amount: 4000, appliedAt: noon(9), appliedById: A.user.id },
    });

    const applyDay = await getDayBook(A.company.id, noon(9));
    expect(applyDay.sales.count).toBe(1);
    expect(applyDay.payments.count).toBe(0);
    expect(applyDay.advances.count).toBe(0);
    expect(applyDay.moneyIn.total).toBe(0);
    expect(applyDay.moneyIn.byMode).toEqual([]);

    // The cash was money in on the day it was taken — once, at its full amount, with the unused part shown.
    const takenDay = await getDayBook(A.company.id, noon(8));
    expect(takenDay.moneyIn.total).toBe(10000);
    expect(takenDay.advances.rows[0]).toMatchObject({ amount: 10000, applied: 4000, available: 6000 });
    expectReconciled(applyDay); expectReconciled(takenDay);
  });

  it('draws the day boundary at midnight India time, for receipts and advances alike', async () => {
    const lastMs10th = new Date('2026-05-10T23:59:59.999+05:30');
    const firstMs11th = new Date('2026-05-11T00:00:00.000+05:30');
    const earlyUtc11th = new Date('2026-05-10T20:00:00.000Z'); // 01:30 IST on the 11th, still the 10th in UTC
    await receipt('CASH', 100, lastMs10th);
    await advance([['CASH', 10]], lastMs10th);
    await receipt('CASH', 200, firstMs11th);
    await advance([['UPI', 20]], earlyUtc11th);

    const tenth = await getDayBook(A.company.id, noon(10));
    expect(tenth.moneyIn.total).toBe(110);
    expect(tenth.payments.count).toBe(1);
    expect(tenth.advances.count).toBe(1);
    const eleventh = await getDayBook(A.company.id, noon(11));
    expect(eleventh.moneyIn.total).toBe(220);
    expect(mode(eleventh, 'CASH')).toMatchObject({ receipts: 200, advances: 0 });
    expect(mode(eleventh, 'UPI')).toMatchObject({ receipts: 0, advances: 20 });
    // Any instant of the India day names the same day.
    expect((await getDayBook(A.company.id, lastMs10th)).moneyIn.total).toBe(110);
    expect((await getDayBook(A.company.id, firstMs11th)).moneyIn.total).toBe(220);
    expectReconciled(tenth); expectReconciled(eleventh);
  });

  it('never shows another company\'s receipts or advances, and never counts them in the totals', async () => {
    await receipt('CASH', 111, noon(12));
    await advance([['CASH', 222]], noon(12));
    await receipt('CASH', 7777, noon(12), {}, B, clientB);
    await advance([['UPI', 8888]], noon(12), {}, B, clientB);

    const a = await getDayBook(A.company.id, noon(12));
    expect(a.moneyIn.total).toBe(333);
    expect(a.payments.rows.map((r) => r.client)).toEqual(['Money-in Client A']);
    expect(a.advances.rows.map((r) => r.client)).toEqual(['Money-in Client A']);
    expect(mode(a, 'UPI')).toBeUndefined();
    const b = await getDayBook(B.company.id, noon(12));
    expect(b.moneyIn.total).toBe(7777 + 8888);
    expect(b.payments.rows.map((r) => r.client)).toEqual(['Money-in Client B']);
    expectReconciled(a); expectReconciled(b);
  });

  it('returns every row (the page size is a screen concern), so section totals and mode cards are not page totals', async () => {
    for (let i = 1; i <= 12; i++) await receipt(i % 2 ? 'CASH' : 'UPI', 100 * i, noon(13));
    for (let i = 1; i <= 7; i++) await advance([[i % 2 ? 'CARD' : 'CASH', 50 * i]], noon(13));
    const r = await getDayBook(A.company.id, noon(13));
    expect(r.payments.rows).toHaveLength(12);
    expect(r.payments.count).toBe(12);
    expect(r.payments.total).toBe(7800);
    expect(r.payments.rows.reduce((s, x) => s + x.amount, 0)).toBe(7800);
    expect(r.advances.rows).toHaveLength(7);
    expect(r.advances.totalAmount).toBe(1400);
    expect(r.advances.rows.reduce((s, x) => s + x.amount, 0)).toBe(1400);
    expect(r.moneyIn.total).toBe(9200);
    expectReconciled(r);
  });

  it('"Added to customer balances" is the same with or without an advance that day', async () => {
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: A.company.id, branchId: A.branch.id, invoiceNumber: `TSTINV-MI-${suffix}-${n++}`, clientId: clientA, invoiceDate: noon(14),
        invoiceType: 'RETAIL', subtotal: 50000, totalAmount: 50000, balanceDue: 20000, status: 'PARTIALLY_PAID',
      },
    });
    invoiceIds.push(inv.id);
    await receipt('CASH', 30000, noon(14), { invoiceId: inv.id });
    const before = await getDayBook(A.company.id, noon(14));
    expect(before.net.balanceChange).toBe(20000);
    expect(before.net.totalMoneyIn).toBe(30000);

    await advance([['UPI', 15000]], noon(14));
    const after = await getDayBook(A.company.id, noon(14));
    expect(after.net.balanceChange).toBe(20000);
    expect(after.net.netSales).toBe(before.net.netSales);
    expect(after.net.collected).toBe(30000);
    expect(after.net.advancesReceived).toBe(15000);
    expect(after.net.totalMoneyIn).toBe(45000);
    expectReconciled(after);
  });

  it('a standalone payment on account is a receipt with no invoice, and stays in the receipts total', async () => {
    await receipt('CASH', 2500, noon(15)); // no invoiceId — F2 on-account payment
    const r = await getDayBook(A.company.id, noon(15));
    expect(r.payments.rows[0]).toMatchObject({ client: 'Money-in Client A', mode: 'CASH', amount: 2500, invoiceNumber: null });
    expect(r.payments.onAccountTotal).toBe(2500);
    expectReconciled(r);
  });
});
