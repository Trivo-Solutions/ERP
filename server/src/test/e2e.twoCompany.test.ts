import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { initWebSocket } from '../shared/websocket';
import { emit } from '../shared/websocket';
import { seedChartOfAccounts } from '../modules/finance/finance.service';
import { seedStarterMasters } from '../shared/starterMasters';
import { deleteCompanyMasters } from './fixtures';

// ═══════════════════════════════════════════════════
// Phase 4 Part M — Two-Company End-to-End Acceptance Test.
//
// Unlike every other test file in this suite (which calls service functions directly), this one
// drives the actual Express app over real HTTP via supertest — login, every subsequent request
// carrying only the JWT it issued, exactly like a real browser session — plus a real Socket.io
// connection over a real listening port for the socket-isolation checks. This is deliberately the
// closest this test suite gets to the real application/API flow without a browser (see the Phase
// 4 report's Part O for why an actual browser pass isn't available in this environment).
//
// Two realistic companies, each with its own admin user, branch(es), a branch-restricted second
// user, clients, tags/stock, and invoices — built with REAL bcrypt-hashed passwords (unlike
// fixtures.ts's createTestTenant, whose 'x' placeholder password can never pass a real
// bcrypt.compare() and so cannot be used to log in over HTTP — this file needs its own setup for
// exactly that reason).
// ═══════════════════════════════════════════════════

