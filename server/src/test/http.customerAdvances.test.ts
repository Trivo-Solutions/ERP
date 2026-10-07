import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';

// Customer Advances Phase 2 — requirePermission(...) actually gates each route over real HTTP, and a forged
// cross-company id is refused.
describe('HTTP: customer advances', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const advanceIds: string[] = [];

  afterAll(async () => {
    await cleanupJournalEntries(advanceIds);
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    for (const t of tenants) await prisma.user.deleteMany({ where: { email: t.user.email } });
    await prisma.$disconnect();
  });

  async function setup(tag: string, perms: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, perms);
    tenants.push(t);
    const c = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `HADV-${tag}-${suffix}`, name: 'C', type: 'RETAIL' } });
    clientIds.push(c.id);
    return { t, clientId: c.id, api: apiWith(tokenFor(t), app) };
  }

  it('create / view / reverse each need their own permission', async () => {
    const full = await setup('F', ['payment:create', 'payment:view', 'payment:reverse']);
    const none = await setup('N', ['sales:view']);
    const body = { clientId: full.clientId, branchId: full.t.branch.id, amount: 1500, mode: 'UPI' };

    expect((await none.api.post('/sales/advances', { ...body, clientId: none.clientId, branchId: none.t.branch.id })).status).toBe(403);
    expect((await none.api.get('/sales/advances')).status).toBe(403);

    const created = await full.api.post('/sales/advances', { ...body, idempotencyKey: `h-${suffix}` });
    expect(created.status).toBe(201);
    advanceIds.push(created.body.data.id);
    const replay = await full.api.post('/sales/advances', { ...body, idempotencyKey: `h-${suffix}` });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(created.body.data.id);

    const id = created.body.data.id;
    expect((await full.api.get('/sales/advances')).body.data.rows).toHaveLength(1);
    expect((await full.api.get(`/sales/advances/${id}`)).body.data.advanceNumber).toMatch(/^ADV-/);
    expect((await none.api.get(`/sales/advances/${id}`)).status).toBe(403);
    expect((await none.api.post(`/sales/advances/${id}/reverse`, { reason: 'x' })).status).toBe(403);

    const viewOnly = await setup('V', ['payment:view', 'payment:create']);
    expect((await viewOnly.api.post(`/sales/advances/${id}/reverse`, { reason: 'x' })).status).toBe(403);

    expect((await full.api.post(`/sales/advances/${id}/reverse`, { reason: '' })).status).toBe(400);
    const rev = await full.api.post(`/sales/advances/${id}/reverse`, { reason: 'mistake' });
    expect(rev.status).toBe(200);
    expect(rev.body.data.status).toBe('REVERSED');
  });

  it('forged cross-company ids are 404 and nothing is created', async () => {
    const a = await setup('XA', ['payment:create', 'payment:view', 'payment:reverse']);
    const b = await setup('XB', ['payment:create', 'payment:view', 'payment:reverse']);
    expect((await a.api.post('/sales/advances', { clientId: b.clientId, branchId: a.t.branch.id, amount: 10, mode: 'UPI' })).status).toBe(404);
    expect((await a.api.post('/sales/advances', { clientId: a.clientId, branchId: b.t.branch.id, amount: 10, mode: 'UPI' })).status).toBe(404);
    const mine = await b.api.post('/sales/advances', { clientId: b.clientId, branchId: b.t.branch.id, amount: 10, mode: 'UPI' });
    advanceIds.push(mine.body.data.id);
    expect((await a.api.get(`/sales/advances/${mine.body.data.id}`)).status).toBe(404);
    expect((await a.api.post(`/sales/advances/${mine.body.data.id}/reverse`, { reason: 'x' })).status).toBe(404);
    expect((await a.api.get('/sales/advances')).body.data.rows).toHaveLength(0);
    expect((await a.api.post('/sales/advances', { clientId: { not: '' }, branchId: a.t.branch.id, amount: 10, mode: 'UPI' })).status).toBe(400);
  });

  // Phase 3
  it('apply-advances / available / applications are permission-gated and company-scoped over HTTP', async () => {
    const full = await setup('P3F', ['payment:create', 'payment:view', 'client:view', 'invoice:create']);
    const none = await setup('P3N', ['sales:view']);
    const other = await setup('P3O', ['payment:create', 'payment:view', 'client:view', 'invoice:create']);

    const adv = await full.api.post('/sales/advances', { clientId: full.clientId, branchId: full.t.branch.id, amount: 5000, mode: 'UPI' });
    advanceIds.push(adv.body.data.id);
    await prisma.client.update({ where: { id: full.clientId }, data: { panNumber: 'ABCDE1234F' } });
    const inv = await full.api.post('/sales/invoices', {
      branchId: full.t.branch.id, clientId: full.clientId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Set', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000, makingCharge: 0 }],
    });
    expect(inv.status).toBe(201);
    advanceIds.push(inv.body.data.id);
    const invId = inv.body.data.id;

    expect((await none.api.get(`/sales/clients/${none.clientId}/advances/available`)).status).toBe(403);
    expect((await none.api.post(`/sales/invoices/${invId}/apply-advances`, { auto: true })).status).toBe(403);
    expect((await none.api.get(`/sales/advances/${adv.body.data.id}/applications`)).status).toBe(403);

    const avail = await full.api.get(`/sales/clients/${full.clientId}/advances/available`);
    expect(avail.status).toBe(200);
    expect(avail.body.data.totalAvailable).toBe(5000);

    // another company: its own caller cannot see this customer's advances or touch this invoice
    expect((await other.api.get(`/sales/clients/${full.clientId}/advances/available`)).status).toBe(404);
    expect((await other.api.post(`/sales/invoices/${invId}/apply-advances`, { allocations: [{ advanceId: adv.body.data.id, amount: 100 }] })).status).toBe(404);

    const body = { allocations: [{ advanceId: adv.body.data.id, amount: 400 }], idempotencyKey: `ap-${suffix}` };
    const applied = await full.api.post(`/sales/invoices/${invId}/apply-advances`, body);
    expect(applied.status).toBe(201);
    expect(applied.body.data.invoice.balanceDue).toBe(630);
    const again = await full.api.post(`/sales/invoices/${invId}/apply-advances`, body);
    expect(again.status).toBe(200);
    expect(again.body.data.replayed).toBe(true);
    expect((await full.api.get(`/sales/advances/${adv.body.data.id}/applications`)).body.data).toHaveLength(1);

    // a plain receipt cannot use the advance mode
    expect((await full.api.post(`/sales/invoices/${invId}/payment`, { paymentDate: new Date().toISOString(), amount: 10, mode: 'CUSTOMER_ADVANCE' })).status).toBe(400);
  });
});
