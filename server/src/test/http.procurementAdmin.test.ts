import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from './ledger';
import { recordSupplierPayment } from '../modules/procurement/procurement.service';
import { getSupplierLedger } from '../modules/finance/finance.service';
import { LEDGER_ACCOUNT } from '../shared/ledgerAccounts';

// Supplier-payment reversal and draft-requisition delete, over real HTTP.
describe('HTTP: procurement administration (payment reversal, requisition delete)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const supplierIds: string[] = [];
  const paymentIds: string[] = [];
  const prIds: string[] = [];

  afterAll(async () => {
    await cleanupJournalEntries(paymentIds);
    await prisma.supplierPayment.deleteMany({ where: { id: { in: paymentIds } } });
    await prisma.purchaseRequisition.deleteMany({ where: { id: { in: prIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    tenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }
  async function supplierWithPayment(t: TestTenant, label: string, mode = 'CASH') {
    const s = await prisma.supplier.create({
      data: { companyId: t.company.id, supplierCode: `PA-${label}-${suffix}`, name: `Supplier ${label}`, type: 'OTHER', currentDue: 1000 },
    });
    supplierIds.push(s.id);
    const p = await recordSupplierPayment({ supplierId: s.id, amount: 400, mode, paymentDate: new Date() }, t.ctx, t.user.id);
    paymentIds.push(p.id);
    return { supplierId: s.id, paymentId: p.id };
  }
  const due = async (id: string) => Number((await prisma.supplier.findUniqueOrThrow({ where: { id } })).currentDue);

  it('reverse payment: restores the payable, posts the inverse journal, audits, and cannot repeat', async () => {
    const { t, api } = await tenantWith('PRV', ['supplierPayment:reverse', 'journal:create']);
    const { supplierId, paymentId } = await supplierWithPayment(t, 'a');
    expect(await due(supplierId)).toBe(600);

    const noReason = await api.post(`/procurement/suppliers/${supplierId}/payments/${paymentId}/reverse`, {});
    expect(noReason.status).toBe(400);
    expect(await due(supplierId)).toBe(600);

    const ok = await api.post(`/procurement/suppliers/${supplierId}/payments/${paymentId}/reverse`, { reason: 'Wrong supplier' });
    expect(ok.status).toBe(200);
    expect(await due(supplierId)).toBe(1000);
    const row = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(row.reversedAt).not.toBeNull();
    expect(row.reversedById).toBe(t.user.id);
    expect(row.reversalReason).toBe('Wrong supplier');

    const audit = await prisma.auditLog.findFirst({ where: { tableName: 'supplier_payments', recordId: paymentId, action: 'REVERSE' } });
    expect(audit?.companyId).toBe(t.company.id);
    expect(audit?.userId).toBe(t.user.id);

    // The ledger journals for the payment and its reversal net to zero on Cash and Accounts Payable.
    const entries = await prisma.journalEntry.findMany({ where: { referenceId: paymentId }, include: { lines: { include: { account: true } } } });
    expect(entries).toHaveLength(2);
    const net = (code: string) => entries.flatMap((e) => e.lines).filter((l) => l.account.code === code)
      .reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0);
    expect(net(LEDGER_ACCOUNT.CASH_IN_HAND)).toBeCloseTo(0);
    expect(net(LEDGER_ACCOUNT.ACCOUNTS_PAYABLE)).toBeCloseTo(0);

    // A reversed payment no longer appears as money paid on the supplier statement.
    const ledger: any = await getSupplierLedger(t.ctx, supplierId);
    expect(JSON.stringify(ledger)).not.toContain(row.paymentNumber);

    const again = await api.post(`/procurement/suppliers/${supplierId}/payments/${paymentId}/reverse`, { reason: 'again' });
    expect(again.status).toBe(409);
    expect(await due(supplierId)).toBe(1000);
    void getJournalEntry; void lineAmount;
  });

  it('reverse payment: 403 without the permission, 404 cross-company or wrong supplier, nothing changes', async () => {
    const denied = await tenantWith('PRVD', ['supplierPayment:view']);
    const d = await supplierWithPayment(denied.t, 'd');
    expect((await denied.api.post(`/procurement/suppliers/${d.supplierId}/payments/${d.paymentId}/reverse`, { reason: 'x' })).status).toBe(403);

    const attacker = await tenantWith('PRVX', ['supplierPayment:reverse']);
    const victim = await tenantWith('PRVV', []);
    const v = await supplierWithPayment(victim.t, 'v');
    expect((await attacker.api.post(`/procurement/suppliers/${v.supplierId}/payments/${v.paymentId}/reverse`, { reason: 'x' })).status).toBe(404);

    const mine = await tenantWith('PRVW', ['supplierPayment:reverse']);
    const m1 = await supplierWithPayment(mine.t, 'm1');
    const m2 = await supplierWithPayment(mine.t, 'm2');
    expect((await mine.api.post(`/procurement/suppliers/${m1.supplierId}/payments/${m2.paymentId}/reverse`, { reason: 'x' })).status).toBe(404);
    expect((await mine.api.post(`/procurement/suppliers/${m1.supplierId}/payments/nope/reverse`, { reason: 'x' })).status).toBe(404);

    for (const x of [d, v, m1, m2]) {
      expect((await prisma.supplierPayment.findUniqueOrThrow({ where: { id: x.paymentId } })).reversedAt).toBeNull();
      expect(await due(x.supplierId)).toBe(600);
    }
  });

  it('supplier payments can still be recorded and listed through the new supplierPayment:* permissions', async () => {
    const { t, api } = await tenantWith('PRN', ['supplierPayment:create', 'supplierPayment:view']);
    const s = await prisma.supplier.create({
      data: { companyId: t.company.id, supplierCode: `PN-${suffix}`, name: 'New perms', type: 'OTHER' },
    });
    supplierIds.push(s.id);
    const res = await api.post(`/procurement/suppliers/${s.id}/payments`, { amount: 100, mode: 'CASH', paymentDate: new Date().toISOString() });
    expect(res.status).toBe(201);
    paymentIds.push(res.body.data.id);
    expect((await api.get(`/procurement/suppliers/${s.id}/payments`)).status).toBe(200);
  });

  async function makePr(companyId: string, userId: string, label: string, status: string) {
    const pr = await prisma.purchaseRequisition.create({
      data: {
        companyId, prNumber: `PR-DEL-${label}-${suffix}`, department: 'X', status, requestedById: userId,
        items: { create: [{ companyId, materialCode: 'M', materialName: 'M', materialType: 'METAL', quantity: 1, weight: 1, unit: 'GM', estimatedRate: 1, totalEstimatedAmount: 1 }] },
      },
    });
    prIds.push(pr.id);
    return pr.id;
  }

  it('requisition delete: draft succeeds and is audited; submitted is refused; 403 / cross-company / missing are safe', async () => {
    const { t, api } = await tenantWith('PRD', ['po:delete']);
    const draft = await makePr(t.company.id, t.user.id, 'd', 'DRAFT');
    expect((await api.del(`/procurement/requisitions/${draft}`)).status).toBe(200);
    expect(await prisma.purchaseRequisition.count({ where: { id: draft } })).toBe(0);
    expect(await prisma.prItem.count({ where: { prId: draft } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: 'purchase_requisitions', recordId: draft, action: 'DELETE', companyId: t.company.id } })).toBe(1);

    const submitted = await makePr(t.company.id, t.user.id, 's', 'SUBMITTED');
    expect((await api.del(`/procurement/requisitions/${submitted}`)).status).toBe(409);
    expect(await prisma.purchaseRequisition.count({ where: { id: submitted } })).toBe(1);

    expect((await api.del('/procurement/requisitions/nope')).status).toBe(404);

    const noPerm = await tenantWith('PRDN', ['po:create']);
    const mine = await makePr(noPerm.t.company.id, noPerm.t.user.id, 'n', 'DRAFT');
    expect((await noPerm.api.del(`/procurement/requisitions/${mine}`)).status).toBe(403);
    expect(await prisma.purchaseRequisition.count({ where: { id: mine } })).toBe(1);

    const victim = await tenantWith('PRDV', []);
    const theirs = await makePr(victim.t.company.id, victim.t.user.id, 'v', 'DRAFT');
    expect((await api.del(`/procurement/requisitions/${theirs}`)).status).toBe(404);
    expect(await prisma.purchaseRequisition.count({ where: { id: theirs } })).toBe(1);
  });
});
