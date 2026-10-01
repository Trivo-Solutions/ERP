import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { tenantQuery } from '../shared/tenantContext';
import { cleanupJournalEntries } from './ledger';

// G2g-4b.2 — proves `salesDebitNote:*` is actually enforced by the router
// (sales.router.ts: requirePermission('salesDebitNote:...')), over real HTTP, and that a
// cross-company invoice/debit-note id is rejected — the one thing the service-level tests in
// salesDebitNote.service.test.ts don't cover (those call the service directly with an
// already-trusted ctx, bypassing authenticate()/requirePermission() entirely).
describe('HTTP: Sales Debit Note (G2g-4b.2) security', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  afterAll(async () => {
    for (const t of cleanupTenants) {
      await tenantQuery(t.company.id, (tx) => tx.salesDebitNote.deleteMany({ where: { companyId: t.company.id } }));
    }
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }

  async function makeInvoice(tenant: TestTenant, label: string) {
    const branchId = tenant.branch.id;
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-HSDN-${label}-${suffix}`, name: `Client ${label}`, type: 'RETAIL', state: 'Gujarat' },
    });
    clientIds.push(client.id);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-HSDN-${label}-${suffix}`, companyId: tenant.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: 8000, sellingPrice: 10000, createdById: tenant.user.id,
      },
    });
    tagIds.push(tag.id);
    const api = apiWith(tokenFor(tenant), app);
    const res = await api.post('/sales/invoices', {
      clientId: client.id, branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 10000, tagId: tag.id }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.data.id);
    return res.body.data;
  }

  it('unauthenticated requests are rejected (401)', async () => {
    const anon = apiWith(undefined, app);
    expect((await anon.get('/sales/debit-notes')).status).toBe(401);
    expect((await anon.post('/sales/debit-notes', {})).status).toBe(401);
  });

  it('salesDebitNote:create — granted succeeds, missing is 403, row never created on the 403', async () => {
    const granted = await tenantWith('SDNG', ['invoice:create', 'salesDebitNote:create']);
    const invoice1 = await makeInvoice(granted.t, 'g');
    const ok = await granted.api.post('/sales/debit-notes', {
      invoiceId: invoice1.id,
      items: [{ invoiceItemId: invoice1.items[0].id, amount: 103 }],
      reasonCode: 'PRICE_INCREASE',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.debitNoteNumber).toMatch(/^SDN-/);

    const missing = await tenantWith('SDNM', ['invoice:create']); // no salesDebitNote:create
    const invoice2 = await makeInvoice(missing.t, 'm');
    const denied = await missing.api.post('/sales/debit-notes', {
      invoiceId: invoice2.id,
      items: [{ invoiceItemId: invoice2.items[0].id, amount: 103 }],
      reasonCode: 'PRICE_INCREASE',
    });
    expect(denied.status).toBe(403);
    const rows = await tenantQuery(missing.t.company.id, (tx) => tx.salesDebitNote.findMany({ where: { invoiceId: invoice2.id } }));
    expect(rows).toHaveLength(0);
  });

  it('salesDebitNote:view — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('SDNVG', ['invoice:create', 'salesDebitNote:create', 'salesDebitNote:view']);
    const invoice = await makeInvoice(granted.t, 'vg');
    const created = await granted.api.post('/sales/debit-notes', {
      invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 103 }], reasonCode: 'PRICE_INCREASE',
    });
    expect(created.status).toBe(201);

    const list = await granted.api.get('/sales/debit-notes');
    expect(list.status).toBe(200);
    expect(list.body.data.some((d: any) => d.id === created.body.data.id)).toBe(true);

    const byId = await granted.api.get(`/sales/debit-notes/${created.body.data.id}`);
    expect(byId.status).toBe(200);

    const missingView = await tenantWith('SDNVM', ['invoice:create', 'salesDebitNote:create']); // no view
    const denied = await missingView.api.get('/sales/debit-notes');
    expect(denied.status).toBe(403);
  });

  it('salesDebitNote:cancel — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('SDNCG', ['invoice:create', 'salesDebitNote:create', 'salesDebitNote:cancel']);
    const invoice = await makeInvoice(granted.t, 'cg');
    const created = await granted.api.post('/sales/debit-notes', {
      invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 103 }], reasonCode: 'PRICE_INCREASE',
    });
    const ok = await granted.api.post(`/sales/debit-notes/${created.body.data.id}/cancel`, { reason: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('CANCELLED');

    const missing = await tenantWith('SDNCM', ['invoice:create', 'salesDebitNote:create']); // no cancel
    const invoice2 = await makeInvoice(missing.t, 'cm');
    const created2 = await missing.api.post('/sales/debit-notes', {
      invoiceId: invoice2.id, items: [{ invoiceItemId: invoice2.items[0].id, amount: 103 }], reasonCode: 'PRICE_INCREASE',
    });
    const denied = await missing.api.post(`/sales/debit-notes/${created2.body.data.id}/cancel`, { reason: 'test' });
    expect(denied.status).toBe(403);
    // sales_debit_notes is a FORCE-RLS table in this single-role test DB (same class as
    // credit_notes — see creditNote.service.test.ts's own afterAll note): a bare prisma call sees
    // zero rows, so verification must go through tenantQuery.
    const fresh = await tenantQuery(missing.t.company.id, (tx) => tx.salesDebitNote.findUniqueOrThrow({ where: { id: created2.body.data.id } }));
    expect(fresh.status).toBe('ISSUED'); // the 403 never touched the row
  });

  it('a cross-company invoiceId is rejected (404), never silently creating a debit note', async () => {
    const A = await tenantWith('SDNXA', ['invoice:create', 'salesDebitNote:create']);
    const B = await tenantWith('SDNXB', ['invoice:create', 'salesDebitNote:create']);
    const invoiceB = await makeInvoice(B.t, 'xb');

    const res = await A.api.post('/sales/debit-notes', {
      invoiceId: invoiceB.id, items: [{ description: 'x', taxableValue: 100 }], reasonCode: 'OTHER', reasonNotes: 'n/a',
    });
    expect(res.status).toBe(404);
  });

  it('a cross-company debit-note id cannot be read or cancelled (404)', async () => {
    const A = await tenantWith('SDNYA', ['invoice:create', 'salesDebitNote:create', 'salesDebitNote:view', 'salesDebitNote:cancel']);
    const B = await tenantWith('SDNYB', ['invoice:create', 'salesDebitNote:create', 'salesDebitNote:view', 'salesDebitNote:cancel']);
    const invoiceA = await makeInvoice(A.t, 'ya');
    const created = await A.api.post('/sales/debit-notes', {
      invoiceId: invoiceA.id, items: [{ invoiceItemId: invoiceA.items[0].id, amount: 103 }], reasonCode: 'PRICE_INCREASE',
    });
    expect(created.status).toBe(201);

    const readDenied = await B.api.get(`/sales/debit-notes/${created.body.data.id}`);
    expect(readDenied.status).toBe(404);

    const cancelDenied = await B.api.post(`/sales/debit-notes/${created.body.data.id}/cancel`, { reason: 'trying anyway' });
    expect(cancelDenied.status).toBe(404);

    const fresh = await tenantQuery(A.t.company.id, (tx) => tx.salesDebitNote.findUniqueOrThrow({ where: { id: created.body.data.id } }));
    expect(fresh.status).toBe('ISSUED'); // company B's denied attempt never touched company A's row
  });
});
