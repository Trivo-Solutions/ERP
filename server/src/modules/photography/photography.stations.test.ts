import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';
import { MemoryStorageProvider, setStorageProviderForTests } from '../../shared/storage';

// Photography Phase 3.5 — station list API, branch rule, capture-session hardening.
const BASE = '/api/v1/photography';
const PERMS = ['photography:view', 'photography:capture'];

describe('Photography Phase 3.5 — stations & capture sessions', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant; let B: TestTenant;
  const ids: Record<string, string> = {};
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const restrictTo = (t: TestTenant, branchIds: string[]) => ({ ...t, ctx: { ...t.ctx, branchAccess: { allBranches: false, branchIds } } }) as TestTenant;
  const mkTag = (t: TestTenant, num: string, branchId: string) => prisma.jewelryTag.create({
    data: { companyId: t.company.id, tagNumber: `${num}-${suffix}`, branchId, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: t.user.id },
  });
  const mkStation = (t: TestTenant, name: string, branchId: string, isActive = true) =>
    prisma.photographyStation.create({ data: { companyId: t.company.id, branchId, name: `${name}-${suffix}`, isActive, registeredById: t.user.id } });
  const session = (t: TestTenant, body: object) => request(app).post(`${BASE}/capture-sessions`).set(authOf(t)).send(body);

  beforeAll(async () => {
    setStorageProviderForTests(new MemoryStorageProvider());
    A = await createTestTenant(`SA${suffix}`, PERMS);
    B = await createTestTenant(`SB${suffix}`, PERMS);
    const br2 = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `B2${suffix}`, name: 'Second' } as any });
    ids.br2 = br2.id;
    ids.stA1 = (await mkStation(A, 'S1', A.branch.id)).id;
    ids.stA2 = (await mkStation(A, 'S2', br2.id)).id;
    ids.stOff = (await mkStation(A, 'SOFF', A.branch.id, false)).id;
    ids.stB = (await mkStation(B, 'SB', B.branch.id)).id;
    ids.tagA1 = (await mkTag(A, 'T1', A.branch.id)).id;
    ids.tagA2 = (await mkTag(A, 'T2', br2.id)).id;
    ids.tagB = (await mkTag(B, 'TB', B.branch.id)).id;
  }, 60_000);

  afterAll(async () => {
    setStorageProviderForTests(null);
    await prisma.photographyStation.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.jewelryTag.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.branch.deleteMany({ where: { id: ids.br2 } });
    for (const t of [A, B]) { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    await prisma.$disconnect();
  });

  describe('GET /stations', () => {
    it("returns only the caller's company's active stations as a safe DTO", async () => {
      const r = await request(app).get(`${BASE}/stations`).set(authOf(A));
      expect(r.status).toBe(200);
      const got = r.body.data.map((s: any) => s.id).sort();
      expect(got).toEqual([ids.stA1, ids.stA2].sort());
      expect(r.body.data[0]).toEqual(expect.objectContaining({ branchName: expect.any(String), isActive: true, lastSeenAt: null }));
      expect(Object.keys(r.body.data[0]).sort()).toEqual(['branchId', 'branchName', 'cameras', 'id', 'isActive', 'lastSeenAt', 'name']);
      expect(JSON.stringify(r.body)).not.toMatch(/tokenHash|registeredBy|companyId/);
      const rb = await request(app).get(`${BASE}/stations`).set(authOf(B));
      expect(rb.body.data.map((s: any) => s.id)).toEqual([ids.stB]);
    });
    it('a branch-restricted user sees only stations of their branches', async () => {
      const r = await request(app).get(`${BASE}/stations`).set(authOf(restrictTo(A, [ids.br2])));
      expect(r.body.data.map((s: any) => s.id)).toEqual([ids.stA2]);
    });
    it('a client-supplied companyId / branchId cannot widen the result', async () => {
      const q = await request(app).get(`${BASE}/stations?companyId=${B.company.id}&branchId=${ids.br2}`).set(authOf(A));
      expect(q.status).toBe(400);
      const h = await request(app).get(`${BASE}/stations`).set(authOf(A)).set('x-company-id', B.company.id);
      expect(h.status).toBe(200); // unrecognised header is simply ignored
      expect(h.body.data.map((s: any) => s.id).sort()).toEqual([ids.stA1, ids.stA2].sort());
      expect((await request(app).get(`${BASE}/stations`).set(authOf(A)).set('companyId', B.company.id)).status).toBe(400);
    });
    it('requires photography:view', async () => {
      const none = await createTestTenant(`SN${suffix}`, []);
      expect((await request(app).get(`${BASE}/stations`).set(authOf(none))).status).toBe(403);
      await cleanupTestTenant(none); await prisma.user.deleteMany({ where: { email: none.user.email } });
    });
  });

  describe('POST /capture-sessions', () => {
    it('same-branch tag + station → 201 with the full contract and correctly bound ticket', async () => {
      const r = await session(A, { tagId: ids.tagA1, stationId: ids.stA1 });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        stationId: ids.stA1, tagId: ids.tagA1, tagNumber: `T1-${suffix}`, operations: ['upload'], captureSource: 'DEVICE_CAMERA',
        tag: { id: ids.tagA1 }, station: { id: ids.stA1 },
      });
      expect(r.body.data.sessionId).toBeTruthy();
      expect(new Date(r.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(jwt.decode(r.body.data.ticket)).toMatchObject({ cid: A.company.id, tid: ids.tagA1, sid: ids.stA1, uid: A.user.id, sess: r.body.data.sessionId, src: 'DEVICE_CAMERA', ops: ['upload'] });
      expect(JSON.stringify(r.body)).not.toMatch(/secret|bucket|storageKey/i);
    });
    it('different-branch tag + station → rejected, no ticket', async () => {
      const r = await session(A, { tagId: ids.tagA1, stationId: ids.stA2 });
      expect(r.status).toBe(409);
      expect(r.body.data?.ticket).toBeUndefined();
      expect((await session(A, { tagId: ids.tagA2, stationId: ids.stA1 })).status).toBe(409);
      expect((await session(A, { tagId: ids.tagA2, stationId: ids.stA2 })).status).toBe(201);
    });
    it('inactive, unknown, and cross-company station / tag are refused', async () => {
      expect((await session(A, { tagId: ids.tagA1, stationId: ids.stOff })).status).toBe(409);
      expect((await session(A, { tagId: ids.tagA1, stationId: 'nope' })).status).toBe(404);
      expect((await session(A, { tagId: 'nope', stationId: ids.stA1 })).status).toBe(404);
      expect((await session(A, { tagId: ids.tagA1, stationId: ids.stB })).status).toBe(404);
      expect((await session(A, { tagId: ids.tagB, stationId: ids.stA1 })).status).toBe(404);
    });
    it('a user without a grant on the station branch gets the same 404 as a missing station (even if inactive)', async () => {
      const onlyBr1 = restrictTo(A, [A.branch.id]);
      const denied = await session(onlyBr1, { tagId: ids.tagA1, stationId: ids.stA2 });
      const missing = await session(onlyBr1, { tagId: ids.tagA1, stationId: 'nope' });
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(missing.body);
    });
    it('does not touch lastSeenAt (reserved for the bridge heartbeat)', async () => {
      await session(A, { tagId: ids.tagA1, stationId: ids.stA1 });
      expect((await prisma.photographyStation.findUniqueOrThrow({ where: { id: ids.stA1 } })).lastSeenAt).toBeNull();
    });
    it('an ERP access token is not accepted as a capture ticket', async () => {
      const r = await request(app).post(`${BASE}/images`).set(authOf(A)).field('ticket', tokenFor(A)).field('imageType', 'SIDE').field('idempotencyKey', `idem-${suffix}-x`)
        .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 's.jpg', contentType: 'image/jpeg' });
      expect(r.status).toBe(401);
    });
    it('upload re-checks the branch rule if the tag moved after the session started', async () => {
      const tag = await mkTag(A, 'TMV', A.branch.id);
      const t = (await session(A, { tagId: tag.id, stationId: ids.stA1 })).body.data.ticket;
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { branchId: ids.br2 } });
      const r = await request(app).post(`${BASE}/images`).set(authOf(A)).field('ticket', t).field('imageType', 'SIDE').field('idempotencyKey', `idem-${suffix}-mv`)
        .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 's.jpg', contentType: 'image/jpeg' });
      expect(r.status).toBe(409);
      expect(await prisma.tagImage.count({ where: { tagId: tag.id } })).toBe(0);
    });
  });
});
