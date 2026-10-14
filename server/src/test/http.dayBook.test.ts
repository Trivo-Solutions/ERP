import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// The Day Book route turns the picker's 'YYYY-MM-DD' into an India business day. A bare date used to be
// parsed as UTC midnight, which is the PREVIOUS day on a server west of UTC.
describe('HTTP: GET /finance/reports/day-book — date handling and permission', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let t: TestTenant; let denied: TestTenant;
  let clientId: string;

  beforeAll(async () => {
    t = await createTestTenant(`DBH${suffix}`, ['report:day_book']);
    denied = await createTestTenant(`DBD${suffix}`, ['report:view']);
    clientId = (await prisma.client.create({ data: { companyId: t.company.id, clientCode: `TSTCL-DBH-${suffix}`, name: 'Day Book HTTP', type: 'RETAIL' } })).id;
    // 00:30 IST on 20 Jun 2026 = 19:00 UTC on the 19th: the two readings of "20 Jun" disagree about this row.
    await prisma.invoicePayment.create({
      data: { companyId: t.company.id, paymentNumber: `TSTPMT-DBH-${suffix}`, clientId, paymentDate: new Date('2026-06-20T00:30:00.000+05:30'), amount: 1234, mode: 'UPI' },
    });
    await prisma.customerAdvance.create({
      data: {
        companyId: t.company.id, branchId: t.branch.id, clientId, advanceNumber: `TSTADV-DBH-${suffix}`, advanceDate: new Date('2026-06-20T23:00:00.000+05:30'),
        amount: 500, mode: 'CASH', createdById: t.user.id, payments: { create: [{ mode: 'CASH', amount: 500 }] },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.invoicePayment.deleteMany({ where: { clientId } });
    await prisma.customerAdvancePayment.deleteMany({ where: { companyId: t.company.id } });
    await prisma.customerAdvance.deleteMany({ where: { companyId: t.company.id } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(t); await cleanupTestTenant(denied);
    await prisma.$disconnect();
  });

  it('a bare date is the India calendar day, receipts and advances included', async () => {
    const api = apiWith(tokenFor(t), app);
    const on = await api.get('/finance/reports/day-book?date=2026-06-20');
    expect(on.status).toBe(200);
    expect(on.body.data.moneyIn.total).toBe(1734);
    expect(on.body.data.moneyIn.byMode.map((m: any) => [m.mode, m.total])).toEqual([['CASH', 500], ['UPI', 1234]]);
    const before = await api.get('/finance/reports/day-book?date=2026-06-19');
    expect(before.body.data.moneyIn.total).toBe(0);
  });

  it('a cross-day advance reversal: original day keeps the receipt, the reversal day shows money out; another company sees neither', async () => {
    await prisma.customerAdvance.create({
      data: {
        companyId: t.company.id, branchId: t.branch.id, clientId, advanceNumber: `TSTADV-DBH-REV-${suffix}`, advanceDate: new Date('2026-06-21T11:00:00.000+05:30'),
        amount: 800, mode: 'UPI', createdById: t.user.id, reversedAt: new Date('2026-06-22T10:00:00.000+05:30'), reversedById: t.user.id, reversalReason: 'cancelled',
        payments: { create: [{ mode: 'UPI', amount: 800 }] },
      },
    });
    const api = apiWith(tokenFor(t), app);
    const d21 = (await api.get('/finance/reports/day-book?date=2026-06-21')).body.data;
    expect(d21.moneyIn.total).toBe(800);
    expect(d21.moneyOut.total).toBe(0);
    expect(d21.net).toMatchObject({ totalMoneyIn: 800, totalMoneyOut: 0, netMoneyMovement: 800 });
    expect(d21.advances.rows[0]).toMatchObject({ amount: 800, reversed: true });
    expect(d21.payments).toMatchObject({ total: 0, byMode: [] }); // receipts-only fields untouched

    const d22 = (await api.get('/finance/reports/day-book?date=2026-06-22')).body.data;
    expect(d22.moneyIn.total).toBe(0);
    expect(d22.moneyOut).toMatchObject({ count: 1, total: 800, byMode: [{ mode: 'UPI', amount: 800 }] });
    expect(d22.moneyOut.rows[0]).toMatchObject({ advanceNumber: `TSTADV-DBH-REV-${suffix}`, client: 'Day Book HTTP', amount: 800, payments: [{ mode: 'UPI', amount: 800 }], reason: 'cancelled' });
    expect(d22.net).toMatchObject({ totalMoneyIn: 0, totalMoneyOut: 800, netMoneyMovement: -800 });
    expect(d22.moneyIn.byMode).toEqual([{ mode: 'UPI', receipts: 0, advances: 0, total: 0, out: 800, net: -800, recognised: true }]);

    // a second company that holds report:day_book sees none of it
    const other = await createTestTenant(`DBO${suffix}`, ['report:day_book']);
    try {
      const oApi = apiWith(tokenFor(other), app);
      for (const day of ['2026-06-21', '2026-06-22']) {
        const body = (await oApi.get(`/finance/reports/day-book?date=${day}`)).body.data;
        expect(body.moneyIn.total).toBe(0);
        expect(body.moneyOut).toMatchObject({ count: 0, total: 0, rows: [] });
      }
    } finally { await cleanupTestTenant(other); }
  });

  it('rejects an invalid date with 400 and a caller without report:day_book with 403', async () => {
    expect((await apiWith(tokenFor(t), app).get('/finance/reports/day-book?date=not-a-date')).status).toBe(400);
    expect((await apiWith(tokenFor(denied), app).get('/finance/reports/day-book?date=2026-06-20')).status).toBe(403);
  });
});
