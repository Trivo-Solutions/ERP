import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createCustomerAdvance, applyCustomerAdvance, listAvailableAdvances, listAdvanceApplications, reverseCustomerAdvance } from './customerAdvance.service';
import { createInvoice, recordPayment, recordClientPayment, reverseInvoicePayment, voidInvoice } from './sales.service';
import { getDayBook, getClientLedger } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { cleanupJournalEntries } from '../../test/ledger';
import type { TenantContext } from '../../shared/tenantContext';

// Customer Advances Phase 3: applying an advance to an invoice. A FIXED-rate free-text line of N rupees bills as
// N + 3% GST, so `bill(100000)` is a ₹1,03,000 invoice.
describe('Customer Advances Phase 3 — apply to invoices', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let branch2: string;
  const clientIds: string[] = [];
  const refIds: string[] = [];
  let n = 0;

  const mkClient = async (t: TestTenant, extra: Record<string, unknown> = {}) => {
    const c = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `ADV3-${suffix}-${n++}`, name: `Cust ${n}`, type: 'RETAIL', panNumber: 'ABCDE1234F', ...extra } });
    clientIds.push(c.id);
    return c.id;
  };
  const advance = async (clientId: string, amount: number, t = A, branchId = t.branch.id) => {
    const r = await createCustomerAdvance({ clientId, branchId, amount, mode: 'UPI' }, t.ctx, t.user.id);
    refIds.push(r.advance.id);
    return r.advance;
  };
  const bill = async (clientId: string, net: number, over: Record<string, unknown> = {}, t = A, branchId = t.branch.id) => {
    const inv = await createInvoice({
      branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Set', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: net, makingCharge: 0 }],
      ...over,
    } as any, t.ctx, t.user.id);
    refIds.push(inv.id);
    return inv;
  };
  const adv = (id: string) => prisma.customerAdvance.findUniqueOrThrow({ where: { id } });
  const inv = (id: string) => prisma.salesInvoice.findUniqueOrThrow({ where: { id } });
  const balance = async (id: string) => Number((await prisma.client.findUniqueOrThrow({ where: { id } })).currentBalance);
  const apply = (invoiceId: string, allocations: Array<{ advanceId: string; amount: number }>, t = A, extra: Record<string, unknown> = {}) =>
    applyCustomerAdvance(invoiceId, { allocations, ...extra }, t.ctx, t.user.id);

  beforeAll(async () => {
    A = await createTestTenant(`ADV3A${suffix}`, []);
    B = await createTestTenant(`ADV3B${suffix}`, []);
    branch2 = (await addBranch(A.company.id, `ADV3${suffix}`)).id;
  }, 60_000);

  afterAll(async () => {
    const pays = await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    await cleanupJournalEntries([...refIds, ...pays.map((p) => p.id)]);
    await prisma.customerAdvanceApplication.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  describe('basic application', () => {
    it('advance larger than the invoice: invoice PAID, advance PARTIALLY_APPLIED, AR and balance settled', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 200000);
      const i = await bill(c, 100000); // 103000
      expect(await balance(c)).toBe(103000);

      const r = await apply(i.id, [{ advanceId: a.id, amount: 200000 }]);
      expect(r.totalApplied).toBe(103000); // clamped to what the invoice still owed
      expect(r.invoice).toMatchObject({ paidAmount: 103000, balanceDue: 0, status: 'PAID' });
      expect(Number((await adv(a.id)).appliedAmount)).toBe(103000);
      expect((await listAvailableAdvances(A.ctx, c)).advances[0].availableAmount).toBe(97000);
      expect(await balance(c)).toBe(0); // receivable settled; the advance never was currentBalance

      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      expect(pay.mode).toBe('CUSTOMER_ADVANCE');
      expect(pay.referenceNo).toBe(a.advanceNumber);
      const app = await prisma.customerAdvanceApplication.findFirstOrThrow({ where: { advanceId: a.id } });
      expect(app).toMatchObject({ invoiceId: i.id, invoicePaymentId: pay.id, clientId: c });
      expect(Number(app.amount)).toBe(103000);
    });

    it('posts exactly Dr 2400 / Cr 1200 — no revenue, GST, inventory, cash or store credit', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 50000);
      const i = await bill(c, 100000);
      await apply(i.id, [{ advanceId: a.id, amount: 50000 }]);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      const entries = await prisma.journalEntry.findMany({ where: { referenceId: pay.id }, include: { lines: { include: { account: true } } } });
      expect(entries).toHaveLength(1);
      const lines = entries[0].lines.map((l) => ({ code: l.account.code, d: Number(l.debit), c: Number(l.credit) })).sort((x, y) => x.code.localeCompare(y.code));
      expect(lines).toEqual([
        { code: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, d: 0, c: 50000 },
        { code: LEDGER_ACCOUNT.CUSTOMER_ADVANCES, d: 50000, c: 0 },
      ].sort((x, y) => x.code.localeCompare(y.code)));
    });

    it('partial application, then the remainder later; FULLY_APPLIED only at zero', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 200000);
      const i = await bill(c, 500000); // 515000
      await apply(i.id, [{ advanceId: a.id, amount: 75000 }]);
      let v = (await listAvailableAdvances(A.ctx, c)).advances[0];
      expect(v).toMatchObject({ appliedAmount: 75000, availableAmount: 125000, status: 'PARTIALLY_APPLIED' });
      expect(await inv(i.id)).toMatchObject({ status: 'PARTIALLY_PAID' });
      expect(Number((await inv(i.id)).balanceDue)).toBe(440000);

      await apply(i.id, [{ advanceId: a.id, amount: 125000 }]);
      expect((await listAvailableAdvances(A.ctx, c)).advances).toHaveLength(0);
      expect((await adv(a.id)).appliedAmount.toString()).toBe('200000');
      expect(Number((await inv(i.id)).balanceDue)).toBe(315000);
      const apps = await listAdvanceApplications(A.ctx, a.id);
      expect(apps.map((x) => x.amount).sort()).toEqual([125000, 75000]);
      expect(apps[0].invoice.invoiceNumber).toBe(i.invoiceNumber);
    });

    it('invoice larger than the advance: the rest is paid by an ordinary mode', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 200000);
      const i = await bill(c, 500000);
      await apply(i.id, [{ advanceId: a.id, amount: 200000 }]);
      await recordPayment({ invoiceId: i.id, paymentDate: new Date(), amount: 315000, mode: 'UPI' }, A.ctx, A.user.id);
      expect(await inv(i.id)).toMatchObject({ status: 'PAID' });
      expect(await balance(c)).toBe(0);
    });

    it('several advances on one invoice: explicit partial use of each, one application per advance', async () => {
      const c = await mkClient(A);
      const a1 = await advance(c, 100000); const a2 = await advance(c, 75000); const a3 = await advance(c, 50000);
      const i = await bill(c, 200000); // 206000
      const r = await apply(i.id, [{ advanceId: a1.id, amount: 100000 }, { advanceId: a2.id, amount: 75000 }, { advanceId: a3.id, amount: 25000 }]);
      expect(r.totalApplied).toBe(200000);
      expect(await prisma.customerAdvanceApplication.count({ where: { invoiceId: i.id } })).toBe(3);
      expect(await prisma.invoicePayment.count({ where: { invoiceId: i.id, mode: 'CUSTOMER_ADVANCE' } })).toBe(3);
      expect(Number((await adv(a3.id)).appliedAmount)).toBe(25000);
    });

    it('auto mode consumes the oldest advances first and keeps one record per advance', async () => {
      const c = await mkClient(A);
      const a1 = await advance(c, 60000); const a2 = await advance(c, 60000); const a3 = await advance(c, 60000);
      const i = await bill(c, 100000); // 103000
      const r = await applyCustomerAdvance(i.id, { auto: true }, A.ctx, A.user.id);
      expect(r.applied.map((x) => [x.advanceId, x.amount])).toEqual([[a1.id, 60000], [a2.id, 43000]]);
      expect(Number((await adv(a3.id)).appliedAmount)).toBe(0);
      const list = await listAvailableAdvances(A.ctx, c);
      expect(list.advances.map((x) => x.id)).toEqual([a2.id, a3.id]); // oldest first
      expect(list.totalAvailable).toBe(77000);
    });

    it('an advance is never applied unasked: creating a bill without it leaves it untouched', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 10000);
      await bill(c, 100000);
      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
    });
  });

  describe('inside createInvoice', () => {
    it('advance + UPI split on one new invoice', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 200000);
      const i = await bill(c, 500000, { payments: [
        { paymentDate: new Date(), amount: 200000, mode: 'CUSTOMER_ADVANCE', advanceId: a.id },
        { paymentDate: new Date(), amount: 315000, mode: 'UPI' },
      ] });
      expect(i.status).toBe('PAID');
      expect(Number((await adv(a.id)).appliedAmount)).toBe(200000);
      expect(await balance(c)).toBe(0);
      expect(await prisma.customerAdvanceApplication.count({ where: { invoiceId: i.id } })).toBe(1);
    });

    it('requires advanceId; refuses another customer\'s, an over-spent, a reversed advance — and leaves nothing behind', async () => {
      const c = await mkClient(A); const other = await mkClient(A);
      const mine = await advance(c, 1000); const theirs = await advance(other, 500000);
      const before = await prisma.salesInvoice.count({ where: { clientId: c } });
      const pay = (advanceId: unknown, amount: number) => [{ paymentDate: new Date(), amount, mode: 'CUSTOMER_ADVANCE', advanceId }];
      await expect(bill(c, 100000, { payments: pay(undefined, 500) })).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 100000, { payments: pay(theirs.id, 500) })).rejects.toMatchObject({ statusCode: 409 });
      await expect(bill(c, 100000, { payments: pay(mine.id, 5000) })).rejects.toMatchObject({ statusCode: 409 });
      const rev = await advance(c, 3000); await reverseCustomerAdvance(rev.id, A.ctx, A.user.id, 'x');
      await expect(bill(c, 100000, { payments: pay(rev.id, 100) })).rejects.toMatchObject({ statusCode: 409 });
      expect(await prisma.salesInvoice.count({ where: { clientId: c } })).toBe(before); // all-or-nothing
      expect(Number((await adv(mine.id)).appliedAmount)).toBe(0);
    });

    it('advances count toward the credit limit; no bypass without them', async () => {
      const c = await mkClient(A, { creditLimit: 30000 });
      const a = await advance(c, 80000);
      await expect(bill(c, 100000)).rejects.toMatchObject({ statusCode: 400 }); // 103000 > 30000
      const i = await bill(c, 100000, { payments: [{ paymentDate: new Date(), amount: 80000, mode: 'CUSTOMER_ADVANCE', advanceId: a.id }] }); // 23000 exposure
      expect(Number(i.balanceDue)).toBe(23000);
      const c2 = await mkClient(A, { creditLimit: 10000 });
      const a2 = await advance(c2, 80000);
      await expect(bill(c2, 100000, { payments: [{ paymentDate: new Date(), amount: 80000, mode: 'CUSTOMER_ADVANCE', advanceId: a2.id }] })).rejects.toMatchObject({ statusCode: 400 }); // 23000 > 10000
    });

    it('CUSTOMER_ADVANCE is refused as a plain receipt', async () => {
      const c = await mkClient(A);
      const i = await bill(c, 1000);
      await expect(recordPayment({ invoiceId: i.id, paymentDate: new Date(), amount: 100, mode: 'CUSTOMER_ADVANCE' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      await expect(recordClientPayment({ clientId: c, paymentDate: new Date(), amount: 100, mode: 'CUSTOMER_ADVANCE' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('validation, tenancy and branches', () => {
    it('another customer\'s advance cannot pay this invoice (409), forged ids are 404, nothing changes', async () => {
      const c = await mkClient(A); const other = await mkClient(A);
      const theirs = await advance(other, 5000);
      const i = await bill(c, 100000);
      await expect(apply(i.id, [{ advanceId: theirs.id, amount: 1000 }])).rejects.toMatchObject({ statusCode: 409 });
      await expect(apply(i.id, [{ advanceId: 'forged', amount: 1000 }])).rejects.toMatchObject({ statusCode: 404 });
      await expect(apply('forged', [{ advanceId: theirs.id, amount: 1000 }])).rejects.toMatchObject({ statusCode: 404 });
      expect(Number((await adv(theirs.id)).appliedAmount)).toBe(0);
      expect(await prisma.invoicePayment.count({ where: { invoiceId: i.id } })).toBe(0);
    });

    it('cross-company: B cannot spend A\'s advance, nor touch A\'s invoice; the advance list is empty for B', async () => {
      const c = await mkClient(A); const cb = await mkClient(B);
      const a = await advance(c, 5000);
      const i = await bill(c, 100000);
      const ib = await bill(cb, 100000, {}, B);
      await expect(apply(ib.id, [{ advanceId: a.id, amount: 1000 }], B)).rejects.toMatchObject({ statusCode: 404 });
      await expect(apply(i.id, [{ advanceId: a.id, amount: 1000 }], B)).rejects.toMatchObject({ statusCode: 404 });
      await expect(listAvailableAdvances(B.ctx, c)).rejects.toMatchObject({ statusCode: 404 });
      await expect(bill(cb, 100000, { payments: [{ paymentDate: new Date(), amount: 1000, mode: 'CUSTOMER_ADVANCE', advanceId: a.id }] }, B)).rejects.toMatchObject({ statusCode: 404 });
      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
    });

    it('an advance taken at branch 1 is applied to an invoice at branch 2 by a user who only has branch 2', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 50000, A, A.branch.id);
      const i = await bill(c, 100000, {}, A, branch2);
      const b2Only: TenantContext = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branch2] } };
      const list = await listAvailableAdvances(b2Only, c);
      expect(list.advances.map((x) => x.id)).toContain(a.id); // origin branch is not the caller's
      await applyCustomerAdvance(i.id, { allocations: [{ advanceId: a.id, amount: 50000 }] }, b2Only, A.user.id);
      const after = await adv(a.id);
      expect(after.branchId).toBe(A.branch.id); // originating branch unchanged
      expect(Number(after.appliedAmount)).toBe(50000);
      const apps = await listAdvanceApplications(A.ctx, a.id);
      expect(apps[0].invoice.branch?.id).toBe(branch2); // the application belongs to the invoice's branch
    });

    it('a user without access to the invoice\'s branch is refused', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 100000, {}, A, branch2);
      const b1Only: TenantContext = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } };
      await expect(applyCustomerAdvance(i.id, { allocations: [{ advanceId: a.id, amount: 1000 }] }, b1Only, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
    });

    it('rejects bad input, a settled invoice and a voided invoice', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 500000);
      const i = await bill(c, 1000); // 1030
      await expect(apply(i.id, [])).rejects.toMatchObject({ statusCode: 400 });
      await expect(apply(i.id, [{ advanceId: a.id, amount: -5 }])).rejects.toMatchObject({ statusCode: 400 });
      await expect(apply(i.id, [{ advanceId: a.id, amount: 1.234 }])).rejects.toMatchObject({ statusCode: 400 });
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      await expect(apply(i.id, [{ advanceId: a.id, amount: 10 }])).rejects.toMatchObject({ statusCode: 409 }); // nothing outstanding

      const v = await bill(c, 1000);
      await voidInvoice(v.id, A.ctx, A.user.id, 'test');
      await expect(apply(v.id, [{ advanceId: a.id, amount: 10 }])).rejects.toMatchObject({ statusCode: 409 });
    });

    it('an invoice carrying an advance payment cannot be voided until the payment is reversed', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 2000);
      const i = await bill(c, 1000);
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      await expect(voidInvoice(i.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('audit entries carry company, actor and action', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      await apply(i.id, [{ advanceId: a.id, amount: 500 }]);
      const log = await prisma.auditLog.findFirst({ where: { tableName: 'customer_advances', recordId: a.id, action: 'APPLY' } });
      expect(log).toMatchObject({ companyId: A.company.id, userId: A.user.id });
    });
  });

  describe('reversal', () => {
    it('restores the advance and the invoice, marks the application, posts the inverse journal, leaves the receipt', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 200000);
      const i = await bill(c, 100000); // 103000
      await apply(i.id, [{ advanceId: a.id, amount: 100000 }]);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      expect(await balance(c)).toBe(3000);

      await reverseInvoicePayment(pay.id, A.ctx, A.user.id, 'applied by mistake');

      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
      expect((await listAvailableAdvances(A.ctx, c)).advances[0].availableAmount).toBe(200000);
      expect(await inv(i.id)).toMatchObject({ status: 'DRAFT' });
      expect(Number((await inv(i.id)).balanceDue)).toBe(103000);
      expect(await balance(c)).toBe(103000);
      const app = await prisma.customerAdvanceApplication.findFirstOrThrow({ where: { invoicePaymentId: pay.id } });
      expect(app.reversedAt).not.toBeNull();
      expect(app.reversalReason).toBe('applied by mistake');

      const entries = await prisma.journalEntry.findMany({ where: { referenceId: pay.id }, include: { lines: { include: { account: true } } } });
      const rev = entries.find((e) => e.description.startsWith('Reversal'))!;
      const l = (code: string) => rev.lines.find((x) => x.account.code === code)!;
      expect(Number(l(LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit)).toBe(100000);
      expect(Number(l(LEDGER_ACCOUNT.CUSTOMER_ADVANCES).credit)).toBe(100000);
      expect(rev.lines).toHaveLength(2);

      // the original receipt is untouched: still one Dr Bank / Cr 2400 entry, advance not reversed
      expect(await prisma.journalEntry.count({ where: { referenceId: a.id } })).toBe(1);
      expect((await adv(a.id)).reversedAt).toBeNull();
      const log = await prisma.auditLog.findFirst({ where: { tableName: 'customer_advances', recordId: a.id, action: 'REVERSE_APPLICATION' } });
      expect(log).toMatchObject({ companyId: A.company.id, userId: A.user.id });

      // and the freed advance can be spent again
      await apply(i.id, [{ advanceId: a.id, amount: 103000 }]);
      expect(await inv(i.id)).toMatchObject({ status: 'PAID' });
    });

    it('a second reversal is refused', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      await reverseInvoicePayment(pay.id, A.ctx, A.user.id, 'x');
      await expect(reverseInvoicePayment(pay.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });
      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
    });

    it('an advance partly spent cannot be reversed; once the application is reversed it can', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      await expect(reverseCustomerAdvance(a.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      await reverseInvoicePayment(pay.id, A.ctx, A.user.id, 'x');
      await expect(reverseCustomerAdvance(a.id, A.ctx, A.user.id, 'x')).resolves.toMatchObject({ status: 'REVERSED' });
    });

    it('concurrent reversals of one application: one winner, one inverse journal', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: i.id } });
      const res = await Promise.allSettled([1, 2, 3].map(() => reverseInvoicePayment(pay.id, A.ctx, A.user.id, 'race')));
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.journalEntry.count({ where: { referenceId: pay.id } })).toBe(2);
      expect(Number((await adv(a.id)).appliedAmount)).toBe(0);
    });
  });

  describe('reports and other money paths', () => {
    it('client ledger shows the application as a credit (so it ties to currentBalance); the day book does not count it as cash', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      const dayBefore = await getDayBook(A.company.id, new Date());
      await apply(i.id, [{ advanceId: a.id, amount: 1030 }]);
      const ledger = await getClientLedger(A.ctx, c);
      expect(ledger.closingBalance).toBe(await balance(c));
      expect(ledger.closingBalance).toBe(0);
      const dayAfter = await getDayBook(A.company.id, new Date());
      expect(dayAfter.payments.total).toBe(dayBefore.payments.total);
    });
  });

  describe('concurrency and retries', () => {
    it('two requests for 80,000 against a 1,00,000 advance never over-apply', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 100000);
      const i1 = await bill(c, 100000); const i2 = await bill(c, 100000);
      const res = await Promise.allSettled([apply(i1.id, [{ advanceId: a.id, amount: 80000 }]), apply(i2.id, [{ advanceId: a.id, amount: 80000 }])]);
      const after = await adv(a.id);
      expect(Number(after.appliedAmount)).toBeLessThanOrEqual(100000);
      const apps = await prisma.customerAdvanceApplication.findMany({ where: { advanceId: a.id } });
      expect(apps.reduce((s, x) => s + Number(x.amount), 0)).toBe(Number(after.appliedAmount));
      expect(Number(after.appliedAmount)).toBe(100000); // 80,000 + the 20,000 that was left
      expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    });

    it('two advances applied to the same invoice at once: the invoice is never over-paid', async () => {
      const c = await mkClient(A);
      const a1 = await advance(c, 100000); const a2 = await advance(c, 100000);
      const i = await bill(c, 100000); // 103000
      await Promise.allSettled([apply(i.id, [{ advanceId: a1.id, amount: 100000 }]), apply(i.id, [{ advanceId: a2.id, amount: 100000 }])]);
      const after = await inv(i.id);
      expect(Number(after.paidAmount)).toBe(103000);
      expect(Number(after.balanceDue)).toBe(0);
      const total = (await prisma.invoicePayment.findMany({ where: { invoiceId: i.id } })).reduce((s, p) => s + Number(p.amount), 0);
      expect(total).toBe(103000);
    });

    it('two users spending the same advance on different bills: applied never exceeds amount', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 50000);
      const bills = await Promise.all([bill(c, 100000), bill(c, 100000), bill(c, 100000)]);
      await Promise.allSettled(bills.map((b) => apply(b.id, [{ advanceId: a.id, amount: 30000 }])));
      const after = await adv(a.id);
      expect(Number(after.appliedAmount)).toBe(50000);
    });

    it('an application racing a reversal of the same advance: consistent end state', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 5000);
      const i = await bill(c, 1000);
      const res = await Promise.allSettled([apply(i.id, [{ advanceId: a.id, amount: 1030 }]), reverseCustomerAdvance(a.id, A.ctx, A.user.id, 'race')]);
      const after = await adv(a.id);
      expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      if (after.reversedAt) expect(Number(after.appliedAmount)).toBe(0);
      else expect(Number(after.appliedAmount)).toBe(1030);
    });

    it('the same request retried (double click) creates one application', async () => {
      const c = await mkClient(A);
      const a = await advance(c, 100000);
      const i = await bill(c, 500000);
      const key = `k-${suffix}`;
      const res = await Promise.all([1, 2, 3].map(() => apply(i.id, [{ advanceId: a.id, amount: 10000 }], A, { idempotencyKey: key })));
      expect(res.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await prisma.customerAdvanceApplication.count({ where: { invoiceId: i.id } })).toBe(1);
      expect(await prisma.invoicePayment.count({ where: { invoiceId: i.id } })).toBe(1);
      expect(Number((await adv(a.id)).appliedAmount)).toBe(10000);
      const later = await apply(i.id, [{ advanceId: a.id, amount: 10000 }], A, { idempotencyKey: key });
      expect(later.replayed).toBe(true);
    });
  });
});
