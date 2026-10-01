import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createStandaloneCreditNote } from '../modules/sales/creditNote.service';
import { tenantQuery } from '../shared/tenantContext';

// G2c — proves creditNote:view/create/cancel actually gate their routes over real HTTP (the
// service-level tests in creditNote.service.test.ts call the service functions directly with a
// full-permission ctx, bypassing requirePermission(...) entirely — same split as J3's own
// http.j3Administrative.test.ts).
describe('HTTP: Credit Note permission gating (G2c)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const creditNoteIds: { companyId: string; id: string }[] = [];

  afterAll(async () => {
    for (const cn of creditNoteIds) {
      await tenantQuery(cn.companyId, (tx) => tx.creditNote.deleteMany({ where: { id: cn.id, companyId: cn.companyId } }));
    }
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
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
      data: { companyId, clientCode: `TSTCL-HCN-${label}-${suffix}`, name: `Client ${label}`, type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }

  async function makeInvoice(tenant: TestTenant) {
    const branchId = tenant.branch.id;
    const clientId = await makeClient(tenant.company.id, `inv-${invoiceIds.length}`);
    const api = apiWith(tokenFor(tenant), app);
    const res = await api.post('/sales/invoices', {
      clientId, branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000 }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.data.id);
    return res.body.data;
  }

  it('creditNote:view — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('CNVG', ['creditNote:view']);
    const ok = await granted.api.get('/sales/credit-notes');
    expect(ok.status).toBe(200);

    const missing = await tenantWith('CNVM', ['invoice:create']); // unrelated permission only
    const denied = await missing.api.get('/sales/credit-notes');
    expect(denied.status).toBe(403);
  });

  it('creditNote:create — granted succeeds (standalone, value-only line), missing is 403', async () => {
    const granted = await tenantWith('CNCG', ['invoice:create', 'creditNote:create']);
    const inv1 = await makeInvoice(granted.t);
    const ok = await granted.api.post('/sales/credit-notes', {
      invoiceId: inv1.id, items: [{ description: 'Adjustment', taxableValue: 100 }], reasonCode: 'POST_SALE_DISCOUNT',
    });
    expect(ok.status).toBe(201);
    creditNoteIds.push({ companyId: granted.t.company.id, id: ok.body.data.id });

    const missing = await tenantWith('CNCM', ['invoice:create']); // no creditNote:create
    const inv2 = await makeInvoice(missing.t);
    const denied = await missing.api.post('/sales/credit-notes', {
      invoiceId: inv2.id, items: [{ description: 'Adjustment', taxableValue: 100 }], reasonCode: 'POST_SALE_DISCOUNT',
    });
    expect(denied.status).toBe(403);
  });

  it('creditNote:cancel — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('CNXG', ['invoice:create', 'creditNote:cancel']);
    const inv1 = await makeInvoice(granted.t);
    const cn1 = await createStandaloneCreditNote(
      { invoiceId: inv1.id, items: [{ description: 'Adjustment', taxableValue: 100 }], reasonCode: 'POST_SALE_DISCOUNT' },
      granted.t.ctx, granted.t.user.id,
    );
    creditNoteIds.push({ companyId: granted.t.company.id, id: cn1.id });
    const ok = await granted.api.post(`/sales/credit-notes/${cn1.id}/cancel`, { reason: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('CANCELLED');

    const missing = await tenantWith('CNXM', ['invoice:create']); // no creditNote:cancel
    const denied = await missing.api.post('/sales/credit-notes/nonexistent-id/cancel', { reason: 'test' });
    expect(denied.status).toBe(403);
  });
});
