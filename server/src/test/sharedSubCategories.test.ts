import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createTag, updateTag } from '../modules/tagging/tagging.service';

// Shared sub-categories: ONE company master ("Traditional") linked to many categories. Covers create,
// reuse-by-link, duplicate prevention, link/unlink, per-category listing, tenant isolation, the server-side
// category + sub-category check on tags, rename propagation, deactivation, and authorization.
describe('Shared sub-categories (Category <-> SubCategory many-to-many)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const PERMS = ['masters:view', 'masters:create', 'masters:edit', 'masters:delete', 'tag:create', 'tag:view'];
  let A: TestTenant, B: TestTenant;
  let a: ReturnType<typeof apiWith>, b: ReturnType<typeof apiWith>;
  let ring: string, haram: string, bangle: string, bRing: string, stockTypeId: string;
  let traditionalId: string;
  const tagIds: string[] = [];

  const base = (categoryId: string, extra: object = {}) => ({
    branchId: A.branch.id, name: 'T', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, stockTypeId, categoryId, ...extra,
  });
  const mk = async (categoryId: string, extra: object = {}) => {
    const t = await createTag(A.ctx, base(categoryId, extra) as any, A.user.id);
    tagIds.push(t.id);
    return t;
  };
  const ids = (res: any) => (res.body.data as any[]).map((x) => x.id);

  beforeAll(async () => {
    A = await createTestTenant(`SSCA${suffix}`, PERMS);
    B = await createTestTenant(`SSCB${suffix}`, PERMS);
    a = apiWith(tokenFor(A), app);
    b = apiWith(tokenFor(B), app);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: 'R', name: 'Ready' } })).id;
    ring = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'RNG', name: 'Ring' } })).id;
    haram = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'HRM', name: 'Haram' } })).id;
    bangle = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'BNG', name: 'Bangle' } })).id;
    bRing = (await prisma.productCategory.create({ data: { companyId: B.company.id, code: 'RNG', name: 'Ring' } })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
  });

  it('A/B: creates Traditional under Ring, then LINKS the same record under Haram — no second row', async () => {
    const made = await a.post('/masters/subcategories', { code: 'trd', name: 'Traditional', categoryId: ring });
    expect(made.status).toBe(201);
    traditionalId = made.body.data.id;
    expect(made.body.data.code).toBe('TRD');
    expect(made.body.data.categories.map((c: any) => c.name)).toEqual(['Ring']);

    const link = await a.post(`/masters/subcategories/${traditionalId}/categories`, { categoryId: haram });
    expect(link.status).toBe(201);
    expect(link.body.data.map((c: any) => c.name).sort()).toEqual(['Haram', 'Ring']);

    expect(await prisma.subCategory.count({ where: { companyId: A.company.id, name: 'Traditional' } })).toBe(1);
    expect(ids(await a.get(`/masters/subcategories?categoryId=${ring}`))).toEqual([traditionalId]);
    expect(ids(await a.get(`/masters/subcategories?categoryId=${haram}`))).toEqual([traditionalId]);
    expect(ids(await a.get(`/masters/subcategories?categoryId=${bangle}`))).toEqual([]);
  });

  it('C: one sub-category linked to both categories shows under both; /categories lists them', async () => {
    const bridal = (await a.post('/masters/subcategories', { code: 'BRD', name: 'Bridal' })).body.data;
    expect(bridal.categories).toEqual([]);
    await a.post(`/masters/subcategories/${bridal.id}/categories`, { categoryId: ring });
    await a.post(`/masters/subcategories/${bridal.id}/categories`, { categoryId: haram });
    for (const cat of [ring, haram]) expect(ids(await a.get(`/masters/subcategories?categoryId=${cat}`))).toContain(bridal.id);
    const cats = await a.get(`/masters/subcategories/${bridal.id}/categories`);
    expect(cats.body.data.map((c: any) => c.name).sort()).toEqual(['Haram', 'Ring']);
    // the unfiltered list carries each sub-category's categories too, and ?search= narrows it
    const all = await a.get('/masters/subcategories?search=bridal');
    expect(all.body.data).toHaveLength(1);
    expect(all.body.data[0].categories).toHaveLength(2);
  });

  it('duplicate prevention: same code, or same name ignoring case/whitespace, is a 409 and creates nothing', async () => {
    const before = await prisma.subCategory.count({ where: { companyId: A.company.id } });
    expect((await a.post('/masters/subcategories', { code: 'TRD', name: 'Other', categoryId: bangle })).status).toBe(409);
    const byName = await a.post('/masters/subcategories', { code: 'TRD2', name: '  tRADITIONAL ', categoryId: bangle });
    expect(byName.status).toBe(409);
    expect(byName.body.error).toMatch(/link the existing/i);
    expect(await prisma.subCategory.count({ where: { companyId: A.company.id } })).toBe(before);
    expect(ids(await a.get(`/masters/subcategories?categoryId=${bangle}`))).toEqual([]);
    // blank / non-string input is a 400, never a 500
    expect((await a.post('/masters/subcategories', { code: ' ', name: 'x' })).status).toBe(400);
    expect((await a.post('/masters/subcategories', { code: 'X', name: { not: '' } })).status).toBe(400);
  });

  it('the same pair cannot be linked twice (409); unlinking works, a second unlink is 404; unknown ids are 404', async () => {
    expect((await a.post(`/masters/subcategories/${traditionalId}/categories`, { categoryId: haram })).status).toBe(409);
    expect((await a.post(`/masters/subcategories/${traditionalId}/categories`, { categoryId: bangle })).status).toBe(201);
    expect((await a.del(`/masters/subcategories/${traditionalId}/categories/${bangle}`)).status).toBe(200);
    expect((await a.del(`/masters/subcategories/${traditionalId}/categories/${bangle}`)).status).toBe(404);
    expect((await a.post(`/masters/subcategories/nope/categories`, { categoryId: ring })).status).toBe(404);
    expect((await a.post(`/masters/subcategories/${traditionalId}/categories`, {})).status).toBe(400);
  });

  it('tenant isolation: company B cannot see, rename, link, unlink, delete or use company A\'s sub-category', async () => {
    expect((await b.get('/masters/subcategories')).body.data).toHaveLength(0);
    expect((await b.get(`/masters/subcategories/${traditionalId}/categories`)).status).toBe(404);
    expect((await b.patch(`/masters/subcategories/${traditionalId}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.post(`/masters/subcategories/${traditionalId}/categories`, { categoryId: bRing })).status).toBe(404);
    expect((await b.del(`/masters/subcategories/${traditionalId}/categories/${ring}`)).status).toBe(404);
    expect((await b.del(`/masters/subcategories/${traditionalId}`)).status).toBe(404);
    expect((await b.get(`/masters/subcategories?categoryId=${ring}`)).status).toBe(404);
    // B creating under A's category, and B's own sub-category linked to A's category, are both 404
    expect((await b.post('/masters/subcategories', { code: 'F', name: 'Forge', categoryId: ring })).status).toBe(404);
    const own = (await b.post('/masters/subcategories', { code: 'TRD', name: 'Traditional', categoryId: bRing })).body.data;
    expect(own.id).not.toBe(traditionalId); // the same name is fine in another company — identity is per company
    expect((await b.post(`/masters/subcategories/${own.id}/categories`, { categoryId: ring })).status).toBe(404);
    expect((await a.get('/masters/subcategories?search=traditional')).body.data.map((x: any) => x.id)).toEqual([traditionalId]);
    expect((await prisma.subCategory.findUniqueOrThrow({ where: { id: traditionalId } })).name).toBe('Traditional');
  });

  it('tag validation (server-side): a linked pair is accepted; an unlinked, foreign or category-less one is rejected', async () => {
    const ok = await mk(ring, { subCategoryId: traditionalId });
    expect(ok.subCategoryId).toBe(traditionalId);
    await mk(haram, { subCategoryId: traditionalId });
    // Bangle is not linked to Traditional any more — through the service and over real HTTP
    await expect(createTag(A.ctx, base(bangle, { subCategoryId: traditionalId }) as any, A.user.id))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not linked/i) });
    const http = await a.post('/tagging/tags', base(bangle, { subCategoryId: traditionalId }));
    expect(http.status).toBe(400);
    expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id, categoryId: bangle } })).toBe(0);
    // another company's sub-category is a 404, not a 400
    const bOwn = (await prisma.subCategory.findFirstOrThrow({ where: { companyId: B.company.id } })).id;
    await expect(createTag(A.ctx, base(ring, { subCategoryId: bOwn }) as any, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('editing a tag: changing its category under a kept sub-category is rejected; clearing it (null) is fine', async () => {
    const t = await mk(ring, { subCategoryId: traditionalId });
    await expect(updateTag(t.id, { categoryId: bangle } as any, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
    const moved = await updateTag(t.id, { categoryId: haram } as any, A.ctx, A.user.id); // Haram is linked too
    expect(moved.categoryId).toBe(haram);
    const cleared = await updateTag(t.id, { categoryId: bangle, subCategoryId: null } as any, A.ctx, A.user.id);
    expect(cleared.subCategoryId).toBeNull();
    expect(cleared.categoryId).toBe(bangle);
  });

  it('historical safety: a used link cannot be unlinked and a used sub-category cannot be deleted (409)', async () => {
    const unlink = await a.del(`/masters/subcategories/${traditionalId}/categories/${ring}`);
    expect(unlink.status).toBe(409);
    expect(unlink.body.error).toMatch(/tag/i);
    expect((await a.del(`/masters/subcategories/${traditionalId}`)).status).toBe(409);
    expect(ids(await a.get(`/masters/subcategories?categoryId=${ring}`))).toContain(traditionalId);
    // an unused one can be deleted — its links go with it
    const tmp = (await a.post('/masters/subcategories', { code: 'TMP', name: 'Temp', categoryId: bangle })).body.data;
    expect((await a.del(`/masters/subcategories/${tmp.id}`)).status).toBe(200);
    expect(await prisma.categorySubCategory.count({ where: { subCategoryId: tmp.id } })).toBe(0);
  });

  it('rename propagates everywhere (one master); a rename onto an existing name is a 409', async () => {
    const t = await mk(ring, { subCategoryId: traditionalId });
    const renamed = await a.patch(`/masters/subcategories/${traditionalId}`, { name: 'Classic' });
    expect(renamed.status).toBe(200);
    for (const cat of [ring, haram]) {
      expect((await a.get(`/masters/subcategories?categoryId=${cat}`)).body.data.find((x: any) => x.id === traditionalId).name).toBe('Classic');
    }
    const row = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id }, include: { subCategory: true } });
    expect(row.subCategory!.name).toBe('Classic');
    expect((await a.patch(`/masters/subcategories/${traditionalId}`, { name: ' bridal ' })).status).toBe(409);
    // renaming to its own name differently cased is allowed (it is itself)
    expect((await a.patch(`/masters/subcategories/${traditionalId}`, { name: 'classic' })).status).toBe(200);
    await a.patch(`/masters/subcategories/${traditionalId}`, { name: 'Traditional' });
  });

  it('deactivation: new tags cannot use it, existing tags keep it and stay editable, it can be re-activated', async () => {
    const existing = await mk(ring, { subCategoryId: traditionalId });
    expect((await a.patch(`/masters/subcategories/${traditionalId}`, { isActive: false })).status).toBe(200);
    expect((await a.get(`/masters/subcategories?categoryId=${ring}&active=true`)).body.data.map((x: any) => x.id)).not.toContain(traditionalId);
    expect((await a.get(`/masters/subcategories?categoryId=${ring}`)).body.data.map((x: any) => x.id)).toContain(traditionalId);

    await expect(createTag(A.ctx, base(ring, { subCategoryId: traditionalId }) as any, A.user.id))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/inactive/i) });
    const edited = await updateTag(existing.id, { name: 'Edited while inactive' } as any, A.ctx, A.user.id);
    expect(edited.subCategoryId).toBe(traditionalId);
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: existing.id } })).subCategoryId).toBe(traditionalId);

    expect((await a.patch(`/masters/subcategories/${traditionalId}`, { isActive: true })).status).toBe(200);
    expect((await mk(ring, { subCategoryId: traditionalId })).subCategoryId).toBe(traditionalId);
    expect((await a.patch(`/masters/subcategories/${traditionalId}`, { isActive: 'no' })).status).toBe(400);
  });

  it('authorization: every sub-category write is 403 without its masters permission, even with the right ids', async () => {
    const viewer = await createTestTenant(`SSCV${suffix}`, ['masters:view']);
    try {
      const v = apiWith(tokenFor(viewer), app);
      const cat = (await prisma.productCategory.create({ data: { companyId: viewer.company.id, code: 'X', name: 'X' } })).id;
      const sub = (await prisma.subCategory.create({ data: { companyId: viewer.company.id, code: 'S', name: 'S' } })).id;
      expect((await v.get('/masters/subcategories')).status).toBe(200);
      expect((await v.post('/masters/subcategories', { code: 'N', name: 'n' })).status).toBe(403);
      expect((await v.patch(`/masters/subcategories/${sub}`, { name: 'y' })).status).toBe(403);
      expect((await v.post(`/masters/subcategories/${sub}/categories`, { categoryId: cat })).status).toBe(403);
      expect((await v.del(`/masters/subcategories/${sub}/categories/${cat}`)).status).toBe(403);
      expect((await v.del(`/masters/subcategories/${sub}`)).status).toBe(403);
    } finally { await cleanupTestTenant(viewer); }
  });

  it('deleting a category that still has sub-category links is refused (409) — links are never cascaded away', async () => {
    expect((await a.del(`/masters/categories/${ring}`)).status).toBe(409);
    expect(await prisma.categorySubCategory.count({ where: { companyId: A.company.id, categoryId: ring } })).toBeGreaterThan(0);
  });
});
