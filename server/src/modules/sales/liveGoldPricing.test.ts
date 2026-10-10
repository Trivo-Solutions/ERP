import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice } from './sales.service';
import { createOffer, setOfferActive, todayString } from '../offers/offer.service';
import { getTagForEstimation, createTagEstimate } from '../tagging/estimation.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { businessDayString, dayToDbDate } from '../../shared/businessDay';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// One synthetic ring, followed through every flow: 10 g of 22K gold, a 1 ct ruby @ 1500, MC 100/g, VA 10%.
//   gold 10 x R + ruby 1500 + MC 1000 + VA 10% of (10 x R)      -> at R = 6000: 68500; at R = 7000: 79500
//   GST 3% (default HSN)                                       -> 68500: 2055 => 70555
// Gold is the ONE live element: the tag's stored METAL saleRate (5000 here, deliberately stale) is never used.
describe('live gold rate - one price from tag to estimate to bill', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let clientId = '';
  const tagIds: string[] = []; const invoiceIds: string[] = []; const estimateIds: string[] = [];
  let seq = 0; let stoneTypeId = '';

  const bill = (data: any) => _createInvoice({ branchId: A.branch.id, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', ...data }, A.ctx, A.user.id);
  const day = (offset: number) => { const d = dayToDbDate(businessDayString()); d.setUTCDate(d.getUTCDate() + offset); return d; };

  async function makeRing(karat = '22K') {
    const grade = await prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId, quality: `Q${seq}` } });
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `LG-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby ring', metalType: 'GOLD', metalKarat: karat,
        grossWeight: 11, netWeight: 10, costPrice: 40000, sellingPrice: 70000, status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 100, saleVaPercent: 10,
      },
    });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, ...o } as any });
    await m({ code: 'G22', materialType: 'METAL', weight: 10, saleRate: 5000 });
    await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id });
    return tag;
  }
  const line = (tagId: string) => ({ productCode: 'X', description: 'Ruby ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId });

  beforeAll(async () => {
    A = await createTestTenant(`LGA${suffix}`, ['invoice:create', 'estimation:manage']);
    await seedMetalRate(A.company.id, '22K', 6000);
    stoneTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `LGCL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
  }, 60_000);

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { clientId } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  it('direct sale: a tagged line is priced at the LIVE gold rate, not the stale one stored on the tag, and GST/total reconcile', async () => {
    const tag = await makeRing();
    const inv = await bill({ items: [line(tag.id)] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(68500);   // 60000 + 1500 + 1000 + 6000
    expect(Number(inv.taxAmount)).toBeCloseTo(2055, 2);
    expect(Number(inv.totalAmount)).toBe(70555);
    expect((inv.items[0].materialBreakdown as any).rows.find((r: any) => r.materialType === 'METAL').rate).toBe(6000);
  });

  it('estimate shows the same live price; billing the estimate keeps its price; a twin tag sold directly matches to the rupee', async () => {
    const tag = await makeRing();
    const view = await getTagForEstimation(A.ctx, tag.id);
    const gold = view.materials.find((m) => m.materialType === 'METAL')!;
    expect(Number(gold.saleRate)).toBe(6000);               // live, not the stored 5000
    expect(view.goldRate).toMatchObject({ karat: '22K', ratePerGram: 6000, isToday: true });

    const est = await createTagEstimate(tag.id, {
      items: view.materials.map((m) => ({ materialId: m.id, code: m.code, materialType: m.materialType, weight: Number(m.weight), unit: m.unit, saleRate: Number(m.saleRate) })),
      saleMcRate: Number(view.saleMcRate), saleVaPercent: Number(view.saleVaPercent), sendToBilling: true,
      customerName: 'Walk-in', customerPhone: '9876500000', salesPersonId: A.user.id,
    } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    expect(Number(est.totalSaleAmount)).toBe(68500);

    // The gold rate moves AFTER the estimate was made. The estimate's own rates are what the bill uses.
    await seedMetalRate(A.company.id, '22K', 7000);
    const stored = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: est.id }, include: { items: true } });
    const breakdown = {
      rows: stored.items.map((i) => ({ materialId: i.materialId ?? undefined, code: i.code, materialType: i.materialType, name: i.name ?? i.code, weight: Number(i.weight), unit: i.unit, rate: Number(i.saleRate) })),
      mcRate: Number(stored.saleMcRate), vaPercent: Number(stored.saleVaPercent),
    };
    const billed = await bill({ estimateIds: [est.id], items: [{ ...line(tag.id), materialBreakdown: breakdown }] });
    invoiceIds.push(billed.id);
    expect(Number(billed.items[0].totalPrice)).toBe(68500);  // not 79500: the estimate's frozen rate
    expect(Number(billed.totalAmount)).toBe(70555);

    // A twin tag sold directly NOW is priced at the new live rate: 70000 + 1500 + 1000 + 7000.
    const twin = await makeRing();
    const direct = await bill({ items: [line(twin.id)] });
    invoiceIds.push(direct.id);
    expect(Number(direct.items[0].totalPrice)).toBe(79500);
    // ...and the earlier bill still carries exactly what it was issued at.
    const reread = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: billed.id } });
    expect(Number(reread.totalAmount)).toBe(70555);
    await seedMetalRate(A.company.id, '22K', 6000);
  });

  it("when today's rate is not entered yet, the latest earlier rate is used and the estimate view says so", async () => {
    const tag = await makeRing();
    await prisma.metalRate.deleteMany({ where: { companyId: A.company.id, karat: '22K' } });
    await prisma.metalRate.create({ data: { companyId: A.company.id, date: day(-1), karat: '22K', purity: 0.916, ratePerGram: 5900, currency: 'INR' } });
    const view = await getTagForEstimation(A.ctx, tag.id);
    expect(Number(view.materials.find((m) => m.materialType === 'METAL')!.saleRate)).toBe(5900);
    expect(view.goldRate).toMatchObject({ ratePerGram: 5900, isToday: false, rateDate: day(-1).toISOString().slice(0, 10) });
    await seedMetalRate(A.company.id, '22K', 6000); // today's rate entered: now live
    expect((await getTagForEstimation(A.ctx, tag.id)).goldRate).toMatchObject({ ratePerGram: 6000, isToday: true });
  });

  it('a karat with no rate at all refuses to price: 409, nothing sold, the piece stays in stock', async () => {
    const tag = await makeRing('18K');
    await expect(bill({ items: [line(tag.id)] })).rejects.toMatchObject({ statusCode: 409 });
    await expect(getTagForEstimation(A.ctx, tag.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
  });

  it('billing a fully priced tag does NOT need a metal rate on file - unless an active offer actually has a METAL rule', async () => {
    const breakdown = {
      rows: [{ code: 'G18', materialType: 'METAL', name: 'G18', weight: 10, unit: 'GM', rate: 5000 }, { code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: 1500 }],
      mcRate: 100, vaPercent: 10,
    };
    const t1 = await makeRing('18K'); // no 18K rate anywhere
    const inv = await bill({ items: [{ ...line(t1.id), materialBreakdown: breakdown }] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(57500);        // 50000 + 1500 + MC 1000 + VA 10% of 50000

    // An offer with a METAL rule can use the rate, so now the missing rate is a real problem and it is refused.
    const offer = await createOffer(A.ctx, { name: 'Gold festival', effectiveFrom: todayString(), effectiveTo: null, rules: [{ component: 'METAL', mode: 'PERCENT_OFF', value: 2 }] } as any, A.user.id);
    try {
      const t2 = await makeRing('18K');
      await expect(bill({ items: [{ ...line(t2.id), materialBreakdown: breakdown }] })).rejects.toMatchObject({ statusCode: 409 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('IN_STOCK');
    } finally {
      await setOfferActive(A.ctx, offer.id, false, A.user.id);
    }
  });

  it('custom (untagged) line uses the same rule: VA is a % of the metal value, MC the making amount - no markup of MC', async () => {
    const inv = await bill({ items: [{ productCode: 'C', description: 'Custom chain', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'PER_GRAM', goldRate: 6000, makingCharge: 1000, wastagePercent: 10, stoneValue: 0 }] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(67000);    // 60000 + 1000 + 6000
  });
});
