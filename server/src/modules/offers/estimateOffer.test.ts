import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { createOffer, deleteOffer, setOfferActive, updateOffer, todayString } from './offer.service';
import { createTagEstimate, getTagEstimate } from '../tagging/estimation.service';

// Offer management step 2: "Apply offer" on the estimate. The offer is chosen by the server from today's date, and the
// estimate keeps a snapshot (offer id + name + the tagged rates) that a later edit/deletion of the offer cannot change.
describe('Estimate: apply offer', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let tagId = ''; let rubyTypeId = '';
  const mat = { gold: '', ruby: '' };
  const estimateIds: string[] = [];

  beforeAll(async () => {
    A = await createTestTenant(`EOA${suffix}`, ['*']);
    await seedMetalRate(A.company.id, '22K', 6000);
    B = await createTestTenant(`EOB${suffix}`, ['*']);
    rubyTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    const grade = await prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId: rubyTypeId, quality: 'AA' } });
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `EO-${suffix}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby ring',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000,
        status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 1500, saleVaPercent: 18,
      },
    });
    tagId = tag.id;
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId, ...o } as any });
    mat.gold = (await m({ code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 })).id;
    mat.ruby = (await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: A.company.id } });
    for (const t of [A, B]) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  const offerInput = (over: Record<string, unknown> = {}) => ({
    name: 'Half VA', effectiveFrom: todayString(), effectiveTo: null,
    rules: [
      { component: 'VA', mode: 'PERCENT_OFF', value: 50 },
      { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
      { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: rubyTypeId },
    ],
    ...over,
  }) as any;

  // The page submits the OFFERED rates (it applied them client-side from /offers/resolve) plus each line's material id.
  const payload = (over: Record<string, unknown> = {}) => ({
    items: [
      { materialId: mat.gold, code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 },
      { materialId: mat.ruby, code: 'RUBY', materialType: 'STONE', weight: 1, saleRate: 800 },
    ],
    saleMcRate: 750, saleVaPercent: 9, applyOffer: true, ...over,
  }) as any;

  const save = async (input: any) => {
    const e = await createTagEstimate(tagId, input, A.ctx, A.user.id);
    estimateIds.push(e.id);
    return e;
  };

  it('refuses "apply offer" when no offer applies today (nothing saved)', async () => {
    const before = await prisma.tagEstimate.count({ where: { tagId } });
    await expect(save(payload())).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.tagEstimate.count({ where: { tagId } })).toBe(before);
  });

  it('records the offer and the tagged rates; an estimate without applyOffer records none', async () => {
    const o = await createOffer(A.ctx, offerInput(), A.user.id);
    const e = await save(payload());
    expect(e).toMatchObject({ offerId: o.id, offerName: 'Half VA' });
    expect(Number(e.baseSaleMcRate)).toBe(1500);
    expect(Number(e.baseSaleVaPercent)).toBe(18);
    const gold = e.items.find((i: any) => i.code === 'G22')!; const ruby = e.items.find((i: any) => i.code === 'RUBY')!;
    expect(Number(gold.baseSaleRate)).toBe(6000);
    expect(Number(ruby.baseSaleRate)).toBe(1500);
    expect(Number(ruby.saleRate)).toBe(800);

    const plain = await save(payload({ applyOffer: undefined, saleMcRate: 1500, saleVaPercent: 18 }));
    expect(plain.offerId).toBeNull();
    expect(plain.items.every((i: any) => i.baseSaleRate === null)).toBe(true);
    await setOfferActive(A.ctx, o.id, false, A.user.id);
  });

  it('a later edit, switch-off or deletion attempt of the offer does not change the saved quote', async () => {
    const o = await createOffer(A.ctx, offerInput({ name: 'Festive' }), A.user.id);
    const e = await save(payload());
    await updateOffer(A.ctx, o.id, offerInput({ name: 'Festive v2', rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 5 }] }), A.user.id);
    await setOfferActive(A.ctx, o.id, false, A.user.id);
    const again = await getTagEstimate(A.ctx, e.id);
    expect(again.offerName).toBe('Festive');
    expect(Number(again.saleVaPercent)).toBe(9);
    expect(Number(again.baseSaleVaPercent)).toBe(18);
    // Used offers cannot be erased (the quote still points at it) - switching off is the supported way.
    await expect(deleteOffer(A.ctx, o.id, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.offer.count({ where: { id: o.id } })).toBe(1);
  });

  it("another company's offer is never applied to this company's tag", async () => {
    await createOffer(B.ctx, offerInput({ name: 'B only', rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 90 }] }), B.user.id);
    await expect(save(payload())).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a stale or foreign materialId only loses its tagged-rate note; it cannot attach anything', async () => {
    const o = await createOffer(A.ctx, offerInput({ name: 'Third' }), A.user.id);
    const e = await save(payload({ items: [{ materialId: 'not-a-real-id', code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 }] }));
    expect(e.offerId).toBe(o.id);
    expect(e.items[0].baseSaleRate).toBeNull();
  });
});
