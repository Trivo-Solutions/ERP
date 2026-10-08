import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, TestTenant } from '../../test/fixtures';
import { MemoryStorageProvider, setStorageProviderForTests, storageForCompany } from '../../shared/storage';
import { DEFAULT_PHOTOGRAPHY_SETTINGS, PHOTOGRAPHY_SETTINGS_KEY, loadPhotographySettings, resolveSettings } from './photographySettings';
import { processTagImage } from './imageProcessing.service';
import * as processor from './imageProcessor';

// Photography Phase 2.5 — settings API, processing pipeline on upload, retry/reprocess, dashboard contract.
// Real app + real DB + in-memory StorageProvider; images are real (sharp-generated), not header-only fixtures.
vi.mock('./imageProcessor', async (orig) => {
  const m = await orig<typeof import('./imageProcessor')>();
  return { ...m, processImage: vi.fn(m.processImage) };
});

const BASE = '/api/v1/photography';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function photo(w: number, h: number, seed = 0, orientation?: number): Promise<Buffer> {
  const noise = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120 + (seed % 100), g: 90, b: 60 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .blur(1.2).png().toBuffer();
  let p = sharp(noise);
  if (orientation) p = p.withMetadata({ orientation });
  return p.jpeg({ quality: 92 }).toBuffer();
}

