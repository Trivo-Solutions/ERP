import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { seedMetalRate, createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../test/fixtures';
import { createOffer, updateOffer, deleteOffer, setOfferActive, listOffers, resolveOfferForTag, offerStatus } from './offer.service';

describe('Offer management (service + HTTP)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant; let viewer: TestTenant;
  let tagId = ''; let rubyTypeId = ''; let cstTypeId = ''; let catId = ''; let foreignStoneType = ''; let foreignBranch = '';
  const ids = { ruby: '', cst: '', gold: '' };

  beforeAll(async () => {
    A = await createTestTenant(`OFA${suffix}`, ['*']);
    await seedMetalRate(A.company.id, '22K', 6000);
    B = await createTestTenant(`OFB${suffix}`, ['*']);
    viewer = await createTestTenant(`OFV${suffix}`, ['offer:view']);
    const mkType = (companyId: string, code: string) => prisma.stoneType.create({ data: { companyId, code, name: code } });
    rubyTypeId = (await mkType(A.company.id, 'RUBY')).id;
    cstTypeId = (await mkType(A.company.id, 'CST')).id;
    foreignStoneType = (await mkType(B.company.id, 'RUBY')).id;
    foreignBranch = B.branch.id;
    catId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'NEC', name: 'Necklace' } })).id;
    const grade = (stoneTypeId: string) => prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId, quality: 'AA' } });
    const gRuby = await grade(rubyTypeId); const gCst = await grade(cstTypeId);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `OFR-${suffix}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby necklace', categoryId: catId,
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000,
        status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 1500, saleVaPercent: 18,
      },
    });
    tagId = tag.id;
    const mat = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId, weight: 1, ...o } as any });
    ids.gold = (await mat({ code: 'G22', materialType: 'METAL', saleRate: 6000 })).id;
    ids.ruby = (await mat({ code: 'RUBY', materialType: 'STONE', unit: 'CT', saleRate: 1500, stoneGradeId: gRuby.id })).id;
    ids.cst = (await mat({ code: 'CST', materialType: 'STONE', unit: 'CT', saleRate: 3000, stoneGradeId: gCst.id })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: A.company.id } });
    for (const t of [A, B, viewer]) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email, viewer.user.email] } } });
    await prisma.$disconnect();
  });

  const base = (over: Record<string, unknown> = {}) => ({
    name: 'Diwali', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31',
    rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 50 }], ...over,
  }) as any;

  it('creates an offer with rules, audits it, and lists it', async () => {
    const o = await createOffer(A.ctx, base({
      rules: [
        { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
        { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: cstTypeId },
      ],
    }), A.user.id);
    expect(o.rules).toHaveLength(2);
    expect(o).toMatchObject({ effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', priority: 0, isActive: true });
    const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, tableName: 'offers', recordId: o.id, action: 'CREATE' } });
    expect(audit?.userId).toBe(A.user.id);
    expect((await listOffers(A.ctx)).map((x) => x.id)).toContain(o.id);
    await deleteOffer(A.ctx, o.id, A.user.id);
  });

  it('derives status from dates and the active flag', () => {
    const o = { isActive: true, effectiveFrom: '2026-10-10', effectiveTo: '2026-10-20' };
    expect(offerStatus(o, '2026-10-09')).toBe('UPCOMING');
    expect(offerStatus(o, '2026-10-10')).toBe('ACTIVE');
    expect(offerStatus(o, '2026-10-20')).toBe('ACTIVE');
    expect(offerStatus(o, '2026-10-21')).toBe('EXPIRED');
    expect(offerStatus({ ...o, isActive: false }, '2026-10-15')).toBe('INACTIVE');
  });

  it('rejects bad input', async () => {
    const bad = async (over: Record<string, unknown>) => createOffer(A.ctx, base(over), A.user.id);
    await expect(bad({ name: ' ' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ effectiveFrom: '01-10-2026' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ effectiveFrom: '2026-02-31' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ effectiveTo: '2026-09-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [{ component: 'GST', mode: 'PERCENT_OFF', value: 5 }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 101 }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [{ component: 'VA', mode: 'FIXED_RATE', value: -1 }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 5, stoneTypeId: rubyTypeId }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(bad({ rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 5, karat: 'NOPE' }] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cross-company foreign ids are a 404 and nothing is persisted', async () => {
    const before = (await listOffers(A.ctx)).length;
    await expect(createOffer(A.ctx, base({ rules: [{ component: 'STONE', mode: 'PERCENT_OFF', value: 5, stoneTypeId: foreignStoneType }] }), A.user.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(createOffer(A.ctx, base({ branchId: foreignBranch }), A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await listOffers(A.ctx)).length).toBe(before);
  });

  it("another company's offer cannot be read, edited, toggled or deleted", async () => {
    const o = await createOffer(B.ctx, base(), B.user.id);
    await expect(updateOffer(A.ctx, o.id, base(), A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(setOfferActive(A.ctx, o.id, false, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteOffer(A.ctx, o.id, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await listOffers(A.ctx)).map((x) => x.id)).not.toContain(o.id);
    expect((await prisma.offer.findUnique({ where: { id: o.id } }))?.isActive).toBe(true);
    await deleteOffer(B.ctx, o.id, B.user.id);
  });

  it('update replaces the rule list atomically and audits before/after; toggle and delete work', async () => {
    const o = await createOffer(A.ctx, base(), A.user.id);
    const u = await updateOffer(A.ctx, o.id, base({ name: 'Diwali 2', priority: 3, rules: [{ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 25 }, { component: 'VA', mode: 'PERCENT_OFF', value: 10 }] }), A.user.id);
    expect(u).toMatchObject({ name: 'Diwali 2', priority: 3 });
    expect(u.rules).toHaveLength(2);
    expect(await prisma.offerRule.count({ where: { offerId: o.id } })).toBe(2);
    const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: o.id, action: 'EDIT' } });
    expect((audit?.oldValues as any).name).toBe('Diwali');
    expect((audit?.newValues as any).name).toBe('Diwali 2');

    expect((await setOfferActive(A.ctx, o.id, false, A.user.id)).status).toBe('INACTIVE');
    await expect(setOfferActive(A.ctx, o.id, false, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    await deleteOffer(A.ctx, o.id, A.user.id);
    expect(await prisma.offer.count({ where: { id: o.id } })).toBe(0);
    expect(await prisma.offerRule.count({ where: { offerId: o.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { companyId: A.company.id, recordId: o.id, action: 'DELETE' } })).toBe(1);
  });

  it("resolves the brief's example on a real tag; never touches the tag; honours the date", async () => {
    const o = await createOffer(A.ctx, base({
      rules: [
        { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
        { component: 'VA', mode: 'PERCENT_OFF', value: 50 },
        { component: 'STONE', mode: 'PERCENT_OFF', value: 50, stoneTypeId: rubyTypeId },
        { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: cstTypeId },
      ],
    }), A.user.id);
    const r = await resolveOfferForTag(A.ctx, tagId, '2026-10-15');
    expect(r.resolution.offer?.id).toBe(o.id);
    expect(r.resolution.mc).toMatchObject({ baseRate: 1500, offerRate: 750 });
    expect(r.resolution.va).toMatchObject({ baseRate: 18, offerRate: 9 });
    expect(r.resolution.rows[ids.ruby].offerRate).toBe(750);
    expect(r.resolution.rows[ids.cst].offerRate).toBe(800);
    expect(r.resolution.rows[ids.gold]).toBeUndefined();

    // Outside the window the tagged price is simply the price again.
    expect((await resolveOfferForTag(A.ctx, tagId, '2026-11-02')).resolution.offer).toBeNull();
    // The tag itself was never written to.
    const tag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tagId }, include: { materials: true } });
    expect(Number(tag.saleMcRate)).toBe(1500);
    expect(Number(tag.saleVaPercent)).toBe(18);
    expect(Number(tag.costPrice)).toBe(40000);
    expect(tag.materials.find((m) => m.id === ids.ruby)?.saleRate?.toString()).toBe('1500');
    await expect(resolveOfferForTag(B.ctx, tagId, '2026-10-15')).rejects.toMatchObject({ statusCode: 404 });
    await deleteOffer(A.ctx, o.id, A.user.id);
  });

  describe('HTTP permission gating', () => {
    it('offer:view can list but not create/edit/delete (403); a no-permission user cannot even list', async () => {
      const api = apiWith(tokenFor(viewer), app);
      expect((await api.get('/offers')).status).toBe(200);
      expect((await api.post('/offers', base())).status).toBe(403);
      expect((await api.put('/offers/x', base())).status).toBe(403);
      expect((await api.del('/offers/x')).status).toBe(403);
      expect((await api.get(`/offers/resolve?tagId=${tagId}`)).status).toBe(403);
      const nobody = await createTestTenant(`OFN${suffix}`, []);
      try { expect((await apiWith(tokenFor(nobody), app).get('/offers')).status).toBe(403); }
      finally { await cleanupTestTenant(nobody); await prisma.user.deleteMany({ where: { email: nobody.user.email } }); }
    });

    it('a full-permission user can run the whole lifecycle over HTTP; a client-supplied companyId is rejected', async () => {
      const api = apiWith(tokenFor(A), app);
      const created = await api.post('/offers', base());
      expect(created.status).toBe(201);
      const id = created.body.data.id;
      expect((await api.get(`/offers/${id}`)).status).toBe(200);
      expect((await api.post(`/offers/${id}/deactivate`)).body.data.status).toBe('INACTIVE');
      expect((await api.post(`/offers/${id}/activate`)).status).toBe(200);
      expect((await request(app).post('/api/v1/offers').set('Authorization', `Bearer ${tokenFor(A)}`).send({ ...base(), companyId: B.company.id })).status).toBe(400);
      expect((await api.del(`/offers/${id}`)).status).toBe(200);
      expect((await api.get(`/offers/${id}`)).status).toBe(404);
      expect((await api.get('/offers/resolve')).status).toBe(400);
    });

    it("company B cannot see or touch company A's offer over HTTP", async () => {
      const a = apiWith(tokenFor(A), app); const b = apiWith(tokenFor(B), app);
      const id = (await a.post('/offers', base())).body.data.id;
      expect((await b.get(`/offers/${id}`)).status).toBe(404);
      expect((await b.put(`/offers/${id}`, base())).status).toBe(404);
      expect((await b.del(`/offers/${id}`)).status).toBe(404);
      expect((await b.get('/offers')).body.data.map((x: any) => x.id)).not.toContain(id);
      await a.del(`/offers/${id}`);
    });
  });
});
