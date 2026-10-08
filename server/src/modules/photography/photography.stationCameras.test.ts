import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, createMember, addBranch, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';
import { CAMERA_REQUEST_TTL_MS, parseCameraReport, pendingSelection } from './stationCameras';

// Station camera discovery: the Camera Bridge REPORTS its cameras in the heartbeat, an ERP user ASKS for one, the bridge is
// handed the request on its next heartbeat / poll. The browser never talks to a bridge.
const BASE = '/api/v1/photography';
const BRIDGE_TRANSPORT = path.resolve(__dirname, '../../../../camera-bridge/src/erpTransport.ts');
const WEBCAM = 'webcam:cam-10cbddd03f968218b0be759a';
const SONY = 'sony:body-1';
const cam = (id: string, o: object = {}) => ({ id, displayName: 'Integrated Camera', available: true, selected: false, ...o });
const report = (cameras: object[], selectedId: string | null = null, selectionRequired = false) => ({ cameras, selectedId, selectionRequired });

describe('parseCameraReport / pendingSelection (pure)', () => {
  it('accepts a bridge report, cleans display names, drops unknown fields', () => {
    const r = parseCameraReport(report([{ ...cam(WEBCAM, { displayName: '  Integrated\u0007   Camera\n', helperPath: 'C:\\secret\\x.exe', placement: 'integrated' }) }], WEBCAM));
    expect(r.cameras[0]).toEqual({ id: WEBCAM, displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: false, placement: 'integrated' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('rejects a malformed report', () => {
    for (const bad of [null, [], 'x', { cameras: 'no' }, report([cam('nope')]), report([cam('webcam:a b')]), report([{ ...cam(WEBCAM), available: 'yes' }]),
      report([cam(WEBCAM)], 'bad id'), report(Array.from({ length: 17 }, (_, i) => cam(`webcam:c${i}`)))]) {
      expect(() => parseCameraReport(bad)).toThrow();
    }
  });
  it('a request is pending until the bridge reports it selected, and stops being delivered after its TTL', () => {
    const now = Date.now(); const at = new Date(now - 1000);
    expect(pendingSelection({ requestedCameraId: WEBCAM, cameraRequestedAt: at, reportedCameras: report([cam(WEBCAM)]) }, now)).toBe(WEBCAM);
    expect(pendingSelection({ requestedCameraId: WEBCAM, cameraRequestedAt: at, reportedCameras: report([cam(WEBCAM, { selected: true })], WEBCAM) }, now)).toBeNull();
    expect(pendingSelection({ requestedCameraId: WEBCAM, cameraRequestedAt: new Date(now - CAMERA_REQUEST_TTL_MS - 1), reportedCameras: null }, now)).toBeNull();
    expect(pendingSelection({ requestedCameraId: null, cameraRequestedAt: null, reportedCameras: null }, now)).toBeNull();
  });
});

describe('Photography — station camera report & selection (HTTP)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant; let B: TestTenant; let noCap: TestTenant; let branch2Id: string;
  let st: string; let stOther: string; let stB: string; let stBranch2: string;
  const cred: Record<string, string> = {};
  let server: http.Server; let apiUrl: string;
  let HttpErpTransport: new (o: { apiUrl: string }) => { sendHeartbeat(p: object, s: string): Promise<{ ok: boolean; kind?: string; cameraSelection?: string }> };
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const restrictTo = (t: TestTenant, branchIds: string[]) => ({ ...t, ctx: { ...t.ctx, branchAccess: { allBranches: false, branchIds } } }) as TestTenant;
  const hb = (secret: string, stationId: string, cameras?: object) => request(app).post(`${BASE}/stations/heartbeat`).set({ Authorization: `Bearer ${secret}` })
    .send({ stationId, bridgeVersion: '0.1.0', cameraStatus: 'CONNECTED', ...(cameras ? { cameras } : {}) });
  const select = (t: TestTenant, stationId: string, body: object) => request(app).post(`${BASE}/stations/${stationId}/camera-selection`).set(authOf(t)).send(body);
  const poll = (secret: string, wait?: number) => request(app).get(`${BASE}/stations/commands/next${wait !== undefined ? `?waitSeconds=${wait}` : ''}`).set({ Authorization: `Bearer ${secret}` });
  const row = (id: string) => prisma.photographyStation.findUniqueOrThrow({ where: { id } });
  const stationDto = async (t: TestTenant, id: string) => {
    const r = await request(app).get(`${BASE}/stations`).set(authOf(t));
    expect(r.status).toBe(200);
    return (r.body.data as Array<{ id: string; cameras: any }>).find((s) => s.id === id);
  };

  beforeAll(async () => {
    A = await createTestTenant(`CA${suffix}`, ['photography:view', 'photography:capture', 'photography:manage_stations']);
    B = await createTestTenant(`CB${suffix}`, ['photography:view', 'photography:capture', 'photography:manage_stations']);
    const viewOnly = await prisma.role.create({ data: { companyId: A.company.id, name: `VIEW_${suffix}`, displayName: 'View only', permissions: ['photography:view'] } });
    const u = await createMember({ companyId: A.company.id, roleId: viewOnly.id, email: `cam-v-${suffix}@example.com` });
    noCap = { ...A, role: viewOnly, user: u.user, companyUser: u.membership } as TestTenant;
    branch2Id = (await addBranch(A.company.id, suffix)).id;
    const mk = (t: TestTenant, name: string, branchId = t.branch.id) => prisma.photographyStation.create({ data: { companyId: t.company.id, branchId, name: `${name}-${suffix}`, registeredById: t.user.id } }).then((s) => s.id);
    st = await mk(A, 'CAM1'); stOther = await mk(A, 'CAM2'); stB = await mk(B, 'CAMB'); stBranch2 = await mk(A, 'CAMBR2', branch2Id);
    for (const [k, t, id] of [['st', A, st], ['stOther', A, stOther], ['stB', B, stB], ['stBranch2', A, stBranch2]] as const) {
      const r = await request(app).post(`${BASE}/stations/${id}/credentials`).set(authOf(t)).send({});
      expect(r.status).toBe(201);
      cred[k] = r.body.data.credential;
    }
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    HttpErpTransport = (await import(/* @vite-ignore */ BRIDGE_TRANSPORT)).HttpErpTransport;
  }, 90_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    for (const t of [A, B]) {
      await prisma.stationCredential.deleteMany({ where: { companyId: t.company.id } });
      await prisma.photographyStation.deleteMany({ where: { companyId: t.company.id } });
      await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } });
    }
    await prisma.user.deleteMany({ where: { email: `cam-v-${suffix}@example.com` } });
    await prisma.$disconnect();
  });

  describe('heartbeat report', () => {
    it('a station that never reported cameras shows cameras: null (older bridge / no bridge)', async () => {
      expect((await stationDto(A, st))!.cameras).toBeNull();
      expect((await hb(cred.st, st)).status).toBe(200); // a heartbeat WITHOUT cameras is still valid
      expect((await stationDto(A, st))!.cameras).toBeNull();
    });

    it('stores what the bridge reports and the station list returns it (single integrated camera, auto-selected)', async () => {
      const r = await hb(cred.st, st, report([cam(WEBCAM, { selected: true, placement: 'integrated' })], WEBCAM));
      expect(r.status).toBe(200);
      const dto = (await stationDto(A, st))!;
      expect(dto.cameras).toMatchObject({ selectedId: WEBCAM, selectionRequired: false, fresh: true, pendingCameraId: null });
      expect(dto.cameras.cameras).toEqual([{ id: WEBCAM, displayName: 'Integrated Camera', kind: 'webcam', available: true, selected: true, placement: 'integrated' }]);
    });

    it('a malformed report is a 400 and changes nothing', async () => {
      const before = (await row(st)).reportedCameras;
      expect((await hb(cred.st, st, { cameras: [{ id: 'bad' }] })).status).toBe(400);
      expect((await request(app).post(`${BASE}/stations/heartbeat`).set({ Authorization: `Bearer ${cred.st}` })
        .send({ bridgeVersion: '0.1.0', cameraStatus: 'CONNECTED', cameras: report([]), companyId: B.company.id })).status).toBe(400); // a tenant selector is never accepted
      expect((await row(st)).reportedCameras).toEqual(before);
    });

    it('a station can only ever write its OWN row (another company\'s credential cannot touch it)', async () => {
      const before = (await row(st)).reportedCameras;
      await hb(cred.stB, stB, report([cam('webcam:other')]));
      expect((await row(st)).reportedCameras).toEqual(before);
      expect((await row(stB)).reportedCameras).toMatchObject({ cameras: [{ id: 'webcam:other' }] });
      expect(await stationDto(A, stB)).toBeUndefined(); // company A never sees company B's station or cameras
    });

    it('the browser-facing station list never carries a credential or hash', async () => {
      const text = JSON.stringify((await request(app).get(`${BASE}/stations`).set(authOf(A))).body);
      expect(text).not.toMatch(/stn_|tokenHash|credential/i);
    });
  });

  describe('camera selection request', () => {
    it('queues a request for a camera the bridge reported; audited; the bridge gets it on its heartbeat and poll', async () => {
      await hb(cred.stOther, stOther, report([cam(WEBCAM), cam(SONY, { displayName: 'Sony', available: true })], null, true));
      const r = await select(A, stOther, { cameraId: WEBCAM });
      expect(r.status).toBe(202);
      expect(r.body.data).toMatchObject({ stationId: stOther, pendingCameraId: WEBCAM });
      expect((await row(stOther)).requestedCameraId).toBe(WEBCAM);
      expect((await stationDto(A, stOther))!.cameras.pendingCameraId).toBe(WEBCAM);

      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: stOther, tableName: 'photography_stations' }, orderBy: { timestamp: 'desc' } });
      expect(audit).toMatchObject({ userId: A.user.id, companyId: A.company.id, action: 'UPDATE' });
      expect(JSON.stringify(audit!.newValues)).toContain(WEBCAM);

      // a poll returns immediately (no 25 s wait) and carries the request; the heartbeat response carries it too
      const t0 = Date.now();
      const p = await poll(cred.stOther, 20);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(p.body.data).toMatchObject({ command: null, cameraSelection: { cameraId: WEBCAM } });
      const beat = await hb(cred.stOther, stOther, report([cam(WEBCAM), cam(SONY)], null, true));
      expect(beat.body.data.cameraSelection).toEqual({ cameraId: WEBCAM });

      // once the bridge reports it selected, nothing is pending any more
      await hb(cred.stOther, stOther, report([cam(WEBCAM, { selected: true }), cam(SONY)], WEBCAM));
      expect((await poll(cred.stOther, 0)).body.data.cameraSelection).toBeNull();
      expect((await stationDto(A, stOther))!.cameras).toMatchObject({ selectedId: WEBCAM, pendingCameraId: null });
    });

    it('the REAL bridge transport receives the request through the heartbeat answer', async () => {
      await hb(cred.st, st, report([cam(WEBCAM, { selected: true }), cam(SONY)], WEBCAM));
      expect((await select(A, st, { cameraId: SONY })).status).toBe(202);
      const t = new HttpErpTransport({ apiUrl });
      const out = await t.sendHeartbeat({
        stationId: st, bridgeVersion: '0.1.0', cameraState: 'CONNECTED', timestamp: new Date().toISOString(),
        cameras: { cameras: [{ ...cam(WEBCAM, { selected: true }), kind: 'webcam' }, { ...cam(SONY), kind: 'sony' }], selectedId: WEBCAM, selectionRequired: false },
      }, cred.st);
      expect(out).toEqual({ ok: true, cameraSelection: SONY });
    });

    it('refuses a camera the station did not report, an unavailable one, a bad id and extra fields', async () => {
      await hb(cred.st, st, report([cam(WEBCAM, { selected: true }), cam(SONY, { available: false, unavailableReason: 'NOT_CONNECTED' })], WEBCAM));
      const before = (await row(st)).requestedCameraId;
      expect((await select(A, st, { cameraId: 'webcam:never-reported' })).status).toBe(409);
      expect((await select(A, st, { cameraId: SONY })).status).toBe(409);
      expect((await select(A, st, { cameraId: '../../etc' })).status).toBe(400);
      expect((await select(A, st, {})).status).toBe(400);
      expect((await select(A, st, { cameraId: WEBCAM, companyId: B.company.id })).status).toBe(400);
      expect((await select(A, st, { cameraId: WEBCAM, stationId: stB })).status).toBe(400);
      expect((await row(st)).requestedCameraId).toBe(before);
    });

    it('requires photography:capture (403), and a request without a login is 401', async () => {
      expect((await select(noCap, st, { cameraId: WEBCAM })).status).toBe(403);
      expect((await request(app).post(`${BASE}/stations/${st}/camera-selection`).send({ cameraId: WEBCAM })).status).toBe(401);
    });

    it('another company\'s station, a nonexistent one, and a station outside the caller\'s branches are all the same 404', async () => {
      await hb(cred.stB, stB, report([cam(WEBCAM)]));
      const bBefore = (await row(stB)).requestedCameraId;
      expect((await select(A, stB, { cameraId: WEBCAM })).status).toBe(404);   // cross-company
      expect((await select(B, st, { cameraId: WEBCAM })).status).toBe(404);    // the reverse
      expect((await select(A, 'does-not-exist', { cameraId: WEBCAM })).status).toBe(404);
      await hb(cred.stBranch2, stBranch2, report([cam(WEBCAM)]));
      expect((await select(restrictTo(A, [A.branch.id]), stBranch2, { cameraId: WEBCAM })).status).toBe(404); // branch restriction
      expect((await select(restrictTo(A, [branch2Id]), stBranch2, { cameraId: WEBCAM })).status).toBe(202);   // ...but its own branch works
      expect((await row(stB)).requestedCameraId).toBe(bBefore);
    });

    it('a request older than its TTL is no longer delivered to the bridge', async () => {
      await hb(cred.st, st, report([cam(WEBCAM, { selected: true }), cam(SONY)], WEBCAM));
      await prisma.photographyStation.update({ where: { id: st }, data: { requestedCameraId: SONY, cameraRequestedAt: new Date(Date.now() - CAMERA_REQUEST_TTL_MS - 5000) } });
      expect((await poll(cred.st, 0)).body.data.cameraSelection).toBeNull();
      expect((await stationDto(A, st))!.cameras.pendingCameraId).toBeNull();
    });
  });

  it('the database refuses a malformed requested camera id even if the application did not', async () => {
    await expect(prisma.photographyStation.update({ where: { id: st }, data: { requestedCameraId: 'http://evil/' } })).rejects.toBeTruthy();
  });
});