describe('Photography Phase 2.5 — settings + image processing', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const mem = new MemoryStorageProvider();
  let A: TestTenant; let B: TestTenant; let viewer: TestTenant; let restricted: TestTenant;
  const ids: Record<string, string> = {};
  let n = 0;
  const authOf = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
  const FULL = ['photography:view', 'photography:capture', 'photography:manage_settings'];

  const mkTag = (t: TestTenant, num: string) => prisma.jewelryTag.create({
    data: { companyId: t.company.id, tagNumber: `${num}-${suffix}`, branchId: t.branch.id, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: t.user.id },
  });
  async function upload(t: TestTenant, tagId: string, stationId: string, file: Buffer) {
    const s = await request(app).post(`${BASE}/capture-sessions`).set(authOf(t)).send({ tagId, stationId });
    expect(s.status).toBe(201);
    return request(app).post(`${BASE}/images`).set(authOf(t))
      .field('ticket', s.body.data.ticket).field('imageType', 'SIDE').field('idempotencyKey', `idem-${suffix}-${n++}`)
      .attach('file', file, { filename: 'shot.jpg', contentType: 'image/jpeg' });
  }
  const rowOf = (id: string) => prisma.tagImage.findFirstOrThrow({ where: { id } });
  const put = (t: TestTenant, body: unknown) => request(app).put(`${BASE}/settings`).set(authOf(t)).send(body as object);
  const setSettings = async (t: TestTenant, body: object) => expect((await put(t, body)).status).toBe(200);
  const reset = (t: TestTenant) => prisma.systemConfig.deleteMany({ where: { companyId: t.company.id, key: PHOTOGRAPHY_SETTINGS_KEY } });

  beforeAll(async () => {
    setStorageProviderForTests(mem);
    A = await createTestTenant(`QA${suffix}`, FULL);
    B = await createTestTenant(`QB${suffix}`, FULL);
    viewer = await createTestTenant(`QV${suffix}`, ['photography:view']);
    restricted = await createTestTenant(`QR${suffix}`, FULL);
    ids.tagA = (await mkTag(A, 'TA')).id;
    ids.stA = (await prisma.photographyStation.create({ data: { companyId: A.company.id, branchId: A.branch.id, name: `ST-A-${suffix}`, registeredById: A.user.id } })).id;
    ids.stB = (await prisma.photographyStation.create({ data: { companyId: B.company.id, branchId: B.branch.id, name: `ST-B-${suffix}`, registeredById: B.user.id } })).id;
    ids.tagB = (await mkTag(B, 'TB')).id;
  }, 60_000);
  afterAll(async () => {
    setStorageProviderForTests(null);
    for (const t of [A, B, viewer, restricted]) { await cleanupTestTenant(t); await prisma.user.deleteMany({ where: { email: t.user.email } }); }
    await prisma.$disconnect();
  });

  // ── settings ──
  describe('settings API', () => {
    it('GET returns the defaults (with limits and formats) when nothing is stored', async () => {
      const r = await request(app).get(`${BASE}/settings`).set(authOf(A));
      expect(r.status).toBe(200);
      expect(r.body.data.settings).toEqual(DEFAULT_PHOTOGRAPHY_SETTINGS);
      expect(r.body.data.usingDefaults).toBe(true);
      expect(r.body.data.formats).toEqual(['WEBP', 'JPEG']);
      expect(r.body.data.settings).toMatchObject({ targetOptimizedSizeKB: 500, keepOriginal: true, autoOrient: true });
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('PUT merges validated fields, persists them, audits before/after', async () => {
      const r = await put(A, { targetOptimizedSizeKB: 300, optimizedFormat: 'JPEG', thumbnailWidth: 200 });
      expect(r.status).toBe(200);
      expect(r.body.data.settings).toMatchObject({ targetOptimizedSizeKB: 300, optimizedFormat: 'JPEG', thumbnailWidth: 200, maximumWidth: 2400 });
      expect(r.body.data.usingDefaults).toBe(false);
      expect((await request(app).get(`${BASE}/settings`).set(authOf(A))).body.data.settings.targetOptimizedSizeKB).toBe(300);
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, tableName: 'system_configs', action: 'UPDATE' }, orderBy: { timestamp: 'desc' } });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit!.newValues)).toContain('"targetOptimizedSizeKB":300');
      expect(JSON.stringify(audit!.oldValues)).toContain('"targetOptimizedSizeKB":500');
      await reset(A);
    });

    it.each([
      [{ targetOptimizedSizeKB: -5 }, /at least/],
      [{ targetOptimizedSizeKB: 0 }, /at least/],
      [{ targetOptimizedSizeKB: 10 }, /at least 50/],
      [{ targetOptimizedSizeKB: 999999 }, /at most/],
      [{ maximumWidth: 100000 }, /at most/],
      [{ maximumHeight: 0 }, /at least/],
      [{ optimizedFormat: 'GIF' }, /format must be one of/],
      [{ thumbnailFormat: 'png' }, /format must be one of/],
      [{ minimumQuality: 90, maximumQuality: 60 }, /cannot be greater/],
      [{ thumbnailWidth: 0 }, /at least/],
      [{ thumbnailHeight: -1 }, /at least/],
      [{ targetOptimizedSizeKB: 'big' }, /must be a number/],
      [{ targetOptimizedSizeKB: 250.5 }, /whole number/],
      [{ keepOriginal: false }, /keepOriginal must be true/],
      [{ maxInputWidth: 1000, maximumWidth: 2400 }, /cannot be smaller/],
      [{ nonsense: 1 }, /Unknown setting/],
    ])('PUT rejects %j', async (body, msg) => {
      const r = await put(A, body);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
      expect((await request(app).get(`${BASE}/settings`).set(authOf(A))).body.data.usingDefaults).toBe(true); // nothing persisted
    });

    it('cross-field check uses the MERGED document (raising min above the stored max fails)', async () => {
      await setSettings(A, { maximumQuality: 70 });
      const r = await put(A, { minimumQuality: 80 });
      expect(r.status).toBe(400);
      await reset(A);
    });

    it('refuses a client-supplied companyId', async () => {
      const r = await put(A, { companyId: B.company.id, targetOptimizedSizeKB: 200 });
      expect(r.status).toBe(400);
      expect(await prisma.systemConfig.count({ where: { key: PHOTOGRAPHY_SETTINGS_KEY, companyId: { in: [A.company.id, B.company.id] } } })).toBe(0);
    });

    it('PUT requires photography:manage_settings (403); GET only needs photography:view', async () => {
      expect((await put(viewer, { targetOptimizedSizeKB: 200 })).status).toBe(403);
      expect((await request(app).get(`${BASE}/settings`).set(authOf(viewer))).status).toBe(200);
      const none = await createTestTenant(`QX${suffix}`, []);
      expect((await request(app).get(`${BASE}/settings`).set(authOf(none))).status).toBe(403);
      await cleanupTestTenant(none); await prisma.user.deleteMany({ where: { email: none.user.email } });
    });

    it('company A settings do not affect company B', async () => {
      await setSettings(A, { targetOptimizedSizeKB: 123 });
      const b = await request(app).get(`${BASE}/settings`).set(authOf(B));
      expect(b.body.data.settings.targetOptimizedSizeKB).toBe(500);
      expect(await loadPhotographySettings(B.company.id)).toEqual(DEFAULT_PHOTOGRAPHY_SETTINGS);
      expect((await loadPhotographySettings(A.company.id)).targetOptimizedSizeKB).toBe(123);
      await reset(A);
    });

    it('the generic /settings/config door cannot write the photography key (bypass closed)', async () => {
      const gen = await createTestTenant(`QG${suffix}`, ['system:config']);
      const r = await request(app).put('/api/v1/settings/config/photography.settings').set(authOf(gen)).send({ value: '{"targetOptimizedSizeKB":1}' });
      expect(r.status).toBe(400);
      await cleanupTestTenant(gen); await prisma.user.deleteMany({ where: { email: gen.user.email } });
    });

    it('a damaged / out-of-range stored document falls back per field, never throws', () => {
      expect(resolveSettings({ targetOptimizedSizeKB: -1, optimizedFormat: 'JPEG' }).settings).toMatchObject({ targetOptimizedSizeKB: 500, optimizedFormat: 'JPEG' });
      expect(resolveSettings('garbage').usingDefaults).toBe(true);
      expect(resolveSettings({ minimumQuality: 90, maximumQuality: 60 }).usingDefaults).toBe(true);
    });
  });

  // ── processing on upload ──
  describe('processing on upload', () => {
    it('stores the original untouched, then an optimized image and a thumbnail (defaults)', async () => {
      const src = await photo(3000, 2000, 1);
      const r = await upload(A, ids.tagA, ids.stA, src);
      expect(r.status).toBe(201);
      const img = r.body.data.image;
      expect(img.processingStatus).toBe('READY');
      expect(img.variants).toEqual({ original: true, optimized: true, thumbnail: true });
      expect(JSON.stringify(r.body)).not.toMatch(/companies\//); // no storage keys in the API
      const row = await rowOf(img.id);
      const store = storageForCompany(A.company.id);
      const original = Buffer.concat(await collect(await store.streamObject(row.storageKeyOriginal!)));
      expect(sha(original)).toBe(sha(src)); // byte-identical
      expect(row.sha256).toBe(sha(src));
      const opt = Buffer.concat(await collect(await store.streamObject(row.storageKeyOptimized!)));
      const th = Buffer.concat(await collect(await store.streamObject(row.storageKeyThumbnail!)));
      expect(opt.length).toBeLessThanOrEqual(500 * 1024);
      expect((await sharp(opt).metadata()).format).toBe('webp');
      const tm = await sharp(th).metadata();
      expect(tm.width).toBe(300); expect(tm.height).toBe(200);
      const base = `companies/${A.company.id}/photography/tags/${ids.tagA}/images/${img.id}/`;
      expect(row.storageKeyOriginal).toBe(`${base}original.jpg`);
      expect(row.storageKeyOptimized).toBe(`${base}optimized.webp`);
      expect(row.storageKeyThumbnail).toBe(`${base}thumbnail.webp`);
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: img.id, action: 'PROCESS' } });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit!.newValues)).toContain('"targetReached":true');
    });

    it('a changed target applies to NEW images only; existing variants are not rewritten', async () => {
      const first = (await upload(A, ids.tagA, ids.stA, await photo(3000, 2000, 2))).body.data.image;
      const before = await rowOf(first.id);
      const optBefore = (await storageForCompany(A.company.id).headObject(before.storageKeyOptimized!))!.sizeBytes;
      await setSettings(A, { targetOptimizedSizeKB: 120 });
      const second = (await upload(A, ids.tagA, ids.stA, await photo(3000, 2000, 3))).body.data.image;
      const optSecond = (await storageForCompany(A.company.id).headObject((await rowOf(second.id)).storageKeyOptimized!))!.sizeBytes;
      expect(optSecond).toBeLessThanOrEqual(120 * 1024);
      expect((await storageForCompany(A.company.id).headObject(before.storageKeyOptimized!))!.sizeBytes).toBe(optBefore); // untouched
      expect(optBefore).toBeGreaterThan(120 * 1024);
      // a deliberate reprocess picks up the current (120 KB) setting from the stored original
      const out = await processTagImage({ companyId: A.company.id, userId: A.user.id }, first.id);
      expect(out.status).toBe('READY');
      expect((await storageForCompany(A.company.id).headObject(before.storageKeyOptimized!))!.sizeBytes).toBeLessThanOrEqual(120 * 1024);
      await reset(A);
    });

    it('records "target not reached" without failing: best valid result kept, status READY', async () => {
      await setSettings(A, { targetOptimizedSizeKB: 50, minimumQuality: 90, maximumQuality: 95, minimumLongEdge: 2000 });
      const img = (await upload(A, ids.tagA, ids.stA, await photo(3000, 2000, 4))).body.data.image;
      expect(img.processingStatus).toBe('READY');
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: img.id, action: 'PROCESS' } });
      expect(JSON.stringify(audit!.newValues)).toContain('"targetReached":false');
      await reset(A);
    });

    it('disabled variants are not generated; original is still kept', async () => {
      await setSettings(A, { generateOptimized: false, generateThumbnail: false });
      const img = (await upload(A, ids.tagA, ids.stA, await photo(1200, 800, 5))).body.data.image;
      expect(img.variants).toEqual({ original: true, optimized: false, thumbnail: false });
      expect(img.processingStatus).toBe('READY');
      await setSettings(A, { generateOptimized: true, generateThumbnail: false });
      const img2 = (await upload(A, ids.tagA, ids.stA, await photo(1200, 800, 6))).body.data.image;
      expect(img2.variants).toEqual({ original: true, optimized: true, thumbnail: false });
      await reset(A);
    });

    it('JPEG format setting yields .jpg variant keys', async () => {
      await setSettings(A, { optimizedFormat: 'JPEG', thumbnailFormat: 'JPEG' });
      const row = await rowOf((await upload(A, ids.tagA, ids.stA, await photo(1200, 800, 7))).body.data.image.id);
      expect(row.storageKeyOptimized).toMatch(/optimized\.jpg$/);
      expect(row.storageKeyThumbnail).toMatch(/thumbnail\.jpg$/);
      await reset(A);
    });

    it('applies EXIF orientation to the optimized image and leaves the original EXIF-tagged', async () => {
      const src = await photo(800, 400, 8, 6);
      const row = await rowOf((await upload(A, ids.tagA, ids.stA, src)).body.data.image.id);
      const store = storageForCompany(A.company.id);
      const opt = await sharp(Buffer.concat(await collect(await store.streamObject(row.storageKeyOptimized!)))).metadata();
      expect([opt.width, opt.height]).toEqual([400, 800]);
      const orig = await sharp(Buffer.concat(await collect(await store.streamObject(row.storageKeyOriginal!)))).metadata();
      expect(orig.orientation).toBe(6);
    });

    it('settings of company B never shape company A processing (and vice versa)', async () => {
      await setSettings(B, { generateThumbnail: false });
      const a = (await upload(A, ids.tagA, ids.stA, await photo(900, 600, 9))).body.data.image;
      expect(a.variants.thumbnail).toBe(true);
      const b = (await upload(B, ids.tagB, ids.stB, await photo(900, 600, 10))).body.data.image;
      expect(b.variants.thumbnail).toBe(false);
      await reset(B);
    });
  });

  // ── failure + retry ──
  describe('failure handling', () => {
    const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from('not-decodable-pixels'), Buffer.from([0xff, 0xd9])]);

    it('undecodable image: upload still succeeds, original safe, status FAILED with a safe code, no variants', async () => {
      const r = await upload(A, ids.tagA, ids.stA, fakeJpeg);
      expect(r.status).toBe(201);
      expect(r.body.data.image.processingStatus).toBe('FAILED');
      expect(r.body.data.image.uploadStatus).toBe('CONFIRMED');
      expect(r.body.data.image.variants).toEqual({ original: true, optimized: false, thumbnail: false });
      const row = await rowOf(r.body.data.image.id);
      expect(row.deletedAt).toBeNull();
      expect(await storageForCompany(A.company.id).verifyObject(row.storageKeyOriginal!, fakeJpeg.length)).toBe('OK');
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: row.id, action: 'PROCESS_FAILED' } });
      expect(JSON.stringify(audit!.newValues)).toBe('{"code":"UNREADABLE_IMAGE"}');
    });

    it('a transient processor failure marks FAILED, and a retry processes the same image to READY', async () => {
      vi.mocked(processor.processImage).mockRejectedValueOnce(new Error('sharp exploded: /secret/path'));
      const r = await upload(A, ids.tagA, ids.stA, await photo(1000, 700, 11));
      const id = r.body.data.image.id;
      expect(r.body.data.image.processingStatus).toBe('FAILED');
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: id, action: 'PROCESS_FAILED' } });
      expect(JSON.stringify(audit)).not.toContain('secret'); // library text never leaks
      const out = await processTagImage({ companyId: A.company.id, userId: A.user.id }, id);
      expect(out.status).toBe('READY');
      const row = await rowOf(id);
      expect(row.processingStatus).toBe('READY');
      expect(row.storageKeyOptimized).toBeTruthy(); expect(row.storageKeyThumbnail).toBeTruthy();
    });

    it('a variant storage failure marks FAILED and keeps the original; retry succeeds', async () => {
      const r = await upload(A, ids.tagA, ids.stA, await photo(1000, 700, 12));
      const id = r.body.data.image.id;
      const spy = vi.spyOn(mem, 'put').mockRejectedValueOnce(new Error('disk full'));
      const out = await processTagImage({ companyId: A.company.id, userId: A.user.id }, id);
      spy.mockRestore();
      expect(out).toMatchObject({ status: 'FAILED', failureCode: 'VARIANT_STORAGE_FAILED' });
      const row = await rowOf(id);
      expect(row.processingStatus).toBe('FAILED');
      expect(await storageForCompany(A.company.id).verifyObject(row.storageKeyOriginal!)).toBe('OK');
      expect((await processTagImage({ companyId: A.company.id, userId: A.user.id }, id)).status).toBe('READY');
    });

    it("another company's image id is a 404 and is not touched", async () => {
      const bImg = (await upload(B, ids.tagB, ids.stB, await photo(900, 600, 13))).body.data.image.id;
      await expect(processTagImage({ companyId: A.company.id, userId: A.user.id }, bImg)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── dashboard ──
  describe('dashboard contract', () => {
    it('aggregates only the caller company; storage usage is explicitly unavailable', async () => {
      const a = await request(app).get(`${BASE}/dashboard`).set(authOf(A));
      expect(a.status).toBe(200);
      expect(a.body.data.todaysPhotos).toBeGreaterThan(0);
      expect(a.body.data.processingFailed).toBeGreaterThanOrEqual(1); // the undecodable upload above
      expect(a.body.data.activeStations).toBe(1);
      expect(a.body.data.storageUsage).toMatchObject({ available: false });
      expect(Object.keys(a.body.data)).toEqual(expect.arrayContaining(['todaysPhotos', 'pendingProcessing', 'processingFailed', 'imagesReviewed', 'imagesDeletedToday', 'activeStations']));
      const none = await request(app).get(`${BASE}/dashboard`).set(authOf(viewer));
      expect(none.body.data).toMatchObject({ todaysPhotos: 0, pendingProcessing: 0, processingFailed: 0, activeStations: 0 });
    });

    it('is branch-scoped: a user without the tag branch sees none of its photos', async () => {
      const other = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `DB${suffix}`, name: 'Other' } as any });
      const limited = { ...A, ctx: { ...A.ctx, branchAccess: { allBranches: false, branchIds: [other.id] } } } as TestTenant;
      const r = await request(app).get(`${BASE}/dashboard`).set(authOf(limited));
      expect(r.body.data).toMatchObject({ todaysPhotos: 0, processingFailed: 0, activeStations: 0 });
      await prisma.branch.delete({ where: { id: other.id } });
    });

    it('requires photography:view', async () => {
      const none = await createTestTenant(`QD${suffix}`, []);
      expect((await request(app).get(`${BASE}/dashboard`).set(authOf(none))).status).toBe(403);
      await cleanupTestTenant(none); await prisma.user.deleteMany({ where: { email: none.user.email } });
    });
  });
});

async function collect(s: NodeJS.ReadableStream): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of s) out.push(c as Buffer);
  return out;
}
