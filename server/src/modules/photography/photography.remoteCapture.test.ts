import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { app } from '../../app';
import { logger } from '../../config/logger';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, createMember, addBranch, cleanupTestTenant, tokenFor, withForcedRls, TestTenant } from '../../test/fixtures';
import { MemoryStorageProvider, setStorageProviderForTests } from '../../shared/storage';
import { issueCaptureTicket } from './captureTicket';
import { COMMAND_TTL_SECONDS } from './captureCommand.service';

// Photography Phase 5D — remote capture, end to end, with NO hardware:
//   ERP user -> capture session -> capture command -> (real) bridge poller/executor -> MockCameraProvider
//   -> (real) HTTP upload to the EXISTING /photography/images -> TagImage -> processing -> status.
// The bridge lives outside this package's rootDir, so its modules are loaded by computed path (invisible to tsc).
const BASE = '/api/v1/photography';
const BR = path.resolve(__dirname, '../../../../camera-bridge/src');
const PERMS = ['photography:view', 'photography:capture', 'photography:manage_stations'];

describe('Photography Phase 5D — remote capture protocol', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const mem = new MemoryStorageProvider();
  let A: TestTenant; let B: TestTenant; let A2: { id: string; token: string };
  let branch2Id: string;
  const ids: Record<string, string> = {};
  const cred: Record<string, string> = {};
  let server: http.Server; let apiUrl: string;
  let bridge: {
    MockCameraProvider: new (o?: object) => any; CameraController: new (p: any, l: any) => any; CaptureExecutor: new (...a: any[]) => any;
    HttpCaptureTransport: new (o: { apiUrl: string }) => any; TempStore: new (...a: any[]) => any; CommandPoller: new (...a: any[]) => any;
    createLogger: (o: object) => any;
  };
  const tmpDirs: string[] = [];
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const stn = (c: string) => ({ Authorization: `Bearer ${c}` });
  const bridgeLines: string[] = [];

  const mkTag = (t: TestTenant, num: string, branchId = t.branch.id) => prisma.jewelryTag.create({
    data: { companyId: t.company.id, tagNumber: `${num}-${suffix}`, branchId, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: t.user.id },
  });
  const mkStation = (t: TestTenant, name: string, branchId = t.branch.id) => prisma.photographyStation.create({
    data: { companyId: t.company.id, branchId, name: `${name}-${suffix}`, registeredById: t.user.id },
  });
  async function issueCred(t: TestTenant, stationId: string): Promise<{ credential: string; id: string }> {
    const r = await request(app).post(`${BASE}/stations/${stationId}/credentials`).set(authOf(t)).send({});
    expect(r.status).toBe(201);
    return { credential: r.body.data.credential, id: r.body.data.id };
  }
  const heartbeat = (c: string, stationId: string) => request(app).post(`${BASE}/stations/heartbeat`).set(stn(c))
    .send({ stationId, bridgeVersion: '0.1.0', cameraStatus: 'CONNECTED' });
  async function session(t: TestTenant, tagId: string, stationId: string, source = 'BRIDGE') {
    const r = await request(app).post(`${BASE}/capture-sessions`).set(authOf(t)).send({ tagId, stationId, captureSource: source });
    expect(r.status).toBe(201);
    return r.body.data.ticket as string;
  }
  const command = (t: TestTenant | { token: string }, ticket: string, imageType = 'PRIMARY', extra: object = {}) =>
    request(app).post(`${BASE}/capture-commands`).set('token' in t ? { Authorization: `Bearer ${t.token}` } : authOf(t)).send({ ticket, imageType, ...extra });
  const getCommand = (t: TestTenant | { token: string }, id: string) =>
    request(app).get(`${BASE}/capture-commands/${id}`).set('token' in t ? { Authorization: `Bearer ${t.token}` } : authOf(t));
  const poll = (c: string) => request(app).get(`${BASE}/stations/commands/next`).set(stn(c));
  const report = (c: string, id: string, body: object) => request(app).post(`${BASE}/stations/commands/${id}/status`).set(stn(c)).send(body);
  const rowOf = (id: string) => prisma.photographyCaptureCommand.findUniqueOrThrow({ where: { id } });

  /** A real bridge (executor + mock camera + real HTTP transport) for one station credential. */
  async function mkBridge(stationId: string, secret: string, camOpts: object = {}, execOpts: object = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivo-5d-')); tmpDirs.push(dir);
    const log = bridge.createLogger({ sink: (l: string) => bridgeLines.push(l) });
    const provider = new bridge.MockCameraProvider(camOpts); await provider.connect();
    const camera = new bridge.CameraController(provider, log);
    const temp = new bridge.TempStore(dir, 60_000, log);
    const transport = new bridge.HttpCaptureTransport({ apiUrl });
    const creds = { kind: 'dev-env', load: async () => secret, save: async () => undefined };
    const executor = new bridge.CaptureExecutor(
      { stationId, captureTimeoutMs: 2000, uploadTimeoutMs: 5000, uploadMaxAttempts: 2, uploadBackoffMs: 5, cameraLabel: 'mock', ...execOpts },
      camera, creds, transport, temp, log,
    );
    return { dir, provider, camera, temp, transport, creds, executor, log };
  }
  /** Poll the command the way the bridge does, then run it. */
  async function runOnBridge(b: Awaited<ReturnType<typeof mkBridge>>, secret: string) {
    const out = await b.transport.pollCommand(secret, 0);
    expect(out.ok).toBe(true);
    expect(out.command).not.toBeNull();
    return b.executor.handle(out.command);
  }

  beforeAll(async () => {
    setStorageProviderForTests(mem);
    A = await createTestTenant(`RA${suffix}`, PERMS);
    B = await createTestTenant(`RB${suffix}`, PERMS);
    const u2 = await createMember({ companyId: A.company.id, roleId: A.role.id, email: `r2-${suffix}@example.com` });
    A2 = { id: u2.user.id, token: tokenFor({ ...A, user: u2.user, companyUser: u2.membership } as TestTenant) };
    branch2Id = (await addBranch(A.company.id, suffix)).id;
    ids.tag = (await mkTag(A, 'T1')).id;
    ids.tag2 = (await mkTag(A, 'T2')).id;
    ids.tag3 = (await mkTag(A, 'T3')).id;
    ids.tagBr2 = (await mkTag(A, 'T4', branch2Id)).id;
    ids.tagB = (await mkTag(B, 'TB')).id;
    ids.st1 = (await mkStation(A, 'ST1')).id;
    ids.st2 = (await mkStation(A, 'ST2')).id;
    ids.stBr2 = (await mkStation(A, 'STBR2', branch2Id)).id;
    ids.stB = (await mkStation(B, 'STB')).id;
    for (const [k, t] of [['st1', A], ['st2', A], ['stBr2', A], ['stB', B]] as const) {
      const c = await issueCred(t, ids[k]);
      cred[k] = c.credential; ids[`${k}Cred`] = c.id;
      expect((await heartbeat(c.credential, ids[k])).status).toBe(200);
    }
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const imp = (f: string) => import(/* @vite-ignore */ path.join(BR, f));
    const [mock, ctl, exe, tr, tmp, pol, lg] = await Promise.all([
      imp('camera/MockCameraProvider.ts'), imp('camera/CameraController.ts'), imp('capture/captureExecutor.ts'),
      imp('capture/captureTransport.ts'), imp('capture/tempStore.ts'), imp('capture/commandPoller.ts'), imp('logger.ts'),
    ]);
    bridge = {
      MockCameraProvider: mock.MockCameraProvider, CameraController: ctl.CameraController, CaptureExecutor: exe.CaptureExecutor,
      HttpCaptureTransport: tr.HttpCaptureTransport, TempStore: tmp.TempStore, CommandPoller: pol.CommandPoller, createLogger: lg.createLogger,
    };
  }, 90_000);

  afterEach(() => vi.restoreAllMocks());
  // Only one live command per station is allowed, so each test starts from a clean slate.
  beforeEach(async () => {
    await prisma.photographyCaptureCommand.updateMany({
      where: { status: { in: ['QUEUED', 'ACCEPTED', 'CAPTURING'] }, companyId: { in: [A.company.id, B.company.id] } },
      data: { status: 'FAILED', failureCode: 'COMMAND_REJECTED', completedAt: new Date() },
    });
  });
  afterAll(async () => {
    setStorageProviderForTests(null);
    await new Promise((r) => server?.close(r));
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    for (const t of [A, B]) { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    await prisma.user.deleteMany({ where: { email: `r2-${suffix}@example.com` } });
    await prisma.$disconnect();
  });

  // ─────────────────────────── end to end ───────────────────────────
  describe('end to end (mock camera, real bridge poller, real upload endpoint)', () => {
    it('ERP capture -> command -> bridge poller -> mock camera -> /photography/images -> TagImage -> processing -> UPLOADED', async () => {
      const ticket = await session(A, ids.tag, ids.st1);
      const b = await mkBridge(ids.st1, cred.st1);
      const poller = new bridge.CommandPoller({ waitSeconds: 1, emptyPollPauseMs: 20, baseBackoffMs: 20 }, b.executor, b.creds, b.transport, b.log);
      poller.start();
      try {
        const c = await command(A, ticket, 'PRIMARY');
        expect(c.status).toBe(201);
        expect(c.body.data).toMatchObject({ status: 'QUEUED', stationId: ids.st1, tagId: ids.tag, imageType: 'PRIMARY' });
        const id = c.body.data.commandId as string;
        let st: any;
        for (let i = 0; i < 60; i++) {
          st = (await getCommand(A, id)).body.data;
          if (['UPLOADED', 'FAILED', 'EXPIRED'].includes(st.status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(st.status).toBe('UPLOADED');
        expect(st.failureCode).toBeNull();
        // the image is the ordinary TagImage the browser path would have made
        expect(st.image).toMatchObject({ tagId: ids.tag, imageType: 'PRIMARY', isPrimary: true, uploadStatus: 'CONFIRMED', captureSource: 'BRIDGE', station: { id: ids.st1 } });
        const row = await prisma.tagImage.findUniqueOrThrow({ where: { id: st.image.id } });
        expect(row.capturedById).toBe(A.user.id);
        expect(row.stationId).toBe(ids.st1);
        expect(row.storageKeyOriginal).toMatch(new RegExp(`^companies/${A.company.id}/`));
        expect(row.idempotencyKey).toMatch(/^brg-/);
        expect(row.mimeType).toBe('image/png');
        // existing processing ran on the station-uploaded image
        expect(['READY', 'FAILED']).toContain(row.processingStatus);
        expect(row.processingStatus).toBe('READY');
        expect(row.storageKeyThumbnail).toBeTruthy();
        // bridge kept nothing; audit carries the command id and the user
        expect(fs.readdirSync(b.dir)).toEqual([]);
        const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: row.id, action: 'CAPTURE' } });
        expect(audit?.userId).toBe(A.user.id);
        expect(JSON.stringify(audit?.newValues)).toContain(id);
        // server-side lifecycle is recorded, not inferred
        const dbc = await rowOf(id);
        expect(dbc).toMatchObject({ status: 'UPLOADED', tagImageId: row.id, idempotencyKey: row.idempotencyKey });
        expect(dbc.acceptedAt).not.toBeNull(); expect(dbc.completedAt).not.toBeNull();
        // gallery sees it
        const gal = await request(app).get(`${BASE}/tags/${ids.tag}/images`).set(authOf(A));
        expect(gal.body.data.some((i: any) => i.id === row.id)).toBe(true);
        // the command is not redelivered once finished
        expect((await poll(cred.st1)).body.data.command).toBeNull();
      } finally { await poller.stop(); }
    }, 30_000);

    it('reports accepted -> capturing in order while the bridge works (server knows the stage)', async () => {
      const ticket = await session(A, ids.tag2, ids.st1);
      const b = await mkBridge(ids.st1, cred.st1, { captureDelayMs: 300 });
      const c = await command(A, ticket, 'SIDE');
      const id = c.body.data.commandId;
      const run = runOnBridge(b, cred.st1);
      await new Promise((r) => setTimeout(r, 120));
      expect((await getCommand(A, id)).body.data.status).toBe('CAPTURING');
      expect(await run).toMatchObject({ code: 'SUCCESS' });
      expect((await getCommand(A, id)).body.data.status).toBe('UPLOADED');
    }, 20_000);

    it('manual file upload with a user token still works and does not need a bridge', async () => {
      const ticket = await session(A, ids.tag3, ids.st2, 'DEVICE_CAMERA');
      const png = Buffer.from((await (async () => { const p = new bridge.MockCameraProvider(); await p.connect(); return p.capture({ correlationId: 'manual-1' }); })()).data);
      const r = await request(app).post(`${BASE}/images`).set(authOf(A)).field('ticket', ticket).field('imageType', 'DETAIL').field('idempotencyKey', `manual-${suffix}`)
        .attach('file', png, { filename: 'x.png', contentType: 'image/png' });
      expect(r.status).toBe(201);
      expect(r.body.data.image.captureSource).toBe('DEVICE_CAMERA');
    });
  });

  // ─────────────────────────── command creation ───────────────────────────
  describe('creating a command (ERP stays authoritative)', () => {
    it('requires the photography:capture permission and authentication', async () => {
      const t = await createTestTenant(`RV${suffix}`, ['photography:view']);
      try {
        expect((await command(t, 'x')).status).toBe(403);
        expect((await request(app).post(`${BASE}/capture-commands`).send({})).status).toBe(401);
      } finally { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    });

    it('rejects a client-supplied company / station / tag / extra fields', async () => {
      const ticket = await session(A, ids.tag, ids.st1);
      expect((await command(A, ticket, 'SIDE', { companyId: B.company.id })).status).toBe(400);
      expect((await command(A, ticket, 'SIDE', { stationId: ids.st2 })).status).toBe(400);
      expect((await command(A, ticket, 'SIDE', { tagId: ids.tagB })).status).toBe(400);
      expect((await command(A, ticket, 'NOPE')).status).toBe(400);
    });

    it('a manual (DEVICE_CAMERA) session ticket cannot start a bridge capture', async () => {
      const t = await session(A, ids.tag, ids.st1, 'DEVICE_CAMERA');
      const r = await command(A, t);
      expect(r.status).toBe(409); expect(r.body.code).toBe('SESSION_NOT_BRIDGE');
    });

    it('an offline station (no recent heartbeat) fails fast so the user falls back to a file', async () => {
      await prisma.photographyStation.update({ where: { id: ids.st2 }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
      const r = await command(A, await session(A, ids.tag, ids.st2));
      expect(r.status).toBe(409); expect(r.body.code).toBe('STATION_OFFLINE');
      await heartbeat(cred.st2, ids.st2);
    });

    it('only one live command per station: a second is STATION_BUSY, not queued', async () => {
      const t1 = await session(A, ids.tag, ids.st2);
      const first = await command(A, t1);
      expect(first.status).toBe(201);
      const second = await command(A, await session(A, ids.tag2, ids.st2));
      expect(second.status).toBe(409); expect(second.body.code).toBe('STATION_BUSY');
      expect(await prisma.photographyCaptureCommand.count({ where: { stationId: ids.st2, status: 'QUEUED' } })).toBe(1);
      expect((await report(cred.st2, first.body.data.commandId, { status: 'FAILED', code: 'COMMAND_REJECTED' })).status).toBe(200);
    });

    it('wrong company: another company\'s ticket (or tag/station via the ticket) is refused', async () => {
      const bTicket = await session(B, ids.tagB, ids.stB);
      const r = await command(A, bTicket);
      expect(r.status).toBe(401);
      expect(await prisma.photographyCaptureCommand.count({ where: { companyId: A.company.id, tagId: ids.tagB } })).toBe(0);
    });

    it('wrong user: another user\'s ticket is refused', async () => {
      const ticket = await session(A, ids.tag, ids.st1);
      expect((await command(A2, ticket)).status).toBe(401);
    });

    it('wrong branch: a station in another branch cannot be paired with the tag', async () => {
      const r = await request(app).post(`${BASE}/capture-sessions`).set(authOf(A)).send({ tagId: ids.tag, stationId: ids.stBr2, captureSource: 'BRIDGE' });
      expect(r.status).toBe(409);
    });

    it('an expired user ticket is refused', async () => {
      const t = issueCaptureTicket({ cid: A.company.id, tid: ids.tag, sid: ids.st1, uid: A.user.id, src: 'BRIDGE', ttlSeconds: -10 }).ticket;
      const r = await command(A, t);
      expect(r.status).toBe(401); expect(r.body.code).toBe('TICKET_EXPIRED');
    });

    it('a command ticket (as minted for a bridge) cannot be used to create another command', async () => {
      const t = issueCaptureTicket({ cid: A.company.id, tid: ids.tag, sid: ids.st1, uid: A.user.id, src: 'BRIDGE', cmd: 'x' }).ticket;
      expect((await command(A, t)).status).toBe(401);
    });
  });

  // ─────────────────────────── status visibility ───────────────────────────
  describe('who can read a command', () => {
    it('only the requesting user, in their own company', async () => {
      const c = await command(A, await session(A, ids.tag, ids.st1));
      const id = c.body.data.commandId;
      expect((await getCommand(A, id)).status).toBe(200);
      expect((await getCommand(A2, id)).status).toBe(404);
      expect((await getCommand(B, id)).status).toBe(404);
      expect((await getCommand(A, 'nope')).status).toBe(404);
      await report(cred.st1, id, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });
  });

  // ─────────────────────────── station side ───────────────────────────
  describe('station authentication on the command channel', () => {
    it('no credential / a user JWT / a forged credential is 401; the user routes reject a station credential', async () => {
      expect((await request(app).get(`${BASE}/stations/commands/next`)).status).toBe(401);
      expect((await request(app).get(`${BASE}/stations/commands/next`).set(authOf(A))).status).toBe(401);
      expect((await poll('stn_nope.' + 'x'.repeat(43))).status).toBe(401);
      expect((await request(app).get(`${BASE}/capture-commands/abc`).set(stn(cred.st1))).status).toBe(401);
      expect((await request(app).post(`${BASE}/capture-commands`).set(stn(cred.st1)).send({})).status).toBe(401);
    });

    it('a heartbeat-only (pre-5D) credential cannot take commands or upload', async () => {
      const old = await prisma.stationCredential.create({
        data: { companyId: A.company.id, stationId: ids.st1, tokenHash: 'd'.repeat(64), scopes: ['station:heartbeat'], createdById: A.user.id },
      });
      // build a real token for it
      const crypto = await import('crypto');
      const token = `stn_${A.company.id}.${crypto.randomBytes(32).toString('base64url')}`;
      await prisma.stationCredential.update({ where: { id: old.id }, data: { tokenHash: crypto.createHash('sha256').update(token).digest('hex') } });
      expect((await heartbeat(token, ids.st1)).status).toBe(200);
      expect((await poll(token)).status).toBe(403);
      expect((await request(app).post(`${BASE}/images`).set(stn(token)).field('ticket', 'x').field('imageType', 'SIDE').field('idempotencyKey', 'abcdefgh1')).status).toBe(403);
    });

    it('a revoked credential is refused everywhere', async () => {
      const own = await mkStation(A, 'STREV');
      const c = await issueCred(A, own.id);
      expect((await poll(c.credential)).status).toBe(200);
      const rv = await request(app).post(`${BASE}/stations/${own.id}/credentials/${c.id}/revoke`).set(authOf(A)).send({ reason: 't' });
      expect(rv.status).toBe(200);
      expect((await poll(c.credential)).status).toBe(403);
      expect((await report(c.credential, 'x', { status: 'ACCEPTED' })).status).toBe(403);
      expect((await request(app).post(`${BASE}/images`).set(stn(c.credential)).field('ticket', 'x').field('imageType', 'SIDE').field('idempotencyKey', 'abcdefgh1')).status).toBe(403);
    });

    it('poll returns only the credential\'s own station\'s command, with no secrets or storage details', async () => {
      const c = await command(A, await session(A, ids.tag, ids.st1));
      const id = c.body.data.commandId;
      expect((await poll(cred.st2)).body.data.command).toBeNull();     // another station of the same company
      expect((await poll(cred.stB)).body.data.command).toBeNull();     // another company
      const mine = (await poll(cred.st1)).body.data.command;
      expect(mine.commandId).toBe(id);
      expect(Object.keys(mine).sort()).toEqual(['commandId', 'correlationId', 'expiresAt', 'imageType', 'stationId', 'tagNumber', 'ticket']);
      expect(mine.commandId).not.toBe(mine.correlationId);
      expect(JSON.stringify(mine)).not.toMatch(/companies\/|bucket|secret|password|stn_|storage/i);
      // the delivered ticket carries the command binding and the same session — and is not the user's ticket
      const claims = JSON.parse(Buffer.from(mine.ticket.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ cid: A.company.id, tid: ids.tag, sid: ids.st1, uid: A.user.id, src: 'BRIDGE', cmd: id });
      await report(cred.st1, id, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('another station / company cannot report on or even see a command (404)', async () => {
      const c = await command(A, await session(A, ids.tag, ids.st1));
      const id = c.body.data.commandId;
      expect((await report(cred.st2, id, { status: 'ACCEPTED' })).status).toBe(404);
      expect((await report(cred.stB, id, { status: 'FAILED', code: 'BUSY' })).status).toBe(404);
      expect((await rowOf(id)).status).toBe('QUEUED');
      await report(cred.st1, id, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('status reports are strictly validated and forward-only', async () => {
      const c = await command(A, await session(A, ids.tag, ids.st1));
      const id = c.body.data.commandId;
      expect((await report(cred.st1, id, { status: 'UPLOADED' })).status).toBe(400);         // server-owned state
      expect((await report(cred.st1, id, { status: 'FAILED', code: 'WHATEVER' })).status).toBe(400);
      expect((await report(cred.st1, id, { status: 'FAILED' })).status).toBe(400);
      expect((await report(cred.st1, id, { status: 'ACCEPTED', code: 'BUSY' })).status).toBe(400);
      expect((await report(cred.st1, id, { status: 'ACCEPTED', tagId: 'x' })).status).toBe(400);
      expect((await report(cred.st1, id, { status: 'CAPTURING' })).status).toBe(409);        // must be ACCEPTED first
      expect((await report(cred.st1, id, { status: 'ACCEPTED' })).status).toBe(200);
      expect((await report(cred.st1, id, { status: 'ACCEPTED' })).status).toBe(409);         // no repeat
      expect((await report(cred.st1, id, { status: 'CAPTURING' })).status).toBe(200);
      const f = await report(cred.st1, id, { status: 'FAILED', code: 'CAMERA_ERROR', detail: 'CAPTURE_TIMEOUT' });
      expect(f.status).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', failureCode: 'CAMERA_ERROR', failureDetail: 'CAPTURE_TIMEOUT' });
      expect((await report(cred.st1, id, { status: 'CAPTURING' })).status).toBe(409);        // terminal
      expect((await getCommand(A, id)).body.data).toMatchObject({ status: 'FAILED', failureCode: 'CAMERA_ERROR', failureDetail: 'CAPTURE_TIMEOUT' });
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: id, action: 'FAIL' } });
      expect(JSON.stringify(audit?.newValues)).toContain('CAPTURE_TIMEOUT');
    });
  });

  // ─────────────────────────── expiry ───────────────────────────
  describe('expiry', () => {
    it('a command past its deadline is never delivered, is EXPIRED, and cannot upload', async () => {
      const c = await command(A, await session(A, ids.tag, ids.st1));
      const id = c.body.data.commandId;
      const mine = (await poll(cred.st1)).body.data.command;
      await prisma.photographyCaptureCommand.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await poll(cred.st1)).body.data.command).toBeNull();
      expect((await getCommand(A, id)).body.data.status).toBe('EXPIRED');
      expect((await report(cred.st1, id, { status: 'ACCEPTED' })).status).toBe(410);
      const up = await request(app).post(`${BASE}/images`).set(stn(cred.st1)).field('ticket', mine.ticket).field('imageType', 'PRIMARY').field('idempotencyKey', `exp-${suffix}-1`)
        .attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });
      expect(up.status).toBe(401); expect(up.body.code).toBe('COMMAND_EXPIRED');
      expect(COMMAND_TTL_SECONDS).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────── station upload authorization ───────────────────────────
  describe('station upload authorization (a station credential alone authorizes nothing)', () => {
    async function liveCommand(tagId = ids.tag, stationKey = 'st1', imageType = 'SIDE') {
      const c = await command(A, await session(A, tagId, ids[stationKey]), imageType);
      expect(c.status).toBe(201);
      const delivered = (await poll(cred[stationKey])).body.data.command;
      expect(delivered.commandId).toBe(c.body.data.commandId);
      return delivered as { commandId: string; ticket: string };
    }
    let k = 0;
    const key = () => `up-${suffix}-${k++}-abc`;
    async function pngBytes() { const p = new bridge.MockCameraProvider(); await p.connect(); return (await p.capture({ correlationId: `s-${k}` })).data as Buffer; }
    const stationUpload = async (secret: string, ticket: string, over: Record<string, string> = {}, file?: Buffer) =>
      request(app).post(`${BASE}/images`).set(stn(secret)).field('ticket', ticket).field('imageType', over.imageType ?? 'SIDE').field('idempotencyKey', over.idempotencyKey ?? key())
        .attach('file', file ?? await pngBytes(), { filename: 'c.png', contentType: 'image/png' });

    it('a command that has not been accepted yet (QUEUED) cannot take an upload', async () => {
      const d = await liveCommand();
      const r = await stationUpload(cred.st1, d.ticket);
      expect(r.status).toBe(409); expect(r.body.code).toBe('COMMAND_STATE');
      await report(cred.st1, d.commandId, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('an ordinary user session ticket (no command binding) is refused when presented by a station', async () => {
      const userTicket = await session(A, ids.tag, ids.st1);
      const r = await stationUpload(cred.st1, userTicket);
      expect(r.status).toBe(401); expect(r.body.code).toBe('TICKET_INVALID');
    });

    it('a DEVICE_CAMERA-source ticket is refused for a station', async () => {
      const t = issueCaptureTicket({ cid: A.company.id, tid: ids.tag, sid: ids.st1, uid: A.user.id, src: 'DEVICE_CAMERA', cmd: 'x' }).ticket;
      expect((await stationUpload(cred.st1, t)).status).toBe(401);
    });

    it('wrong station: another station\'s credential cannot use this command\'s ticket', async () => {
      const d = await liveCommand();
      await report(cred.st1, d.commandId, { status: 'ACCEPTED' });
      const r = await stationUpload(cred.st2, d.ticket);
      expect(r.status).toBe(401);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, tagId: ids.tag, captureSource: 'BRIDGE', stationId: ids.st2 } })).toBe(0);
      await report(cred.st1, d.commandId, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('wrong company: company B\'s credential cannot use company A\'s ticket', async () => {
      const d = await liveCommand();
      await report(cred.st1, d.commandId, { status: 'ACCEPTED' });
      expect((await stationUpload(cred.stB, d.ticket)).status).toBe(401);
      await report(cred.st1, d.commandId, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('wrong tag / wrong user / forged binding: a ticket whose claims do not match its command is refused', async () => {
      const d = await liveCommand();
      await report(cred.st1, d.commandId, { status: 'ACCEPTED' });
      const forge = (over: object) => issueCaptureTicket({ cid: A.company.id, tid: ids.tag, sid: ids.st1, uid: A.user.id, src: 'BRIDGE', cmd: d.commandId, ...over }).ticket;
      const sess = JSON.parse(Buffer.from(d.ticket.split('.')[1], 'base64url').toString()).sess;
      expect((await stationUpload(cred.st1, forge({ tid: ids.tag2, sess }))).status).toBe(401);   // wrong tag
      expect((await stationUpload(cred.st1, forge({ uid: A2.id, sess }))).status).toBe(401);      // wrong user
      expect((await stationUpload(cred.st1, forge({}))).status).toBe(401);                         // wrong session
      expect((await stationUpload(cred.st1, forge({ cmd: 'someone-elses-command', sess }))).status).toBe(401);
      expect((await stationUpload(cred.st1, 'garbage.ticket.value')).status).toBe(401);
      expect((await stationUpload(cred.st1, forge({ sess, ttlSeconds: -5 }))).body.code).toBe('TICKET_EXPIRED');
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, tagId: { in: [ids.tag, ids.tag2] }, captureSource: 'BRIDGE', idempotencyKey: { startsWith: 'up-' } } })).toBe(0);
      await report(cred.st1, d.commandId, { status: 'FAILED', code: 'COMMAND_REJECTED' });
    });

    it('the image type is the command\'s, not the caller\'s; authority fields in the body are ignored/refused', async () => {
      const d = await liveCommand(ids.tag, 'st1', 'SIDE');
      await report(cred.st1, d.commandId, { status: 'ACCEPTED' });
      const bad = await request(app).post(`${BASE}/images`).set(stn(cred.st1)).field('ticket', d.ticket).field('imageType', 'PRIMARY').field('idempotencyKey', key())
        .attach('file', await pngBytes(), { filename: 'c.png', contentType: 'image/png' });
      expect(bad.status).toBe(403);
      const spoof = await request(app).post(`${BASE}/images`).set(stn(cred.st1)).field('ticket', d.ticket).field('imageType', 'SIDE').field('idempotencyKey', key())
        .field('companyId', B.company.id).attach('file', await pngBytes(), { filename: 'c.png', contentType: 'image/png' });
      expect(spoof.status).toBe(400);
      // tagId / stationId in the body are not read at all — the ticket decides
      const ok = await request(app).post(`${BASE}/images`).set(stn(cred.st1)).field('ticket', d.ticket).field('imageType', 'SIDE').field('idempotencyKey', key())
        .field('tagId', ids.tag2).field('stationId', ids.st2).attach('file', await pngBytes(), { filename: 'c.png', contentType: 'image/png' });
      expect(ok.status).toBe(201);
      expect(ok.body.data.image.tagId).toBe(ids.tag);
      expect(ok.body.data.image.station.id).toBe(ids.st1);
    });

    it('upload replay (same idempotency key) creates no duplicate image; a different key on a finished command is refused', async () => {
      const d = await liveCommand(ids.tag2, 'st1', 'BACK');
      await report(cred.st1, d.commandId, { status: 'ACCEPTED' });
      const file = await pngBytes();
      const idem = key();
      const first = await stationUpload(cred.st1, d.ticket, { idempotencyKey: idem, imageType: 'BACK' }, file);
      expect(first.status).toBe(201);
      expect(first.body.data.idempotentReplay).toBe(false);
      const replay = await stationUpload(cred.st1, d.ticket, { idempotencyKey: idem, imageType: 'BACK' }, file);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ idempotentReplay: true });
      expect(replay.body.data.image.id).toBe(first.body.data.image.id);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, idempotencyKey: idem } })).toBe(1);
      const other = await stationUpload(cred.st1, d.ticket, { imageType: 'BACK' }, file); // a second image for the same command
      expect(other.status).toBe(409); expect(other.body.code).toBe('COMMAND_STATE');
      expect((await rowOf(d.commandId)).status).toBe('UPLOADED');
    });
  });

  // ─────────────────────────── bridge executing against the real ERP ───────────────────────────
  describe('bridge behaviour against the real ERP', () => {
    it('command replay (same command delivered twice) captures once and creates one image', async () => {
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'DETAIL');
      const b = await mkBridge(ids.st1, cred.st1);
      let shots = 0; const orig = b.provider.capture.bind(b.provider); b.provider.capture = async (q: any) => { shots++; return orig(q); };
      const out = await b.transport.pollCommand(cred.st1, 0);
      const [r1, r2] = await Promise.all([b.executor.handle(out.command), b.executor.handle(out.command)]);
      const r3 = await b.executor.handle(out.command);
      expect(r1.code).toBe('SUCCESS'); expect(r2).toEqual(r1); expect(r3).toEqual(r1);
      expect(shots).toBe(1);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, tagId: ids.tag3, imageType: 'DETAIL', idempotencyKey: { startsWith: 'brg-' } } })).toBe(1);
      expect((await rowOf(c.body.data.commandId)).status).toBe('UPLOADED');
    }, 20_000);

    it('an upload retried after a lost response reuses the idempotency key and does not duplicate the image', async () => {
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'OTHER');
      const b = await mkBridge(ids.st1, cred.st1);
      // First response is dropped on the way back (the server HAS stored the image); the retry must replay, not duplicate.
      const real = b.transport.uploadImage.bind(b.transport); let calls = 0; const keys: string[] = [];
      b.transport.uploadImage = async (s: string, q: any) => { calls++; keys.push(q.idempotencyKey); const o = await real(s, q); return calls === 1 ? { ok: false, kind: 'NETWORK', retryable: true } : o; };
      const r = await runOnBridge(b, cred.st1);
      expect(r.code).toBe('SUCCESS');
      expect(calls).toBe(2); expect(new Set(keys).size).toBe(1);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, idempotencyKey: keys[0] } })).toBe(1);
      expect((await rowOf(c.body.data.commandId)).status).toBe('UPLOADED');
    }, 20_000);

    it('camera failure: server records FAILED / CAMERA_ERROR with the finer detail; no image', async () => {
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'OTHER');
      const b = await mkBridge(ids.st1, cred.st1); b.provider.injectCaptureFailure();
      expect(await runOnBridge(b, cred.st1)).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_FAILED' });
      expect(await rowOf(c.body.data.commandId)).toMatchObject({ status: 'FAILED', failureCode: 'CAMERA_ERROR', failureDetail: 'CAPTURE_FAILED', tagImageId: null });
    });

    it('slow camera: CAPTURE_TIMEOUT is a camera fault, recorded as such', async () => {
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'OTHER');
      const b = await mkBridge(ids.st1, cred.st1, { captureDelayMs: 300 }, { captureTimeoutMs: 40 });
      expect(await runOnBridge(b, cred.st1)).toMatchObject({ code: 'CAMERA_ERROR', detail: 'CAPTURE_TIMEOUT' });
      expect(await rowOf(c.body.data.commandId)).toMatchObject({ status: 'FAILED', failureCode: 'CAMERA_ERROR', failureDetail: 'CAPTURE_TIMEOUT' });
      await new Promise((r) => setTimeout(r, 350));
    });

    it('tag moved to another branch after the command was issued: the ERP refuses the upload; nothing is stored', async () => {
      const tag = await mkTag(A, 'T-MOVE');
      const c = await command(A, await session(A, tag.id, ids.st1), 'OTHER');
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { branchId: branch2Id } });
      const b = await mkBridge(ids.st1, cred.st1);
      const r = await runOnBridge(b, cred.st1);
      expect(r).toMatchObject({ code: 'UPLOAD_ERROR', detail: 'ERP_REJECTED', imageRetained: false });
      expect(await prisma.tagImage.count({ where: { tagId: tag.id } })).toBe(0);
      expect(await rowOf(c.body.data.commandId)).toMatchObject({ status: 'FAILED', failureCode: 'UPLOAD_ERROR' });
      expect(fs.readdirSync(b.dir)).toEqual([]);
    });

    it('ERP unreachable at upload: recoverable NETWORK_ERROR, image retained only inside the temp area, not claimed as success', async () => {
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'OTHER');
      const b = await mkBridge(ids.st1, cred.st1);
      b.transport.uploadImage = async () => ({ ok: false, kind: 'NETWORK', retryable: true });
      const r = await runOnBridge(b, cred.st1);
      expect(r).toMatchObject({ code: 'NETWORK_ERROR', imageRetained: true });
      expect(fs.readdirSync(b.dir).some((f) => f.endsWith('.png'))).toBe(true);
      expect(await rowOf(c.body.data.commandId)).toMatchObject({ status: 'FAILED', failureCode: 'NETWORK_ERROR' });
    });

    it('a revoked credential mid-flight surfaces as AUTH_ERROR and captures nothing', async () => {
      const own = await mkStation(A, 'STREV2');
      const cr = await issueCred(A, own.id);
      expect((await heartbeat(cr.credential, own.id)).status).toBe(200);
      const t = await mkTag(A, 'T-REV');
      const c = await command(A, await session(A, t.id, own.id), 'OTHER');
      const b = await mkBridge(own.id, cr.credential);
      const out = await b.transport.pollCommand(cr.credential, 0);
      await request(app).post(`${BASE}/stations/${own.id}/credentials/${cr.id}/revoke`).set(authOf(A)).send({});
      let shots = 0; const orig = b.provider.capture.bind(b.provider); b.provider.capture = async (q: any) => { shots++; return orig(q); };
      const r = await b.executor.handle({ ...out.command, stationId: out.command.stationId });
      expect(r.code).toBe('AUTH_ERROR'); expect(shots).toBe(0);
      expect((await rowOf(c.body.data.commandId)).status).toBe('QUEUED');
    });
  });

  // ─────────────────────────── secrets ───────────────────────────
  describe('secrets', () => {
    it('neither the station credential nor any ticket reaches the server or bridge logs', async () => {
      const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(logger, m));
      const c = await command(A, await session(A, ids.tag3, ids.st1), 'OTHER');
      const b = await mkBridge(ids.st1, cred.st1);
      const out = await b.transport.pollCommand(cred.st1, 0);
      await b.executor.handle(out.command);
      // also provoke error paths that log request lines
      await request(app).post(`${BASE}/images`).set(stn(cred.st1)).field('ticket', out.command.ticket).field('imageType', 'SIDE').field('idempotencyKey', 'zzzzzzzz1')
        .attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' });
      const serverLog = spies.flatMap((s) => s.mock.calls.map((a) => a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '))).join('\n');
      const all = serverLog + '\n' + bridgeLines.join('\n');
      for (const secret of Object.values(cred)) expect(all).not.toContain(secret);
      expect(all).not.toContain(out.command.ticket);
      expect(all).not.toContain(out.command.ticket.split('.')[1]);
      void c;
    });
  });

  // ─────────────────────────── RLS ───────────────────────────
  describe('RLS: photography_capture_commands', () => {
    it('is invisible and immutable across companies, and fail-closed with no tenant', async () => {
      const own = (await command(A, await session(A, ids.tag, ids.st2))).body.data.commandId as string;
      await report(cred.st2, own, { status: 'FAILED', code: 'COMMAND_REJECTED' });
      const bTicket = await session(B, ids.tagB, ids.stB);
      const foreign = (await command(B, bTicket)).body.data.commandId as string;
      await withForcedRls(['photography_capture_commands'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows: any[] = await tx.$queryRawUnsafe('SELECT id FROM "photography_capture_commands" WHERE id IN ($1, $2)', own, foreign);
        expect(rows.map((r) => r.id)).toEqual([own]);
        expect(Number(await tx.$executeRawUnsafe('UPDATE "photography_capture_commands" SET "companyId" = "companyId" WHERE id = $1', foreign))).toBe(0);
        expect(Number(await tx.$executeRawUnsafe('DELETE FROM "photography_capture_commands" WHERE id = $1', foreign))).toBe(0);
        await expect(tx.$executeRaw`INSERT INTO photography_capture_commands (id, "companyId", "stationId", "tagId", "requestedById", "sessionId", "correlationId", "imageType", "expiresAt", "updatedAt")
          VALUES (${'rls' + suffix}, ${B.company.id}, ${ids.stB}, ${ids.tagB}, ${B.user.id}, 's', 'c', 'SIDE', now(), now())`).rejects.toThrow(/row-level security|policy/i);
      });
      await withForcedRls(['photography_capture_commands'], async (tx) => {
        const rows: any[] = await tx.$queryRawUnsafe('SELECT id FROM "photography_capture_commands" WHERE id IN ($1, $2)', own, foreign);
        expect(rows).toHaveLength(0);
      });
    });

    it('the database refuses a command that points at another company\'s station or tag (composite FK)', async () => {
      await expect(prisma.photographyCaptureCommand.create({
        data: { companyId: A.company.id, stationId: ids.stB, tagId: ids.tag, requestedById: A.user.id, sessionId: 's', correlationId: 'c', imageType: 'SIDE', expiresAt: new Date(Date.now() + 60_000) },
      })).rejects.toThrow(/foreign key/i);
      await expect(prisma.photographyCaptureCommand.create({
        data: { companyId: A.company.id, stationId: ids.st2, tagId: ids.tagB, requestedById: A.user.id, sessionId: 's', correlationId: 'c', imageType: 'SIDE', expiresAt: new Date(Date.now() + 60_000) },
      })).rejects.toThrow(/foreign key/i);
    });
  });
});
