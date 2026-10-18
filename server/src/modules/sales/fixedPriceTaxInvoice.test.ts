import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice } from './sales.service';
import { createTagEstimate, sendEstimateToBilling, searchBillableEstimates } from '../tagging/estimation.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// PHF (fixed price per piece, Silver): tagging -> estimate -> save -> send to billing -> billable-estimate search -> tax invoice.
// The saved GST-exclusive price must survive every hop; GST is added once, by the HSN master rate.
describe('fixed price per piece (silver) - estimate -> send to billing -> tax invoice', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let clientId = ''; let fixedCat = ''; let weightCat = ''; let seq = 0; let gstRate = 0.03;
  const estimateIds: string[] = []; const invoiceIds: string[] = [];

  async function makeTag(fixed: boolean, price = 750) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `PHFB-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'PHF', metalType: 'SILVER', metalKarat: '925',
        grossWeight: 12.5, netWeight: 12.5, costPrice: 500, sellingPrice: fixed ? price : 1, status: 'IN_STOCK', createdById: A.user.id,
        categoryId: fixed ? fixedCat : weightCat,
        ...(fixed ? { pricingMode: 'FIXED_PRICE_PER_PIECE' } : { saleMcRate: 10, saleVaPercent: 5 }),
      },
    });
    await prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, code: 'S925', materialType: 'METAL', weight: 12.5, saleRate: 1 } as any });
    return tag;
  }
  const customer = () => ({ customerName: 'E2E Test', customerPhone: '9999900000', salesPersonId: A.user.id });

  beforeAll(async () => {
    A = await createTestTenant(`PHB${suffix}`, ['invoice:create', 'estimation:manage', 'masters:view']);
    await seedMetalRate(A.company.id, '925', 90);
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `PHBC-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
    fixedCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'PHF', name: 'PHF', pricingMode: 'FIXED_PRICE_PER_PIECE' } })).id;
    weightCat = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'SLV', name: 'Silver chain' } })).id;
    gstRate = Number((await prisma.hsnCode.findFirstOrThrow({ where: { code: '7113' } })).gstRate);
  }, 60_000);

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { clientId } });
    const tags = await prisma.jewelryTag.findMany({ where: { companyId: A.company.id }, select: { id: true } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tags.map((t) => t.id) } } });
    await prisma.jewelryTag.deleteMany({ where: { companyId: A.company.id } });
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  // Exactly what NewSalePage's estimateInvoiceLine sends for an estimate-backed row.
  const billLine = (tagId: string, est: any, over: object = {}) => ({
    productCode: 'PHF', description: 'PHF', quantity: 1, grossWeight: 12.5, netGoldWeight: 12.5, rateType: 'FIXED',
    goldRate: Number(est.totalSaleAmount), makingCharge: 0, wastagePercent: 0, stoneValue: 0, tagId,
    materialBreakdown: { rows: est.items.map((i: any) => ({ code: i.code, materialType: i.materialType, name: i.name, weight: Number(i.weight), unit: i.unit, rate: Number(i.saleRate) })), mcRate: 0, vaPercent: 0 },
    ...over,
  });
  const bill = (items: any[], extra: object = {}) =>
    createInvoice({ branchId: A.branch.id, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items, ...extra } as any, A.ctx, A.user.id);

  it('send to billing keeps the fixed price and billable search exposes pricingMode', async () => {
    const tag = await makeTag(true);
    const est = await createTagEstimate(tag.id, { items: [{ code: 'S925', materialType: 'METAL', weight: 12.5, saleRate: 90 }], saleMcRate: 10, saleVaPercent: 5, sendToBilling: true, ...customer() } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    expect(est.status).toBe('SENT');
    expect(Number(est.totalSaleAmount)).toBe(750);
    const found = (await searchBillableEstimates(A.ctx, est.estimateNumber)).find((e: any) => e.id === est.id) as any;
    expect(found.tag.pricingMode).toBe('FIXED_PRICE_PER_PIECE');
    expect(Number(found.totalSaleAmount)).toBe(750);
  });

  it('estimate -> tax invoice: taxable 750, GST once from the HSN master, total reconciles, estimate INVOICED, tag price intact', async () => {
    const tag = await makeTag(true);
    const est = await createTagEstimate(tag.id, { items: [{ code: 'S925', materialType: 'METAL', weight: 12.5, saleRate: 90 }], saleMcRate: 10, saleVaPercent: 5, ...customer() } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    await sendEstimateToBilling(A.ctx, est.id, customer() as any, A.user.id);
    const inv = await bill([billLine(tag.id, est)], { estimateIds: [est.id] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(750);
    expect(Number(inv.items[0].taxRate)).toBeCloseTo(gstRate, 6);
    expect(Number(inv.subtotal)).toBe(750);
    expect(Number(inv.taxAmount)).toBeCloseTo(750 * gstRate, 2);
    expect(Number(inv.totalAmount)).toBe(Math.round(750 * (1 + gstRate)));
    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv.id } });
    expect(Number(tax.taxableAmount)).toBe(750);
    expect(Number(tax.cgst) + Number(tax.sgst) + Number(tax.igst)).toBeCloseTo(750 * gstRate, 2);
    expect(Number(tax.totalTax)).toBeCloseTo(750 * gstRate, 2);
    expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe('INVOICED');
    const after = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(after.status).toBe('SOLD');
    expect(Number(after.sellingPrice)).toBe(750);
  });

  it('a stale or hand-edited client price cannot change the invoice: the saved price wins', async () => {
    const tag = await makeTag(true);
    const est = await createTagEstimate(tag.id, { items: [], ...customer() } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    await sendEstimateToBilling(A.ctx, est.id, customer() as any, A.user.id);
    const inv = await bill([billLine(tag.id, est, { goldRate: 1125, makingCharge: 181.25, stoneValue: 0 })], { estimateIds: [est.id] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBe(750);
  });

  it('invoice discount reduces the taxable value, then GST is on the reduced value', async () => {
    const tag = await makeTag(true);
    const est = await createTagEstimate(tag.id, { items: [], ...customer() } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    const inv = await bill([billLine(tag.id, est)], { discountAmount: 50 });
    invoiceIds.push(inv.id);
    expect(Number(inv.subtotal) - Number(inv.discountAmount)).toBe(700);
    expect(Number(inv.taxAmount)).toBeCloseTo(700 * gstRate, 2);
    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv.id } });
    expect(Number(tax.taxableAmount)).toBe(700);
  });

  it('weight-based silver: estimate -> invoice still prices from live rate + MC + VA', async () => {
    const tag = await makeTag(false);
    const est = await createTagEstimate(tag.id, { items: [{ code: 'S925', materialType: 'METAL', weight: 12.5, saleRate: 90 }], saleMcRate: 10, saleVaPercent: 5, ...customer() } as any, A.ctx, A.user.id);
    estimateIds.push(est.id);
    expect(Number(est.totalSaleAmount)).toBeCloseTo(1306.25, 2);
    await sendEstimateToBilling(A.ctx, est.id, customer() as any, A.user.id);
    const inv = await bill([{
      productCode: 'SLV', description: 'SLV', quantity: 1, grossWeight: 12.5, netGoldWeight: 12.5, rateType: 'FIXED', goldRate: 1306.25, tagId: tag.id,
      materialBreakdown: { rows: [{ code: 'S925', materialType: 'METAL', name: 'S925', weight: 12.5, rate: 90 }], mcRate: 10, vaPercent: 5 },
    }], { estimateIds: [est.id] });
    invoiceIds.push(inv.id);
    expect(Number(inv.items[0].totalPrice)).toBeCloseTo(1306.25, 2);
    expect(Number(inv.taxAmount)).toBeCloseTo(1306.25 * gstRate, 2);
  });
});
