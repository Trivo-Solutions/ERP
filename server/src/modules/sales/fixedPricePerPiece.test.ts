import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice } from './sales.service';
import { getTagForEstimation, createTagEstimate } from '../tagging/estimation.service';
import { liveSaleValue, LIVE_VALUE_TAG_SELECT, loadLiveRates } from '../../shared/liveSaleValue';
import { cleanupJournalEntries } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../test/fixtures';

// Fixed Price per Piece: a category set to FIXED_PRICE_PER_PIECE tags pieces with a GST-EXCLUSIVE price that nothing recomputes.
// Illustrative: Rs 1,500 + GST at the default HSN's master rate (3% on the seeded 7113) = Rs 1,545.
describe('fixed price per piece - tag to estimate to bill', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant; let clientId = ''; let stockTypeId = ''; let fixedCat = ''; let weightCat = ''; let gstRate = 0.03;
  const invoiceIds: string[] = []; const estimateIds: string[] = [];
  let seq = 0;

  const bill = (data: any) => _createInvoice({ branchId: A.branch.id, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', ...data }, A.ctx, A.user.id);
  const line = (tagId: string, over: object = {}) => ({ productCode: 'FR', description: 'Frame', quantity: 1, grossWeight: 5, netGoldWeight: 4, tagId, ...over });
  // A fixed-price piece with a METAL material row (so any metal-rate leak would show up) and NO MC / VA / stone rates.
  async function makeFixed(price = 1500) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `FP-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Frame', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 4, costPrice: 900, sellingPrice: price, pricingMode: 'FIXED_PRICE_PER_PIECE', status: 'IN_STOCK', createdById: A.user.id,
        categoryId: fixedCat,
      },
    });
    await prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, code: 'G22', materialType: 'METAL', weight: 4, saleRate: 1 } as any });
    return tag;
  }
  async function makeWeighted() {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `WB-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Chain', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 10, costPrice: 40000, sellingPrice: 1, status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 100, saleVaPercent: 10, categoryId: weightCat,
      },
    });
    await prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, code: 'G22', materialType: 'METAL', weight: 10, saleRate: 1 } as any });
    return tag;
  }
  const tagBody = (over: object = {}) => ({
    branchId: A.branch.id, metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 4, stockTypeId, categoryId: fixedCat, ...over,
  });

  beforeAll(async () => {
    A = await createTestTenant(`FPA${suffix}`, ['invoice:create', 'estimation:manage', 'tag:create', 'masters:edit', 'masters:view', 'masters:create']);
    B = await createTestTenant(`FPB${suffix}`, ['masters:edit', 'masters:view']);
    await seedMetalRate(A.company.id, '22K', 6000);
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `FPCL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: 'ST', name: 'Stock' } })).id;
    fixedCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'FRM', name: 'Frames', pricingMode: 'FIXED_PRICE_PER_PIECE' } })).id;
    weightCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'CHN', name: 'Chains' } })).id;
    const hsn = await prisma.hsnCode.findFirstOrThrow({ where: { code: '7113' } });
    gstRate = Number(hsn.gstRate);
  }, 60_000);

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { clientId } });
    const created = await prisma.jewelryTag.findMany({ where: { companyId: A.company.id }, select: { id: true } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: created.map((t) => t.id) } } });
    await prisma.jewelryTag.deleteMany({ where: { companyId: A.company.id } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  it('defaults: an existing/new category and tag are WEIGHT_BASED', async () => {
    expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: weightCat } })).pricingMode).toBe('WEIGHT_BASED');
    expect((await makeWeighted()).pricingMode).toBe('WEIGHT_BASED');
  });

  it('bills Rs 1,500 + GST, unchanged when the metal rate moves (needs no MC/VA/stone rates)', async () => {
    const tag = await makeFixed(1500);
    const inv1 = await bill({ items: [line(tag.id)] });
    invoiceIds.push(inv1.id);
    expect(Number(inv1.items[0].totalPrice)).toBe(1500);
    expect(Number(inv1.taxAmount)).toBeCloseTo(1500 * gstRate, 2);
    expect(Number(inv1.totalAmount)).toBe(Math.round(1500 * (1 + gstRate)));
    await seedMetalRate(A.company.id, '22K', 9500);
    const tag2 = await makeFixed(1500);
    const inv2 = await bill({ items: [line(tag2.id)] });
    invoiceIds.push(inv2.id);
    expect(Number(inv2.items[0].totalPrice)).toBe(1500);
    expect(Number(inv2.totalAmount)).toBe(Number(inv1.totalAmount));
  });

  it('ignores client-sent rates / breakdown for a fixed-price tag (the saved price wins)', async () => {
    const tag = await makeFixed(1500);
    const inv = await bill({ items: [line(tag.id, { rateType: 'PER_GRAM', goldRate: 9999, makingCharge: 5000, wastagePercent: 20, materialBreakdown: { rows: [{ code: 'G22', materialType: 'METAL', name: 'x', weight: 4, rate: 9999 }], mcRate: 500, vaPercent: 20 } })] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(1500);
  });

  it('quantity 2 -> taxable 3,000, GST on it, total reconciles', async () => {
    const tag = await makeFixed(1500);
    const inv = await bill({ items: [line(tag.id, { quantity: 2 })] });
    invoiceIds.push(inv.id);
    expect(Number(inv.subtotal)).toBe(3000);
    expect(Number(inv.taxAmount)).toBeCloseTo(3000 * gstRate, 2);
    expect(Number(inv.totalAmount)).toBe(Math.round(3000 * (1 + gstRate)));
  });

  it('an invoice discount applies as usual and never touches the tag price', async () => {
    const tag = await makeFixed(1500);
    const inv = await bill({ items: [line(tag.id)], discountAmount: 100 });
    invoiceIds.push(inv.id);
    expect(Number(inv.subtotal) - Number(inv.discountAmount)).toBe(1400);
    expect(Number(inv.taxAmount)).toBeCloseTo(1400 * gstRate, 2);
    expect(Number((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).sellingPrice)).toBe(1500);
  });

  it('weight-based regression: a normal tag still prices from the live metal rate + MC + VA', async () => {
    const tag = await makeWeighted();
    const inv = await bill({ items: [line(tag.id, { grossWeight: 10, netGoldWeight: 10 })] });
    invoiceIds.push(inv.id);
    // 10 g x 9500 live + MC 100 x 10 + VA 10% of 95000
    expect(Number(inv.items[0].totalPrice)).toBe(95000 + 1000 + 9500);
  });

  it('estimate quotes the same fixed price; billing it reconciles to the same totals', async () => {
    const tag = await makeFixed(1500);
    const view = await getTagForEstimation(A.ctx, tag.id);
    expect(view.goldRate).toBeNull();
    const est = await createTagEstimate(tag.id, { items: [{ code: 'G22', materialType: 'METAL', weight: 4, saleRate: 9999 }], saleMcRate: 500, saleVaPercent: 20 }, A.ctx, A.user.id);
    estimateIds.push(est.id);
    expect(Number(est.totalSaleAmount)).toBe(1500);
    expect(Number(est.gstAmount)).toBeCloseTo(1500 * gstRate, 2);
    const inv = await bill({ items: [line(tag.id)] });
    invoiceIds.push(inv.id);
    expect(Number(inv.subtotal) - Number(inv.discountAmount)).toBe(Number(est.totalSaleAmount));
    expect(Number(inv.taxAmount)).toBeCloseTo(Number(est.gstAmount), 2);
  });

  it('offers do not apply to a fixed-price piece', async () => {
    const tag = await makeFixed(1500);
    await expect(createTagEstimate(tag.id, { items: [], applyOffer: true }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('live stock value is the fixed price, not a metal-rate figure', async () => {
    const tag = await makeFixed(1500);
    const row = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id }, select: LIVE_VALUE_TAG_SELECT });
    expect(liveSaleValue(row as any, await loadLiveRates(A.company.id, ['22K']))).toBe(1500);
    expect(liveSaleValue(row as any, new Map())).toBe(1500); // no rate on file at all - still priced
  });

  it('tagging: fixed category needs a positive price (0, negative, blank rejected) and snapshots the mode; no MC/VA/metal rate needed', async () => {
    const api = apiWith(tokenFor(A), app);
    for (const bad of [undefined, 0, -5, 'abc']) {
      const r = await api.post('/tagging/tags', tagBody({ sellingPrice: bad }));
      expect(r.status, String(bad)).toBe(400);
    }
    const ok = await api.post('/tagging/tags', tagBody({ sellingPrice: 1500 }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.pricingMode).toBe('FIXED_PRICE_PER_PIECE');
    expect(Number(ok.body.data.sellingPrice)).toBe(1500);
    expect(ok.body.data.saleMcRate).toBeNull();
    // later flipping the category does not reprice or re-mode the existing tag
    await prisma.productCategory.update({ where: { id: fixedCat }, data: { pricingMode: 'WEIGHT_BASED' } });
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: ok.body.data.id } })).pricingMode).toBe('FIXED_PRICE_PER_PIECE');
    await prisma.productCategory.update({ where: { id: fixedCat }, data: { pricingMode: 'FIXED_PRICE_PER_PIECE' } });
    // editing a fixed tag: bad price rejected, good price saved and not re-summed from materials
    const id = ok.body.data.id;
    expect((await api.patch(`/tagging/tags/${id}`, { sellingPrice: 0 })).status).toBe(400);
    expect((await api.patch(`/tagging/tags/${id}`, { sellingPrice: 1800 })).status).toBe(200);
    expect(Number((await prisma.jewelryTag.findUniqueOrThrow({ where: { id } })).sellingPrice)).toBe(1800);
  });

  it('a weight-based category still demands MC / VA at tagging', async () => {
    const api = apiWith(tokenFor(A), app);
    const r = await api.post('/tagging/tags', tagBody({ categoryId: weightCat, sellingPrice: 1500 }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/making charge/i);
  });

  it("category mode: validated, audited, and one company cannot change another company's category", async () => {
    const apiA = apiWith(tokenFor(A), app);
    expect((await apiA.patch(`/masters/categories/${weightCat}`, { pricingMode: 'BOGUS' })).status).toBe(400);
    expect((await apiA.patch(`/masters/categories/${weightCat}`, { pricingMode: 'FIXED_PRICE_PER_PIECE' })).status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, tableName: 'product_categories', recordId: weightCat } });
    expect(audit).toBeTruthy();
    await prisma.productCategory.update({ where: { id: weightCat }, data: { pricingMode: 'WEIGHT_BASED' } });
    const apiB = apiWith(tokenFor(B), app);
    const cross = await apiB.patch(`/masters/categories/${weightCat}`, { pricingMode: 'FIXED_PRICE_PER_PIECE' });
    expect(cross.status).toBe(404);
    expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: weightCat } })).pricingMode).toBe('WEIGHT_BASED');
  });
});
