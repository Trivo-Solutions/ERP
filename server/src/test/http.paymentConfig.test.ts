import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, addBranch, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';

// Payment Configuration over real HTTP: each route is gated by its own permission, the company comes from the token
// (never the body), forged / cross-company ids are 404, and a payment naming a configured terminal is validated
// server-side regardless of what the UI offered.
describe('HTTP: payment configuration', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const clientIds: string[] = [];
  const refIds: string[] = [];

  afterAll(async () => {
    const pays = await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    await cleanupJournalEntries([...refIds, ...pays.map((p) => p.id)]);
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    for (const t of tenants) await prisma.user.deleteMany({ where: { email: t.user.email } });
    await prisma.$disconnect();
  });

  async function setup(tag: string, perms: string[], restrictToFirstBranch = false) {
    const t = await createTestTenant(`${tag}${suffix}`, perms);
    tenants.push(t);
    if (restrictToFirstBranch) t.ctx.branchAccess = { allBranches: false, branchIds: [t.branch.id] };
    const c = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `HPC-${tag}-${suffix}`, name: 'C', type: 'RETAIL', panNumber: 'ABCDE1234F' } });
    clientIds.push(c.id);
    return { t, clientId: c.id, api: apiWith(tokenFor(t), app) };
  }
  const providerBody = (name: string) => ({ name: `${name}-${suffix}`, category: 'ACQUIRER', supportedMethods: ['CARD', 'UPI'] });

  it('view and manage are separate permissions; anonymous and unrelated roles get 401 / 403', async () => {
    const admin = await setup('M', ['paymentConfig:view', 'paymentConfig:manage']);
    const viewer = await setup('V', ['paymentConfig:view']);
    const none = await setup('N', ['sales:view']);
    const anon = apiWith(undefined, app);

    expect((await anon.get('/payment-config/providers')).status).toBe(401);
    expect((await none.api.get('/payment-config/providers')).status).toBe(403);
    expect((await none.api.get('/payment-config/terminals')).status).toBe(403);
    expect((await none.api.post('/payment-config/providers', providerBody('Z'))).status).toBe(403);

    const created = await admin.api.post('/payment-config/providers', providerBody('HDFC'));
    expect(created.status).toBe(201);
    expect((await admin.api.get('/payment-config/providers')).body.data).toHaveLength(1);

    expect((await viewer.api.get('/payment-config/providers')).status).toBe(200);
    expect((await viewer.api.post('/payment-config/providers', providerBody('Y'))).status).toBe(403);
    expect((await viewer.api.patch(`/payment-config/providers/${created.body.data.id}`, { isActive: false })).status).toBe(403);
    expect((await viewer.api.post('/payment-config/terminals', {})).status).toBe(403);
    expect((await viewer.api.post('/payment-config/branch-providers', { branchId: viewer.t.branch.id, providerId: created.body.data.id })).status).toBe(403);
    expect((await viewer.api.del(`/payment-config/branch-providers/${viewer.t.branch.id}/${created.body.data.id}`)).status).toBe(403);
    // the provider is untouched
    expect((await prisma.paymentProvider.findUniqueOrThrow({ where: { id: created.body.data.id } })).isActive).toBe(true);
  });

  it('a body companyId is refused and another company\'s ids are 404 (nothing changes)', async () => {
    const a = await setup('XA', ['paymentConfig:view', 'paymentConfig:manage']);
    const b = await setup('XB', ['paymentConfig:view', 'paymentConfig:manage']);
    const theirs = await b.api.post('/payment-config/providers', providerBody('BProv'));
    const theirTerm = await b.api.post('/payment-config/terminals', { code: 'B1', name: 'B', providerId: theirs.body.data.id, tid: `BT${suffix}`, supportedMethods: ['CARD'], branchId: b.t.branch.id });
    expect(theirTerm.status).toBe(201);

    expect((await a.api.post('/payment-config/providers', { ...providerBody('Spoof'), companyId: b.t.company.id })).status).toBeGreaterThanOrEqual(400);
    expect((await a.api.patch(`/payment-config/providers/${theirs.body.data.id}`, { isActive: false })).status).toBe(404);
    expect((await a.api.patch(`/payment-config/terminals/${theirTerm.body.data.id}`, { isActive: false })).status).toBe(404);
    expect((await a.api.post('/payment-config/terminals', { code: 'A1', name: 'A', providerId: theirs.body.data.id, tid: 'T1', supportedMethods: ['CARD'], branchId: a.t.branch.id })).status).toBe(404);
    expect((await a.api.post('/payment-config/terminals', { code: 'A2', name: 'A', providerId: (await a.api.post('/payment-config/providers', providerBody('AProv'))).body.data.id, tid: 'T2', supportedMethods: ['CARD'], branchId: b.t.branch.id })).status).toBe(404);
    expect((await a.api.post('/payment-config/branch-providers', { branchId: b.t.branch.id, providerId: theirs.body.data.id })).status).toBe(404);
    expect((await a.api.get('/payment-config/terminals')).body.data).toHaveLength(0);
    expect((await a.api.get('/payment-config/options?branchId=' + b.t.branch.id)).status).toBe(404);
    expect((await prisma.posTerminal.findUniqueOrThrow({ where: { id: theirTerm.body.data.id } })).isActive).toBe(true);
    expect((await a.api.get('/payment-config/providers?active=maybe')).status).toBe(400);
  });

  it('the options endpoint follows payment permissions and branch grants; saving a payment re-validates every id', async () => {
    const admin = await setup('O', ['paymentConfig:view', 'paymentConfig:manage', 'payment:create', 'invoice:create', 'client:view']);
    const cashier = await setup('C', ['payment:create', 'invoice:create'], true);
    // The cashier shares NO company with admin; build their own config through their company's own admin instead:
    const co = await setup('CA', ['paymentConfig:view', 'paymentConfig:manage', 'payment:create', 'invoice:create'], true);
    const branch2 = (await addBranch(co.t.company.id, `H${suffix}`)).id;
    const prov = (await co.api.post('/payment-config/providers', providerBody('CoProv'))).body.data.id;
    const t1 = (await co.api.post('/payment-config/terminals', { code: 'P1', name: 'P1', providerId: prov, tid: `PT1${suffix}`, supportedMethods: ['CARD'], branchId: co.t.branch.id })).body.data.id;
    // co's token is branch-restricted to branch 1, so it cannot create a terminal at branch 2 ...
    expect((await co.api.post('/payment-config/terminals', { code: 'P2', name: 'P2', providerId: prov, tid: `PT2${suffix}`, supportedMethods: ['CARD'], branchId: branch2 })).status).toBe(404);
    // ... nor read its options.
    expect((await co.api.get(`/payment-config/options?branchId=${branch2}`)).status).toBe(404);

    const opts = await co.api.get(`/payment-config/options?branchId=${co.t.branch.id}`);
    expect(opts.status).toBe(200);
    expect(opts.body.data.terminals.map((x: any) => x.id)).toEqual([t1]);
    expect(opts.body.data.requireTerminalForCard).toBe(true);
    expect((await cashier.api.get(`/payment-config/options?branchId=${cashier.t.branch.id}`)).status).toBe(200); // payment:create is enough
    expect((await setup('NP', ['sales:view'])).api.get('/payment-config/options?branchId=x').then((r) => r.status)).resolves.toBe(403);

    // Saving a card payment over HTTP: no terminal -> 400; forged -> 404; the real terminal -> 201 with the snapshot.
    const inv = async (payments: unknown[]) => co.api.post('/sales/invoices', {
      branchId: co.t.branch.id, clientId: co.clientId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Set', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000, makingCharge: 0 }],
      payments,
    });
    const pay = (extra: Record<string, unknown>) => ({ paymentDate: new Date().toISOString(), mode: 'CARD', amount: 1030, ...extra });
    expect((await inv([pay({})])).status).toBe(400);
    expect((await inv([pay({ terminalId: 'forged' })])).status).toBe(404);
    expect((await inv([pay({ terminalId: admin.clientId })])).status).toBe(404);
    const ok = await inv([pay({ terminalId: t1, authCode: 'HTTP1' })]);
    expect(ok.status).toBe(201);
    refIds.push(ok.body.data.id);
    const legs = await prisma.invoicePayment.findMany({ where: { invoiceId: ok.body.data.id } });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ terminalId: t1, terminalTid: `PT1${suffix}`, authCode: 'HTTP1', branchId: co.t.branch.id });
    // legacy cash payload over HTTP: unchanged
    const cash = await inv([pay({ mode: 'CASH' })]);
    expect(cash.status).toBe(201);
    refIds.push(cash.body.data.id);
  });

  it('audit rows written by configuration changes cannot be altered or removed through the application role', async () => {
    const a = await setup('AU', ['paymentConfig:view', 'paymentConfig:manage']);
    const p = await a.api.post('/payment-config/providers', providerBody('Aud'));
    await a.api.patch(`/payment-config/providers/${p.body.data.id}`, { isActive: false });
    const rows = await prisma.auditLog.findMany({ where: { tableName: 'payment_providers', recordId: p.body.data.id } });
    expect(rows.map((r) => r.action).sort()).toEqual(['CREATE', 'DEACTIVATE']);
    expect(rows.every((r) => r.companyId === a.t.company.id && r.userId === a.t.user.id)).toBe(true);
    // No route exists that edits or deletes audit history.
    expect((await a.api.del(`/payment-config/providers/${p.body.data.id}`)).status).toBe(404);
  });
});
