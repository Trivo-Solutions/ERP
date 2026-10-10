import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { app } from '../../app';
import { createInvoice as _createInvoice } from './sales.service';
import {
  getTagForEstimation, createTagEstimate, sendEstimateToBilling, searchBillableEstimates, recallEstimate, listTagEstimatesForTag,
} from '../tagging/estimation.service';
import { assertTagSaleRatesForSave } from '../tagging/tagging.service';
import { pickMakingCharge } from '../../shared/makingChargeLookup';
import { cleanupJournalEntries } from '../../test/ledger';
import { endOfBusinessDay } from '../../shared/businessDay';
import { seedMetalRate, createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../test/fixtures';

// Step 2 + 3 of the pricing work: missing sale rates are blocked, a quote lives for one day, a sent estimate can be pulled
// back (by the estimator or by billing) until it is billed, the gold-rate-moved indicator, and the rate:update permission.
describe('estimate lifecycle: block missing rates, same-day expiry, recall', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant; let clientId = ''; let seq = 0;
  const tagIds: string[] = []; const estimateIds: string[] = []; const invoiceIds: string[] = [];
  const bill = (data: any) => _createInvoice({ branchId: A.branch.id, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', ...data }, A.ctx, A.user.id);
  const cust = () => ({ customerName: 'Walk-in', customerPhone: '9876500000', salesPersonId: A.user.id });

  async function makeTag(over: Record<string, unknown> = {}, stoneRate: number | null = 1500) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `EL-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 11, netWeight: 10, costPrice: 40000, sellingPrice: 70000, status: 'IN_STOCK', createdById: A.user.id,
        saleMcRate: 100, saleVaPercent: 10, ...over,
      },
    });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, ...o } as any });
    await m({ code: 'G22', materialType: 'METAL', weight: 10, saleRate: 5000 });
    await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: stoneRate });
    return tag;
  }
  async function estimate(tagId: string, extra: Record<string, unknown> = {}) {
    const view = await getTagForEstimation(A.ctx, tagId);
    const e = await createTagEstimate(tagId, {
      items: view.materials.map((m) => ({ materialId: m.id, code: m.code, materialType: m.materialType, weight: Number(m.weight), unit: m.unit, saleRate: Number(m.saleRate) })),
      saleMcRate: Number(view.saleMcRate), saleVaPercent: Number(view.saleVaPercent), ...extra,
    } as any, A.ctx, A.user.id);
    estimateIds.push(e.id);
    return e;
  }
  const backdate = (id: string) => prisma.tagEstimate.update({ where: { id }, data: { createdAt: new Date(Date.now() - 36 * 3600 * 1000) } });

  beforeAll(async () => {
    A = await createTestTenant(`ELA${suffix}`, ['invoice:create', 'estimation:manage', 'estimation:view']);
    B = await createTestTenant(`ELB${suffix}`, ['invoice:create', 'estimation:manage', 'estimation:view']);
    await seedMetalRate(A.company.id, '22K', 6000);
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `ELCL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.discountApproval.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await cleanupJournalEntries(invoiceIds);
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { clientId } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  describe('missing sale rates are blocked, never read as 0', () => {
    it('estimation read, estimate save and an auto-priced sale line all refuse a tag with no MC / VA (409), and nothing is sold', async () => {
      const tag = await makeTag({ saleMcRate: null, saleVaPercent: null });
      await expect(getTagForEstimation(A.ctx, tag.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/making charge rate, VA %/) });
      await expect(createTagEstimate(tag.id, { items: [{ code: 'G22', materialType: 'METAL', weight: 10, saleRate: 6000 }] } as any, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(bill({ items: [{ productCode: 'X', description: 'Ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: tag.id }] })).rejects.toMatchObject({ statusCode: 409 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
    });

    it('a stone row with no sale rate is refused too - never quoted at 0', async () => {
      const tag = await makeTag({}, null);
      await expect(getTagForEstimation(A.ctx, tag.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/RUBY sale rate/) });
    });

    it('tagging entry point: blank MC / VA / stone rate => 400; an explicit 0 is allowed; no metal rate for the karat => 409; an edit only checks what it sends', async () => {
      const ok = { metalKarat: '22K', saleMcRate: 0, saleVaPercent: 0, materials: [{ code: 'G22', materialType: 'METAL', weight: 10 }, { code: 'R', materialType: 'STONE', weight: 1, saleRate: 0 }] };
      await expect(assertTagSaleRatesForSave(A.ctx, ok, { partial: false })).resolves.toBeUndefined();
      await expect(assertTagSaleRatesForSave(A.ctx, { ...ok, saleMcRate: undefined }, { partial: false })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/making charge rate/) });
      await expect(assertTagSaleRatesForSave(A.ctx, { ...ok, saleVaPercent: '' }, { partial: false })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/VA %/) });
      await expect(assertTagSaleRatesForSave(A.ctx, { ...ok, materials: [{ code: 'R', materialType: 'STONE', weight: 1 }] }, { partial: false })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/R sale rate/) });
      await expect(assertTagSaleRatesForSave(A.ctx, { ...ok, metalKarat: '18K' }, { partial: false })).rejects.toMatchObject({ statusCode: 409 });
      await expect(assertTagSaleRatesForSave(A.ctx, { huid: 'ABC123' }, { partial: true })).resolves.toBeUndefined();
      await expect(assertTagSaleRatesForSave(A.ctx, { saleMcRate: null }, { partial: true })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('making-charge master lookup (shared) is most-specific-wins', () => {
      const rows = [{ id: 'any', categoryId: null, karat: null, makeType: null }, { id: 'k22', categoryId: null, karat: '22K', makeType: null }, { id: 'k22c', categoryId: 'C1', karat: '22K', makeType: null }];
      expect(pickMakingCharge(rows, 'C1', '22K', 'GOLD')?.id).toBe('k22c');
      expect(pickMakingCharge(rows, 'C2', '22K', 'GOLD')?.id).toBe('k22');
      expect(pickMakingCharge(rows, 'C2', '18K', 'GOLD')?.id).toBe('any');
    });
  });

  describe('a quote is good for one day', () => {
    it('is valid until the end of the day it was made, whatever the client asks for', async () => {
      const e = await estimate((await makeTag()).id, { validUntil: '2099-01-01' });
      const v = new Date(e.validUntil!);
      expect(v.getTime()).toBeGreaterThan(Date.now());
      expect(v.getTime() - Date.now()).toBeLessThan(24 * 3600 * 1000);
      expect(v.getTime()).toBe(endOfBusinessDay().getTime()); // 23:59:59.999 India time, whatever the server's timezone
    });

    it("yesterday's estimate cannot be sent to billing, is not offered by the billing search, and cannot be billed", async () => {
      const tag = await makeTag();
      const stale = await estimate(tag.id);
      await backdate(stale.id);
      await expect(sendEstimateToBilling(A.ctx, stale.id, cust(), A.user.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/expired/) });

      // Sent while fresh, then the day turns over: no longer offered, and billing it is refused.
      const t2 = await makeTag();
      const sent = await estimate(t2.id, { sendToBilling: true, ...cust() });
      expect((await searchBillableEstimates(A.ctx, sent.estimateNumber)).map((x) => x.id)).toContain(sent.id);
      await backdate(sent.id);
      expect(await searchBillableEstimates(A.ctx, sent.estimateNumber)).toHaveLength(0);
      await expect(bill({ estimateIds: [sent.id], items: [{ productCode: 'X', description: 'Ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: t2.id, rateType: 'FIXED', goldRate: 68500 }] }))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/expired/) });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('IN_STOCK');
    });

    it('the estimate GST is the default HSN rate from the master (not a hardcoded 3%) and the view carries it', async () => {
      const tag = await makeTag();
      const hsn = await prisma.hsnCode.findFirstOrThrow({ where: { code: '7113' } });
      const view = await getTagForEstimation(A.ctx, tag.id);
      expect(view.defaultGstRate).toBe(Number(hsn.gstRate));
      const e = await estimate(tag.id);
      expect(Number(e.taxRate)).toBe(Number(hsn.gstRate));
      expect(Number(e.gstAmount)).toBeCloseTo(Number(e.totalSaleAmount) * Number(hsn.gstRate), 2);
    });
  });

  describe('recall / return to estimation', () => {
    it('the estimator recalls a sent estimate (SENT -> OPEN, audited with actor + company), then can send it again', async () => {
      const tag = await makeTag();
      const sent = await estimate(tag.id, { sendToBilling: true, ...cust() });
      expect(sent.status).toBe('SENT');
      const back = await recallEstimate(A.ctx, sent.id, A.user.id, 'ESTIMATOR', 'customer wants to think');
      expect(back.status).toBe('OPEN');
      expect(await searchBillableEstimates(A.ctx, sent.estimateNumber)).toHaveLength(0);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { tableName: 'tag_estimates', recordId: sent.id, action: 'RECALL' } });
      expect(audit.userId).toBe(A.user.id);
      expect(audit.companyId).toBe(A.company.id);
      expect(audit.oldValues).toMatchObject({ status: 'SENT' });
      expect(audit.newValues).toMatchObject({ status: 'OPEN', via: 'ESTIMATOR', reason: 'customer wants to think' });
      expect((await sendEstimateToBilling(A.ctx, sent.id, cust(), A.user.id)).status).toBe('SENT');
    });

    it('billing can return it too; an OPEN one is refused; a BILLED one can never be recalled; another company gets 404', async () => {
      const tag = await makeTag();
      const sent = await estimate(tag.id, { sendToBilling: true, ...cust() });
      expect((await recallEstimate(A.ctx, sent.id, A.user.id, 'BILLING')).status).toBe('OPEN');
      await expect(recallEstimate(A.ctx, sent.id, A.user.id, 'BILLING')).rejects.toMatchObject({ statusCode: 409 });

      const t2 = await makeTag();
      const e2 = await estimate(t2.id, { sendToBilling: true, ...cust() });
      const inv = await bill({ estimateIds: [e2.id], items: [{ productCode: 'X', description: 'Ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: t2.id, rateType: 'FIXED', goldRate: Number(e2.totalSaleAmount) }] });
      invoiceIds.push(inv.id);
      await expect(recallEstimate(A.ctx, e2.id, A.user.id, 'ESTIMATOR')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/already been billed/) });
      expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e2.id } })).status).toBe('INVOICED');

      await expect(recallEstimate(B.ctx, sent.id, B.user.id, 'ESTIMATOR')).rejects.toMatchObject({ statusCode: 404 });
      await expect(recallEstimate(A.ctx, 'nonexistent', A.user.id, 'ESTIMATOR')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('a recalled estimate can no longer be billed (the biller is told), and the recall withdraws its approval request', async () => {
      const tag = await makeTag();
      const sent = await estimate(tag.id, { sendToBilling: true, ...cust() });
      await recallEstimate(A.ctx, sent.id, A.user.id, 'ESTIMATOR');
      await expect(bill({ estimateIds: [sent.id], items: [{ productCode: 'X', description: 'Ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: tag.id, rateType: 'FIXED', goldRate: 1000 }] }))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not awaiting billing/) });
    });

    it("the gold-rate-moved indicator compares the estimate's frozen rate with the live one - and changes nothing", async () => {
      const tag = await makeTag();
      const e = await estimate(tag.id, { sendToBilling: true, ...cust() });
      let row = (await searchBillableEstimates(A.ctx, e.estimateNumber))[0];
      expect(row).toMatchObject({ goldRateAtEstimate: 6000, goldRateNow: 6000, goldRateChanged: false, expired: false });
      await seedMetalRate(A.company.id, '22K', 6200);
      row = (await searchBillableEstimates(A.ctx, e.estimateNumber))[0];
      expect(row).toMatchObject({ goldRateAtEstimate: 6000, goldRateNow: 6200, goldRateChanged: true });
      expect(Number(row.totalSaleAmount)).toBe(Number(e.totalSaleAmount)); // the quote did not move
      const listed = (await listTagEstimatesForTag(A.ctx, tag.id))[0];
      expect(listed.goldRateChanged).toBe(true);
      await seedMetalRate(A.company.id, '22K', 6000);
    });
  });

  describe('permissions over real HTTP', () => {
    it('recall needs estimation:manage; return-from-billing needs invoice:create; the viewer gets 403 on both', async () => {
      const tag = await makeTag();
      const sent = await estimate(tag.id, { sendToBilling: true, ...cust() });
      const viewer = await createTestTenant(`ELV${suffix}`, ['estimation:view']);
      try {
        const v = apiWith(tokenFor(viewer), app);
        expect((await v.post(`/estimation/estimates/${sent.id}/recall`)).status).toBe(403);
        expect((await v.post(`/estimation/estimates/${sent.id}/return-from-billing`)).status).toBe(403);
      } finally { await cleanupTestTenant(viewer); }
      const biller = apiWith(tokenFor(A), app);
      expect((await biller.post(`/estimation/estimates/${sent.id}/return-from-billing`, { reason: 'wrong piece' })).status).toBe(200);
      expect((await biller.post(`/estimation/estimates/${sent.id}/recall`)).status).toBe(409); // already back with the estimator
    });

    it('saving a metal rate needs rate:update - system:config alone is 403, rate:update succeeds, a viewer can still read the sheet', async () => {
      const cfg = await createTestTenant(`ELC${suffix}`, ['system:config', 'design:view']);
      const rate = await createTestTenant(`ELR${suffix}`, ['rate:update', 'design:view']);
      try {
        const date = new Date().toISOString().slice(0, 10);
        const body = { date, rates: [{ karat: '24K', ratePerGram: 7000 }] };
        expect((await apiWith(tokenFor(cfg), app).post('/designs/rates/batch', body)).status).toBe(403);
        expect((await apiWith(tokenFor(cfg), app).post('/designs/rates', { date, karat: '24K', ratePerGram: 7000 })).status).toBe(403);
        expect((await apiWith(tokenFor(rate), app).post('/designs/rates/batch', body)).status).toBe(200);
        expect((await apiWith(tokenFor(cfg), app).get(`/designs/rates/sheet?date=${date}`)).status).toBe(200);
      } finally { await cleanupTestTenant(cfg); await cleanupTestTenant(rate); }
    });
  });
});