describe('Phase 4 Part M: two-company end-to-end acceptance', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const PASSWORD = 'E2E-test-passw0rd!';

  let httpServer: HttpServer;
  let socketPort: number;

  // Masters are company-owned — each company gets its own category + stock type.
  const masterIds = {} as Record<'A' | 'B', { categoryId: string; stockTypeId: string }>;

  const companies: Record<'A' | 'B', {
    company: { id: string; code: string };
    branch: { id: string; branchCode: string };
    branch2: { id: string };
    adminUser: { id: string; email: string };
    adminToken: string;
    restrictedUser: { id: string; email: string };
    restrictedToken: string;
    clientId: string;
    tagId: string;
    invoiceId: string;
  }> = {} as any;

  async function makeCompanyWithUsers(tag: 'A' | 'B') {
    const company = await prisma.company.create({
      // Company codes are looked up uppercased at login (see auth.service.ts's login()) —
      // the stored code must already be uppercase or a mixed-case suffix here would never match.
      data: { code: `E2E${tag}-${suffix}`.toUpperCase(), name: `E2E Company ${tag}`, stateCode: '24', gstin: `24E2E${tag}GSTIN${suffix}`.slice(0, 15) },
    });
    const branch = await prisma.branch.create({ data: { companyId: company.id, branchCode: `E2E${tag}-BR1-${suffix}`, name: `${tag} Branch 1` } });
    const branch2 = await prisma.branch.create({ data: { companyId: company.id, branchCode: `E2E${tag}-BR2-${suffix}`, name: `${tag} Branch 2` } });
    await seedStarterMasters(company.id); // karat list etc. — company-owned, every new company starts with the standard set

    const adminRole = await prisma.role.create({
      data: {
        companyId: company.id, name: `E2E_ADMIN_${tag}_${suffix}`, displayName: 'E2E Admin',
        permissions: ['*'],
      },
    });
    const restrictedRole = await prisma.role.create({
      data: {
        companyId: company.id, name: `E2E_RESTRICTED_${tag}_${suffix}`, displayName: 'E2E Branch-Restricted',
        permissions: ['tag:view', 'tag:create', 'report:view'],
      },
    });

    const hashed = await bcrypt.hash(PASSWORD, 12);
    const adminUser = await prisma.user.create({ data: { email: `e2e-admin-${tag.toLowerCase()}-${suffix}@example.com`, password: hashed, name: `E2E Admin ${tag}` } });
    const restrictedUser = await prisma.user.create({ data: { email: `e2e-restricted-${tag.toLowerCase()}-${suffix}@example.com`, password: hashed, name: `E2E Restricted ${tag}` } });

    await prisma.companyUser.create({ data: { companyId: company.id, userId: adminUser.id, roleId: adminRole.id, allBranches: true } });
    const restrictedMembership = await prisma.companyUser.create({ data: { companyId: company.id, userId: restrictedUser.id, roleId: restrictedRole.id, allBranches: false } });
    await prisma.userBranchAccess.create({ data: { companyId: company.id, companyUserId: restrictedMembership.id, branchId: branch.id } }); // only branch 1, not branch2

    // createInvoice posts an auto journal entry (finance.service.ts:postAutoJournalEntry) that
    // needs a real chart of accounts to exist — fixtures.ts's createTestTenant does this
    // automatically for every other test file; this file builds its own tenants (for real
    // bcrypt-hashed, HTTP-loginable users) so it must do the same.
    await seedChartOfAccounts(company.id);

    return { company, branch, branch2, adminUser, restrictedUser };
  }

  async function login(companyCode: string, identifier: string) {
    const res = await request(app).post('/api/v1/auth/login').send({ companyCode, identifier, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.data.accessToken as string;
  }

  beforeAll(async () => {
    for (const tag of ['A', 'B'] as const) {
      const built = await makeCompanyWithUsers(tag);
      const adminToken = await login(built.company.code, built.adminUser.email);
      const restrictedToken = await login(built.company.code, built.restrictedUser.email);
      companies[tag] = {
        company: built.company, branch: built.branch, branch2: built.branch2,
        adminUser: built.adminUser, adminToken,
        restrictedUser: built.restrictedUser, restrictedToken,
        clientId: '', tagId: '', invoiceId: '',
      };
      const category = await prisma.productCategory.create({ data: { companyId: built.company.id, code: `E2ECAT-${suffix}`, name: 'E2E Category' } });
      const stockType = await prisma.stockType.create({ data: { companyId: built.company.id, code: `E2EST-${suffix}`.toUpperCase(), name: 'E2E Stock Type' } });
      masterIds[tag] = { categoryId: category.id, stockTypeId: stockType.id };
    }

    // Real Socket.io server on a real ephemeral port for the socket-isolation checks below.
    httpServer = createServer(app);
    initWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    socketPort = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const tag of ['A', 'B'] as const) {
      const c = companies[tag];
      if (!c) continue;
      await prisma.invoiceItem.deleteMany({ where: { companyId: c.company.id } });
      await prisma.taxInvoice.deleteMany({ where: { companyId: c.company.id } });
      await prisma.salesInvoice.deleteMany({ where: { companyId: c.company.id } });
      await prisma.jewelryTag.deleteMany({ where: { companyId: c.company.id } });
      await prisma.client.deleteMany({ where: { companyId: c.company.id } });
      await prisma.journalLine.deleteMany({ where: { companyId: c.company.id } }); // before account (RESTRICT FK)
      await prisma.journalEntry.deleteMany({ where: { companyId: c.company.id } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: [c.adminUser.id, c.restrictedUser.id] } } });
      await prisma.userBranchAccess.deleteMany({ where: { companyUser: { companyId: c.company.id } } });
      await prisma.companyUser.deleteMany({ where: { companyId: c.company.id } });
      await prisma.role.deleteMany({ where: { companyId: c.company.id } });
      await prisma.user.deleteMany({ where: { id: { in: [c.adminUser.id, c.restrictedUser.id] } } });
      await prisma.branch.deleteMany({ where: { companyId: c.company.id } });
      await prisma.numberSequence.deleteMany({ where: { companyId: c.company.id } });
      await prisma.account.deleteMany({ where: { companyId: c.company.id } });
      await deleteCompanyMasters(c.company.id);
      await prisma.tagHistory.deleteMany({ where: { companyId: c.company.id } }); // trigger-written, per tag change
      await prisma.company.deleteMany({ where: { id: c.company.id } });
    }
    await prisma.$disconnect();
  });

  // ─── Login lifecycle ────────────────────────────────────────────────────

  it('rejects an invalid company code', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: `NOPE-${suffix}`, identifier: companies.A.adminUser.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a correct company + identifier with a wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: companies.A.company.code, identifier: companies.A.adminUser.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects Company A\'s identifier logged in against Company B\'s company code', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: companies.B.company.code, identifier: companies.A.adminUser.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects login for an inactive CompanyUser membership', async () => {
    const membership = await prisma.companyUser.findFirstOrThrow({ where: { companyId: companies.A.company.id, userId: companies.A.restrictedUser.id } });
    await prisma.companyUser.update({ where: { id: membership.id }, data: { isActive: false } });
    const res = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: companies.A.company.code, identifier: companies.A.restrictedUser.email, password: PASSWORD });
    expect(res.status).toBe(401);
    await prisma.companyUser.update({ where: { id: membership.id }, data: { isActive: true } }); // restore for later tests
  });

  it('rejects login for a globally inactive User', async () => {
    await prisma.user.update({ where: { id: companies.B.restrictedUser.id }, data: { isActive: false } });
    const res = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: companies.B.company.code, identifier: companies.B.restrictedUser.email, password: PASSWORD });
    expect(res.status).toBe(401);
    await prisma.user.update({ where: { id: companies.B.restrictedUser.id }, data: { isActive: true } }); // restore
  });

  it('a request with no token is rejected', async () => {
    const res = await request(app).get('/api/v1/reports/dashboard');
    expect(res.status).toBe(401);
  });

  it('refresh-token flow issues a new working access token', async () => {
    const loginRes = await request(app).post('/api/v1/auth/login')
      .send({ companyCode: companies.A.company.code, identifier: companies.A.adminUser.email, password: PASSWORD });
    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: loginRes.body.data.refreshToken });
    expect(refreshRes.status).toBe(200);
    const meRes = await request(app).get('/api/v1/reports/dashboard').set('Authorization', `Bearer ${refreshRes.body.data.accessToken}`);
    expect(meRes.status).toBe(200);
  });

  it('a request cannot smuggle a companyId override — rejected outright, not silently ignored', async () => {
    const res = await request(app).get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${companies.A.adminToken}`)
      .query({ companyId: companies.B.company.id });
    expect(res.status).toBe(400);
  });

  // ─── Company A: golden-path operations ────────────────────────────────

  it('Company A can view its dashboard', async () => {
    const res = await request(app).get('/api/v1/reports/dashboard').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('Company A can create and view its own client', async () => {
    const res = await request(app).post('/api/v1/orders/clients')
      .set('Authorization', `Bearer ${companies.A.adminToken}`)
      .send({ name: 'E2E Client A', type: 'RETAIL' });
    expect(res.status).toBe(201);
    companies.A.clientId = res.body.data.id;

    const list = await request(app).get('/api/v1/orders/clients').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((c: any) => c.id === companies.A.clientId)).toBe(true);
  });

  it('Company A can create a stock tag and view it', async () => {
    const res = await request(app).post('/api/v1/tagging/tags')
      .set('Authorization', `Bearer ${companies.A.adminToken}`)
      .send({
        branchId: companies.A.branch.id, name: 'E2E Ring A', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 5, ...masterIds.A, sellingPrice: 30000, saleMcRate: 0, saleVaPercent: 0,
      });
    expect(res.status).toBe(201);
    companies.A.tagId = res.body.data.id;

    const get = await request(app).get(`/api/v1/tagging/tags/${companies.A.tagId}`).set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(get.status).toBe(200);
  });

  it('Company A can create an invoice against its own client and tag', async () => {
    const res = await request(app).post('/api/v1/sales/invoices')
      .set('Authorization', `Bearer ${companies.A.adminToken}`)
      .send({
        clientId: companies.A.clientId, branchId: companies.A.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', currency: 'INR',
        items: [{ productCode: 'E2E-A', description: 'E2E Ring A', tagId: companies.A.tagId, quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 30000 }],
      });
    expect(res.status).toBe(201);
    companies.A.invoiceId = res.body.data.id;
  });

  it('Company A can access its reports', async () => {
    const res = await request(app).get('/api/v1/reports/aging-receivables').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(res.status).toBe(200);
  });

  it('Company A\'s branch-restricted user can create a tag in its granted branch but not the other', async () => {
    const ok = await request(app).post('/api/v1/tagging/tags')
      .set('Authorization', `Bearer ${companies.A.restrictedToken}`)
      .send({ branchId: companies.A.branch.id, name: 'E2E Ring Restricted', metalType: 'GOLD', grossWeight: 2, netWeight: 2, saleMcRate: 0, saleVaPercent: 0, ...masterIds.A });
    expect(ok.status).toBe(201);
    await prisma.jewelryTag.deleteMany({ where: { id: ok.body.data.id } });

    const denied = await request(app).post('/api/v1/tagging/tags')
      .set('Authorization', `Bearer ${companies.A.restrictedToken}`)
      .send({ branchId: companies.A.branch2.id, name: 'E2E Ring Should Fail', metalType: 'GOLD', grossWeight: 2, netWeight: 2, saleMcRate: 0, saleVaPercent: 0, ...masterIds.A });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBeLessThan(500);
  });

  it('Company A can view its own audit log entries', async () => {
    const res = await request(app).get('/api/v1/settings/audit-logs').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((l: any) => l.tableName === 'invoices' || l.tableName === 'jewelry_tags')).toBe(true);
  });

  // ─── Company B: symmetric golden path (proves the above wasn't A-specific plumbing) ────────

  it('Company B can independently create its own client, tag, and invoice', async () => {
    const client = await request(app).post('/api/v1/orders/clients').set('Authorization', `Bearer ${companies.B.adminToken}`).send({ name: 'E2E Client B', type: 'RETAIL' });
    expect(client.status).toBe(201);
    companies.B.clientId = client.body.data.id;

    const tag = await request(app).post('/api/v1/tagging/tags').set('Authorization', `Bearer ${companies.B.adminToken}`)
      .send({ branchId: companies.B.branch.id, name: 'E2E Ring B', metalType: 'GOLD', metalKarat: '18K', grossWeight: 4, netWeight: 4, ...masterIds.B, sellingPrice: 20000, saleMcRate: 0, saleVaPercent: 0, });
    expect(tag.status).toBe(201);
    companies.B.tagId = tag.body.data.id;

    const invoice = await request(app).post('/api/v1/sales/invoices').set('Authorization', `Bearer ${companies.B.adminToken}`).send({
      clientId: companies.B.clientId, branchId: companies.B.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', currency: 'INR',
      items: [{ productCode: 'E2E-B', description: 'E2E Ring B', tagId: companies.B.tagId, quantity: 1, grossWeight: 4, netGoldWeight: 4, rateType: 'FIXED', goldRate: 20000 }],
    });
    expect(invoice.status).toBe(201);
    companies.B.invoiceId = invoice.body.data.id;
  });

  // ─── Cross-company negative tests — the actual point of this suite ─────────────────────

  it('Company A cannot view Company B\'s client list entries, and vice versa', async () => {
    const asA = await request(app).get('/api/v1/orders/clients').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(asA.body.data.some((c: any) => c.id === companies.B.clientId)).toBe(false);
    const asB = await request(app).get('/api/v1/orders/clients').set('Authorization', `Bearer ${companies.B.adminToken}`);
    expect(asB.body.data.some((c: any) => c.id === companies.A.clientId)).toBe(false);
  });

  it('Company A cannot view Company B\'s stock tag by id (IDOR), and vice versa', async () => {
    const asA = await request(app).get(`/api/v1/tagging/tags/${companies.B.tagId}`).set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(asA.status).toBe(404);
    const asB = await request(app).get(`/api/v1/tagging/tags/${companies.A.tagId}`).set('Authorization', `Bearer ${companies.B.adminToken}`);
    expect(asB.status).toBe(404);
  });

  it('Company A cannot view Company B\'s invoice by id (IDOR), and vice versa', async () => {
    const asA = await request(app).get(`/api/v1/sales/invoices/${companies.B.invoiceId}`).set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(asA.status).toBe(404);
    const asB = await request(app).get(`/api/v1/sales/invoices/${companies.A.invoiceId}`).set('Authorization', `Bearer ${companies.B.adminToken}`);
    expect(asB.status).toBe(404);
  });

  it('Company A cannot update Company B\'s client record (IDOR)', async () => {
    const res = await request(app).patch(`/api/v1/orders/clients/${companies.B.clientId}`)
      .set('Authorization', `Bearer ${companies.A.adminToken}`)
      .send({ name: 'Hijacked by Company A' });
    expect(res.status).toBe(404);
  });

  it('Company A cannot retire Company B\'s stock tag (IDOR delete-equivalent)', async () => {
    const res = await request(app).patch(`/api/v1/tagging/tags/${companies.B.tagId}/retire`).set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(res.status).toBe(404);
    // Prove it's still there and unretired.
    const stillThere = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: companies.B.tagId } });
    expect(stillThere.status).not.toBe('RETIRED');
  });

  it('Company A cannot forge Company B\'s clientId or tagId as a foreign key on its own invoice', async () => {
    const forgedClient = await request(app).post('/api/v1/sales/invoices').set('Authorization', `Bearer ${companies.A.adminToken}`).send({
      clientId: companies.B.clientId, branchId: companies.A.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', currency: 'INR',
      items: [{ productCode: 'E2E-FORGE', description: 'Forged', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000 }],
    });
    expect(forgedClient.status).toBeGreaterThanOrEqual(400);
    expect(forgedClient.status).toBeLessThan(500);

    const forgedTag = await request(app).post('/api/v1/sales/invoices').set('Authorization', `Bearer ${companies.A.adminToken}`).send({
      clientId: companies.A.clientId, branchId: companies.A.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', currency: 'INR',
      items: [{ productCode: 'E2E-FORGE2', description: 'Forged tag', tagId: companies.B.tagId, quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000 }],
    });
    expect(forgedTag.status).toBeGreaterThanOrEqual(400);
    expect(forgedTag.status).toBeLessThan(500);
  });

  it('Company A\'s reports never include Company B\'s invoice/receivable data', async () => {
    const res = await request(app).get('/api/v1/reports/aging-receivables').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(res.body.data.some((r: any) => r.invoiceNumber && r.invoiceNumber.startsWith('E2E-B'))).toBe(false);
  });

  it('Company A cannot see Company B\'s audit log entries', async () => {
    const res = await request(app).get('/api/v1/settings/audit-logs').set('Authorization', `Bearer ${companies.A.adminToken}`);
    const companyBIds = [companies.B.clientId, companies.B.tagId, companies.B.invoiceId];
    expect(res.body.data.some((l: any) => companyBIds.includes(l.recordId))).toBe(false);
  });

  it('Company A cannot access Company B\'s hardware devices', async () => {
    const device = await prisma.hardwareDevice.create({
      data: { companyId: companies.B.company.id, deviceId: `E2E-SCALE-${suffix}`, deviceType: 'SCALE', location: 'E2E Scale B' },
    });
    const listAsA = await request(app).get('/api/v1/hardware/devices').set('Authorization', `Bearer ${companies.A.adminToken}`);
    expect(listAsA.body.data.some((d: any) => d.id === device.id)).toBe(false);

    const simulateAsA = await request(app).post(`/api/v1/hardware/scales/${device.deviceId}/simulate`)
      .set('Authorization', `Bearer ${companies.A.adminToken}`).send({ weight: 12.5 });
    expect(simulateAsA.status).toBe(404);

    await prisma.hardwareDevice.deleteMany({ where: { id: device.id } });
  });

  // ─── Socket.io isolation — real connections over a real port ───────────────────────────

  it('Company A\'s socket receives its own company-scoped event; Company B\'s socket does not', async () => {
    const clientA: ClientSocket = ioClient(`http://localhost:${socketPort}`, { auth: { token: companies.A.adminToken }, transports: ['websocket'] });
    const clientB: ClientSocket = ioClient(`http://localhost:${socketPort}`, { auth: { token: companies.B.adminToken }, transports: ['websocket'] });

    await Promise.all([
      new Promise<void>((resolve, reject) => { clientA.on('connect', () => resolve()); clientA.on('connect_error', reject); }),
      new Promise<void>((resolve, reject) => { clientB.on('connect', () => resolve()); clientB.on('connect_error', reject); }),
    ]);

    const sharedJobCardId = `E2E-JC-${suffix}`; // deliberately the SAME raw id both sockets subscribe to
    clientA.emit('subscribe:jobcard', sharedJobCardId);
    clientB.emit('subscribe:jobcard', sharedJobCardId);
    await new Promise((r) => setTimeout(r, 150)); // let the join land server-side

    const receivedByA: unknown[] = [];
    const receivedByB: unknown[] = [];
    clientA.on('jobcard:update', (data) => receivedByA.push(data));
    clientB.on('jobcard:update', (data) => receivedByB.push(data));

    emit.jobCardUpdate(sharedJobCardId, { marker: 'company-A-only' }, companies.A.company.id);
    await new Promise((r) => setTimeout(r, 150));

    expect(receivedByA).toHaveLength(1);
    expect(receivedByB).toHaveLength(0); // same raw jobCardId, different company room — must not cross

    clientA.disconnect();
    clientB.disconnect();
  });

  it('a socket handshake with no auth token is rejected', async () => {
    const unauthed: ClientSocket = ioClient(`http://localhost:${socketPort}`, { auth: {}, transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      unauthed.on('connect_error', () => resolve());
      unauthed.on('connect', () => { unauthed.disconnect(); resolve(); throw new Error('should not have connected'); });
    });
    unauthed.disconnect();
  });
});
