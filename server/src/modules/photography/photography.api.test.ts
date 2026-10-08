import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app';
import { env } from '../../config/env';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';
import { MemoryStorageProvider, setStorageProviderForTests } from '../../shared/storage';
import { issueCaptureTicket } from './captureTicket';
import { readImageDimensions } from './imageDimensions';

// Photography Phase 2 — HTTP-level tests against the real app + real DB, with the in-memory StorageProvider (the
// MinIO provider has its own smoke test; Photography code is provider-independent by design).
const PERMS = ['photography:view', 'photography:capture', 'photography:delete'];
const BASE = '/api/v1/photography';

/** A syntactically valid JPEG header (SOI, JFIF, SOF0 with real dimensions) + filler; `seed` makes the bytes — and hash — unique. */
function jpeg(seed: string, w = 640, h = 480): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, sof, Buffer.from(seed), Buffer.from([0xff, 0xd9])]);
}

describe('Photography Phase 2 — backend APIs', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const mem = new MemoryStorageProvider();
  let A: TestTenant; let B: TestTenant; let noPerm: TestTenant;
  const ids: Record<string, string> = {};
  let n = 0;
  const idem = () => `idem-${suffix}-${n++}`;
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });

  const mkTag = (t: TestTenant, num: string, branchId = t.branch.id) => prisma.jewelryTag.create({
    data: { companyId: t.company.id, tagNumber: `${num}-${suffix}`, branchId, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: t.user.id },
  });
  async function session(t: TestTenant, tagId: string, stationId: string, extra: object = {}) {
    return request(app).post(`${BASE}/capture-sessions`).set(authOf(t)).send({ tagId, stationId, ...extra });
  }
  async function ticketFor(t: TestTenant, tagId: string, stationId: string): Promise<string> {
    const r = await session(t, tagId, stationId);
    expect(r.status).toBe(201);
    return r.body.data.ticket;
  }
  function upload(t: TestTenant, fields: Record<string, string>, file: Buffer | null, opts: { filename?: string; contentType?: string } = {}) {
    let r = request(app).post(`${BASE}/images`).set(authOf(t));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach('file', file, { filename: opts.filename ?? 'shot.jpg', contentType: opts.contentType ?? 'image/jpeg' });
    return r;
  }
  const up = async (t: TestTenant, ticket: string, over: Record<string, string> = {}, file = jpeg(`s${n}`), opts = {}) =>
    upload(t, { ticket, imageType: 'SIDE', idempotencyKey: idem(), ...over }, file, opts);

  beforeAll(async () => {
    setStorageProviderForTests(mem);
    A = await createTestTenant(`PA${suffix}`, PERMS);
    B = await createTestTenant(`PB${suffix}`, PERMS);
    noPerm = await createTestTenant(`PN${suffix}`, ['photography:view']); // view only
    ids.tagA = (await mkTag(A, 'TA')).id;
    ids.tagB = (await mkTag(B, 'TB')).id;
    ids.stA = (await prisma.photographyStation.create({ data: { companyId: A.company.id, branchId: A.branch.id, name: `ST-A-${suffix}`, registeredById: A.user.id } })).id;
    ids.stA2 = (await prisma.photographyStation.create({ data: { companyId: A.company.id, branchId: A.branch.id, name: `ST-A2-${suffix}`, registeredById: A.user.id } })).id;
    ids.stOff = (await prisma.photographyStation.create({ data: { companyId: A.company.id, branchId: A.branch.id, name: `ST-OFF-${suffix}`, isActive: false, registeredById: A.user.id } })).id;
    ids.stB = (await prisma.photographyStation.create({ data: { companyId: B.company.id, branchId: B.branch.id, name: `ST-B-${suffix}`, registeredById: B.user.id } })).id;
    ids.tagN = (await mkTag(noPerm, 'TN')).id;
    ids.stN = (await prisma.photographyStation.create({ data: { companyId: noPerm.company.id, branchId: noPerm.branch.id, name: `ST-N-${suffix}`, registeredById: noPerm.user.id } })).id;
  }, 60_000);

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => {
    setStorageProviderForTests(null);
    for (const t of [A, B, noPerm]) { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    await prisma.$disconnect();
  });

  // ── tag lookup ──
  describe('tag lookup', () => {
    it('finds a tag of its own company by number, with a photography summary', async () => {
      const r = await request(app).get(`${BASE}/tags/${encodeURIComponent(`TA-${suffix}`)}`).set(authOf(A));
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ id: ids.tagA, tagNumber: `TA-${suffix}`, branch: { id: A.branch.id }, photography: { imageCount: 0, hasPrimary: false } });
    });
    it("company B cannot see company A's tag (same 404 as a missing tag)", async () => {
      const cross = await request(app).get(`${BASE}/tags/${encodeURIComponent(`TA-${suffix}`)}`).set(authOf(B));
      const missing = await request(app).get(`${BASE}/tags/NOPE-${suffix}`).set(authOf(B));
      expect(cross.status).toBe(404);
      expect(cross.body).toEqual(missing.body);
    });
    it('a user whose branch grants do not include the tag branch gets 404', async () => {
      const other = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `OB${suffix}`, name: 'Other' } as any });
      const restricted = { ...A, ctx: { ...A.ctx, branchAccess: { allBranches: false, branchIds: [other.id] } } } as TestTenant;
      const r = await request(app).get(`${BASE}/tags/${encodeURIComponent(`TA-${suffix}`)}`).set(authOf(restricted));
      expect(r.status).toBe(404);
      await prisma.branch.delete({ where: { id: other.id } });
    });
    it('requires photography:view', async () => {
      const none = await createTestTenant(`PX${suffix}`, []);
      const r = await request(app).get(`${BASE}/tags/x`).set(authOf(none));
      expect(r.status).toBe(403);
      await cleanupTestTenant(none); await prisma.user.deleteMany({ where: { email: none.user.email } });
    });
  });

  // ── capture session / ticket ──
  describe('capture session', () => {
    it('issues a short-lived scoped ticket for a valid tag + station', async () => {
      const r = await session(A, ids.tagA, ids.stA);
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({ operations: ['upload'], captureSource: 'DEVICE_CAMERA', tag: { id: ids.tagA }, station: { id: ids.stA } });
      expect(r.body.data.expiresInSeconds).toBeLessThanOrEqual(900);
      const claims = jwt.decode(r.body.data.ticket) as any;
      expect(claims).toMatchObject({ cid: A.company.id, tid: ids.tagA, sid: ids.stA, uid: A.user.id });
      expect(r.headers['cache-control']).toBe('no-store');
    });
    it('rejects a tag or station of another company (404), an inactive station (409), a missing id (400)', async () => {
      expect((await session(A, ids.tagB, ids.stA)).status).toBe(404);
      expect((await session(A, ids.tagA, ids.stB)).status).toBe(404);
      expect((await session(B, ids.tagA, ids.stB)).status).toBe(404);
      expect((await session(A, ids.tagA, ids.stOff)).status).toBe(409);
      expect((await session(A, ids.tagA, 'nope')).status).toBe(404);
      expect((await request(app).post(`${BASE}/capture-sessions`).set(authOf(A)).send({ stationId: ids.stA })).status).toBe(400);
      expect((await session(A, ids.tagA, ids.stA, { captureSource: 'SONY' })).status).toBe(400);
    });
    it('requires photography:capture, and refuses a client-supplied companyId', async () => {
      expect((await session(noPerm, ids.tagN, ids.stN)).status).toBe(403);
      expect((await session(A, ids.tagA, ids.stA, { companyId: B.company.id })).status).toBe(400);
    });
  });

  // ── ticket security on upload ──
  describe('ticket security', () => {
    it('rejects an expired ticket', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60 * 1000 });
      const r = await up(A, ticket);
      vi.useRealTimers();
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/expired/i);
    });
    it('rejects garbage, a missing ticket, and an ACCESS token used as a ticket', async () => {
      expect((await up(A, 'not-a-ticket')).status).toBe(401);
      expect((await up(A, '')).status).toBe(400);
      expect((await up(A, tokenFor(A))).status).toBe(401);
    });
    it("rejects company A's ticket presented by company B (and B's ticket by A)", async () => {
      const ticketA = await ticketFor(A, ids.tagA, ids.stA);
      const r = await up(B, ticketA);
      expect(r.status).toBe(401);
      expect(await prisma.tagImage.count({ where: { companyId: B.company.id } })).toBe(0);
      const forged = issueCaptureTicket({ cid: B.company.id, tid: ids.tagA, sid: ids.stA, uid: A.user.id, src: 'DEVICE_CAMERA' }).ticket;
      expect((await up(A, forged)).status).toBe(401); // company in ticket != caller's company
    });
    it("rejects another user's ticket in the same company", async () => {
      const t = issueCaptureTicket({ cid: A.company.id, tid: ids.tagA, sid: ids.stA, uid: 'someone-else', src: 'DEVICE_CAMERA' }).ticket;
      expect((await up(A, t)).status).toBe(401);
    });
    it('rejects a ticket used for a different tag or station than it names', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const tag2 = await mkTag(A, 'TA2');
      expect((await up(A, ticket, { tagId: tag2.id })).status).toBe(403);
      expect((await up(A, ticket, { stationId: ids.stA2 })).status).toBe(403);
    });
    it('rechecks the station on upload: deactivated mid-session → 409', async () => {
      const st = await prisma.photographyStation.create({ data: { companyId: A.company.id, branchId: A.branch.id, name: `ST-MID-${suffix}`, registeredById: A.user.id } });
      const ticket = await ticketFor(A, ids.tagA, st.id);
      await prisma.photographyStation.update({ where: { id: st.id }, data: { isActive: false } });
      expect((await up(A, ticket)).status).toBe(409);
    });
    it('requires photography:capture even with a valid ticket, and refuses client company selectors in the form', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const v = await createTestTenant(`PV${suffix}`, ['photography:view']);
      expect((await up(v, ticket)).status).toBe(403);
      await cleanupTestTenant(v); await prisma.user.deleteMany({ where: { email: v.user.email } });
      const r = await up(A, ticket, { companyId: B.company.id });
      expect(r.status).toBe(400);
    });
  });

  // ── upload ──
  describe('upload', () => {
    it('stores a valid image and creates the TagImage with authoritative metadata', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const bytes = jpeg('valid-one', 800, 600);
      const key = idem();
      const r = await up(A, ticket, { idempotencyKey: key, imageType: 'SIDE', cameraLabel: 'Bench cam 1' }, bytes, { filename: 'C:\\fakepath\\IMG_0001.JPG' });
      expect(r.status).toBe(201);
      const row = await prisma.tagImage.findFirstOrThrow({ where: { companyId: A.company.id, idempotencyKey: key } });
      const sha = (await import('crypto')).createHash('sha256').update(bytes).digest('hex');
      expect(row).toMatchObject({
        tagId: ids.tagA, imageType: 'SIDE', isPrimary: false, uploadStatus: 'CONFIRMED', processingStatus: 'FAILED' /* header-only fixture is not a decodable image */, reviewStatus: 'CAPTURED',
        mimeType: 'image/jpeg', width: 800, height: 600, sha256: sha, stationId: ids.stA, capturedById: A.user.id,
        captureSource: 'DEVICE_CAMERA', cameraLabel: 'Bench cam 1', originalFilename: 'IMG_0001.JPG',
      });
      expect(Number(row.sizeBytes)).toBe(bytes.length);
      // key: company + tag + image id, no branch / filename / station / user
      expect(row.storageKeyOriginal).toBe(`companies/${A.company.id}/photography/tags/${ids.tagA}/images/${row.id}/original.jpg`);
      expect(mem.objects.get(row.storageKeyOriginal!)?.data.equals(bytes)).toBe(true);
      expect(row.storageKeyOriginal).not.toMatch(new RegExp(`${A.branch.id}|IMG_0001|${A.user.id}|ST-A`));
      // response: metadata only
      expect(JSON.stringify(r.body)).not.toMatch(/companies\/|storageKey/);
      expect(r.body.data.image).toMatchObject({ id: row.id, sha256: sha, width: 800, height: 600, uploadStatus: 'CONFIRMED', variants: { original: true } });
      // audit: CAPTURE with the right actor + company
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: A.company.id, tableName: 'tag_images', recordId: row.id, action: 'CAPTURE' } });
      expect(audit.userId).toBe(A.user.id);
    });
    it('rejects bytes that are not an image even when declared as JPEG (415), and writes nothing', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const before = await prisma.tagImage.count({ where: { companyId: A.company.id } });
      const objs = mem.objects.size;
      const r = await up(A, ticket, {}, Buffer.from('<?php echo 1; ?> this is not an image'));
      expect(r.status).toBe(415);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id } })).toBe(before);
      expect(mem.objects.size).toBe(objs);
    });
    it('rejects an unsupported or mismatching declared MIME type / extension (415)', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      expect((await up(A, ticket, {}, jpeg('m1'), { contentType: 'image/gif' })).status).toBe(415);
      expect((await up(A, ticket, {}, jpeg('m2'), { contentType: 'text/plain' })).status).toBe(415);
      expect((await up(A, ticket, {}, jpeg('m3'), { filename: 'shot.png' })).status).toBe(415);
      expect((await up(A, ticket, {}, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]), { contentType: 'image/gif', filename: 'a.gif' })).status).toBe(415);
      // octet-stream is "undeclared": the real format is still sniffed and accepted
      expect((await up(A, ticket, {}, jpeg('m4'), { contentType: 'application/octet-stream' })).status).toBe(201);
    });
    it('rejects an oversized image (413) and an empty/missing file (400)', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const big = Buffer.concat([jpeg('big'), Buffer.alloc(env.PHOTO_MAX_UPLOAD_BYTES)]);
      expect((await up(A, ticket, {}, big)).status).toBe(413);
      expect((await up(A, ticket, {}, Buffer.alloc(0))).status).toBe(400);
      expect((await upload(A, { ticket, imageType: 'SIDE', idempotencyKey: idem() }, null)).status).toBe(400);
    });
    it('validates imageType and idempotencyKey', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      expect((await up(A, ticket, { imageType: 'SELFIE' })).status).toBe(400);
      expect((await up(A, ticket, { idempotencyKey: 'short' })).status).toBe(400);
      expect((await upload(A, { ticket, imageType: 'SIDE' }, jpeg('nokey'))).status).toBe(400);
    });
    it('supports every image type', async () => {
      const tag = await mkTag(A, 'TTYPES');
      const ticket = await ticketFor(A, tag.id, ids.stA);
      for (const imageType of ['PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER']) {
        expect((await up(A, ticket, { imageType }, jpeg(`type-${imageType}`))).status, imageType).toBe(201);
      }
    });
  });

  // ── idempotency ──
  describe('idempotency', () => {
    it('a retried upload returns the same image and creates no duplicate row or object', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA);
      const bytes = jpeg('idem-1'); const key = idem();
      const first = await up(A, ticket, { idempotencyKey: key }, bytes);
      const objs = mem.objects.size;
      const second = await up(A, ticket, { idempotencyKey: key }, bytes);
      expect(first.status).toBe(201); expect(second.status).toBe(200);
      expect(second.body.data.idempotentReplay).toBe(true);
      expect(second.body.data.image.id).toBe(first.body.data.image.id);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, idempotencyKey: key } })).toBe(1);
      expect(mem.objects.size).toBe(objs);
    });
    it('the same key with different bytes, or for another tag, is a 409 and changes nothing', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA); const key = idem();
      const first = await up(A, ticket, { idempotencyKey: key }, jpeg('idem-2'));
      expect((await up(A, ticket, { idempotencyKey: key }, jpeg('idem-2-different'))).status).toBe(409);
      const tag2 = await mkTag(A, 'TIDEM2');
      const t2 = await ticketFor(A, tag2.id, ids.stA);
      expect((await up(A, t2, { idempotencyKey: key }, jpeg('idem-2'))).status).toBe(409);
      const row = await prisma.tagImage.findUniqueOrThrow({ where: { id: first.body.data.image.id } });
      expect(row.uploadStatus).toBe('CONFIRMED');
    });
    it("one company's idempotency key does not collide with another company's", async () => {
      const key = idem();
      const a = await up(A, await ticketFor(A, ids.tagA, ids.stA), { idempotencyKey: key }, jpeg('iso'));
      const b = await up(B, await ticketFor(B, ids.tagB, ids.stB), { idempotencyKey: key }, jpeg('iso'));
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      expect(b.body.data.image.id).not.toBe(a.body.data.image.id);
    });
    it('a storage failure leaves a FAILED row and a retry with the same key completes it (no duplicate row)', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA); const key = idem(); const bytes = jpeg('idem-fail');
      const spy = vi.spyOn(mem, 'put').mockRejectedValueOnce(new Error('bucket down'));
      const failed = await up(A, ticket, { idempotencyKey: key }, bytes);
      expect(failed.status).toBe(502);
      expect(JSON.stringify(failed.body)).not.toMatch(/bucket down/);
      const row1 = await prisma.tagImage.findFirstOrThrow({ where: { companyId: A.company.id, idempotencyKey: key } });
      expect(row1).toMatchObject({ uploadStatus: 'FAILED', storageKeyOriginal: null });
      spy.mockRestore();
      const retry = await up(A, ticket, { idempotencyKey: key }, bytes);
      expect(retry.status).toBe(201);
      expect(retry.body.data.image.id).toBe(row1.id);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, idempotencyKey: key } })).toBe(1);
    });
    it('a PENDING row left by a crash is resumed by a retry', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA); const key = idem(); const bytes = jpeg('idem-pending');
      const pending = await prisma.tagImage.create({ data: {
        companyId: A.company.id, tagId: ids.tagA, imageType: 'OTHER', isPrimary: false, mimeType: 'image/jpeg', idempotencyKey: key,
        captureSource: 'DEVICE_CAMERA', capturedById: A.user.id, capturedAt: new Date(),
      } });
      const r = await up(A, ticket, { idempotencyKey: key, imageType: 'BACK' }, bytes);
      expect(r.status).toBe(201);
      expect(r.body.data.image).toMatchObject({ id: pending.id, uploadStatus: 'CONFIRMED', imageType: 'BACK' });
    });
    it('concurrent identical uploads produce one image', async () => {
      const ticket = await ticketFor(A, ids.tagA, ids.stA); const key = idem(); const bytes = jpeg('idem-race');
      const rs = await Promise.all([1, 2, 3].map(() => up(A, ticket, { idempotencyKey: key }, bytes)));
      expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.body.data.image.id)).size).toBe(1);
      expect(await prisma.tagImage.count({ where: { companyId: A.company.id, idempotencyKey: key } })).toBe(1);
    });
  });

  // ── primary ──
  describe('primary image', () => {
    const livePrimaries = (tagId: string) => prisma.tagImage.findMany({ where: { tagId, isPrimary: true, deletedAt: null } });

    it('a new PRIMARY atomically replaces the old one, which is kept (as OTHER) with its object', async () => {
      const tag = await mkTag(A, 'TPRIM1');
      const ticket = await ticketFor(A, tag.id, ids.stA);
      const p1 = await up(A, ticket, { imageType: 'PRIMARY' }, jpeg('prim-1'));
      expect(p1.body.data.replacedPrimaryImageId).toBeNull();
      const p2 = await up(A, ticket, { imageType: 'PRIMARY' }, jpeg('prim-2'));
      expect(p2.status).toBe(201);
      expect(p2.body.data.replacedPrimaryImageId).toBe(p1.body.data.image.id);
      const live = await livePrimaries(tag.id);
      expect(live.map((i) => i.id)).toEqual([p2.body.data.image.id]);
      const old = await prisma.tagImage.findUniqueOrThrow({ where: { id: p1.body.data.image.id } });
      expect(old).toMatchObject({ isPrimary: false, imageType: 'OTHER', deletedAt: null, uploadStatus: 'CONFIRMED' });
      expect(mem.objects.has(old.storageKeyOriginal!)).toBe(true);
      expect(await prisma.auditLog.count({ where: { companyId: A.company.id, recordId: old.id, action: 'REPLACE' } })).toBe(1);
    });
    it('concurrent PRIMARY uploads leave exactly one live primary', async () => {
      const tag = await mkTag(A, 'TPRIM2');
      const ticket = await ticketFor(A, tag.id, ids.stA);
      const rs = await Promise.all([1, 2, 3].map((i) => up(A, ticket, { imageType: 'PRIMARY' }, jpeg(`prim-race-${i}`))));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(await livePrimaries(tag.id)).toHaveLength(1);
      expect(await prisma.tagImage.count({ where: { tagId: tag.id, uploadStatus: 'CONFIRMED', deletedAt: null } })).toBe(3);
    });
    it('a failed PRIMARY upload does not disturb the existing primary', async () => {
      const tag = await mkTag(A, 'TPRIM3');
      const ticket = await ticketFor(A, tag.id, ids.stA);
      const p1 = await up(A, ticket, { imageType: 'PRIMARY' }, jpeg('prim-keep'));
      vi.spyOn(mem, 'put').mockRejectedValueOnce(new Error('down'));
      expect((await up(A, ticket, { imageType: 'PRIMARY' }, jpeg('prim-fail'))).status).toBe(502);
      expect((await livePrimaries(tag.id)).map((i) => i.id)).toEqual([p1.body.data.image.id]);
    });
  });

  // ── list / signed URL / delete ──
  describe('list, signed URL and delete', () => {
    let imageId: string; let tagId: string;
    beforeAll(async () => {
      tagId = (await mkTag(A, 'TREAD')).id;
      const r = await up(A, await ticketFor(A, tagId, ids.stA), { imageType: 'PRIMARY' }, jpeg('read-1'));
      imageId = r.body.data.image.id;
    });

    it('lists metadata only, and never another company\'s images', async () => {
      const r = await request(app).get(`${BASE}/tags/${tagId}/images`).set(authOf(A));
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0]).toMatchObject({ id: imageId, imageType: 'PRIMARY', isPrimary: true, station: { id: ids.stA }, width: 640, height: 480 });
      expect(JSON.stringify(r.body)).not.toMatch(/companies\/|storageKey|bucket/i);
      expect((await request(app).get(`${BASE}/tags/${tagId}/images`).set(authOf(B))).status).toBe(404);
    });
    it('issues a short-lived signed URL to the owning tenant only', async () => {
      const r = await request(app).get(`${BASE}/images/${imageId}/url`).set(authOf(A));
      expect(r.status).toBe(200);
      expect(r.body.data.expiresInSeconds).toBeGreaterThan(0);
      expect(r.body.data.expiresInSeconds).toBeLessThanOrEqual(900);
      expect(decodeURIComponent(r.body.data.url)).toContain(`companies/${A.company.id}/photography/`);
      expect(r.headers['cache-control']).toBe('no-store');
      const foreign = await request(app).get(`${BASE}/images/${imageId}/url`).set(authOf(B));
      expect(foreign.status).toBe(404);
      expect(JSON.stringify(foreign.body)).not.toContain(A.company.id);
      expect((await request(app).get(`${BASE}/images/${imageId}/url?variant=thumbnail`).set(authOf(A))).status).toBe(404); // not generated yet
      expect((await request(app).get(`${BASE}/images/${imageId}/url?variant=../../etc`).set(authOf(A))).status).toBe(400);
      expect((await request(app).get(`${BASE}/images/nope/url`).set(authOf(A))).status).toBe(404);
    });
    it('delete needs photography:delete and a reason; another tenant gets 404 and nothing changes', async () => {
      const del = (t: TestTenant, body: object) => request(app).delete(`${BASE}/images/${imageId}`).set(authOf(t)).send(body);
      expect((await del(noPerm, { reason: 'wrong tag photographed' })).status).toBe(403);
      expect((await del(A, {})).status).toBe(400);
      expect((await del(B, { reason: 'attack attempt' })).status).toBe(404);
      expect((await prisma.tagImage.findUniqueOrThrow({ where: { id: imageId } })).deletedAt).toBeNull();
    });
    it('soft-deletes: row and object are kept, it disappears from the list, its URL is refused, audit is written', async () => {
      const key = (await prisma.tagImage.findUniqueOrThrow({ where: { id: imageId } })).storageKeyOriginal!;
      const r = await request(app).delete(`${BASE}/images/${imageId}`).set(authOf(A)).send({ reason: 'wrong tag photographed' });
      expect(r.status).toBe(200);
      const row = await prisma.tagImage.findUniqueOrThrow({ where: { id: imageId } });
      expect(row).toMatchObject({ deletedById: A.user.id, deleteReason: 'wrong tag photographed' });
      expect(row.deletedAt).not.toBeNull();
      expect(mem.objects.has(key)).toBe(true);
      expect((await request(app).get(`${BASE}/tags/${tagId}/images`).set(authOf(A))).body.data).toHaveLength(0);
      expect((await request(app).get(`${BASE}/images/${imageId}/url`).set(authOf(A))).status).toBe(404);
      expect((await request(app).delete(`${BASE}/images/${imageId}`).set(authOf(A)).send({ reason: 'again again' })).status).toBe(404);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: A.company.id, recordId: imageId, action: 'DELETE' } });
      expect(audit.userId).toBe(A.user.id);
      expect(audit.newValues).toMatchObject({ reason: 'wrong tag photographed' });
    });
    it('a soft-deleted primary frees the slot for a new PRIMARY', async () => {
      const r = await up(A, await ticketFor(A, tagId, ids.stA), { imageType: 'PRIMARY' }, jpeg('read-2'));
      expect(r.status).toBe(201);
      expect(r.body.data.replacedPrimaryImageId).toBeNull();
    });
  });

  // ── branch behaviour ──
  describe('branch behaviour', () => {
    it("moving a tag to another branch does not modify its photos (they stay readable by the new branch's users)", async () => {
      const tag = await mkTag(A, 'TMOVE');
      const r = await up(A, await ticketFor(A, tag.id, ids.stA), { imageType: 'PRIMARY' }, jpeg('move-1'));
      const before = await prisma.tagImage.findUniqueOrThrow({ where: { id: r.body.data.image.id } });
      const other = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `MB${suffix}`, name: 'Moved-to' } as any });
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { branchId: other.id } });
      const after = await prisma.tagImage.findUniqueOrThrow({ where: { id: r.body.data.image.id } });
      expect(after).toEqual(before);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      const asNewBranch = { ...A, ctx: { ...A.ctx, branchAccess: { allBranches: false, branchIds: [other.id] } } } as TestTenant;
      expect((await request(app).get(`${BASE}/tags/${tag.id}/images`).set(authOf(asNewBranch))).body.data).toHaveLength(1);
      const asOldBranch = { ...A, ctx: { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } } } as TestTenant;
      expect((await request(app).get(`${BASE}/tags/${tag.id}/images`).set(authOf(asOldBranch))).status).toBe(404);
      await prisma.tagImage.deleteMany({ where: { tagId: tag.id } });
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { branchId: A.branch.id } });
      await prisma.branch.delete({ where: { id: other.id } });
    });
  });

  describe('image header parsing', () => {
    it('reads JPEG / PNG / WebP dimensions and returns null for junk', () => {
      expect(readImageDimensions(jpeg('d', 1234, 567), 'image/jpeg')).toEqual({ width: 1234, height: 567 });
      const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(300, 16); png.writeUInt32BE(200, 20);
      expect(readImageDimensions(png, 'image/png')).toEqual({ width: 300, height: 200 });
      const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(1599, 24, 3); webp.writeUIntLE(899, 27, 3);
      expect(readImageDimensions(webp, 'image/webp')).toEqual({ width: 1600, height: 900 });
      expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    });
  });
});
