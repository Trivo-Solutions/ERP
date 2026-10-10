import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// Phase J4 — proves each new/re-gated permission actually gates its route over real HTTP (the one
// thing service-level unit tests can't cover, since they call the service directly with a
// full-permission ctx and bypass requirePermission(...) entirely). Mirrors http.j3Administrative.test.ts.
describe('HTTP: J4 authorization gating', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const supplierIds: string[] = [];
  const poIds: string[] = [];

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.approvalHistory.deleteMany({ where: { purchaseOrderId: { in: poIds } } });
    await prisma.poItem.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
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
      data: { companyId, clientCode: `TSTCL-HJ4-${label}-${suffix}`, name: `Client ${label}`, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }

  async function makeSupplier(companyId: string, label: string) {
    const s = await prisma.supplier.create({
      data: { companyId, supplierCode: `TSTSUP-HJ4-${label}-${suffix}`, name: `Supplier ${label}`, type: 'OTHER' },
    });
    supplierIds.push(s.id);
    return s.id;
  }

  /** A submitted (PENDING_APPROVAL) PO for `amount` (pre-tax) — unregistered supplier keeps tax at 0. */
  async function makeSubmittedPO(tenant: TestTenant, amount: number, label: string) {
    const supplierId = await makeSupplier(tenant.company.id, label);
    const api = apiWith(tokenFor(tenant), app);
    const created = await api.post('/procurement/orders', {
      supplierId, poType: 'OUTRIGHT', orderDate: new Date().toISOString(),
      items: [{ materialCode: 'G22', materialName: 'Gold 22K', materialType: 'METAL', quantity: 1, weight: 100, unit: 'GM', karat: '22K', ratePerUnit: amount }],
    });
    expect(created.status).toBe(201);
    const poId = created.body.data.id;
    poIds.push(poId);
    const submitted = await api.post(`/procurement/orders/${poId}/submit`);
    expect(submitted.status).toBe(200);
    return poId;
  }

  // ─── J4-D2: high-value PO approval ─────────────────────────────────────────

  it('po:approve alone approves an ordinary (<=₹5,00,000) PO — existing behavior unchanged', async () => {
    const t = await tenantWith('POLO', ['po:view', 'po:create', 'po:approve']);
    const poId = await makeSubmittedPO(t.t, 400000, 'lo');
    const res = await t.api.post(`/procurement/orders/${poId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });

  it('po:approve alone cannot approve a >₹5,00,000 PO — needs po:approve_high_value too', async () => {
    const t = await tenantWith('POHIM', ['po:view', 'po:create', 'po:approve']);
    const poId = await makeSubmittedPO(t.t, 600000, 'him');
    const res = await t.api.post(`/procurement/orders/${poId}/approve`, {});
    expect(res.status).toBe(403);
  });

  it('po:approve + po:approve_high_value approves a >₹5,00,000 PO', async () => {
    const t = await tenantWith('POHIG', ['po:view', 'po:create', 'po:approve', 'po:approve_high_value']);
    const poId = await makeSubmittedPO(t.t, 600000, 'hig');
    const res = await t.api.post(`/procurement/orders/${poId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
  });

  it('po:approve_high_value alone (no po:approve) cannot approve any PO — never sufficient on its own', async () => {
    const owner = await tenantWith('POAPP', ['po:view', 'po:create', 'po:approve']);
    const poId = await makeSubmittedPO(owner.t, 100000, 'nop');
    // A different tenant holding only po:approve_high_value: the router's requirePermission('po:approve')
    // rejects the request before the service (or the cross-company ownership check) ever runs.
    const t2 = await tenantWith('POHVO', ['po:approve_high_value']);
    const res = await t2.api.post(`/procurement/orders/${poId}/approve`, {});
    expect(res.status).toBe(403);
  });

  // ─── J4-D5: GRN view vs create ─────────────────────────────────────────────

  it('grn:view — granted can list GRNs, missing is 403; grn:create still separately required to create', async () => {
    const withView = await tenantWith('GRNV', ['grn:view']);
    const listOk = await withView.api.get('/procurement/grn');
    expect(listOk.status).toBe(200);
    const createDenied = await withView.api.post('/procurement/grn', { poId: 'x', receivedDate: new Date().toISOString(), items: [] });
    expect(createDenied.status).toBe(403); // grn:view does not imply grn:create

    const withCreateOnly = await tenantWith('GRNC', ['grn:create']);
    const listDenied = await withCreateOnly.api.get('/procurement/grn');
    expect(listDenied.status).toBe(403); // grn:create no longer implies grn:view
  });

  // ─── J4-D6: payment:view vs sales:view ─────────────────────────────────────

  it('payment:view — granted can see client payment history, sales:view alone is no longer sufficient', async () => {
    const withView = await tenantWith('PAYV', ['payment:view']);
    const clientId1 = await makeClient(withView.t.company.id, 'view');
    const ok = await withView.api.get(`/sales/clients/${clientId1}/payments`);
    expect(ok.status).toBe(200);

    const withSalesView = await tenantWith('PAYS', ['sales:view']); // old gate — should no longer be sufficient
    const clientId2 = await makeClient(withSalesView.t.company.id, 'sales');
    const denied = await withSalesView.api.get(`/sales/clients/${clientId2}/payments`);
    expect(denied.status).toBe(403);
  });

  // ─── J4-D1: sensitive financial reports vs operational reports ────────────

  const sensitiveReportRoutes: Array<{ name: string; perm: string; path: (clientId: string, supplierId: string) => string }> = [
    { name: 'trial-balance', perm: 'report:trial_balance', path: () => '/finance/reports/trial-balance' },
    { name: 'pnl', perm: 'report:pnl', path: () => '/finance/reports/pnl' },
    { name: 'balance-sheet', perm: 'report:balance_sheet', path: () => '/finance/reports/balance-sheet' },
    { name: 'dealer-aging', perm: 'report:dealer_aging', path: () => '/finance/reports/dealer-aging' },
    { name: 'client-ledger', perm: 'report:client_ledger', path: (clientId) => `/finance/reports/client-ledger/${clientId}` },
    { name: 'day-book', perm: 'report:day_book', path: () => '/finance/reports/day-book' },
    { name: 'gst-summary', perm: 'report:financial_view', path: () => '/finance/reports/gst-summary' },
    { name: 'supplier-ledger', perm: 'report:supplier_ledger', path: (_c, supplierId) => `/finance/reports/supplier-ledger/${supplierId}` },
    { name: 'purchase-gst-summary', perm: 'report:financial_view', path: () => '/finance/reports/purchase-gst-summary' },
    { name: 'aging-receivables', perm: 'report:aging_receivables', path: () => '/reports/aging-receivables' },
  ];

  it.each(sensitiveReportRoutes)('$name — report:view alone is 403, its own report permission succeeds', async ({ name, perm, path }) => {
    const tag = name.slice(0, 6).toUpperCase();
    const reportViewOnly = await tenantWith(`${tag}V`, ['report:view']);
    const clientId = await makeClient(reportViewOnly.t.company.id, 'rpt');
    const supplierId = await makeSupplier(reportViewOnly.t.company.id, 'rpt');
    const denied = await reportViewOnly.api.get(path(clientId, supplierId));
    expect(denied.status).toBe(403);

    const granted = await tenantWith(`${tag}F`, [perm]);
    const clientId2 = await makeClient(granted.t.company.id, 'rpt2');
    const supplierId2 = await makeSupplier(granted.t.company.id, 'rpt2');
    const ok = await granted.api.get(path(clientId2, supplierId2));
    expect(ok.status).toBe(200);
  });

  it('each report is granted on its own — report:view (dashboard) opens none of the individual reports', async () => {
    const dash = await tenantWith('RDASH', ['report:view']);
    expect((await dash.api.get('/reports/dashboard')).status).toBe(200);
    expect((await dash.api.get('/reports/wip-summary')).status).toBe(200); // the dashboard's own widget
    expect((await dash.api.get('/reports/stock-summary')).status).toBe(403);
    expect((await dash.api.get('/sales/reports/register')).status).toBe(403);
    expect((await dash.api.get('/finance/reports/cost-centers')).status).toBe(403);

    const stockOnly = await tenantWith('RSTK', ['report:stock_summary']);
    expect((await stockOnly.api.get('/reports/stock-summary')).status).toBe(200);
    expect((await stockOnly.api.get('/sales/reports/register')).status).toBe(403);
    expect((await stockOnly.api.get('/reports/dashboard')).status).toBe(403);

    const register = await tenantWith('RREG', ['report:sales_register']);
    expect((await register.api.get('/sales/reports/register')).status).toBe(200);
    expect((await register.api.get('/sales/reports/sales-summary')).status).toBe(403);
  });

  it('SUPER_ADMIN wildcard (*) reaches every J4-gated route', async () => {
    const t = await tenantWith('SUP', ['*']);
    const clientId = await makeClient(t.t.company.id, 'sup');
    const supplierId = await makeSupplier(t.t.company.id, 'sup');
    expect((await t.api.get('/procurement/grn')).status).toBe(200);
    expect((await t.api.get(`/sales/clients/${clientId}/payments`)).status).toBe(200);
    expect((await t.api.get('/finance/reports/dealer-aging')).status).toBe(200);
    expect((await t.api.get(`/finance/reports/supplier-ledger/${supplierId}`)).status).toBe(200);
  });
});
