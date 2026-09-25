import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { apiWith, addBranch, createMember, createTestTenant, cleanupTestTenant, purgeCompany, tokenFor, TestTenant } from './fixtures';
import { initWebSocket, emit, getIO, disconnectCompany } from '../shared/websocket';
import { hardwareService } from '../shared/hardware';
import { provisionCompany } from '../modules/platform/provisioning.service';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: runtime isolation — realtime (Socket.io), hardware, and print/export endpoints.
// Real HTTP server, real WebSocket connections, real database.
// ═══════════════════════════════════════════════════════════════════════════

const PERMS = ['*'];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Phase 4: runtime isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
  let httpServer: HttpServer;
  let port: number;
  let A: TestTenant; let B: TestTenant;
  let apiA: ReturnType<typeof apiWith>; let apiB: ReturnType<typeof apiWith>;
  const sockets: ClientSocket[] = [];

  // A token whose role NAME is "SUPER_ADMIN" in BOTH companies — the exact hazard a bare role room would have.
  const roleToken = (t: TestTenant, roleName: string, branchIds?: string[]) => jwt.sign(
    { userId: t.user.id, email: t.user.email, companyId: t.company.id, companyUserId: t.companyUser.id, roleId: t.role.id, roleName,
      permissions: ['*'], branchAccess: { allBranches: !branchIds, branchIds: branchIds ?? [t.branch.id] } },
    env.JWT_SECRET, { expiresIn: '1h' });

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', (e) => reject(e));
    });
  }
  const collect = (s: ClientSocket, events: string[]) => {
    const got: Array<{ event: string; data: any }> = [];
    for (const e of events) s.on(e, (data) => got.push({ event: e, data }));
    return got;
  };

  beforeAll(async () => {
    A = await createTestTenant(`RTA${suffix}`, PERMS);
    B = await createTestTenant(`RTB${suffix}`, PERMS);
    apiA = apiWith(tokenFor(A), app); apiB = apiWith(tokenFor(B), app);
    httpServer = createServer(app);
    initWebSocket(httpServer);
    await new Promise<void>((r) => httpServer.listen(0, r));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await prisma.hardwareDevice.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  // ─── WebSocket ─────────────────────────────────────────────────────────────
  describe('WebSocket isolation (two real connections)', () => {
    const EVENTS = ['jobcard:update', 'factory:update', 'scale:SCALE-1', 'rfid:scan', 'stock:alert', 'memo:alert', 'notification'];

    it('every event emitted for Company A reaches A\'s socket and NEVER B\'s — even with an identical role name and device id in both', async () => {
      const sa = await connect(roleToken(A, 'SUPER_ADMIN')); const sb = await connect(roleToken(B, 'SUPER_ADMIN'));
      const gotA = collect(sa, EVENTS); const gotB = collect(sb, EVENTS);
      sa.emit('subscribe:jobcard', 'JC-SHARED'); sb.emit('subscribe:jobcard', 'JC-SHARED'); // the SAME raw id
      sa.emit('subscribe:factory'); sb.emit('subscribe:factory');
      await wait(300);

      emit.jobCardUpdate('JC-SHARED', { from: 'A' }, A.company.id);
      emit.scaleReading('SCALE-1', 11.1, A.company.id);
      emit.rfidScan('TAG-A', 'bench', A.company.id);
      emit.stockAlert('STK-A', 'A low stock', A.company.id);
      emit.memoAlert('MEMO-A', 3, A.company.id);
      emit.notification(A.user.id, { text: 'for A' }, A.company.id);
      await wait(500);

      expect(gotA.map((g) => g.event).sort()).toEqual(
        ['factory:update', 'jobcard:update', 'memo:alert', 'notification', 'rfid:scan', 'scale:SCALE-1', 'stock:alert'].sort());
      expect(gotB).toEqual([]); // nothing at all

      // …and the reverse
      gotA.length = 0;
      emit.jobCardUpdate('JC-SHARED', { from: 'B' }, B.company.id);
      emit.scaleReading('SCALE-1', 22.2, B.company.id);
      emit.stockAlert('STK-B', 'B low stock', B.company.id);
      emit.notification(B.user.id, { text: 'for B' }, B.company.id);
      await wait(500);
      expect(gotA).toEqual([]);
      expect(gotB.map((g) => g.data.weight).filter(Boolean)).toEqual([22.2]);
    });

    it('a notification addressed to a user id is delivered only within that user\'s own company', async () => {
      const sa = await connect(tokenFor(A)); const sb = await connect(tokenFor(B));
      const gotA = collect(sa, ['notification']); const gotB = collect(sb, ['notification']);
      await wait(200);
      emit.notification(A.user.id, { text: 'hello A' }, B.company.id); // A's user id, but B's company: goes nowhere
      await wait(300);
      expect(gotA).toEqual([]); expect(gotB).toEqual([]);
    });

    it('no legacy/bare room exists anywhere: every room is company-namespaced', async () => {
      await connect(roleToken(A, 'SUPER_ADMIN')); await connect(roleToken(B, 'SUPER_ADMIN'));
      await wait(200);
      const rooms = [...getIO()!.sockets.adapter.rooms.keys()].filter((r) => !getIO()!.sockets.sockets.has(r)); // drop each socket's own id room
      expect(rooms.length).toBeGreaterThan(0);
      for (const r of rooms) expect(r.startsWith('company:'), r).toBe(true);
      for (const legacy of ['factory:floor', 'role:SUPER_ADMIN', 'role:ADMIN', 'role:STORE_MANAGER', 'role:SALES']) {
        expect(rooms).not.toContain(legacy);
      }
      expect(rooms.some((r) => /^(user|role|jobcard):/.test(r))).toBe(false);
    });

    it('a socket cannot put itself in another company\'s room — subscribe events only ever join ITS OWN prefix', async () => {
      const sb = await connect(roleToken(B, 'SUPER_ADMIN'));
      sb.emit('subscribe:jobcard', `company:${A.company.id}:factory:floor`); // room-name injection attempt
      sb.emit('subscribe:jobcard', '../x'); sb.emit('subscribe:jobcard', { evil: true } as any);
      sb.emit('subscribe:jobcard', 'JC-REAL');
      await wait(300);
      const server = [...getIO()!.sockets.sockets.values()].find((s) => (s as any).user?.companyId === B.company.id && s.rooms.has(`company:${B.company.id}:jobcard:JC-REAL`))!;
      expect(server).toBeTruthy();
      for (const r of server.rooms) {
        if (r === server.id) continue;
        expect(r.startsWith(`company:${B.company.id}`), r).toBe(true);
        expect(r.includes(A.company.id)).toBe(false);
      }
    });

    it('emit.* refuses to run without a company — there is no global broadcast', () => {
      for (const fn of [
        () => (emit.jobCardUpdate as any)('j', {}, undefined),
        () => (emit.scaleReading as any)('d', 1, undefined),
        () => (emit.rfidScan as any)('t', 'l', undefined),
        () => (emit.stockAlert as any)('s', 'm', undefined),
        () => (emit.memoAlert as any)('m', 1, undefined),
        () => (emit.notification as any)('u', {}, undefined),
      ]) expect(fn).toThrow(/requires a companyId/);
    });

    it('connection is refused: no token, garbage token, forged company claim, deactivated member', async () => {
      await expect(connect('')).rejects.toBeTruthy();
      await expect(connect('not.a.jwt')).rejects.toBeTruthy();
      const forged = jwt.sign({ userId: A.user.id, email: A.user.email, companyId: B.company.id, companyUserId: A.companyUser.id, roleId: A.role.id, roleName: 'X', permissions: ['*'], branchAccess: { allBranches: true, branchIds: [] } }, env.JWT_SECRET);
      await expect(connect(forged)).rejects.toBeTruthy(); // A's membership is not a member of B
      const m = await createMember({ companyId: A.company.id, roleId: A.role.id, email: `ws-${suffix.toLowerCase()}@rt.example.com` });
      const tok = jwt.sign({ userId: m.user.id, email: m.user.email, companyId: A.company.id, companyUserId: m.membership.id, roleId: A.role.id, roleName: 'X', permissions: ['*'], branchAccess: { allBranches: true, branchIds: [] } }, env.JWT_SECRET);
      const ok = await connect(tok); ok.close();
      await prisma.companyUser.update({ where: { id: m.membership.id }, data: { isActive: false } });
      await expect(connect(tok)).rejects.toBeTruthy();
      await prisma.companyUser.deleteMany({ where: { id: m.membership.id } });
      await prisma.user.deleteMany({ where: { id: m.user.id } });
    });

    it('suspending a company drops its LIVE sockets, and it cannot reconnect', async () => {
      const t = await createTestTenant(`RTS${suffix}`, PERMS);
      try {
        const s = await connect(tokenFor(t));
        const closed = new Promise<string>((r) => s.once('disconnect', (reason) => r(reason)));
        await prisma.company.update({ where: { id: t.company.id }, data: { isActive: false } });
        disconnectCompany(t.company.id);
        expect(await closed).toBeTruthy();
        await expect(connect(tokenFor(t))).rejects.toBeTruthy();
      } finally { await cleanupTestTenant(t); }
    });

    it('branch rooms: a branch-restricted member hears only the branches they may access', async () => {
      const b2 = await addBranch(A.company.id, `rt2${suffix}`);
      const restricted = await connect(roleToken(A, 'FLOOR', [A.branch.id]));
      const all = await connect(roleToken(A, 'ADMINX'));
      const gotR = collect(restricted, ['scale:BR']); const gotAll = collect(all, ['scale:BR']);
      await wait(300);
      emit.scaleReading('BR', 1, A.company.id, A.branch.id);   // their branch
      emit.scaleReading('BR', 2, A.company.id, b2.id);         // another branch of the SAME company
      await wait(400);
      expect(gotR.map((g) => g.data.weight)).toEqual([1]);
      expect(gotAll.map((g) => g.data.weight).sort()).toEqual([1]); // token lists only A.branch in branchIds for this helper
      await prisma.branch.delete({ where: { id: b2.id } });
    });
  });

  // ─── Hardware ──────────────────────────────────────────────────────────────
  describe('hardware isolation', () => {
    it('a device id shared by two companies keeps two separate readings — no weight ever crosses over', async () => {
      expect((await apiA.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'SCALE-1' })).status).toBe(201);
      expect((await apiB.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'SCALE-1' })).status).toBe(201);
      const sa = await connect(tokenFor(A)); const sb = await connect(tokenFor(B));
      const gotA = collect(sa, ['scale:SCALE-1']); const gotB = collect(sb, ['scale:SCALE-1']);
      await wait(200);

      expect((await apiA.post('/hardware/scales/SCALE-1/simulate', { weight: 11.1 })).status).toBe(200);
      expect((await apiB.post('/hardware/scales/SCALE-1/simulate', { weight: 22.2 })).status).toBe(200);
      await wait(400);

      expect((await apiA.get('/hardware/scales/SCALE-1/read')).body.data.weight).toBe(11.1);
      expect((await apiB.get('/hardware/scales/SCALE-1/read')).body.data.weight).toBe(22.2);
      expect(gotA.map((g) => g.data.weight)).toEqual([11.1]);
      expect(gotB.map((g) => g.data.weight)).toEqual([22.2]);
      expect(hardwareService.getLastReading(A.company.id, 'SCALE-1')?.weight).toBe(11.1);
      expect(hardwareService.getLastReading(B.company.id, 'SCALE-1')?.weight).toBe(22.2);
    });

    it('a device that exists only in Company A is a 404 for Company B (read AND simulate)', async () => {
      await apiA.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'A-ONLY' });
      expect((await apiB.get('/hardware/scales/A-ONLY/read')).status).toBe(404);
      expect((await apiB.post('/hardware/scales/A-ONLY/simulate', { weight: 5 })).status).toBe(404);
      expect(hardwareService.getLastReading(B.company.id, 'A-ONLY')).toBeNull();
    });

    it('there is NO default/fallback device: "default-scale" is just an unowned id → 404 for everyone', async () => {
      for (const api of [apiA, apiB]) {
        expect((await api.get('/hardware/scales/default-scale/read')).status).toBe(404);
        expect((await api.post('/hardware/scales/default-scale/simulate', { weight: 1 })).status).toBe(404);
      }
      expect(Object.keys(env)).not.toContain('SCALE_PORT');
    });

    it('the device list and "connected scales" show only the caller\'s own company', async () => {
      const listB = (await apiB.get('/hardware/devices')).body;
      expect(listB.data.map((d: any) => d.deviceId)).not.toContain('A-ONLY');
      expect(listB.data.every((d: any) => d.companyId === B.company.id)).toBe(true);
      expect(listB.connectedScales).not.toContain('A-ONLY');
      expect(hardwareService.getConnectedScales(B.company.id)).toEqual([]);
    });

    it('a client cannot smuggle a companyId or forge a branch onto a device', async () => {
      expect((await apiB.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'X1', companyId: A.company.id })).status).toBe(400);
      expect((await apiB.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'X2', branchId: A.branch.id })).status).toBe(404);
      const dbFk = prisma.hardwareDevice.create({ data: { companyId: B.company.id, deviceType: 'SCALE', deviceId: 'X3', branchId: A.branch.id } });
      await expect(dbFk).rejects.toThrow(/foreign key/i); // and the DATABASE refuses it too (composite FK)
    });

    it('branch-assigned devices are visible only to members of that branch', async () => {
      expect((await apiA.post('/hardware/devices', { deviceType: 'SCALE', deviceId: 'BR-SCALE', branchId: A.branch.id })).status).toBe(201);
      const m = await createMember({ companyId: A.company.id, roleId: A.role.id, email: `hw-${suffix.toLowerCase()}@rt.example.com`, allBranches: false });
      const tok = jwt.sign({ userId: m.user.id, email: m.user.email, companyId: A.company.id, companyUserId: m.membership.id, roleId: A.role.id, roleName: 'X', permissions: ['*'], branchAccess: { allBranches: false, branchIds: [] } }, env.JWT_SECRET);
      const api = apiWith(tok, app);
      expect((await api.get('/hardware/devices')).body.data.map((d: any) => d.deviceId)).not.toContain('BR-SCALE');
      expect((await api.get('/hardware/scales/BR-SCALE/read')).status).toBe(404);
      await prisma.companyUser.deleteMany({ where: { id: m.membership.id } }); await prisma.user.deleteMany({ where: { id: m.user.id } });
    });

    it('simulation is a development aid: refused in production', async () => {
      const saved = env.NODE_ENV;
      (env as any).NODE_ENV = 'production';
      try { expect((await apiA.post('/hardware/scales/SCALE-1/simulate', { weight: 9 })).status).toBe(404); }
      finally { (env as any).NODE_ENV = saved; }
    });
  });

  // ─── Print / export endpoints ─────────────────────────────────────────────
  describe('print, estimate and export endpoints only ever operate on the caller\'s own records', () => {
    let va: { id: string; token: string; api: ReturnType<typeof apiWith>; branchId: string };
    let sh: typeof va;
    const ids: Record<string, string> = {};
    const DOMAIN = '@export.example.com';

    beforeAll(async () => {
      const mk = async (code: string, tag: string) => {
        const r = await provisionCompany({ code, name: `${tag} Co`, admin: { email: `${tag.toLowerCase()}${suffix.toLowerCase()}${DOMAIN}`, name: 'Owner Person', password: 'Export-Passw0rd-123' } });
        const login = await apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: `${tag.toLowerCase()}${suffix.toLowerCase()}${DOMAIN}`, password: 'Export-Passw0rd-123' });
        return { id: r.company.id, token: login.body.data.accessToken as string, api: apiWith(login.body.data.accessToken, app), branchId: r.branch.id };
      };
      va = await mk(`EXV${suffix}`.slice(0, 12), 'Vas'); sh = await mk(`EXS${suffix}`.slice(0, 12), 'Shr');
      const stock = (await va.api.get('/masters/stock-types')).body.data[0].id;
      const cat = (await va.api.get('/masters/categories')).body.data[0].id;
      const tag = await va.api.post('/tagging/tags', { branchId: va.branchId, stockTypeId: stock, categoryId: cat, name: 'Vasavi Export Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, sellingPrice: 30000 });
      ids.tag = tag.body.data.id;
      const client = await va.api.post('/orders/clients', { name: 'Vasavi Export Client', type: 'RETAIL' });
      ids.client = client.body.data.id;
      const inv = await va.api.post('/sales/invoices', { clientId: ids.client, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', branchId: va.branchId, currency: 'INR', items: [{ productCode: 'X', description: 'Vasavi Export Ring', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 30000, karat: '22K', tagId: ids.tag }] });
      ids.invoice = inv.body.data?.id;
      ids.tpl = (await va.api.get('/tagging/templates')).body.data[0].id;
      const est = await va.api.post(`/estimation/tags/${ids.tag}/estimates`, { items: [{ code: 'G22', materialType: 'METAL', weight: 5, saleRate: 6000 }] });
      ids.estimate = est.body.data?.id;
    });

    afterAll(async () => {
      for (const c of [va, sh]) if (c) await purgeCompany(c.id);
      await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    });

    it('control: the owning company can print its own tag and read its own estimate', async () => {
      expect((await va.api.get(`/tagging/tags/${ids.tag}/print`)).status).toBe(200);
      expect(ids.estimate).toBeTruthy();
      expect((await va.api.get(`/estimation/estimates/${ids.estimate}`)).status).toBe(200);
    });

    it('another company gets 404 — never the document — for each print / estimate / export request', async () => {
      const probes: Array<[string, () => Promise<any>]> = [
        ['tag print (TSPL)', () => sh.api.get(`/tagging/tags/${ids.tag}/print`)],
        ['tag print with the other company\'s template', () => sh.api.get(`/tagging/tags/${ids.tag}/print?templateId=${ids.tpl}`)],
        ['list a tag\'s estimates', () => sh.api.get(`/estimation/tags/${ids.tag}/estimates`)],
        ['create an estimate on the tag', () => sh.api.post(`/estimation/tags/${ids.tag}/estimates`, { items: [{ code: 'G22', materialType: 'METAL', weight: 5, saleRate: 6000 }] })],
        ['read an estimate', () => sh.api.get(`/estimation/estimates/${ids.estimate}`)],
        ['client ledger statement', () => sh.api.get(`/finance/reports/client-ledger/${ids.client}`)],
        ['client payment', () => sh.api.post(`/sales/clients/${ids.client}/payments`, { amount: 1, mode: 'CASH' })],
      ];
      if (ids.invoice) {
        probes.push(['invoice packing list', () => sh.api.get(`/sales/invoices/${ids.invoice}/packing-list`)]);
        probes.push(['invoice payment', () => sh.api.post(`/sales/invoices/${ids.invoice}/payment`, { amount: 1, mode: 'CASH' })]);
      }
      for (const [what, run] of probes) {
        const r = await run();
        expect(r.status, `${what}: ${JSON.stringify(r.body).slice(0, 120)}`).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/Vasavi/);
      }
    });

    it('using the other company\'s template on your OWN tag is also refused', async () => {
      const stock = (await sh.api.get('/masters/stock-types')).body.data[0].id;
      const cat = (await sh.api.get('/masters/categories')).body.data[0].id;
      const own = await sh.api.post('/tagging/tags', { branchId: sh.branchId, stockTypeId: stock, categoryId: cat, name: 'Shree Ring', metalType: 'GOLD', grossWeight: 1, netWeight: 1 });
      expect((await sh.api.get(`/tagging/tags/${own.body.data.id}/print?templateId=${ids.tpl}`)).status).toBe(404);
      expect((await sh.api.get(`/tagging/tags/${own.body.data.id}/print`)).status).toBe(200);
    });
  });
});
