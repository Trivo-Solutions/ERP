import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';

// J3 (Decisions 6/7): client:deactivate, client:delete, invoice:void, payment:reverse are new,
// SUPER_ADMIN-only-by-default permissions. This is the one thing the service-level tests in
// orders.service.test.ts / sales.service.test.ts do NOT cover — they call the service functions
// directly with a full-permission ctx, bypassing requirePermission(...) entirely. This file proves
// each new route is actually gated: granted -> succeeds, not granted -> 403, over real HTTP.
describe('HTTP: J3 administrative permission gating', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }

  async function makeClient(companyId: string, label: string) {
    const c = await prisma.client.create({
      data: { companyId, clientCode: `TSTCL-HJ3-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }

  it('client:deactivate — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('CDG', ['client:deactivate']);
    const clientId1 = await makeClient(granted.t.company.id, 'g');
    const ok = await granted.api.patch(`/orders/clients/${clientId1}/deactivate`, { reason: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.isActive).toBe(false);

    const missing = await tenantWith('CDM', ['client:edit']); // has edit, not deactivate
    const clientId2 = await makeClient(missing.t.company.id, 'm');
    const denied = await missing.api.patch(`/orders/clients/${clientId2}/deactivate`, { reason: 'test' });
    expect(denied.status).toBe(403);
  });

  it('client:delete — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('CLDG', ['client:delete']);
    const clientId1 = await makeClient(granted.t.company.id, 'g');
    const ok = await granted.api.del(`/orders/clients/${clientId1}`).send({ reason: 'never used' } as any);
    expect(ok.status).toBe(200);

    const missing = await tenantWith('CLDM', ['client:edit']);
    const clientId2 = await makeClient(missing.t.company.id, 'm');
    const denied = await missing.api.del(`/orders/clients/${clientId2}`).send({ reason: 'never used' } as any);
    expect(denied.status).toBe(403);
    clientIds.push(clientId2); // survives — the 403 must never have touched the row
  });

  async function makeInvoice(tenant: TestTenant) {
    const branchId = tenant.branch.id;
    const clientId = await makeClient(tenant.company.id, `inv-${invoiceIds.length}`);
    const api = apiWith(tokenFor(tenant), app);
    const res = await api.post('/sales/invoices', {
      clientId, branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 100 }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.data.id);
    return res.body.data;
  }

  it('invoice:void — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('IVG', ['invoice:create', 'invoice:void']);
    const inv1 = await makeInvoice(granted.t);
    const ok = await granted.api.post(`/sales/invoices/${inv1.id}/void`, { reason: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('VOID');

    const missing = await tenantWith('IVM', ['invoice:create', 'invoice:edit']); // has edit, not void
    const inv2 = await makeInvoice(missing.t);
    const denied = await missing.api.post(`/sales/invoices/${inv2.id}/void`, { reason: 'test' });
    expect(denied.status).toBe(403);
  });

  it('payment:reverse — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('PRG', ['invoice:create', 'payment:create', 'payment:reverse']);
    const invG = await makeInvoice(granted.t);
    const payG = await granted.api.post(`/sales/invoices/${invG.id}/payment`, { paymentDate: new Date().toISOString(), amount: 100, mode: 'CASH' });
    expect(payG.status).toBe(200);
    const paymentG = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invG.id } });
    const ok = await granted.api.post(`/sales/payments/${paymentG.id}/reverse`, { reason: 'test' });
    expect(ok.status).toBe(200);

    const missing = await tenantWith('PRM', ['invoice:create', 'payment:create']); // has create, not reverse
    const invM = await makeInvoice(missing.t);
    const payM = await missing.api.post(`/sales/invoices/${invM.id}/payment`, { paymentDate: new Date().toISOString(), amount: 100, mode: 'CASH' });
    expect(payM.status).toBe(200);
    const paymentM = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invM.id } });
    const denied = await missing.api.post(`/sales/payments/${paymentM.id}/reverse`, { reason: 'test' });
    expect(denied.status).toBe(403);
  });

  it('J3 Decision 7: GET /sales/clients/:id/credit now requires client:view, not invoice:create', async () => {
    const withView = await tenantWith('CRV', ['client:view']);
    const clientId1 = await makeClient(withView.t.company.id, 'view');
    expect((await withView.api.get(`/sales/clients/${clientId1}/credit`)).status).toBe(200);

    const withoutView = await tenantWith('CRN', ['invoice:create']); // old gate — should no longer be sufficient
    const clientId2 = await makeClient(withoutView.t.company.id, 'noview');
    expect((await withoutView.api.get(`/sales/clients/${clientId2}/credit`)).status).toBe(403);
  });
});
