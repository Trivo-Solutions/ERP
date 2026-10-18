import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { getTagForEstimation, createTagEstimate } from './estimation.service';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// PHF-style regression: a fixed-price-per-piece tag whose material is SILVER (sample weight recorded for stock only) must be
// quoted at its saved GST-exclusive price - never sample weight x today's silver rate (+ MC / VA).
describe('fixed price per piece - silver tag in estimation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let fixedCat = ''; let weightCat = ''; let seq = 0; let gstRate = 0.03;
  const estimateIds: string[] = [];

  async function makeTag(fixed: boolean, o: { price?: number; weight?: number; materialType?: string; code?: string } = {}) {
    const weight = o.weight ?? 12.5;
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `PHF-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'PHF', metalType: 'SILVER', metalKarat: '925',
        grossWeight: weight, netWeight: weight, costPrice: 500, sellingPrice: o.price ?? 750, status: 'IN_STOCK', createdById: A.user.id,
        categoryId: fixed ? fixedCat : weightCat,
        ...(fixed ? { pricingMode: 'FIXED_PRICE_PER_PIECE' } : { saleMcRate: 10, saleVaPercent: 5 }),
      },
    });
    await prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, code: o.code ?? 'S925', materialType: o.materialType ?? 'METAL', weight, saleRate: 1 } as any });
    return tag;
  }
  // The client sends its (wrong, weight-based) rows exactly like the old Estimation screen did.
  const estimate = async (tagId: string, weight: number, rate: number, extra: object = {}) => {
    const e = await createTagEstimate(tagId, { items: [{ code: 'S925', materialType: 'METAL', weight, saleRate: rate }], saleMcRate: 10, saleVaPercent: 5, ...extra }, A.ctx, A.user.id);
    estimateIds.push(e.id);
    return e;
  };

  beforeAll(async () => {
    A = await createTestTenant(`PHS${suffix}`, ['estimation:manage', 'masters:view']);
    await seedMetalRate(A.company.id, '925', 90);
    fixedCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'PHF', name: 'PHF', pricingMode: 'FIXED_PRICE_PER_PIECE' } })).id;
    weightCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'SLV', name: 'Silver chain' } })).id;
    gstRate = Number((await prisma.hsnCode.findFirstOrThrow({ where: { code: '7113' } })).gstRate);
  }, 60_000);

  afterAll(async () => {
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    const tags = await prisma.jewelryTag.findMany({ where: { companyId: A.company.id }, select: { id: true } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tags.map((t) => t.id) } } });
    await prisma.jewelryTag.deleteMany({ where: { companyId: A.company.id } });
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  it('silver fixed tag: estimate view exposes pricingMode + price and attaches no live silver rate', async () => {
    const tag = await makeTag(true);
    const view = await getTagForEstimation(A.ctx, tag.id);
    expect(view.pricingMode).toBe('FIXED_PRICE_PER_PIECE');
    expect(Number(view.sellingPrice)).toBe(750);
    expect(view.goldRate).toBeNull();
  });

  it('silver fixed tag: estimate = saved price, not weight x daily silver rate (12.5 x 90 = 1125 + MC/VA)', async () => {
    const tag = await makeTag(true);
    const e = await estimate(tag.id, 12.5, 90);
    expect(Number(e.totalSaleAmount)).toBe(750);
    expect(e.items).toHaveLength(1);
  });

  it('another material (stone) on a fixed tag: same saved price', async () => {
    const tag = await makeTag(true, { materialType: 'STONE', code: 'CZ' });
    expect(Number((await estimate(tag.id, 3, 4000)).totalSaleAmount)).toBe(750);
  });

  it('changing the sample weight or the daily metal rate does not change the price', async () => {
    const tag = await makeTag(true, { weight: 3 });
    expect(Number((await estimate(tag.id, 3, 90)).totalSaleAmount)).toBe(750);
    await prisma.jewelryTag.update({ where: { id: tag.id }, data: { grossWeight: 40, netWeight: 40 } });
    await prisma.jewelryTagMaterial.updateMany({ where: { tagId: tag.id }, data: { weight: 40 } });
    await seedMetalRate(A.company.id, '925', 400);
    expect(Number((await estimate(tag.id, 40, 400)).totalSaleAmount)).toBe(750);
    await seedMetalRate(A.company.id, '925', 90);
  });

  it('GST is separate and on top; MC/VA never raise the base', async () => {
    const tag = await makeTag(true);
    const e = await estimate(tag.id, 12.5, 90, { saleMcRate: 1000, saleVaPercent: 90 });
    expect(Number(e.totalSaleAmount)).toBe(750);
    expect(e.saleMcRate).toBeNull();
    expect(e.saleVaPercent).toBeNull();
    expect(Number(e.gstAmount)).toBeCloseTo(750 * gstRate, 2);
    expect(Number(e.netPayableAmount)).toBeCloseTo(750 * (1 + gstRate), 2);
  });

  it('creating an estimate never overwrites the tag (price, mode, weights)', async () => {
    const tag = await makeTag(true);
    await estimate(tag.id, 99, 999);
    const after = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(Number(after.sellingPrice)).toBe(750);
    expect(after.pricingMode).toBe('FIXED_PRICE_PER_PIECE');
    expect(Number(after.netWeight)).toBe(12.5);
  });

  it('the estimator can quote a different amount for this estimate only; invalid amounts are refused; the tag keeps its saved price', async () => {
    const tag = await makeTag(true);
    const e = await estimate(tag.id, 12.5, 90, { fixedPrice: 600 });
    expect(Number(e.totalSaleAmount)).toBe(600);
    expect(Number(e.gstAmount)).toBeCloseTo(600 * gstRate, 2);
    await expect(estimate(tag.id, 12.5, 90, { fixedPrice: 0 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(estimate(tag.id, 12.5, 90, { fixedPrice: -5 })).rejects.toMatchObject({ statusCode: 400 });
    expect(Number((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).sellingPrice)).toBe(750);
    expect(Number((await estimate(tag.id, 12.5, 90)).totalSaleAmount)).toBe(750); // no amount sent -> the saved price again
  });

  it('fixedPrice is ignored on a weight-based tag', async () => {
    const tag = await makeTag(false);
    expect(Number((await estimate(tag.id, 12.5, 90, { fixedPrice: 5 })).totalSaleAmount)).toBeCloseTo(1306.25, 2);
  });

  it('weight-based silver category still prices from the live silver rate + MC + VA', async () => {
    const tag = await makeTag(false);
    const view = await getTagForEstimation(A.ctx, tag.id);
    expect(view.pricingMode).toBe('WEIGHT_BASED');
    expect(Number(view.goldRate!.ratePerGram)).toBe(90);
    // 12.5 x 90 = 1125; MC 10 x 12.5 = 125; VA 5% of 1125 = 56.25
    expect(Number((await estimate(tag.id, 12.5, 90)).totalSaleAmount)).toBeCloseTo(1306.25, 2);
  });
});
