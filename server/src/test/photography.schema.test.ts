import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';
import { PERMISSION_CATALOG } from '../shared/permissionCatalog';
import { createHash } from 'crypto';
// ═══════════════════════════════════════════════════════════════════════════
// Photography — Phase 1 (schema only; migration 20261009110000_photography_data_model). Fixtures write with the
// platform role (BYPASSRLS) on purpose: every refusal below must come from the DATABASE (composite FK / CHECK /
// unique index / RLS), not from application code — Phase 1 has no service.
// ═══════════════════════════════════════════════════════════════════════════

describe('Photography Phase 1 — schema, constraints and isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  const ids: Record<string, string> = {};
  let seq = 0;
  const key = () => `K-${suffix}-${seq++}`;
  const sha = '0'.repeat(63) + '1';
  // station_credentials.tokenHash is globally UNIQUE (and must be 64 lowercase hex). A literal such as 'f'.repeat(64) collides with
  // a row left by any earlier or concurrent run, so every hash in this file is derived from this run's own suffix.
  const hash = (label: string) => createHash('sha256').update(`${suffix}:${label}`).digest('hex');

  const station = (t: TestTenant, over: Record<string, unknown> = {}) => prisma.photographyStation.create({
    data: { companyId: t.company.id, branchId: t.branch.id, name: `ST-${suffix}-${seq++}`, registeredById: t.user.id, ...over } as any,
  });
  const image = (t: TestTenant, tagId: string, over: Record<string, unknown> = {}) => prisma.tagImage.create({
    data: {
      companyId: t.company.id, tagId, imageType: 'SIDE', isPrimary: false, mimeType: 'image/jpeg',
      idempotencyKey: key(), captureSource: 'DEVICE_CAMERA', capturedById: t.user.id, capturedAt: new Date(), ...over,
    } as any,
  });
  const mkTag = (t: TestTenant, n: string) => prisma.jewelryTag.create({
    data: { companyId: t.company.id, tagNumber: `${n}-${suffix}`, branchId: t.branch.id, name: 'Tag', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: t.user.id },
  });

  beforeAll(async () => {
    A = await createTestTenant(`PHA${suffix}`, []);
    B = await createTestTenant(`PHB${suffix}`, []);
    ids.tagA = (await mkTag(A, 'TA')).id; ids.tagA2 = (await mkTag(A, 'TA2')).id; ids.tagB = (await mkTag(B, 'TB')).id;
    ids.stA = (await station(A)).id; ids.stB = (await station(B)).id;
  }, 60_000);

  afterAll(async () => {
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  // ── Composite FKs: cross-company references are refused by the database ──
  it('rejects an image whose tag belongs to another company', async () => {
    await expect(image(B, ids.tagA)).rejects.toThrow(/foreign key/i);
  });
  it('has no branch column or branch relationship on tag_images (branch comes from the tag / the station)', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'tag_images' AND column_name = 'branchId'`;
    expect(cols).toHaveLength(0);
    const fks = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conrelid = 'tag_images'::regclass AND confrelid = 'branches'::regclass`;
    expect(fks).toHaveLength(0);
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'tag_images' AND indexdef LIKE '%branchId%'`;
    expect(idx).toHaveLength(0);
  });
  it('keeps the tag -> branch and station -> branch links, and a tag move never touches its photos', async () => {
    const tag = await mkTag(A, 'TMOVE');
    const img = await image(A, tag.id, { stationId: ids.stA });
    const other = await prisma.branch.create({ data: { companyId: A.company.id, name: `Other-${suffix}`, branchCode: `OB${suffix}` } as any });
    await prisma.jewelryTag.update({ where: { id: tag.id }, data: { branchId: other.id } });
    const after = await prisma.tagImage.findUniqueOrThrow({ where: { id: img.id }, include: { tag: true, station: true } });
    expect(after.tag.branchId).toBe(other.id);          // current branch: the tag
    expect(after.station!.branchId).toBe(A.branch.id);  // capture branch: the station
    expect(after.updatedAt.getTime()).toBe(img.updatedAt.getTime());
    await prisma.tagImage.delete({ where: { id: img.id } }); await prisma.jewelryTag.delete({ where: { id: tag.id } }); await prisma.branch.delete({ where: { id: other.id } });
  });
  it('rejects an image whose station belongs to another company', async () => {
    await expect(image(B, ids.tagB, { stationId: ids.stA })).rejects.toThrow(/foreign key/i);
  });
  it('accepts an image with a station of its own company, and with no station', async () => {
    await expect(image(A, ids.tagA, { stationId: ids.stA })).resolves.toBeTruthy();
    await expect(image(A, ids.tagA)).resolves.toBeTruthy();
  });
  it('rejects a station whose branch belongs to another company', async () => {
    await expect(station(B, { branchId: A.branch.id })).rejects.toThrow(/foreign key/i);
  });
  it('rejects a credential whose station belongs to another company', async () => {
    await expect(prisma.stationCredential.create({
      data: { companyId: B.company.id, stationId: ids.stA, tokenHash: hash('a'), scopes: [], createdById: B.user.id },
    })).rejects.toThrow(/foreign key/i);
  });
  it('a tag with images cannot be deleted (nothing cascades)', async () => {
    await expect(prisma.jewelryTag.delete({ where: { id: ids.tagA } })).rejects.toThrow(/foreign key/i);
  });
  it('a station with images or credentials cannot be deleted', async () => {
    const st = await station(A);
    await image(A, ids.tagA2, { stationId: st.id });
    await expect(prisma.photographyStation.delete({ where: { id: st.id } })).rejects.toThrow(/foreign key/i);
    const st2 = await station(A);
    await prisma.stationCredential.create({ data: { companyId: A.company.id, stationId: st2.id, tokenHash: hash('b'), scopes: ['x'], createdById: A.user.id } });
    await expect(prisma.photographyStation.delete({ where: { id: st2.id } })).rejects.toThrow(/foreign key/i);
  });

  // ── One live PRIMARY per tag ──
  it('allows one live PRIMARY per tag, rejects a second, and a soft-deleted PRIMARY frees the slot', async () => {
    const tag = (await mkTag(A, 'TP')).id;
    const first = await image(A, tag, { imageType: 'PRIMARY', isPrimary: true });
    await expect(image(A, tag, { imageType: 'PRIMARY', isPrimary: true })).rejects.toThrow(/unique/i);
    await prisma.tagImage.update({ where: { id: first.id }, data: { deletedAt: new Date(), deletedById: A.user.id, deleteReason: 'retake' } });
    await expect(image(A, tag, { imageType: 'PRIMARY', isPrimary: true })).resolves.toBeTruthy();
    // restoring the old one while a live primary exists is refused too
    await expect(prisma.tagImage.update({ where: { id: first.id }, data: { deletedAt: null, deletedById: null } })).rejects.toThrow(/unique/i);
  });
  it('a primary on one tag does not block a primary on another tag or another company', async () => {
    await expect(image(A, ids.tagA2, { imageType: 'PRIMARY', isPrimary: true })).resolves.toBeTruthy();
    await expect(image(B, ids.tagB, { imageType: 'PRIMARY', isPrimary: true })).resolves.toBeTruthy();
  });
  it('allows many SIDE / BACK / DETAIL / OTHER images on one tag', async () => {
    const tag = (await mkTag(A, 'TM')).id;
    for (const imageType of ['SIDE', 'SIDE', 'BACK', 'DETAIL', 'DETAIL', 'DETAIL', 'OTHER', 'OTHER']) {
      await expect(image(A, tag, { imageType })).resolves.toBeTruthy();
    }
  });
  it('CHECK: isPrimary must agree with imageType', async () => {
    await expect(image(A, ids.tagA, { imageType: 'PRIMARY', isPrimary: false })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { imageType: 'SIDE', isPrimary: true })).rejects.toThrow(/check/i);
  });

  // ── Idempotency ──
  it('idempotency key is unique per company but reusable across companies', async () => {
    const k = key();
    await image(A, ids.tagA, { idempotencyKey: k });
    await expect(image(A, ids.tagA2, { idempotencyKey: k })).rejects.toThrow(/unique/i);
    await expect(image(B, ids.tagB, { idempotencyKey: k })).resolves.toBeTruthy();
  });

  // ── Names / hashes / CHECKs ──
  it('station name is unique per company but reusable across companies; blank rejected', async () => {
    const name = `Studio-${suffix}`;
    await station(A, { name });
    await expect(station(A, { name })).rejects.toThrow(/unique/i);
    await expect(station(B, { name })).resolves.toBeTruthy();
    await expect(station(A, { name: '   ' })).rejects.toThrow(/check/i);
  });
  it('credential token hash is unique and must be a SHA-256 hex digest; revocation needs a revoker', async () => {
    const mk = (over: Record<string, unknown> = {}) => prisma.stationCredential.create({
      data: { companyId: A.company.id, stationId: ids.stA, tokenHash: hash('c'), scopes: [], createdById: A.user.id, ...over } as any,
    });
    await mk();
    await expect(mk()).rejects.toThrow(/unique/i);
    await expect(mk({ tokenHash: 'not-a-hash' })).rejects.toThrow(/check/i);
    await expect(mk({ tokenHash: hash('d'), revokedAt: new Date() })).rejects.toThrow(/check/i);
    await expect(mk({ tokenHash: hash('e'), revokedAt: new Date(), revokedById: A.user.id })).resolves.toBeTruthy();
  });
  it('CHECK: enumerated states are enforced', async () => {
    await expect(image(A, ids.tagA, { imageType: 'FRONT' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { reviewStatus: 'DONE' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { uploadStatus: 'UPLOADED' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { processingStatus: 'QUEUED' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { captureSource: 'WEBCAM' })).rejects.toThrow(/check/i);
  });
  it('CHECK: dimensions, size, checksum shape, blank idempotency key', async () => {
    await expect(image(A, ids.tagA, { width: 0 })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { height: -1 })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { sizeBytes: -1 })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { sha256: 'xyz' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { idempotencyKey: ' ' })).rejects.toThrow(/check/i);
  });
  it('CHECK: CONFIRMED upload requires stored bytes, size and checksum', async () => {
    await expect(image(A, ids.tagA, { uploadStatus: 'CONFIRMED' })).rejects.toThrow(/check/i);
    const k = `companies/${A.company.id}/photos/x-${suffix}.jpg`;
    await expect(image(A, ids.tagA, { uploadStatus: 'CONFIRMED', storageKeyOriginal: k, sha256: sha, sizeBytes: 5_000_000n })).resolves.toBeTruthy();
  });
  it('CHECK: storage keys must sit under the owning company prefix (no foreign prefix, no traversal)', async () => {
    await expect(image(A, ids.tagA, { storageKeyOriginal: `companies/${B.company.id}/x.jpg` })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { storageKeyOptimized: 'uploads/x.jpg' })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { storageKeyThumbnail: `companies/${A.company.id}/../${B.company.id}/x.jpg` })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { storageKeyThumbnail: `companies/${A.company.id}/photos/t.jpg` })).resolves.toBeTruthy();
  });
  it('CHECK: soft delete always records who deleted', async () => {
    await expect(image(A, ids.tagA, { deletedAt: new Date() })).rejects.toThrow(/check/i);
    await expect(image(A, ids.tagA, { deletedById: A.user.id })).rejects.toThrow(/check/i);
  });

  // ── Untouched JewelryTag ──
  it('jewelry_tags gained no photography column', async () => {
    const cols: any[] = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'jewelry_tags'`;
    expect(cols.map((c) => c.column_name).filter((n: string) => /photo|image/i.test(n))).toEqual([]);
  });

  // ── RLS ──
  for (const table of ['tag_images', 'photography_stations', 'station_credentials'] as const) {
    it(`RLS: ${table} is invisible/immutable across companies and fail-closed with no tenant`, async () => {
      const own = table === 'tag_images' ? (await prisma.tagImage.findFirst({ where: { companyId: A.company.id } }))!.id
        : table === 'photography_stations' ? ids.stA
          : (await prisma.stationCredential.findFirst({ where: { companyId: A.company.id } }))!.id;
      const foreign = table === 'tag_images' ? (await prisma.tagImage.findFirst({ where: { companyId: B.company.id } }))!.id
        : table === 'photography_stations' ? ids.stB
          : (await prisma.stationCredential.create({ data: { companyId: B.company.id, stationId: ids.stB, tokenHash: hash('f'), scopes: [], createdById: B.user.id } })).id;
      await withForcedRls([table], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows: any[] = await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id IN ($1, $2)`, own, foreign);
        expect(rows.map((r) => r.id)).toEqual([own]);
        expect(Number(await tx.$executeRawUnsafe(`UPDATE "${table}" SET "companyId" = "companyId" WHERE id = $1`, foreign))).toBe(0);
        expect(Number(await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = $1`, foreign))).toBe(0);
      });
      await withForcedRls([table], async (tx) => {
        const rows: any[] = await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id IN ($1, $2)`, own, foreign);
        expect(rows).toHaveLength(0);
      });
    });
  }

  it('RLS: INSERT of another company\'s row is refused by the policy (WITH CHECK)', async () => {
    await withForcedRls(['tag_images', 'photography_stations', 'station_credentials'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
      await expect(tx.$executeRaw`INSERT INTO photography_stations (id, "companyId", "branchId", name, "registeredById", "updatedAt")
        VALUES (${'ps' + suffix}, ${B.company.id}, ${B.branch.id}, 'x', ${B.user.id}, now())`).rejects.toThrow(/row-level security|policy/i);
    });
    await withForcedRls(['tag_images'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
      await expect(tx.$executeRaw`INSERT INTO tag_images (id, "companyId", "tagId", "imageType", "mimeType", "idempotencyKey", "captureSource", "capturedById", "capturedAt", "updatedAt")
        VALUES (${'ti' + suffix}, ${B.company.id}, ${ids.tagB}, 'SIDE', 'image/jpeg', 'rls-x', 'BRIDGE', ${B.user.id}, now(), now())`).rejects.toThrow(/row-level security|policy/i);
    });
    await withForcedRls(['station_credentials'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
      await expect(tx.$executeRaw`INSERT INTO station_credentials (id, "companyId", "stationId", "tokenHash", scopes, "createdById")
        VALUES (${'sc' + suffix}, ${B.company.id}, ${ids.stB}, ${hash('9')}, ARRAY[]::text[], ${B.user.id})`).rejects.toThrow(/row-level security|policy/i);
    });
  });

  // ── Permissions catalog ──
  it('permission catalog exposes the eight photography permissions', () => {
    const perms = PERMISSION_CATALOG.flatMap((g) => g.items).flatMap((i) => i.capabilities.map((c) => c.permission))
      .filter((p) => p.startsWith('photography:')).sort();
    // The catalog also pads every row with unenforced create/edit/export (permissionCatalog.ts), so
    // assert the eight real ones are all present rather than that they are the only ones.
    expect(perms).toEqual(expect.arrayContaining(['photography:capture', 'photography:delete', 'photography:manage_cameras', 'photography:manage_settings', 'photography:manage_stations',
      'photography:restore', 'photography:review', 'photography:view']));
  });

  it('derives its token hashes per run: valid sha-256 hex, distinct per label, different from another run', () => {
    const other = (label: string) => createHash('sha256').update(`other-run:${label}`).digest('hex');
    for (const l of ['a', 'b', 'c', 'd', 'e', 'f', '9']) {
      expect(hash(l)).toMatch(/^[0-9a-f]{64}$/);
      expect(hash(l)).not.toBe(other(l));
      expect(hash(l)).not.toBe(l.repeat(64)); // never the old fixed literal
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', '9'].map(hash)).size).toBe(7);
  });
});
