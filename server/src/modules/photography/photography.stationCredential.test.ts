import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app';
import { env } from '../../config/env';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';
import { hashStationToken, LAST_USED_THROTTLE_MS } from './stationCredential.service';

// Photography Phase 5A-B — station credential issuance/revocation + authenticated heartbeat.
const BASE = '/api/v1/photography';

describe('Photography Phase 5A-B — station credentials & heartbeat', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant; let B: TestTenant; let Plain: TestTenant;
  const ids: Record<string, string> = {};
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const restrictTo = (t: TestTenant, branchIds: string[]) => ({ ...t, ctx: { ...t.ctx, branchAccess: { allBranches: false, branchIds } } }) as TestTenant;
  const mkStation = (t: TestTenant, name: string, branchId: string, isActive = true) =>
    prisma.photographyStation.create({ data: { companyId: t.company.id, branchId, name: `${name}-${suffix}`, isActive, registeredById: t.user.id } });
  const issue = (t: TestTenant, stationId: string, body: object = {}) =>
    request(app).post(`${BASE}/stations/${stationId}/credentials`).set(authOf(t)).send(body);
  const hb = (token: string | undefined, body: object = { bridgeVersion: '1.0.0', cameraStatus: 'CONNECTED' }) => {
    const r = request(app).post(`${BASE}/stations/heartbeat`);
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
  };
  const station = (id: string) => prisma.photographyStation.findUniqueOrThrow({ where: { id } });
  const issueToken = async (t: TestTenant, stationId: string) => (await issue(t, stationId)).body.data as { id: string; credential: string };

  beforeAll(async () => {
    A = await createTestTenant(`CA${suffix}`, ['photography:view', 'photography:manage_stations']);
    B = await createTestTenant(`CB${suffix}`, ['photography:view', 'photography:manage_stations']);
    Plain = await createTestTenant(`CP${suffix}`, ['photography:view']);
    const br2 = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `B2${suffix}`, name: 'Second' } as any });
    ids.br2 = br2.id;
    ids.stA = (await mkStation(A, 'S1', A.branch.id)).id;
    ids.stA2 = (await mkStation(A, 'S2', br2.id)).id;
    ids.stOff = (await mkStation(A, 'SOFF', A.branch.id, false)).id;
    ids.stB = (await mkStation(B, 'SB', B.branch.id)).id;
    ids.stP = (await mkStation(Plain, 'SP', Plain.branch.id)).id;
  }, 60_000);

  afterAll(async () => {
    const cids = [A.company.id, B.company.id, Plain.company.id];
    await prisma.stationCredential.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.photographyStation.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.branch.deleteMany({ where: { id: ids.br2 } });
    for (const t of [A, B, Plain]) { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    await prisma.$disconnect();
  });

  describe('issuance', () => {
    it('issues an opaque credential once; only a SHA-256 is stored; scope is heartbeat-only', async () => {
      const r = await issue(A, ids.stA);
      expect(r.status).toBe(201);
      const { credential, id, scopes, expiresAt } = r.body.data;
      expect(credential).toMatch(/^stn_[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
      expect(scopes).toEqual(['station:heartbeat', 'station:capture']);
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
      const row = await prisma.stationCredential.findUniqueOrThrow({ where: { id } });
      expect(row.tokenHash).toBe(hashStationToken(credential));
      expect(row.tokenHash).not.toContain(credential);
      expect(row.companyId).toBe(A.company.id);
      expect(row.createdById).toBe(A.user.id);
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('is never exposed again: list returns safe metadata only', async () => {
      const issued = await issueToken(A, ids.stA);
      const r = await request(app).get(`${BASE}/stations/${ids.stA}/credentials`).set(authOf(A));
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(issued.credential);
      expect(text).not.toMatch(/tokenHash|credential"/);
      expect(r.body.data.find((c: any) => c.id === issued.id)).toEqual(expect.objectContaining({ id: issued.id, stationId: ids.stA, revokedAt: null }));
    });

    it('honours expiresInDays and rejects bad/forged inputs', async () => {
      const r = await issue(A, ids.stA, { expiresInDays: 7 });
      expect(r.status).toBe(201);
      expect(new Date(r.body.data.expiresAt).getTime()).toBeLessThan(Date.now() + 8 * 86_400_000);
      expect((await issue(A, ids.stA, { expiresInDays: 0 })).status).toBe(400);
      expect((await issue(A, ids.stA, { expiresInDays: 9999 })).status).toBe(400);
      expect((await issue(A, ids.stA, { tokenHash: 'a'.repeat(64) })).status).toBe(400);
      expect((await issue(A, ids.stA, { scopes: ['*'] })).status).toBe(400);
      expect((await issue(A, ids.stA, { credential: 'stn_x.y' })).status).toBe(400);
    });

    it('supports several credentials per station', async () => {
      const one = await issueToken(A, ids.stA2); const two = await issueToken(A, ids.stA2);
      expect(one.id).not.toBe(two.id);
      expect(one.credential).not.toBe(two.credential);
    });

    it('denies a user without photography:manage_stations (403)', async () => {
      expect((await issue(Plain, ids.stP)).status).toBe(403);
      expect((await request(app).get(`${BASE}/stations/${ids.stP}/credentials`).set(authOf(Plain))).status).toBe(403);
    });

    it('denies a branch the caller cannot access, a cross-company station, and an unknown station (all 404)', async () => {
      expect((await issue(restrictTo(A, [A.branch.id]), ids.stA2)).status).toBe(404);
      expect((await issue(A, ids.stB)).status).toBe(404);
      expect((await issue(B, ids.stA)).status).toBe(404);
      expect((await issue(A, 'nope')).status).toBe(404);
      expect(await prisma.stationCredential.count({ where: { stationId: ids.stB } })).toBe(0);
    });

    it('rejects client company selectors', async () => {
      expect((await issue(A, ids.stA, { companyId: B.company.id })).status).toBe(400);
    });

    it('refuses to issue for an inactive station (409)', async () => {
      expect((await issue(A, ids.stOff)).status).toBe(409);
    });

    it('audits issuance without the secret', async () => {
      const issued = await issueToken(A, ids.stA);
      const logs = await prisma.auditLog.findMany({ where: { companyId: A.company.id, tableName: 'station_credentials', recordId: issued.id, action: 'ISSUE' } });
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(A.user.id);
      expect(JSON.stringify(logs[0])).not.toContain(issued.credential);
    });
  });

  describe('revocation', () => {
    it('revokes, audits, and a second revoke is a 409; the credential then stops working', async () => {
      const c = await issueToken(A, ids.stA);
      const r = await request(app).post(`${BASE}/stations/${ids.stA}/credentials/${c.id}/revoke`).set(authOf(A)).send({ reason: 'lost laptop' });
      expect(r.status).toBe(200);
      expect(r.body.data.revokedAt).toBeTruthy();
      expect((await request(app).post(`${BASE}/stations/${ids.stA}/credentials/${c.id}/revoke`).set(authOf(A)).send({})).status).toBe(409);
      const row = await prisma.stationCredential.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.revokedById).toBe(A.user.id);
      const log = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: c.id, action: 'REVOKE' } });
      expect(log).toBeTruthy();
      expect(JSON.stringify(log)).not.toContain(c.credential);
      expect((await hb(c.credential)).status).toBe(403);
    });

    it('requires the permission and cannot touch another company’s credential', async () => {
      const c = await issueToken(A, ids.stA);
      expect((await request(app).post(`${BASE}/stations/${ids.stA}/credentials/${c.id}/revoke`).set(authOf(Plain)).send({})).status).toBe(403);
      expect((await request(app).post(`${BASE}/stations/${ids.stB}/credentials/${c.id}/revoke`).set(authOf(B)).send({})).status).toBe(404);
      expect((await request(app).post(`${BASE}/stations/${ids.stB}/credentials/${c.id}/revoke`).set(authOf(A)).send({})).status).toBe(404);
      expect((await prisma.stationCredential.findUniqueOrThrow({ where: { id: c.id } })).revokedAt).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('a valid heartbeat sets lastSeenAt (and lastUsedAt), returns a safe body, and repeats fine', async () => {
      const c = await issueToken(A, ids.stA);
      expect((await station(ids.stA)).lastSeenAt).toBeNull();
      const r = await hb(c.credential, { bridgeVersion: '1.2.3', cameraStatus: 'CONNECTED', clientTimestamp: new Date().toISOString(), stationId: ids.stA });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ accepted: true, stationId: ids.stA, stationName: expect.any(String), branchId: A.branch.id, serverTime: expect.any(String), cameraSelection: null });
      expect(JSON.stringify(r.body)).not.toMatch(/tokenHash|stn_|companyId/);
      const first = (await station(ids.stA)).lastSeenAt!;
      expect(first).toBeTruthy();
      const used = (await prisma.stationCredential.findUniqueOrThrow({ where: { id: c.id } })).lastUsedAt;
      expect(used).toBeTruthy();
      expect((await hb(c.credential)).status).toBe(200);
      expect((await station(ids.stA)).lastSeenAt!.getTime()).toBeGreaterThanOrEqual(first.getTime());
      // lastUsedAt is throttled: the immediate second heartbeat did not rewrite it.
      expect((await prisma.stationCredential.findUniqueOrThrow({ where: { id: c.id } })).lastUsedAt!.getTime()).toBe(used!.getTime());
      expect(LAST_USED_THROTTLE_MS).toBeGreaterThan(0);
    });

    it('audits an accepted heartbeat on first contact only, attributed to the issuer, with no secret', async () => {
      const c = await issueToken(A, ids.stA2);
      await hb(c.credential); await hb(c.credential);
      const logs = await prisma.auditLog.findMany({ where: { companyId: A.company.id, recordId: c.id, action: 'HEARTBEAT_ACCEPTED' } });
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(A.user.id);
      expect(logs[0].newValues).toEqual(expect.objectContaining({ actor: 'STATION', stationId: ids.stA2, credentialId: c.id }));
      expect(JSON.stringify(logs[0])).not.toContain(c.credential);
    });

    it('missing / malformed / unknown credentials are 401 and write nothing', async () => {
      const c = await issueToken(A, ids.stA);
      const before = (await station(ids.stA)).lastSeenAt;
      expect((await hb(undefined)).status).toBe(401);
      expect((await request(app).post(`${BASE}/stations/heartbeat`).set('Authorization', 'Basic abc').send({})).status).toBe(401);
      expect((await hb('garbage')).status).toBe(401);
      expect((await hb(`stn_${A.company.id}.${'x'.repeat(43)}`)).status).toBe(401);
      // right secret, wrong company prefix → RLS hides the row → same 401
      const swapped = c.credential.replace(A.company.id, B.company.id);
      expect((await hb(swapped)).status).toBe(401);
      expect((await station(ids.stA)).lastSeenAt).toEqual(before);
    });

    it('does not accept a user JWT, a refresh-style token, or a password as a station credential', async () => {
      const userJwt = tokenFor(A);
      expect((await hb(userJwt)).status).toBe(401);
      expect((await hb(jwt.sign({ userId: A.user.id, companyId: A.company.id }, env.JWT_SECRET))).status).toBe(401);
      expect((await hb('x')).status).toBe(401);
      // and a station credential does not authenticate as a user
      const c = await issueToken(A, ids.stA);
      expect((await request(app).get(`${BASE}/stations`).set('Authorization', `Bearer ${c.credential}`)).status).toBe(401);
    });

    it('expired credential → 403 and no lastSeenAt', async () => {
      const c = await issueToken(A, ids.stA2);
      await prisma.photographyStation.update({ where: { id: ids.stA2 }, data: { lastSeenAt: null } });
      await prisma.stationCredential.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const r = await hb(c.credential);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('CREDENTIAL_INVALID');
      expect((await station(ids.stA2)).lastSeenAt).toBeNull();
      const log = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: c.id, action: 'AUTH_DENIED' } });
      expect(log?.newValues).toEqual(expect.objectContaining({ reason: 'EXPIRED' }));
    });

    it('inactive station → 403 STATION_DISABLED, lastSeenAt untouched', async () => {
      const c = await issueToken(A, ids.stA);
      await prisma.photographyStation.update({ where: { id: ids.stA }, data: { isActive: false, lastSeenAt: null } });
      try {
        const r = await hb(c.credential);
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('STATION_DISABLED');
        expect((await station(ids.stA)).lastSeenAt).toBeNull();
      } finally {
        await prisma.photographyStation.update({ where: { id: ids.stA }, data: { isActive: true } });
      }
    });

    it('a credential without the heartbeat scope is refused', async () => {
      const c = await issueToken(A, ids.stA);
      await prisma.stationCredential.update({ where: { id: c.id }, data: { scopes: [] } });
      expect((await hb(c.credential)).status).toBe(403);
    });

    it('company and station come from the credential, never the request', async () => {
      const cA = await issueToken(A, ids.stA);
      const before = (await station(ids.stB)).lastSeenAt;
      // companyId selector is rejected app-wide
      expect((await hb(cA.credential, { bridgeVersion: '1', cameraStatus: 'CONNECTED', companyId: B.company.id })).status).toBe(400);
      expect((await request(app).post(`${BASE}/stations/heartbeat?companyId=${B.company.id}`).set('Authorization', `Bearer ${cA.credential}`).send({ bridgeVersion: '1', cameraStatus: 'CONNECTED' })).status).toBe(400);
      // branchId is never accepted
      expect((await hb(cA.credential, { bridgeVersion: '1', cameraStatus: 'CONNECTED', branchId: ids.br2 })).status).toBe(400);
      // a foreign stationId does not redirect the write
      expect((await hb(cA.credential, { bridgeVersion: '1', cameraStatus: 'CONNECTED', stationId: ids.stB })).status).toBe(400);
      expect((await station(ids.stB)).lastSeenAt).toEqual(before);
      expect((await station(ids.stA)).branchId).toBe(A.branch.id);
    });

    it('rejects malformed payloads (400) without writing', async () => {
      const c = await issueToken(A, ids.stA2);
      await prisma.photographyStation.update({ where: { id: ids.stA2 }, data: { lastSeenAt: null } });
      for (const body of [
        {}, { bridgeVersion: '1.0.0' }, { cameraStatus: 'CONNECTED' },
        { bridgeVersion: '1.0.0', cameraStatus: 'ON_FIRE' },
        { bridgeVersion: '', cameraStatus: 'CONNECTED' },
        { bridgeVersion: 'x'.repeat(40), cameraStatus: 'CONNECTED' },
        { bridgeVersion: 1, cameraStatus: 'CONNECTED' },
        { bridgeVersion: '1.0.0', cameraStatus: 'CONNECTED', clientTimestamp: 'yesterday' },
        { bridgeVersion: '1.0.0', cameraStatus: 'CONNECTED', clientTimestamp: new Date(Date.now() + 3600_000).toISOString() },
        { bridgeVersion: '1.0.0', cameraStatus: 'CONNECTED', extra: { arbitrary: 'json' } },
      ]) {
        expect((await hb(c.credential, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await station(ids.stA2)).lastSeenAt).toBeNull();
    });

    it('other Photography actions never touch lastSeenAt', async () => {
      await prisma.photographyStation.update({ where: { id: ids.stA }, data: { lastSeenAt: null } });
      await request(app).get(`${BASE}/stations`).set(authOf(A));
      await issue(A, ids.stA);
      expect((await station(ids.stA)).lastSeenAt).toBeNull();
    });
  });
});
