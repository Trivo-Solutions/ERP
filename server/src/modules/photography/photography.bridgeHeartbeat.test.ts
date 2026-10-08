import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';

// Photography Phase 5C — the REAL Camera Bridge HttpErpTransport against the REAL backend heartbeat endpoint
// (real StationCredential auth, no bypass). The bridge lives outside this package's rootDir, so it is loaded by a
// computed path (invisible to tsc) rather than a static import.
const BASE = '/api/v1/photography';
const BRIDGE_TRANSPORT = path.resolve(__dirname, '../../../../camera-bridge/src/erpTransport.ts');

describe('Photography Phase 5C — bridge transport -> heartbeat endpoint', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant;
  let stationId: string;
  let credential: string;
  let credentialId: string;
  let apiUrl: string;
  let server: http.Server;
  let HttpErpTransport: new (o: { apiUrl: string }) => {
    sendHeartbeat(p: object, secret: string): Promise<{ ok: boolean; kind?: string }>;
  };
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const payload = (over: object = {}) => ({ stationId, bridgeVersion: '0.1.0', cameraState: 'CONNECTED', timestamp: new Date().toISOString(), ...over });
  const seen = () => prisma.photographyStation.findUniqueOrThrow({ where: { id: stationId } }).then((s) => s.lastSeenAt);

  beforeAll(async () => {
    A = await createTestTenant(`BH${suffix}`, ['photography:view', 'photography:manage_stations']);
    stationId = (await prisma.photographyStation.create({
      data: { companyId: A.company.id, branchId: A.branch.id, name: `BH-${suffix}`, registeredById: A.user.id },
    })).id;
    const r = await request(app).post(`${BASE}/stations/${stationId}/credentials`).set(authOf(A)).send({});
    expect(r.status).toBe(201);
    credential = r.body.data.credential; credentialId = r.body.data.id;
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    HttpErpTransport = (await import(/* @vite-ignore */ BRIDGE_TRANSPORT)).HttpErpTransport;
  }, 60_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await prisma.stationCredential.deleteMany({ where: { companyId: A.company.id } });
    await prisma.photographyStation.deleteMany({ where: { companyId: A.company.id } });
    await cleanupTestTenant(A); await prisma.user.deleteMany({ where: { email: A.user.email } });
    await prisma.$disconnect();
  });

  it('accepted heartbeat updates PhotographyStation.lastSeenAt', async () => {
    expect(await seen()).toBeNull();
    const r = await new HttpErpTransport({ apiUrl }).sendHeartbeat(payload(), credential);
    expect(r).toEqual({ ok: true });
    const t1 = await seen();
    expect(t1).not.toBeNull();
    await new Promise((x) => setTimeout(x, 20));
    expect(await new HttpErpTransport({ apiUrl }).sendHeartbeat(payload(), credential)).toEqual({ ok: true });
    expect((await seen())!.getTime()).toBeGreaterThan(t1!.getTime());
  });

  it('a missing / forged credential is AUTH and does not touch lastSeenAt', async () => {
    const before = await seen();
    expect(await new HttpErpTransport({ apiUrl }).sendHeartbeat(payload(), 'stn_nope.' + 'x'.repeat(43))).toEqual({ ok: false, kind: 'AUTH' });
    expect(await seen()).toEqual(before);
  });

  it('a mismatching stationId echo is rejected (REJECTED, not retried) and does not touch lastSeenAt', async () => {
    const before = await seen();
    expect(await new HttpErpTransport({ apiUrl }).sendHeartbeat(payload({ stationId: 'someone-else' }), credential)).toEqual({ ok: false, kind: 'REJECTED' });
    expect(await seen()).toEqual(before);
  });

  it('a revoked credential is AUTH (403) and does not touch lastSeenAt', async () => {
    const before = await seen();
    const rv = await request(app).post(`${BASE}/stations/${stationId}/credentials/${credentialId}/revoke`).set(authOf(A)).send({ reason: 'test' });
    expect(rv.status).toBe(200);
    expect(await new HttpErpTransport({ apiUrl }).sendHeartbeat(payload(), credential)).toEqual({ ok: false, kind: 'AUTH' });
    expect(await seen()).toEqual(before);
  });
});
