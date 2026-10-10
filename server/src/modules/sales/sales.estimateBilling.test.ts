import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createInvoice as _createInvoice } from './sales.service';
import { createTagEstimate, sendEstimateToBilling, searchBillableEstimates } from '../tagging/estimation.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Estimate -> billing: an estimator sends a quote to the billing counter; the biller finds it by number / item /
// customer name, bills it (changing rates if need be) and the estimate is marked INVOICED exactly once.
describe('estimate -> invoice hand-off', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  const tagIds: string[] = [];
  const estimateIds: string[] = [];
  const invoiceIds: string[] = [];

  const createInvoice = (data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'>) =>
    _createInvoice({ branchId, ...data }, tenant.ctx, userId);

  async function makeTag(name: string, status = 'IN_STOCK') {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `EST-TAG-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, name,
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, huid: `HUID${suffix}${tagIds.length}`.toUpperCase().slice(0, 12),
        costPrice: 40000, sellingPrice: 70000, status, createdById: userId, saleMcRate: 0, saleVaPercent: 0,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // 10 g of gold at 6,000 = 60,000, + MC 500/g (5,000) + VA 10% of metal (6,000) = 71,000 before GST.
  async function estimateFor(tagId: string, extra: Record<string, unknown> = {}) {
    const e = await createTagEstimate(tagId, {
      items: [{ code: 'GOLD-22K', materialType: 'METAL', name: 'Gold 22K', weight: 10, saleRate: 6000 }],
      saleMcRate: 500, saleVaPercent: 10, ...extra,
    }, tenant.ctx, userId);
    estimateIds.push(e.id);
    return e;
  }

  // What "send to billing" now requires: the customer's name + mobile, and the sales employee attending them.
  const cust = () => ({ customerName: 'Walk-in Customer', customerPhone: '9876500000', salesPersonId: userId });

  // The line the billing screen builds from an estimate: the piece itself, priced as a flat (FIXED) amount.
  const billLine = (tag: { id: string; tagNumber: string; name: string }, price: number) => ({
    productCode: tag.tagNumber, description: tag.name, quantity: 1, grossWeight: 10, netGoldWeight: 10,
    rateType: 'FIXED', goldRate: price, tagId: tag.id,
  });

  beforeAll(async () => {
    tenant = await createTestTenant(`EST${suffix}`, ['invoice:create', 'estimation:manage', 'estimation:view']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    clientId = (await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `EST-CL-${suffix}`, name: 'Walk-in', type: 'RETAIL', panNumber: 'ABCDE1234F' },
    })).id;
  });

  afterAll(async () => {
    const pays = await prisma.invoicePayment.findMany({ where: { clientId }, select: { id: true } });
    await cleanupJournalEntries([...invoiceIds, ...pays.map((p) => p.id)]);
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId } });
    await prisma.salesInvoice.deleteMany({ where: { clientId } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('sending and finding', () => {
    it('a plain saved estimate is OPEN and is NOT offered to the billing counter', async () => {
      const tag = await makeTag('Open Necklace');
      const e = await estimateFor(tag.id);
      expect(e.status).toBe('OPEN');
      const found = await searchBillableEstimates(tenant.ctx, e.estimateNumber);
      expect(found).toHaveLength(0);
    });

    it('sending it makes it findable — by estimate number, item name, tag number, HUID, customer name and phone', async () => {
      const tag = await makeTag('Temple Haram');
      const e = await estimateFor(tag.id);
      const sent = await sendEstimateToBilling(tenant.ctx, e.id, { customerName: 'Ramesh Kumar', customerPhone: '9876500011', salesPersonId: userId }, userId);
      expect(sent.status).toBe('SENT');

      for (const q of [e.estimateNumber, e.estimateNumber.toLowerCase(), 'temple', tag.tagNumber, tag.huid!, 'ramesh', 'KUMAR', '98765']) {
        const found = await searchBillableEstimates(tenant.ctx, q);
        expect(found.map((f) => f.id), `query "${q}"`).toContain(e.id);
      }
      expect((await searchBillableEstimates(tenant.ctx, 'no-such-thing-zzz'))).toHaveLength(0);
    });

    it('can be saved and sent in one step, and carries what the billing screen needs (sale-side only)', async () => {
      const tag = await makeTag('Diamond Ring');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust(), customerName: 'Priya' });
      expect(e.status).toBe('SENT');

      const [found] = await searchBillableEstimates(tenant.ctx, 'Priya');
      expect(found.id).toBe(e.id);
      expect(found.customerName).toBe('Priya');
      expect(Number(found.totalSaleAmount)).toBeCloseTo(71000);
      expect(found.items[0]).toMatchObject({ code: 'GOLD-22K', materialType: 'METAL' });
      expect(found.tag).toMatchObject({ tagNumber: tag.tagNumber, name: 'Diamond Ring' });
      expect(found.createdBy?.id).toBe(userId); // the estimator — the billing screen pre-selects them as sales person
      expect(found.expired).toBe(false);

      // no cost data anywhere in the payload
      const json = JSON.stringify(found);
      expect(json).not.toMatch(/costRate|costAmount|totalCostAmount|costMcRate|costVaPercent|costPrice/);
    });

    it('will not send an estimate for a piece that is not in stock, and stops offering one whose piece has been sold', async () => {
      const soldTag = await makeTag('Sold Bangle', 'SOLD');
      const e1 = await estimateFor(soldTag.id);
      await expect(sendEstimateToBilling(tenant.ctx, e1.id, {}, userId)).rejects.toThrow(/only a piece that is in stock/);

      const tag = await makeTag('Sold Later Chain');
      const e2 = await estimateFor(tag.id, { sendToBilling: true, ...cust() });
      expect((await searchBillableEstimates(tenant.ctx, e2.estimateNumber)).map((f) => f.id)).toContain(e2.id);
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { status: 'SOLD' } });
      expect((await searchBillableEstimates(tenant.ctx, e2.estimateNumber))).toHaveLength(0);
    });

    describe('customer details taken at the hand-off', () => {
      const full = () => ({
        customerName: '  Sita Devi ', customerPhone: '+91 98765 00022', customerDob: '1990-04-15',
        customerAddress: ' 12 MG Road, Guntur ', customerPan: 'abcde1234f', salesPersonId: userId,
      });

      it('stores name, mobile, DOB, address, PAN and the sales employee — normalised — and hands them to billing', async () => {
        const tag = await makeTag('Details Chain');
        const e = await estimateFor(tag.id);
        const sent = await sendEstimateToBilling(tenant.ctx, e.id, full(), userId);
        expect(sent).toMatchObject({
          customerName: 'Sita Devi', customerPhone: '9876500022', customerAddress: '12 MG Road, Guntur',
          customerPan: 'ABCDE1234F', salesPersonId: userId,
        });
        expect(sent.customerDob?.toISOString().slice(0, 10)).toBe('1990-04-15');

        const [found] = await searchBillableEstimates(tenant.ctx, 'Sita');
        expect(found).toMatchObject({ customerPhone: '9876500022', customerPan: 'ABCDE1234F', salesPerson: { id: userId } });
        expect(found.customerDob?.toISOString().slice(0, 10)).toBe('1990-04-15');
      });

      it('save-and-send in one step takes the same details', async () => {
        const tag = await makeTag('Details Ring');
        const e = await estimateFor(tag.id, { sendToBilling: true, ...full() });
        expect(e).toMatchObject({ status: 'SENT', customerPhone: '9876500022', salesPersonId: userId });
      });

      it('refuses to send without a name, a mobile number or a sales employee — and leaves the estimate OPEN', async () => {
        const tag = await makeTag('Incomplete Bangle');
        const e = await estimateFor(tag.id);
        for (const [missing, re] of [
          ['customerName', /name is required/i], ['customerPhone', /mobile number is required/i], ['salesPersonId', /sales employee/i],
        ] as const) {
          await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), [missing]: '' }, userId), missing).rejects.toThrow(re);
        }
        await expect(estimateFor(tag.id, { sendToBilling: true, ...full(), customerPhone: undefined })).rejects.toThrow(/mobile number is required/i);
        expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('OPEN');
      });

      it('DOB, address and PAN are optional', async () => {
        const tag = await makeTag('Minimal Chain');
        const e = await estimateFor(tag.id);
        const sent = await sendEstimateToBilling(tenant.ctx, e.id, cust(), userId);
        expect(sent).toMatchObject({ status: 'SENT', customerDob: null, customerAddress: null, customerPan: null });
      });

      it('rejects a bad mobile, PAN or date of birth', async () => {
        const tag = await makeTag('Invalid Details Chain');
        const e = await estimateFor(tag.id);
        await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), customerPhone: '12345' }, userId)).rejects.toThrow(/10-digit/);
        await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), customerPan: 'ABCDE12345' }, userId)).rejects.toThrow(/PAN must be/);
        await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), customerDob: '2999-01-01' }, userId)).rejects.toThrow(/future/);
        await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), customerDob: 'not-a-date' }, userId)).rejects.toThrow(/valid date/);
      });

      it("only accepts a sales employee who belongs to this company", async () => {
        const other = await createTestTenant(`ESY${suffix}`, ['invoice:create']);
        try {
          const tag = await makeTag('Foreign Staff Chain');
          const e = await estimateFor(tag.id);
          await expect(sendEstimateToBilling(tenant.ctx, e.id, { ...full(), salesPersonId: other.user.id }, userId)).rejects.toThrow(/Sales employee not found/);
        } finally {
          await cleanupTestTenant(other);
        }
      });

      it('re-sending keeps what is already on the estimate unless corrected', async () => {
        const tag = await makeTag('Resend Chain');
        const e = await estimateFor(tag.id);
        await sendEstimateToBilling(tenant.ctx, e.id, full(), userId);
        const again = await sendEstimateToBilling(tenant.ctx, e.id, { customerAddress: '7 New Street' }, userId);
        expect(again).toMatchObject({ customerName: 'Sita Devi', customerPhone: '9876500022', customerAddress: '7 New Street', customerPan: 'ABCDE1234F' });
      });
    });

    it("never shows another company's estimate", async () => {
      const other = await createTestTenant(`ESX${suffix}`, ['invoice:create']);
      try {
        expect(await searchBillableEstimates(other.ctx, '')).toHaveLength(0);
        await expect(sendEstimateToBilling(other.ctx, estimateIds[0], {}, other.user.id)).rejects.toThrow(/not found/i);
      } finally {
        await cleanupTestTenant(other);
      }
    });
  });

  describe('billing an estimate', () => {
    it('bills it: the piece is sold, the estimate is INVOICED against the invoice, and it cannot be billed again', async () => {
      const tag = await makeTag('Billed Bangle');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust() });

      const inv = await createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id],
        items: [billLine(tag, Number(e.totalSaleAmount))],
      });
      invoiceIds.push(inv.id);

      expect(Number(inv.subtotal)).toBeCloseTo(71000);
      const after = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } });
      expect(after.status).toBe('INVOICED');
      expect(after.invoiceId).toBe(inv.id);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');

      expect(await searchBillableEstimates(tenant.ctx, e.estimateNumber)).toHaveLength(0);

      // A second bill against the same estimate is refused (the piece is sold too, but the estimate says so first).
      const tag2 = await makeTag('Substitute');
      await expect(
        createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], items: [billLine(tag2, 1000)] })
      ).rejects.toThrow(/not awaiting billing|not on this invoice/);
    });

    it('lets the biller change the price on the way through — the invoice takes the new number, the quote is untouched', async () => {
      const tag = await makeTag('Negotiated Ring');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust() });

      const inv = await createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id],
        items: [billLine(tag, 65000)], // a rate/row edited down at billing
      });
      invoiceIds.push(inv.id);

      expect(Number(inv.subtotal)).toBe(65000);
      const quote = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } });
      expect(Number(quote.totalSaleAmount)).toBeCloseTo(71000); // what was quoted is history
    });

    it('supports billing the estimate alongside other lines on the same invoice (add / delete items freely)', async () => {
      const tag = await makeTag('Estimate ring');
      const extra = await makeTag('Extra pendant');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust() });

      const inv = await createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id],
        items: [billLine(tag, 71000), billLine(extra, 12000)],
      });
      invoiceIds.push(inv.id);
      expect(inv.items).toHaveLength(2);
      expect(Number(inv.subtotal)).toBe(83000);
    });

    it('refuses an estimate whose piece is not on the invoice — and books nothing', async () => {
      const quoted = await makeTag('Quoted piece');
      const other = await makeTag('Some other piece');
      const e = await estimateFor(quoted.id, { sendToBilling: true, ...cust() });

      await expect(
        createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], items: [billLine(other, 5000)] })
      ).rejects.toThrow(/not on this invoice/);

      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('IN_STOCK');
      expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('SENT');
    });

    it('refuses an estimate that was never sent to billing', async () => {
      const tag = await makeTag('Never sent');
      const e = await estimateFor(tag.id);
      await expect(
        createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], items: [billLine(tag, 71000)] })
      ).rejects.toThrow(/not awaiting billing \(OPEN\)/);
    });

    it("rejects another company's estimate id as not found", async () => {
      const other = await createTestTenant(`ESY${suffix}`, ['invoice:create']);
      try {
        const tag = await makeTag('Mine');
        await expect(
          _createInvoice({
            branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [estimateIds[0]],
            items: [billLine(tag, 100)],
          }, other.ctx, other.user.id)
        ).rejects.toThrow(/not found/i);
      } finally {
        await cleanupTestTenant(other);
      }
    });

    it('is all-or-nothing: a sale that fails later leaves the estimate SENT and the piece IN_STOCK', async () => {
      const tag = await makeTag('Rolled back');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust() });
      // ₹2,00,000 in cash trips the Sec 269ST check inside the same transaction, after the estimate was flipped
      await expect(
        createInvoice({
          clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], items: [billLine(tag, 200000)],
          payments: [{ paymentDate: new Date(), amount: 200000, mode: 'CASH' }],
        })
      ).rejects.toThrow(/Cash limit/);

      expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('SENT');
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect((await searchBillableEstimates(tenant.ctx, e.estimateNumber)).map((f) => f.id)).toContain(e.id);
    });

    it('two counters billing the same estimate at once: exactly one wins', async () => {
      const tag = await makeTag('Contested piece');
      const e = await estimateFor(tag.id, { sendToBilling: true, ...cust() });

      const attempt = () => createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], items: [billLine(tag, 71000)],
      });
      const results = await Promise.allSettled([attempt(), attempt()]);
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      invoiceIds.push((won[0] as PromiseFulfilledResult<{ id: string }>).value.id);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('INVOICED');
    });
  });
});
