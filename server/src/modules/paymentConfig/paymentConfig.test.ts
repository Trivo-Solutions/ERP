import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import {
  createProvider, updateProvider, listProviders, allocateProvider, removeAllocation, listBranchProviders,
  createTerminal, updateTerminal, listTerminals, getCollectionOptions,
} from './paymentConfig.service';
import { createInvoice, recordPayment, recordClientPayment } from '../sales/sales.service';
import { createCustomerAdvance, getCustomerAdvance } from '../sales/customerAdvance.service';
import { assertSafeAuthCode } from '../../shared/paymentMetadata';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import type { TenantContext } from '../../shared/tenantContext';

// Payment Configuration & Collection: provider master, branch availability, POS terminals, and per-leg metadata on
// the existing payment paths. A FIXED-rate free-text line of N rupees bills as N + 3% GST, so bill(10000) = 10,300.
describe('Payment Configuration & Collection', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let branch2: string;
  let restricted: TenantContext; // A's user limited to branch 1 only
  const clientIds: string[] = [];
  const refIds: string[] = [];
  let n = 0;

  const mkClient = async (t: TestTenant) => {
    const c = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `PC-${suffix}-${n++}`, name: `Cust ${n}`, type: 'RETAIL', panNumber: 'ABCDE1234F' } });
    clientIds.push(c.id);
    return c.id;
  };
  const bill = async (clientId: string, net: number, payments?: unknown[], t = A, branchId = t.branch.id, ctx: TenantContext = t.ctx) => {
    const inv = await createInvoice({
      branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Set', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: net, makingCharge: 0 }],
      ...(payments && { payments }),
    } as any, ctx, t.user.id);
    refIds.push(inv.id);
    return inv;
  };
  const pay = (mode: string, amount: number, extra: Record<string, unknown> = {}) => ({ paymentDate: new Date(), mode, amount, ...extra });
  const legs = (invoiceId: string) => prisma.invoicePayment.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
  const provider = async (t: TestTenant, name: string, methods = ['CARD', 'UPI', 'BANK_TRANSFER'], category = 'BANK') => {
    const p = await createProvider(t.ctx, { name: `${name}-${suffix}`, shortCode: name.slice(0, 5).toUpperCase() + n++, category, supportedMethods: methods });
    return p;
  };
  const terminal = (t: TestTenant, providerId: string, over: Record<string, unknown> = {}) =>
    createTerminal(t.ctx, { code: `T${n++}-${suffix}`, name: 'Counter POS', providerId, tid: `TID${n++}${suffix}`, supportedMethods: ['CARD'], branchId: t.branch.id, ...over });
  const audits = (table: string, recordId: string) => prisma.auditLog.findMany({ where: { tableName: table, recordId }, orderBy: { timestamp: 'asc' } });

  beforeAll(async () => {
    A = await createTestTenant(`PCA${suffix}`, []);
    B = await createTestTenant(`PCB${suffix}`, []);
    branch2 = (await addBranch(A.company.id, `PC${suffix}`)).id;
    restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } };
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

  // Runs FIRST on purpose: no provider / terminal exists yet, so these are exactly today's payloads.
  describe('legacy payloads (nothing configured)', () => {
    it('cash, card, upi, bank transfer and cheque legs with no new fields still work, and carry no metadata', async () => {
      const c = await mkClient(A);
      const inv = await bill(c, 10000, [pay('CASH', 2000), pay('CARD', 2000), pay('UPI', 2000, { referenceNo: 'UTR1' }), pay('BANK_TRANSFER', 2000), pay('CHEQUE', 2300)]);
      expect(Number(inv.paidAmount)).toBe(10300);
      const rows = await legs(inv.id);
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r).toMatchObject({ providerId: null, terminalId: null, providerName: null, terminalTid: null, authCode: null, chequeNumber: null });
        expect(r.branchId).toBe(A.branch.id); // stamped on NEW rows only
      }
      expect(rows[2].referenceNo).toBe('UTR1');
    });

    it('legacy standalone receipt and advance (no branchId / metadata) work', async () => {
      const c = await mkClient(A);
      const p = await recordClientPayment({ clientId: c, ...pay('CARD', 500) }, A.ctx, A.user.id);
      expect(p.providerId).toBeNull();
      const { advance } = await createCustomerAdvance({ clientId: c, branchId: A.branch.id, amount: 800, mode: 'CARD' }, A.ctx, A.user.id);
      refIds.push(advance.id, p.id);
      expect(advance.payments[0]).toMatchObject({ mode: 'CARD', providerId: null, terminalId: null });
    });
  });

  describe('provider master', () => {
    it('creates, edits, deactivates and reactivates with an audit trail naming actor / company / action', async () => {
      const p = await provider(A, 'HDFC', ['CARD', 'UPI']);
      expect(p).toMatchObject({ isActive: true, category: 'BANK' });
      const e = await updateProvider(A.ctx, p.id, { merchantRef: 'trivo@hdfc', supportedMethods: ['UPI'] });
      expect(e.supportedMethods).toEqual(['UPI']);
      await updateProvider(A.ctx, p.id, { isActive: false });
      await updateProvider(A.ctx, p.id, { isActive: true });
      const log = await audits('payment_providers', p.id);
      expect(log.map((l) => l.action)).toEqual(['CREATE', 'EDIT', 'DEACTIVATE', 'REACTIVATE']);
      for (const l of log) expect(l).toMatchObject({ companyId: A.company.id, userId: A.user.id });
      expect((log[1].oldValues as any).supportedMethods).toEqual(['CARD', 'UPI']);
      expect((log[1].newValues as any).supportedMethods).toEqual(['UPI']);
    });

    it('validates input and refuses a duplicate name', async () => {
      await expect(createProvider(A.ctx, { name: '', category: 'BANK', supportedMethods: ['UPI'] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(createProvider(A.ctx, { name: `x-${suffix}`, category: 'WALLET', supportedMethods: ['UPI'] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(createProvider(A.ctx, { name: `x-${suffix}`, category: 'BANK', supportedMethods: ['CASH'] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(createProvider(A.ctx, { name: `x-${suffix}`, category: 'BANK', supportedMethods: [] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(createProvider(A.ctx, { name: `x-${suffix}`, category: 'BANK', supportedMethods: ['UPI'], merchantRef: 'a b; DROP' })).rejects.toMatchObject({ statusCode: 400 });
      const p = await provider(A, 'DUP');
      await expect(createProvider(A.ctx, { name: p.name, category: 'BANK', supportedMethods: ['UPI'] })).rejects.toMatchObject({ statusCode: 409 });
      // The same name is fine in another company.
      await expect(createProvider(B.ctx, { name: p.name, category: 'BANK', supportedMethods: ['UPI'] })).resolves.toBeTruthy();
    });

    it('never shows or edits another company\'s provider', async () => {
      const mine = await provider(A, 'MINE');
      const theirs = await provider(B, 'THEIRS');
      expect((await listProviders(A.ctx)).map((p) => p.id)).not.toContain(theirs.id);
      await expect(updateProvider(A.ctx, theirs.id, { isActive: false })).rejects.toMatchObject({ statusCode: 404 });
      expect((await prisma.paymentProvider.findUniqueOrThrow({ where: { id: theirs.id } })).isActive).toBe(true);
      await expect(updateProvider(A.ctx, 'nope', { isActive: false })).rejects.toMatchObject({ statusCode: 404 });
      expect(mine.id).not.toBe(theirs.id);
    });
  });

  describe('branch availability', () => {
    it('allocates (idempotently), lists, removes, audits; cross-company ids are 404', async () => {
      const p = await provider(A, 'ALLOC');
      const a1 = await allocateProvider(A.ctx, A.branch.id, p.id);
      const a2 = await allocateProvider(A.ctx, A.branch.id, p.id);
      expect(a2.id).toBe(a1.id);
      expect((await listBranchProviders(A.ctx, A.branch.id)).filter((l) => l.providerId === p.id)).toHaveLength(1);
      await expect(allocateProvider(A.ctx, B.branch.id, p.id)).rejects.toMatchObject({ statusCode: 404 });
      const other = await provider(B, 'OTHERCO');
      await expect(allocateProvider(A.ctx, A.branch.id, other.id)).rejects.toMatchObject({ statusCode: 404 });
      await removeAllocation(A.ctx, A.branch.id, p.id);
      await expect(removeAllocation(A.ctx, A.branch.id, p.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await audits('branch_payment_providers', a1.id)).map((l) => l.action)).toEqual(['ALLOCATE', 'REMOVE']);
    });

    it('a branch-restricted user cannot allocate at, or list, a branch they are not granted', async () => {
      const p = await provider(A, 'RESTR');
      await expect(allocateProvider(restricted, branch2, p.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(listBranchProviders(restricted, branch2)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('POS terminals', () => {
    it('TID is unique per provider + MID, never globally', async () => {
      const p1 = await provider(A, 'ACQ1', ['CARD'], 'ACQUIRER');
      const p2 = await provider(A, 'ACQ2', ['CARD'], 'ACQUIRER');
      const tid = `SAME${suffix}`;
      const t1 = await terminal(A, p1.id, { tid, mid: 'M1' });
      await expect(terminal(A, p1.id, { tid, mid: 'M1' })).rejects.toMatchObject({ statusCode: 409 }); // same acquirer + merchant
      await expect(terminal(A, p1.id, { tid, mid: 'M2' })).resolves.toBeTruthy();                       // another merchant: fine
      await expect(terminal(A, p2.id, { tid, mid: 'M1' })).resolves.toBeTruthy();                       // another acquirer: fine
      await expect(terminal(B, (await provider(B, 'ACQB', ['CARD'])).id, { tid, mid: 'M1', branchId: B.branch.id })).resolves.toBeTruthy(); // another company: fine
      await terminal(A, p1.id, { tid: `NM${suffix}` });
      await expect(terminal(A, p1.id, { tid: `NM${suffix}` })).rejects.toMatchObject({ statusCode: 409 }); // two MID-less rows clash
      await expect(terminal(A, p1.id, { code: t1.code, tid: `OTHER${suffix}` })).rejects.toMatchObject({ statusCode: 409 }); // code per company
    });

    it('validates fields and refuses forged / foreign / inactive references', async () => {
      const p = await provider(A, 'VAL', ['CARD'], 'ACQUIRER');
      await expect(terminal(A, p.id, { tid: '' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(terminal(A, p.id, { tid: 'ab cd;' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(terminal(A, p.id, { supportedMethods: ['CASH'] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(terminal(A, p.id, { providerId: { not: '' } })).rejects.toMatchObject({ statusCode: 400 });
      const foreign = await provider(B, 'FOREIGN', ['CARD']);
      await expect(terminal(A, foreign.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(terminal(A, p.id, { branchId: B.branch.id })).rejects.toMatchObject({ statusCode: 404 });
      await expect(createTerminal(restricted, { code: `R${n++}-${suffix}`, name: 'x', providerId: p.id, tid: `RT${n++}${suffix}`, supportedMethods: ['CARD'], branchId: branch2 })).rejects.toMatchObject({ statusCode: 404 });
      await updateProvider(A.ctx, p.id, { isActive: false });
      await expect(terminal(A, p.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('reassigning / deactivating audits before+after and a restricted user cannot move a terminal into a branch they lack', async () => {
      const p = await provider(A, 'MOVE', ['CARD'], 'ACQUIRER');
      const t = await terminal(A, p.id);
      await expect(updateTerminal(restricted, t.id, { branchId: branch2 })).rejects.toMatchObject({ statusCode: 404 });
      await updateTerminal(A.ctx, t.id, { branchId: branch2 });
      await updateTerminal(A.ctx, t.id, { isActive: false });
      await updateTerminal(A.ctx, t.id, { name: 'Renamed' });
      const log = await audits('pos_terminals', t.id);
      expect(log.map((l) => l.action)).toEqual(['CREATE', 'REASSIGN', 'DEACTIVATE', 'EDIT']);
      expect((log[1].oldValues as any).branchId).toBe(A.branch.id);
      expect((log[1].newValues as any).branchId).toBe(branch2);
      // Once it sits in branch 2 the restricted user (branch 1 only) cannot even see or touch it.
      await expect(updateTerminal(restricted, t.id, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 });
      expect((await listTerminals(restricted)).map((x) => x.id)).not.toContain(t.id);
      await expect(listTerminals(restricted, { branchId: branch2 })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('cannot touch another company\'s terminal', async () => {
      const pb = await provider(B, 'TB', ['CARD']);
      const tb = await terminal(B, pb.id, { branchId: B.branch.id });
      await expect(updateTerminal(A.ctx, tb.id, { isActive: false })).rejects.toMatchObject({ statusCode: 404 });
      expect((await prisma.posTerminal.findUniqueOrThrow({ where: { id: tb.id } })).isActive).toBe(true);
    });
  });

  describe('collection: card / POS', () => {
    let acq: { id: string; name: string }; let term: { id: string; code: string; tid: string };
    let client: string;
    beforeAll(async () => {
      acq = await provider(A, 'POSBANK', ['CARD', 'UPI'], 'ACQUIRER');
      term = await terminal(A, acq.id, { mid: 'MID9', supportedMethods: ['CARD', 'UPI'] });
      client = await mkClient(A);
    });

    it('once the branch has an active terminal a card leg must name it - and the leg snapshots it', async () => {
      await expect(bill(client, 1000, [pay('CARD', 1030)])).rejects.toMatchObject({ statusCode: 400 });
      expect(await prisma.salesInvoice.count({ where: { clientId: client } })).toBe(0); // all-or-nothing

      const inv = await bill(client, 1000, [pay('CARD', 1030, { terminalId: term.id, authCode: 'A1B2C3', referenceNo: 'RRN1' })]);
      const [leg] = await legs(inv.id);
      expect(leg).toMatchObject({ terminalId: term.id, terminalCode: term.code, terminalTid: term.tid, terminalMid: 'MID9', providerId: acq.id, providerName: acq.name, authCode: 'A1B2C3', referenceNo: 'RRN1' });
    });

    it('rejects a terminal that is inactive, at another branch, foreign, unsupported-method, or a mismatched provider', async () => {
      const c = await mkClient(A);
      const other = await terminal(A, acq.id, { branchId: branch2 });
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: other.id })])).rejects.toMatchObject({ statusCode: 400 });
      const pb = await provider(B, 'FB', ['CARD']);
      const tb = await terminal(B, pb.id, { branchId: B.branch.id });
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: tb.id })])).rejects.toMatchObject({ statusCode: 404 });
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: 'forged' })])).rejects.toMatchObject({ statusCode: 404 });
      await expect(bill(c, 1000, [pay('BANK_TRANSFER', 1030, { terminalId: term.id })])).rejects.toMatchObject({ statusCode: 400 });
      const cardOnly = await terminal(A, acq.id, { supportedMethods: ['CARD'] });
      await expect(bill(c, 1000, [pay('UPI', 1030, { terminalId: cardOnly.id })])).rejects.toMatchObject({ statusCode: 400 });
      const p2 = await provider(A, 'POSBANK2', ['CARD'], 'ACQUIRER');
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: term.id, providerId: p2.id })])).rejects.toMatchObject({ statusCode: 400 });
      const spare = await terminal(A, acq.id, { supportedMethods: ['CARD'] });
      await updateTerminal(A.ctx, spare.id, { isActive: false });
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: spare.id })])).rejects.toMatchObject({ statusCode: 409 });
      await updateProvider(A.ctx, p2.id, { isActive: false });
      const t3 = await terminal(A, acq.id, { supportedMethods: ['CARD'] });
      await updateProvider(A.ctx, acq.id, { isActive: false });
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: t3.id })])).rejects.toMatchObject({ statusCode: 409 });
      await updateProvider(A.ctx, acq.id, { isActive: true });
      expect(await prisma.salesInvoice.count({ where: { clientId: c } })).toBe(0);
    });

    it('cash needs and accepts no bank / provider / terminal / reference data', async () => {
      const c = await mkClient(A);
      const inv = await bill(c, 1000, [pay('CASH', 1030)]);
      expect((await legs(inv.id))[0]).toMatchObject({ terminalId: null, providerId: null });
      await expect(bill(c, 1000, [pay('CASH', 1030, { terminalId: term.id })])).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 1000, [pay('CASH', 1030, { providerId: acq.id })])).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 1000, [pay('CASH', 1030, { authCode: 'X1' })])).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a physical terminal is optional for ordinary UPI', async () => {
      const c = await mkClient(A);
      const inv = await bill(c, 1000, [pay('UPI', 1030, { referenceNo: 'UTR9' })]);
      expect((await legs(inv.id))[0]).toMatchObject({ terminalId: null, referenceNo: 'UTR9' });
    });

    it('refuses anything shaped like a card number as an authorization code', async () => {
      expect(() => assertSafeAuthCode('4111111111111111')).toThrow(/card number/);
      expect(() => assertSafeAuthCode('4111-1111-1111-1111')).toThrow();
      expect(() => assertSafeAuthCode('A1B2C3')).not.toThrow();
      const c = await mkClient(A);
      await expect(bill(c, 1000, [pay('CARD', 1030, { terminalId: term.id, authCode: '4111111111111111' })])).rejects.toMatchObject({ statusCode: 400 });
    });

    it('authorization code / cheque fields are refused on the wrong method', async () => {
      const c = await mkClient(A);
      await expect(bill(c, 1000, [pay('UPI', 1030, { authCode: 'AB12' })])).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 1000, [pay('UPI', 1030, { chequeNumber: '123456' })])).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('collection: UPI / bank transfer / cheque providers', () => {
    it('a bank-transfer provider must be active, serve the method, and be allocated at the branch; required once one is allocated', async () => {
      const c = await mkClient(A);
      const sbi = await provider(A, 'SBI', ['BANK_TRANSFER', 'UPI']);
      const unallocated = await provider(A, 'UNALLOC', ['BANK_TRANSFER']);
      const noUpi = await provider(A, 'NOUPI', ['BANK_TRANSFER']);
      await allocateProvider(A.ctx, A.branch.id, sbi.id);
      await allocateProvider(A.ctx, A.branch.id, noUpi.id);
      // bank transfer now requires a provider at this branch
      await expect(bill(c, 1000, [pay('BANK_TRANSFER', 1030)])).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 1000, [pay('BANK_TRANSFER', 1030, { providerId: unallocated.id })])).rejects.toMatchObject({ statusCode: 400 });
      await expect(bill(c, 1000, [pay('UPI', 1030, { providerId: noUpi.id })])).rejects.toMatchObject({ statusCode: 400 }); // does not serve UPI
      const foreign = await provider(B, 'FP', ['BANK_TRANSFER']);
      await expect(bill(c, 1000, [pay('BANK_TRANSFER', 1030, { providerId: foreign.id })])).rejects.toMatchObject({ statusCode: 404 });
      const inv = await bill(c, 1000, [pay('BANK_TRANSFER', 1030, { providerId: sbi.id, referenceNo: 'UTR-77' })]);
      expect((await legs(inv.id))[0]).toMatchObject({ providerId: sbi.id, providerName: sbi.name, referenceNo: 'UTR-77' });
      // UPI provider optional, but validated when sent; inactive refused
      await updateProvider(A.ctx, sbi.id, { isActive: false });
      await expect(bill(c, 1000, [pay('UPI', 1030, { providerId: sbi.id })])).rejects.toMatchObject({ statusCode: 409 });
      await updateProvider(A.ctx, sbi.id, { isActive: true });
      await removeAllocation(A.ctx, A.branch.id, sbi.id);
      await expect(bill(c, 1000, [pay('UPI', 1030, { providerId: sbi.id })])).rejects.toMatchObject({ statusCode: 400 }); // removed from branch
      await removeAllocation(A.ctx, A.branch.id, noUpi.id);
    });

    it('cheque number / date / bank are captured on a cheque leg', async () => {
      const c = await mkClient(A);
      const inv = await bill(c, 1000, [pay('CHEQUE', 1030, { chequeNumber: '000123', chequeDate: '2026-10-20', chequeBank: 'Axis Bank' })]);
      expect((await legs(inv.id))[0]).toMatchObject({ chequeNumber: '000123', chequeBank: 'Axis Bank' });
      expect((await legs(inv.id))[0].chequeDate?.toISOString().slice(0, 10)).toBe('2026-10-20');
      await expect(bill(c, 1000, [pay('CHEQUE', 1030, { chequeDate: 'not a date' })])).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('split payments keep per-leg metadata, and accounting is unchanged', () => {
    it('two UPI legs + a card leg on one invoice stay three independent records; ledger/balance identical to a legacy split', async () => {
      const upiBank = await provider(A, 'UPIB', ['UPI']);
      const acq = await provider(A, 'ACQSPLIT', ['CARD'], 'ACQUIRER');
      const upi2 = await provider(A, 'UPIB2', ['UPI']);
      await allocateProvider(A.ctx, A.branch.id, upiBank.id); await allocateProvider(A.ctx, A.branch.id, upi2.id);
      const t = await terminal(A, acq.id);
      const c = await mkClient(A);

      const split = [
        pay('UPI', 3000, { providerId: upiBank.id, referenceNo: 'U-1' }),
        pay('UPI', 2000, { providerId: upi2.id, referenceNo: 'U-2' }),
        pay('CARD', 5300, { terminalId: t.id, authCode: 'AUTH55', referenceNo: 'R-5' }),
      ];
      const inv = await bill(c, 10000, split);
      const rows = await legs(inv.id);
      expect(rows.map((r) => [r.mode, Number(r.amount), r.providerName, r.referenceNo, r.terminalTid, r.authCode])).toEqual([
        ['UPI', 3000, upiBank.name, 'U-1', null, null],
        ['UPI', 2000, upi2.name, 'U-2', null, null],
        ['CARD', 5300, acq.name, 'R-5', t.tid, 'AUTH55'],
      ]);
      const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      expect(after).toMatchObject({ status: 'PAID' });
      expect(Number(after.paidAmount)).toBe(10300); expect(Number(after.balanceDue)).toBe(0);
      expect(Number((await prisma.client.findUniqueOrThrow({ where: { id: c } })).currentBalance)).toBe(0);
      // Each leg posts exactly the receipt entry it always did: Dr Bank / Cr AR, no provider-specific account.
      for (const r of rows) {
        const je = (await getJournalEntry(r.id))!;
        expect(lineAmount(je, LEDGER_ACCOUNT.BANK_ACCOUNT)).toEqual({ debit: Number(r.amount), credit: 0 });
        expect(lineAmount(je, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE)).toEqual({ debit: 0, credit: Number(r.amount) });
      }
    });

    it('a later single payment, a standalone receipt and an advance split all carry their own metadata', async () => {
      const acq = await provider(A, 'ACQLATER', ['CARD', 'UPI'], 'ACQUIRER');
      const t = await terminal(A, acq.id, { supportedMethods: ['CARD', 'UPI'] });
      const c = await mkClient(A);
      const inv = await bill(c, 10000);
      await recordPayment({ invoiceId: inv.id, ...pay('CARD', 4000, { terminalId: t.id, authCode: 'LATE1' }) } as any, A.ctx, A.user.id);
      await recordPayment({ invoiceId: inv.id, ...pay('UPI', 1000, { referenceNo: 'U-L', terminalId: t.id }) } as any, A.ctx, A.user.id);
      const rows = await legs(inv.id);
      expect(rows.map((r) => [r.mode, r.terminalCode, r.authCode])).toEqual([['CARD', t.code, 'LATE1'], ['UPI', t.code, null]]);

      // standalone receipt: provider data needs the collecting branch
      await expect(recordClientPayment({ clientId: c, ...pay('CARD', 100, { terminalId: t.id }) }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      const sp = await recordClientPayment({ clientId: c, branchId: A.branch.id, ...pay('CARD', 100, { terminalId: t.id, authCode: 'ONACC' }) }, A.ctx, A.user.id);
      refIds.push(sp.id);
      expect(sp).toMatchObject({ terminalTid: t.tid, authCode: 'ONACC', branchId: A.branch.id, invoiceId: null });

      // advance: three lines, two UPI, each with its own provider
      const u1 = await provider(A, 'ADVU1', ['UPI']); const u2 = await provider(A, 'ADVU2', ['UPI']);
      await allocateProvider(A.ctx, A.branch.id, u1.id); await allocateProvider(A.ctx, A.branch.id, u2.id);
      const { advance } = await createCustomerAdvance({
        clientId: c, branchId: A.branch.id,
        payments: [
          { mode: 'UPI', amount: 100, referenceNo: 'AU1', providerId: u1.id }, { mode: 'UPI', amount: 200, referenceNo: 'AU2', providerId: u2.id },
          { mode: 'CARD', amount: 300, terminalId: t.id, authCode: 'ADVC' },
        ],
      }, A.ctx, A.user.id);
      refIds.push(advance.id);
      const got = await getCustomerAdvance(A.ctx, advance.id);
      expect(got.payments.map((p) => [p.mode, Number(p.amount), p.providerName ?? null, p.terminalTid ?? null, p.authCode ?? null])).toEqual([
        ['UPI', 100, u1.name, null, null], ['UPI', 200, u2.name, null, null], ['CARD', 300, acq.name, t.tid, 'ADVC'],
      ]);
      expect(got.amount).toBe(600);
      // an advance leg naming a forged terminal fails as a whole
      await expect(createCustomerAdvance({ clientId: c, branchId: A.branch.id, amount: 50, mode: 'CARD', terminalId: 'forged' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('credit-settlement legs take no provider data', async () => {
      const c = await mkClient(A);
      await expect(bill(c, 1000, [pay('STORE_CREDIT', 100, { providerId: 'x' })])).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('history is preserved when configuration changes', () => {
    it('deactivating, renaming, reassigning and re-pointing a terminal never rewrites a past payment', async () => {
      const acq = await provider(A, 'HIST', ['CARD'], 'ACQUIRER');
      const t = await terminal(A, acq.id, { mid: 'HM1' });
      const c = await mkClient(A);
      const inv = await bill(c, 1000, [pay('CARD', 1030, { terminalId: t.id, authCode: 'H1' })]);
      const before = (await legs(inv.id))[0];

      await updateTerminal(A.ctx, t.id, { name: 'Renamed', code: `NEW-${suffix}`, tid: `NEWTID${suffix}`, mid: 'HM2', branchId: branch2 });
      await updateTerminal(A.ctx, t.id, { isActive: false });
      await updateProvider(A.ctx, acq.id, { name: `Renamed-${suffix}`, isActive: false });

      const after = (await legs(inv.id))[0];
      expect(after).toMatchObject({ terminalCode: before.terminalCode, terminalTid: before.terminalTid, terminalMid: 'HM1', providerName: before.providerName, authCode: 'H1' });
      expect(after.terminalId).toBe(t.id); // the link survives so reconciliation can still find the machine
      // ...and the deactivated terminal is no longer usable for a NEW payment
      const c2 = await mkClient(A);
      await expect(bill(c2, 1000, [pay('CARD', 1030, { terminalId: t.id })])).rejects.toMatchObject({ statusCode: 400 });
      // a used provider / terminal cannot be hard-deleted out from under its payments
      await expect(prisma.posTerminal.delete({ where: { id: t.id } })).rejects.toBeTruthy();
      await expect(prisma.paymentProvider.delete({ where: { id: acq.id } })).rejects.toBeTruthy();
    });
  });

  describe('branch isolation on collection', () => {
    it('options list only active, branch-allocated providers and terminals the caller may use', async () => {
      const acq = await provider(A, 'OPT', ['CARD', 'UPI'], 'ACQUIRER');
      const t1 = await terminal(A, acq.id);
      const t2 = await terminal(A, acq.id, { branchId: branch2 });
      const off = await terminal(A, acq.id); await updateTerminal(A.ctx, off.id, { isActive: false });
      const up = await provider(A, 'OPTU', ['UPI']); await allocateProvider(A.ctx, A.branch.id, up.id);
      const o1 = await getCollectionOptions(A.ctx, A.branch.id);
      expect(o1.terminals.map((x) => x.id)).toContain(t1.id);
      expect(o1.terminals.map((x) => x.id)).not.toContain(t2.id);
      expect(o1.terminals.map((x) => x.id)).not.toContain(off.id);
      expect(o1.providers.map((x) => x.id)).toContain(up.id);
      expect(o1.requireTerminalForCard).toBe(true);
      await expect(getCollectionOptions(restricted, branch2)).rejects.toMatchObject({ statusCode: 404 });
      await expect(getCollectionOptions(A.ctx, B.branch.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(getCollectionOptions(A.ctx, undefined as any)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a restricted user cannot collect with a branch-2 terminal on a branch-2 invoice', async () => {
      const acq = await provider(A, 'B2', ['CARD'], 'ACQUIRER');
      const t = await terminal(A, acq.id, { branchId: branch2 });
      const c = await mkClient(A);
      const inv = await bill(c, 1000, undefined, A, branch2); // an all-branches user bills at branch 2 (terminal present => no card leg here)
      await expect(recordPayment({ invoiceId: inv.id, ...pay('CARD', 100, { terminalId: t.id }) } as any, restricted, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
      expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } })).toBe(0);
      await expect(recordPayment({ invoiceId: inv.id, ...pay('CARD', 100, { terminalId: t.id }) } as any, A.ctx, A.user.id)).resolves.toBeTruthy();
    });
  });
});
