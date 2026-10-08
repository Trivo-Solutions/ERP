import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import {
  createCustomerAdvance, getCustomerAdvance, listCustomerAdvances, reverseCustomerAdvance, deriveAdvanceStatus,
} from './customerAdvance.service';
import { recordClientPayment } from './sales.service';
import { CASH_RECEIPT_LIMIT } from '../../shared/compliance';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { getJournalEntry, lineAmount, cleanupJournalEntries } from '../../test/ledger';

describe('Customer Advances Phase 2 — receive, list, reverse', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let clientA: string; let clientA2: string; let clientB: string;
  let branch2: string;
  const clientIds: string[] = [];
  const refIds: string[] = [];
  let n = 0;

  const mk = async (t: TestTenant, extra: Record<string, unknown> = {}) => {
    const c = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `ADV2-${suffix}-${n++}`, name: `Cust ${n}`, type: 'RETAIL', ...extra } });
    clientIds.push(c.id);
    return c.id;
  };
  const create = async (over: Record<string, unknown> = {}, t = A, client = clientA) => {
    const r = await createCustomerAdvance({ clientId: client, branchId: t.branch.id, amount: 1000, mode: 'UPI', ...over } as any, t.ctx, t.user.id);
    refIds.push(r.advance.id);
    return r;
  };

  beforeAll(async () => {
    A = await createTestTenant(`ADV2A${suffix}`, []);
    B = await createTestTenant(`ADV2B${suffix}`, []);
    clientA = await mk(A); clientA2 = await mk(A); clientB = await mk(B);
    branch2 = (await addBranch(A.company.id, `ADV2${suffix}`)).id;
  }, 60_000);

  afterAll(async () => {
    const pays = await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    await cleanupJournalEntries([...refIds, ...pays.map((p) => p.id)]);
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  describe('creation', () => {
    it('creates an advance with number, journal and no AR / balance / store-credit effect', async () => {
      const before = await prisma.client.findUniqueOrThrow({ where: { id: clientA } });
      const { advance, replayed } = await create({ amount: 200000.5, mode: 'upi', referenceNo: 'UTR1', notes: 'for necklace' });
      expect(replayed).toBe(false);
      expect(advance.advanceNumber).toMatch(/^ADV-\d{4}-000001$/);
      expect(advance).toMatchObject({ amount: 200000.5, appliedAmount: 0, availableAmount: 200000.5, status: 'ACTIVE', mode: 'UPI' });
      expect(advance).not.toHaveProperty('idempotencyKey');

      const je = (await getJournalEntry(advance.id))!;
      expect(lineAmount(je, LEDGER_ACCOUNT.BANK_ACCOUNT)).toEqual({ debit: 200000.5, credit: 0 });
      expect(lineAmount(je, LEDGER_ACCOUNT.CUSTOMER_ADVANCES)).toEqual({ debit: 0, credit: 200000.5 });
      expect(lineAmount(je, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE)).toEqual({ debit: 0, credit: 0 });

      const after = await prisma.client.findUniqueOrThrow({ where: { id: clientA } });
      expect(Number(after.currentBalance)).toBe(Number(before.currentBalance)); // = Store Credit too (it is currentBalance)
      expect(await prisma.invoicePayment.count({ where: { clientId: clientA } })).toBe(0);
    });

    it('cash goes to the cash account; numbers increase', async () => {
      const a = await create({ mode: 'CASH', amount: 500 });
      const b = await create({ mode: 'CASH', amount: 500 }, A, clientA2);
      expect(lineAmount((await getJournalEntry(a.advance.id))!, LEDGER_ACCOUNT.CASH_IN_HAND).debit).toBe(500);
      expect(Number(b.advance.advanceNumber.slice(-6))).toBe(Number(a.advance.advanceNumber.slice(-6)) + 1);
    });

    it('writes a CREATE audit entry with actor and company', async () => {
      const { advance } = await create({ amount: 700 });
      const log = await prisma.auditLog.findFirst({ where: { tableName: 'customer_advances', recordId: advance.id, action: 'CREATE' } });
      expect(log).toMatchObject({ companyId: A.company.id, userId: A.user.id });
      expect(log!.newValues).toMatchObject({ advanceNumber: advance.advanceNumber, amount: 700, mode: 'UPI' });
    });

    it.each([[0], [-5], [NaN], ['abc'], [10.005]])('rejects amount %s', async (amount) => {
      await expect(create({ amount })).rejects.toMatchObject({ statusCode: 400 });
    });
    it('rejects an invalid mode (incl. credit-settlement modes)', async () => {
      await expect(create({ mode: 'OLD_GOLD' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(create({ mode: 'STORE_CREDIT' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(create({ mode: 'BARTER' })).rejects.toMatchObject({ statusCode: 400 });
    });
    it('rejects unknown and cross-company customers, and a cross-company branch', async () => {
      await expect(create({ clientId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
      await expect(create({}, A, clientB)).rejects.toMatchObject({ statusCode: 404 });
      await expect(create({ branchId: B.branch.id })).rejects.toMatchObject({ statusCode: 404 });
    });
    it('rejects a branch the caller has no grant for', async () => {
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } };
      await expect(createCustomerAdvance({ clientId: clientA, branchId: branch2, amount: 10, mode: 'UPI' }, restricted, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });
    it('rejects a deactivated customer', async () => {
      const c = await mk(A, { isActive: false });
      await expect(create({}, A, c)).rejects.toMatchObject({ statusCode: 409 });
    });
    it('rolls back everything if the journal cannot post', async () => {
      const acct = await prisma.account.findFirstOrThrow({ where: { companyId: A.company.id, code: LEDGER_ACCOUNT.CUSTOMER_ADVANCES } });
      await prisma.account.update({ where: { id: acct.id }, data: { code: '2400-X' } });
      const c = await mk(A);
      try {
        await expect(create({}, A, c)).rejects.toThrow();
      } finally {
        await prisma.account.update({ where: { id: acct.id }, data: { code: LEDGER_ACCOUNT.CUSTOMER_ADVANCES } });
      }
      expect(await prisma.customerAdvance.count({ where: { clientId: c } })).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('same key returns the same advance, one journal; concurrent duplicates collapse', async () => {
      const key = `k-${suffix}`;
      const first = await create({ idempotencyKey: key, amount: 321 });
      const again = await createCustomerAdvance({ clientId: clientA, branchId: A.branch.id, amount: 321, mode: 'UPI', idempotencyKey: key }, A.ctx, A.user.id);
      expect(again.replayed).toBe(true);
      expect(again.advance.id).toBe(first.advance.id);
      expect(await prisma.journalEntry.count({ where: { referenceId: first.advance.id } })).toBe(1);

      const key2 = `k2-${suffix}`;
      const results = await Promise.all([1, 2, 3, 4].map(() =>
        createCustomerAdvance({ clientId: clientA, branchId: A.branch.id, amount: 11, mode: 'UPI', idempotencyKey: key2 }, A.ctx, A.user.id)));
      results.forEach((r) => refIds.push(r.advance.id));
      expect(new Set(results.map((r) => r.advance.id)).size).toBe(1);
      expect(await prisma.customerAdvance.count({ where: { companyId: A.company.id, idempotencyKey: key2 } })).toBe(1);
      expect(await prisma.journalEntry.count({ where: { referenceId: results[0].advance.id } })).toBe(1);
    });
    it('the same key with a different amount is a 409', async () => {
      const key = `k3-${suffix}`;
      await create({ idempotencyKey: key, amount: 50 });
      await expect(create({ idempotencyKey: key, amount: 51 })).rejects.toMatchObject({ statusCode: 409 });
    });
    it('keys are per company', async () => {
      const key = `k4-${suffix}`;
      const a = await create({ idempotencyKey: key });
      const b = await create({ idempotencyKey: key }, B, clientB);
      expect(a.advance.id).not.toBe(b.advance.id);
    });
  });

  describe('cash limit (Sec 269ST)', () => {
    it('cash advances count toward the daily limit, together with invoice-side cash receipts', async () => {
      const c = await mk(A);
      await create({ mode: 'CASH', amount: CASH_RECEIPT_LIMIT - 1000 }, A, c);
      await expect(create({ mode: 'CASH', amount: 1000 }, A, c)).rejects.toThrow(/Cash limit/);
      // an on-account cash payment is limited by the same advance cash
      await expect(recordClientPayment({ clientId: c, paymentDate: new Date(), amount: 1000, mode: 'CASH' }, A.ctx, A.user.id)).rejects.toThrow(/Cash limit/);
      await create({ mode: 'CASH', amount: 999 }, A, c); // still below
    });
    it('non-cash advances never trip the limit', async () => {
      const c = await mk(A);
      await create({ mode: 'BANK_TRANSFER', amount: CASH_RECEIPT_LIMIT * 3 }, A, c);
      await create({ mode: 'CASH', amount: 1000 }, A, c);
    });
    it('a reversed cash advance frees the allowance', async () => {
      const c = await mk(A);
      const { advance } = await create({ mode: 'CASH', amount: CASH_RECEIPT_LIMIT - 1 }, A, c);
      await reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'keyed twice');
      await create({ mode: 'CASH', amount: CASH_RECEIPT_LIMIT - 1 }, A, c);
    });
  });

  describe('split payments', () => {
    const split = [{ mode: 'cash', amount: 30000 }, { mode: 'UPI', amount: 20000.5, referenceNo: 'UTR9' }];
    const make = (c: string, over: Record<string, unknown> = {}) =>
      createCustomerAdvance({ clientId: c, branchId: A.branch.id, payments: split, ...over } as any, A.ctx, A.user.id)
        .then((r) => { refIds.push(r.advance.id); return r; });

    it('one receipt, total of the lines, one balanced journal across cash and bank, and a clean reversal', async () => {
      const c = await mk(A);
      const { advance } = await make(c);
      expect(advance).toMatchObject({ amount: 50000.5, mode: 'SPLIT', availableAmount: 50000.5 });
      expect(advance.payments.map((p) => [p.mode, p.amount])).toEqual([['CASH', 30000], ['UPI', 20000.5]]);

      const je = (await getJournalEntry(advance.id))!;
      expect(lineAmount(je, LEDGER_ACCOUNT.CASH_IN_HAND)).toEqual({ debit: 30000, credit: 0 });
      expect(lineAmount(je, LEDGER_ACCOUNT.BANK_ACCOUNT)).toEqual({ debit: 20000.5, credit: 0 });
      expect(lineAmount(je, LEDGER_ACCOUNT.CUSTOMER_ADVANCES)).toEqual({ debit: 0, credit: 50000.5 });

      await reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'keyed wrong');
      const rev = (await prisma.journalEntry.findMany({ where: { referenceId: advance.id }, include: { lines: { include: { account: true } } } }))
        .find((e) => e.description.startsWith('Reversal'))!;
      const l = (code: string) => rev.lines.find((x) => x.account.code === code)!;
      expect(Number(l(LEDGER_ACCOUNT.CASH_IN_HAND).credit)).toBe(30000);
      expect(Number(l(LEDGER_ACCOUNT.BANK_ACCOUNT).credit)).toBe(20000.5);
    });

    it('only the cash part counts toward the Sec 269ST limit', async () => {
      const c = await mk(A);
      await make(c, { payments: [{ mode: 'CASH', amount: 1000 }, { mode: 'BANK_TRANSFER', amount: CASH_RECEIPT_LIMIT * 2 }] });
      await make(c, { payments: [{ mode: 'CASH', amount: CASH_RECEIPT_LIMIT - 2000 }, { mode: 'UPI', amount: 5000 }] });
      await expect(make(c, { payments: [{ mode: 'CASH', amount: 1000 }, { mode: 'UPI', amount: 1 }] })).rejects.toThrow(/Cash limit/);
    });

    it('filters by a mode inside a split, and rejects bad lines', async () => {
      const c = await mk(A);
      const { advance } = await make(c);
      const list = await listCustomerAdvances(A.ctx, { clientId: c, mode: 'UPI' });
      expect(list.rows.map((r) => r.id)).toContain(advance.id);
      await expect(make(c, { payments: Array.from({ length: 11 }, () => ({ mode: 'UPI', amount: 1 })) })).rejects.toMatchObject({ statusCode: 400 });
      await expect(make(c, { payments: [{ mode: 'UPI', amount: 5 }, { mode: 'CASH', amount: 0 }] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(make(c, { payments: [{ mode: 'OLD_GOLD', amount: 5 }] })).rejects.toMatchObject({ statusCode: 400 });
    });
it('allows the same mode on several lines (two UPI payments) in one receipt', async () => {      const c = await mk(A);      const { advance } = await make(c, { payments: [{ mode: 'UPI', amount: 700, referenceNo: 'U1' }, { mode: 'upi', amount: 300, referenceNo: 'U2' }] });      expect(advance).toMatchObject({ amount: 1000, mode: 'SPLIT' });      expect(advance.payments.map((p) => [p.mode, p.amount, p.referenceNo])).toEqual([['UPI', 700, 'U1'], ['UPI', 300, 'U2']]);      expect(lineAmount((await getJournalEntry(advance.id))!, LEDGER_ACCOUNT.BANK_ACCOUNT)).toEqual({ debit: 1000, credit: 0 });    });

    it('a retry with the same key replays; the same key with different lines is refused', async () => {
      const c = await mk(A);
      const key = `split-${suffix}`;
      const a = await make(c, { idempotencyKey: key });
      const b = await make(c, { idempotencyKey: key });
      expect(b.replayed).toBe(true); expect(b.advance.id).toBe(a.advance.id);
      await expect(make(c, { idempotencyKey: key, payments: [{ mode: 'CASH', amount: 20000 }, { mode: 'UPI', amount: 30000.5 }] })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('reversal', () => {
    it('reverses an unused advance with the inverse journal, reason and audit', async () => {
      const { advance } = await create({ mode: 'CASH', amount: 4000 });
      const r = await reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'wrong customer');
      expect(r).toMatchObject({ status: 'REVERSED', availableAmount: 0, reversalReason: 'wrong customer', amount: 4000 });
      expect(r.reversedBy?.id).toBe(A.user.id);
      const entries = await prisma.journalEntry.findMany({ where: { referenceId: advance.id }, include: { lines: { include: { account: true } } } });
      expect(entries).toHaveLength(2);
      const rev = entries.find((e) => e.description.startsWith('Reversal'))!;
      const l = (code: string) => rev.lines.find((x) => x.account.code === code)!;
      expect(Number(l(LEDGER_ACCOUNT.CUSTOMER_ADVANCES).debit)).toBe(4000);
      expect(Number(l(LEDGER_ACCOUNT.CASH_IN_HAND).credit)).toBe(4000);
      const log = await prisma.auditLog.findFirst({ where: { tableName: 'customer_advances', recordId: advance.id, action: 'REVERSE' } });
      expect(log).toMatchObject({ companyId: A.company.id, userId: A.user.id });
      expect((await getCustomerAdvance(A.ctx, advance.id)).status).toBe('REVERSED'); // still visible
    });
    it('requires a reason', async () => {
      const { advance } = await create();
      await expect(reverseCustomerAdvance(advance.id, A.ctx, A.user.id, '  ')).rejects.toMatchObject({ statusCode: 400 });
    });
    it('cannot be reversed twice, nor when applied or refunded', async () => {
      const { advance } = await create();
      await reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'x');
      await expect(reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });

      const applied = await create();
      await prisma.customerAdvance.update({ where: { id: applied.advance.id }, data: { appliedAmount: 1 } });
      await expect(reverseCustomerAdvance(applied.advance.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });
      const refunded = await create();
      await prisma.customerAdvance.update({ where: { id: refunded.advance.id }, data: { refundedAmount: 1 } });
      await expect(reverseCustomerAdvance(refunded.advance.id, A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 409 });
    });
    it('concurrent reversals: exactly one wins, one inverse journal', async () => {
      const { advance } = await create();
      const res = await Promise.allSettled([1, 2, 3].map(() => reverseCustomerAdvance(advance.id, A.ctx, A.user.id, 'race')));
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.journalEntry.count({ where: { referenceId: advance.id } })).toBe(2);
    });
    it('another company cannot read or reverse it; unknown id is 404', async () => {
      const { advance } = await create();
      await expect(getCustomerAdvance(B.ctx, advance.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(reverseCustomerAdvance(advance.id, B.ctx, B.user.id, 'x')).rejects.toMatchObject({ statusCode: 404 });
      await expect(reverseCustomerAdvance('nope', A.ctx, A.user.id, 'x')).rejects.toMatchObject({ statusCode: 404 });
      expect((await prisma.customerAdvance.findUniqueOrThrow({ where: { id: advance.id } })).reversedAt).toBeNull();
    });
  });

  describe('register', () => {
    it('is company- and branch-scoped, filters, derives status and totals everything', async () => {
      const T = await createTestTenant(`ADV2L${suffix}`, []);
      const c = await prisma.client.create({ data: { companyId: T.company.id, clientCode: `ADV2L-${suffix}`, name: 'Lister', type: 'RETAIL' } });
      clientIds.push(c.id);
      const b2 = await addBranch(T.company.id, `ADV2L${suffix}`);
      try {
        const mkAdv = async (branchId: string, amount: number, mode = 'UPI') => {
          const r = await createCustomerAdvance({ clientId: c.id, branchId, amount, mode }, T.ctx, T.user.id);
          refIds.push(r.advance.id); return r.advance;
        };
        const a1 = await mkAdv(T.branch.id, 1000);
        const a2 = await mkAdv(b2.id, 2000, 'CARD');
        const a3 = await mkAdv(T.branch.id, 500);
        await reverseCustomerAdvance(a3.id, T.ctx, T.user.id, 'oops');
        await prisma.customerAdvance.update({ where: { id: a1.id }, data: { appliedAmount: 400 } });

        const all = await listCustomerAdvances(T.ctx, {});
        expect(all.rows).toHaveLength(3);
        expect(all.totals).toMatchObject({ count: 2, reversedCount: 1, amount: 3000, applied: 400, available: 2600 });
        expect(all.rows.find((r) => r.id === a1.id)!.status).toBe('PARTIALLY_APPLIED');
        expect((await listCustomerAdvances(T.ctx, { status: 'REVERSED' })).rows.map((r) => r.id)).toEqual([a3.id]);
        expect((await listCustomerAdvances(T.ctx, { mode: 'card' })).rows.map((r) => r.id)).toEqual([a2.id]);
        expect((await listCustomerAdvances(T.ctx, { advanceNumber: a1.advanceNumber.slice(-8) })).rows.map((r) => r.id)).toContain(a1.id);
        await expect(listCustomerAdvances(T.ctx, { status: 'BOGUS' })).rejects.toMatchObject({ statusCode: 400 });

        const restricted = { ...T.ctx, branchAccess: { allBranches: false, branchIds: [T.branch.id] } };
        expect((await listCustomerAdvances(restricted, {})).rows.map((r) => r.id).sort()).toEqual([a1.id, a3.id].sort());
        await expect(listCustomerAdvances(restricted, { branchId: b2.id })).rejects.toMatchObject({ statusCode: 404 });
        await expect(getCustomerAdvance(restricted, a2.id)).rejects.toMatchObject({ statusCode: 404 });
        expect((await listCustomerAdvances(A.ctx, {})).rows.some((r) => r.id === a1.id)).toBe(false);
      } finally {
        await prisma.customerAdvance.updateMany({ where: { companyId: T.company.id }, data: { appliedAmount: 0 } });
        await cleanupJournalEntries(refIds);
        await cleanupTestTenant(T);
        await prisma.user.deleteMany({ where: { email: T.user.email } });
      }
    });
    it('deriveAdvanceStatus covers every state', () => {
      const d = (amount: number, applied: number, refunded: number, rev: Date | null = null) =>
        deriveAdvanceStatus({ amount, appliedAmount: applied, refundedAmount: refunded, reversedAt: rev } as any);
      expect(d(100, 0, 0)).toBe('ACTIVE');
      expect(d(100, 40, 0)).toBe('PARTIALLY_APPLIED');
      expect(d(100, 100, 0)).toBe('FULLY_APPLIED');
      expect(d(100, 0, 100)).toBe('REFUNDED');
      expect(d(100, 0, 0, new Date())).toBe('REVERSED');
    });
  });
});
