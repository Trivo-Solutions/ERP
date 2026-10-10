import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import {
  getTagForEstimation, createTagEstimate, getTagEstimate, listTagEstimatesForTag,
} from './estimation.service';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

describe('Estimation (per-tag price quote)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let userId: string;
  let tenant: TestTenant;
  let branchId: string;
  let categoryId: string;
  let stockTypeId: string;
  let tagId: string;
  const estimateIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`EST${suffix}`, []);
    await seedMetalRate(tenant.company.id, '22K', 5500);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const category = await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `TSTCAT-EST-${suffix}`, name: 'Test Category' },
    });
    categoryId = category.id;

    const stockType = await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `TES${suffix}`.slice(0, 8).toUpperCase(), name: 'Test Stock Type' },
    });
    stockTypeId = stockType.id;

    // A tag with a mixed metal+stone materials list — same shape createTag persists it in.
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-EST-${suffix}`, companyId: tenant.company.id, branchId, categoryId, stockTypeId,
        name: 'Test Estimation Piece', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 9.5, stoneWeight: 0.5,
        costPrice: 50000, sellingPrice: 60000, saleMcRate: 350, saleVaPercent: 7, createdById: userId,
        materials: {
          createMany: {
            data: [
              { code: 'GOLD-22K', materialType: 'METAL', weight: 9.5, unit: 'GM', costRate: 5000, costAmount: 47500, saleRate: 5500, saleAmount: 52250 },
              { code: 'DIA-1', materialType: 'DIAMOND', weight: 0.5, unit: 'CT', costRate: 15000, costAmount: 7500, saleRate: 18000, saleAmount: 9000 },
            ],
          },
        },
      },
    });
    tagId = tag.id;
  });

  afterAll(async () => {
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } }); // cascades tag_estimate_items
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } }); // cascades jewelry_tag_materials
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('getTagForEstimation returns the tag with its materials included', async () => {
    const tag = await getTagForEstimation(tenant.ctx, tagId);
    expect(tag.materials).toHaveLength(2);
    expect(tag.materials.map((m) => m.code).sort()).toEqual(['DIA-1', 'GOLD-22K']);

    // The MC rate/VA% actually decided for this piece at tagging time — the client must prefer
    // these over a fresh MakingCharge master lookup (see JewelryTag's schema comment).
    expect(Number(tag.saleMcRate)).toBe(350);
    expect(Number(tag.saleVaPercent)).toBe(7);
  });

  it('throws for an unknown tag id', async () => {
    await expect(getTagForEstimation(tenant.ctx, 'nonexistent-id')).rejects.toThrow('Tag not found');
  });

  it('computes per-item amounts and MC/VA-inclusive totals from edited rates, without touching the tag', async () => {
    const estimate = await createTagEstimate(
      tagId,
      {
        items: [
          // Deliberately different from the tag's own JewelryTagMaterial rates (5000/5500,
          // 15000/18000) to prove this is an independent, editable snapshot.
          { code: 'GOLD-22K', materialType: 'METAL', weight: 9.5, unit: 'GM', costRate: 5200, saleRate: 5800 },
          { code: 'DIA-1', materialType: 'DIAMOND', weight: 0.5, unit: 'CT', costRate: 16000, saleRate: 19000 },
        ],
        costMcRate: 200, costVaPercent: 5,
        saleMcRate: 250, saleVaPercent: 8,
      },
      tenant.ctx, userId
    );
    estimateIds.push(estimate.id);

    expect(estimate.estimateNumber).toMatch(/^EST-\d{4}-/);
    expect(estimate.items).toHaveLength(2);

    const goldItem = estimate.items.find((i: any) => i.code === 'GOLD-22K')!;
    expect(Number(goldItem.saleAmount)).toBeCloseTo(9.5 * 5800);

    // Estimation is a sales/counter-staff feature — the public shape never carries cost data,
    // even though it was computed and stored internally (checked against the DB below).
    expect((goldItem as any).costRate).toBeUndefined();
    expect((goldItem as any).costAmount).toBeUndefined();
    expect((estimate as any).costMcRate).toBeUndefined();
    expect((estimate as any).totalCostAmount).toBeUndefined();

    // Making charge/VA — same formula as NewTagPage.tsx: metalWeight×mcRate + metalValue×va%/100,
    // applied once against metal totals only (the diamond row never enters this calc).
    const metalSaleAmt = 9.5 * 5800;
    const makingSaleAmount = 9.5 * 250 + (metalSaleAmt * 8) / 100;
    const materialsSaleAmt = 9.5 * 5800 + 0.5 * 19000;

    expect(Number(estimate.totalSaleAmount)).toBeCloseTo(materialsSaleAmt + makingSaleAmount);

    // GST — indicative 3% for INR (same convention as NewSalePage.tsx), snapshotted onto the
    // estimate so a later rate change never reprices a past quote.
    const expectedGst = Math.round((materialsSaleAmt + makingSaleAmount) * 0.03 * 100) / 100;
    expect(Number(estimate.taxRate)).toBeCloseTo(0.03);
    expect(Number(estimate.gstAmount)).toBeCloseTo(expectedGst);
    expect(Number(estimate.netPayableAmount)).toBeCloseTo(materialsSaleAmt + makingSaleAmount + expectedGst);

    // Cost math is still computed and persisted (a later, more privileged view could use it) —
    // verified directly against the DB rather than the public (sale-only) return shape.
    const storedItems = await prisma.tagEstimateItem.findMany({ where: { estimateId: estimate.id } });
    const storedGold = storedItems.find((i) => i.code === 'GOLD-22K')!;
    expect(Number(storedGold.costAmount)).toBeCloseTo(9.5 * 5200);
    const storedEstimate = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: estimate.id } });
    const metalCostAmt = 9.5 * 5200;
    const makingCostAmount = 9.5 * 200 + (metalCostAmt * 5) / 100;
    const materialsCostAmt = 9.5 * 5200 + 0.5 * 16000;
    expect(Number(storedEstimate.totalCostAmount)).toBeCloseTo(materialsCostAmt + makingCostAmount);

    // Immutability guarantee: the tag's own materials/cost/selling price are untouched.
    const untouchedTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tagId }, include: { materials: true } });
    expect(Number(untouchedTag.costPrice)).toBe(50000);
    expect(Number(untouchedTag.sellingPrice)).toBe(60000);
    const untouchedGoldRow = untouchedTag.materials.find((m) => m.code === 'GOLD-22K')!;
    expect(Number(untouchedGoldRow.costRate)).toBe(5000);
    expect(Number(untouchedGoldRow.saleRate)).toBe(5500);
  });

  it('charges zero GST on a non-INR estimate (regression, same convention as NewSalePage.tsx)', async () => {
    const estimate = await createTagEstimate(
      tagId,
      { items: [{ code: 'GOLD-22K', materialType: 'METAL', weight: 9.5, saleRate: 5500 }], currency: 'USD' },
      tenant.ctx, userId
    );
    estimateIds.push(estimate.id);

    expect(Number(estimate.taxRate)).toBe(0);
    expect(Number(estimate.gstAmount)).toBe(0);
    expect(Number(estimate.netPayableAmount)).toBeCloseTo(Number(estimate.totalSaleAmount));
  });

  it('rejects an estimate with no items', async () => {
    await expect(createTagEstimate(tagId, { items: [] }, tenant.ctx, userId)).rejects.toThrow(AppError);
  });

  it('rejects an unknown tag id', async () => {
    await expect(
      createTagEstimate('nonexistent-id', { items: [{ code: 'X', materialType: 'METAL', weight: 1, saleRate: 100 }] }, tenant.ctx, userId)
    ).rejects.toThrow('Tag not found');
  });

  it('getTagEstimate returns a saved estimate with its items', async () => {
    const created = await createTagEstimate(
      tagId,
      { items: [{ code: 'GOLD-22K', materialType: 'METAL', weight: 9.5, saleRate: 5500 }] },
      tenant.ctx, userId
    );
    estimateIds.push(created.id);

    const fetched = await getTagEstimate(tenant.ctx, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.items).toHaveLength(1);
  });

  it('throws for an unknown estimate id', async () => {
    await expect(getTagEstimate(tenant.ctx, 'nonexistent-id')).rejects.toThrow('Estimate not found');
  });

  it('listTagEstimatesForTag returns every saved estimate for that tag, most recent first', async () => {
    const list = await listTagEstimatesForTag(tenant.ctx, tagId);
    expect(list.length).toBeGreaterThanOrEqual(2); // the two successful creates above
    expect(list.every((e) => e.tagId === tagId)).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(list[i].createdAt.getTime());
    }
  });
});
