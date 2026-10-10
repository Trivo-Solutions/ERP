import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { getBranchStockSummary, getStockOnHand, getDeadStock, getStockBook, searchTags, getTag } from './tagging.service';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Stock-side reports show what a piece would sell for TODAY (live gold + the piece's own stored rates) beside what it cost.
// Reference ring: 10 g @ gold rate R, ruby 1 ct @ 1500, MC 100/g, VA 10%  =>  R = 6000: 68500; R = 7000: 79500. Cost stays 40000.
describe('stock reports: live sale value beside cost', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant; let seq = 0;
  const tagIds: string[] = [];

  async function ring(t: TestTenant, over: Record<string, unknown> = {}, withRows = true) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `LV-${suffix}-${seq++}`, companyId: t.company.id, branchId: t.branch.id, name: 'Ruby ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 11, netWeight: 10, costPrice: 40000, sellingPrice: 1 /* the day-of-tagging figure: must NOT be what reports show */,
        status: 'IN_STOCK', createdById: t.user.id, saleMcRate: 100, saleVaPercent: 10, ...over,
      },
    });
    tagIds.push(tag.id);
    if (withRows) {
      await prisma.jewelryTagMaterial.create({ data: { companyId: t.company.id, tagId: tag.id, code: 'G22', materialType: 'METAL', weight: 10, saleRate: 100 } });
      await prisma.jewelryTagMaterial.create({ data: { companyId: t.company.id, tagId: tag.id, code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500 } });
    }
    return tag;
  }

  beforeAll(async () => {
    A = await createTestTenant(`LVA${suffix}`, ['*']);
    B = await createTestTenant(`LVB${suffix}`, ['*']);
    await seedMetalRate(A.company.id, '22K', 6000);
    await seedMetalRate(B.company.id, '22K', 9000);
  }, 60_000);

  afterAll(async () => {
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  it('every report shows today\'s value, ignores the stale stored sellingPrice, and follows the gold rate - cost never moves', async () => {
    const t = await ring(A);
    await ring(B); // another company's piece must never leak into A's totals
    const v1 = await getBranchStockSummary(A.company.id);
    const b1 = v1.find((b) => b.branchId === A.branch.id)!;
    expect(b1.inStock.sellingValue).toBe(68500);
    expect(b1.inStock.costValue).toBe(40000);
    expect(b1.inStock.unpricedCount).toBe(0);

    const hand = await getStockOnHand(A.company.id);
    expect(hand.totals).toMatchObject({ count: 1, sellingValue: 68500, costValue: 40000, unpricedCount: 0 });

    const dead = await getDeadStock(A.company.id);
    expect(dead.rows[0]).toMatchObject({ sellingValue: 68500, costValue: 40000, priced: true });

    const book = await getStockBook(A.ctx, {});
    expect(book.rows[0]).toMatchObject({ sellingPrice: 68500, costPrice: 40000, priced: true });

    await seedMetalRate(A.company.id, '22K', 7000); // gold moves: sale value follows, cost does not
    expect((await getStockOnHand(A.company.id)).totals).toMatchObject({ sellingValue: 79500, costValue: 40000 });
    expect((await getStockBook(A.ctx, {})).rows[0]).toMatchObject({ sellingPrice: 79500, costPrice: 40000 });
    expect((await getBranchStockSummary(A.company.id)).find((b) => b.branchId === A.branch.id)!.inStock.sellingValue).toBe(79500);

    // The counter lookup: a search hit and the detail both carry today's price.
    expect((await searchTags(A.ctx, t.tagNumber, undefined, 'ALL'))[0].liveSellingPrice).toBe(79500);
    expect((await getTag(A.ctx, t.id)).liveSellingPrice).toBe(79500);
    await seedMetalRate(A.company.id, '22K', 6000);
  });

  it('a piece that cannot be priced is counted as unpriced - never silently valued at 0 - and a bought-in piece with no rows uses its net weight', async () => {
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } }).catch(() => undefined); // start clean for exact totals
    const missingVa = await ring(A, { saleVaPercent: null });
    const bought = await ring(A, {}, false);   // no material rows: 10 g x 6000 + MC 1000 + VA 6000 = 67000
    const book = await getStockBook(A.ctx, { status: 'IN_STOCK' });
    const byId = new Map(book.rows.map((r) => [r.id, r]));
    expect(byId.get(missingVa.id)).toMatchObject({ priced: false, sellingPrice: 0 });
    expect(byId.get(bought.id)).toMatchObject({ priced: true, sellingPrice: 67000 });
    const hand = await getStockOnHand(A.company.id);
    expect(hand.totals.unpricedCount).toBe(1);
    expect(hand.totals.sellingValue).toBe(67000);
    expect((await getTag(A.ctx, missingVa.id)).liveSellingPrice).toBeNull();
  });

  it('a karat with no metal rate is unpriced, not guessed', async () => {
    const t = await ring(A, { metalKarat: '18K' });
    expect((await getTag(A.ctx, t.id)).liveSellingPrice).toBeNull();
  });
});
