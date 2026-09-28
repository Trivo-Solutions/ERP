import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createInvoice as _createInvoice, recordClientPayment, recordPayment, createMemoOut, convertMemoToInvoice, reverseInvoicePayment } from './sales.service';
import { createClient, updateClient } from '../orders/orders.service';
import { normalizePan, panFromGstin, assertPanIfRequired, CASH_RECEIPT_LIMIT, PAN_REQUIRED_ABOVE } from '../../shared/compliance';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Two statutory checks at the counter: PAN on a sale above ₹2,00,000 (Rule 114B) and the ₹2,00,000-a-day
// cash-receipt ceiling (Sec 269ST).
describe('PAN and cash-receipt compliance', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const memoIds: string[] = [];
  const paymentIds: string[] = [];

  const createInvoice = (data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'>) =>
    _createInvoice({ branchId, ...data }, tenant.ctx, userId);

  // One free-text line whose price is exactly `price` (FIXED rate) — total tax adds 3% on top.
  const line = (price: number) => ({
    productCode: 'X', description: 'Item', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: price,
  });

  async function makeClient(extra: Record<string, unknown> = {}) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `CMP-${suffix}-${clientIds.length}`, name: `Client ${clientIds.length}`, type: 'RETAIL', ...extra },
    });
    clientIds.push(c.id);
    return c;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`CMP${suffix}`, ['invoice:create', 'memo:manage', 'order:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
  });

  afterAll(async () => {
    const pays = await prisma.invoicePayment.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
    await cleanupJournalEntries([...invoiceIds, ...pays.map((p) => p.id), ...paymentIds]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.salesInvoice.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.memoItem.deleteMany({ where: { memoId: { in: memoIds } } });
    await prisma.memoOut.deleteMany({ where: { id: { in: memoIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('PAN helpers', () => {
    it('normalises case and whitespace, treats blank as no PAN, and rejects a malformed one', () => {
      expect(normalizePan(' abcde1234f ')).toBe('ABCDE1234F');
      expect(normalizePan('')).toBeNull();
      expect(normalizePan(undefined)).toBeNull();
      expect(() => normalizePan('ABCDE12345')).toThrow(/PAN must be/);
      expect(() => normalizePan('1234567890')).toThrow(/PAN must be/);
    });

    it('reads the PAN embedded in a GSTIN (characters 3-12)', () => {
      expect(panFromGstin('24ABCDE1234F1Z5')).toBe('ABCDE1234F');
      expect(panFromGstin('not a gstin')).toBeNull();
      expect(panFromGstin(null)).toBeNull();
    });
  });

  describe('client master', () => {
    it('stores an upper-cased PAN, refuses a malformed one, and clears it with a blank', async () => {
      const c = await createClient(tenant.company.id, { name: 'PAN Client', type: 'RETAIL', panNumber: 'abcde1234f' });
      clientIds.push(c.id);
      expect(c.panNumber).toBe('ABCDE1234F');

      await expect(updateClient(c.id, tenant.company.id, { panNumber: 'nope' })).rejects.toThrow(/PAN must be/);
      expect((await updateClient(c.id, tenant.company.id, { panNumber: '' })).panNumber).toBeNull();
      expect((await updateClient(c.id, tenant.company.id, { form60Received: true })).form60Received).toBe(true);
    });

    it('ignores fields that are not hand-editable (a balance is only moved by invoices and payments)', async () => {
      const c = await createClient(tenant.company.id, { name: 'Sneaky', type: 'RETAIL', currentBalance: 999999 } as any);
      clientIds.push(c.id);
      expect(Number(c.currentBalance)).toBe(0);
      const u = await updateClient(c.id, tenant.company.id, { currentBalance: 5, name: 'Renamed' } as any);
      expect(Number(u.currentBalance)).toBe(0);
      expect(u.name).toBe('Renamed');
    });
  });

  describe('Rule 114B — PAN on a sale above ₹2,00,000', () => {
    it('refuses a sale above the threshold when the client has no PAN, GSTIN or Form 60 — and books nothing', async () => {
      const client = await makeClient();
      await expect(
        createInvoice({ clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(250000)] })
      ).rejects.toThrow(/PAN required/);
      expect(await prisma.salesInvoice.count({ where: { clientId: client.id } })).toBe(0);
    });

    it('lets it through with a PAN, with a Form 60, or with a GSTIN (which carries the PAN)', async () => {
      for (const extra of [{ panNumber: 'ABCDE1234F' }, { form60Received: true }, { gstNumber: '24ABCDE1234F1Z5' }]) {
        const client = await makeClient(extra);
        const inv = await createInvoice({ clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(250000)] });
        invoiceIds.push(inv.id);
        expect(Number(inv.subtotal)).toBe(250000);
      }
    });

    it('needs nothing at or below the threshold — "exceeding ₹2,00,000", not "reaching" it', async () => {
      const client = await makeClient();
      // 194,000 + 3% GST = 199,820: under the threshold, so no PAN is asked for
      const inv = await createInvoice({ clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(194000)] });
      invoiceIds.push(inv.id);
      expect(Number(inv.totalAmount)).toBeLessThanOrEqual(PAN_REQUIRED_ABOVE);
    });

    it('is decided on the invoice total including GST', async () => {
      const client = await makeClient();
      // 195,000 + 3% GST = 200,850 > 200,000 even though the goods alone are under it
      await expect(
        createInvoice({ clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(195000)] })
      ).rejects.toThrow(/PAN required/);
    });

    it('applies to a memo conversion as well', async () => {
      const client = await makeClient();
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `CMPTAG-${suffix}`, companyId: tenant.company.id, branchId, name: 'Memo ring', metalType: 'GOLD', metalKarat: '22K',
          grossWeight: 10, netWeight: 10, costPrice: 100000, sellingPrice: 300000, createdById: userId,
        },
      });
      tagIds.push(tag.id);
      const memo = await createMemoOut({
        clientId: client.id, branchId, sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86_400_000),
        items: [{
          productCode: tag.tagNumber, description: 'Memo ring', pieces: 1,
          grossWeight: 10, netGoldWeight: 10, estimatedValue: 300000, tagId: tag.id,
        }],
      }, tenant.ctx, userId);
      memoIds.push(memo.id);

      await expect(
        convertMemoToInvoice(memo.id, [{ tagId: tag.id, sellingPrice: 300000 }], tenant.ctx, userId)
      ).rejects.toThrow(/PAN required/);
      // the piece is still out on memo — nothing half-done
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('ON_APPROVAL');
    });

    it('assertPanIfRequired is a plain function of (client, amount)', () => {
      const bare = { name: 'X', panNumber: null, gstNumber: null, form60Received: false };
      expect(() => assertPanIfRequired(bare, PAN_REQUIRED_ABOVE)).not.toThrow();
      expect(() => assertPanIfRequired(bare, PAN_REQUIRED_ABOVE + 1)).toThrow(/PAN required/);
      expect(() => assertPanIfRequired({ ...bare, panNumber: 'ABCDE1234F' }, 5_000_000)).not.toThrow();
    });
  });

  describe('Sec 269ST — cash receipts of ₹2,00,000 or more in a day', () => {
    // A client with a PAN, so only the cash rule is in play.
    const cashClient = () => makeClient({ panNumber: 'ABCDE1234F' });
    const today = () => new Date();

    it('refuses a single cash payment of the limit or more, and leaves the whole sale un-booked', async () => {
      const client = await cashClient();
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `CASHTAG-${suffix}-1`, companyId: tenant.company.id, branchId, name: 'Cash ring', metalType: 'GOLD',
          grossWeight: 5, netWeight: 5, costPrice: 1000, sellingPrice: 300000, createdById: userId,
        },
      });
      tagIds.push(tag.id);

      await expect(
        createInvoice({
          clientId: client.id, invoiceDate: today(), invoiceType: 'RETAIL', items: [{ ...line(250000), tagId: tag.id }],
          payments: [{ paymentDate: today(), amount: CASH_RECEIPT_LIMIT, mode: 'CASH' }],
        })
      ).rejects.toThrow(/Cash limit \(Sec 269ST\)/);

      // all-or-nothing: no invoice, no payment, and the tag was NOT flipped to SOLD
      expect(await prisma.salesInvoice.count({ where: { clientId: client.id } })).toBe(0);
      expect(await prisma.invoicePayment.count({ where: { clientId: client.id } })).toBe(0);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
    });

    it('accepts just under the limit in cash, and any amount by bank/UPI/card/cheque', async () => {
      const client = await cashClient();
      const inv = await createInvoice({
        clientId: client.id, invoiceDate: today(), invoiceType: 'RETAIL', items: [line(250000)],
        payments: [
          { paymentDate: today(), amount: CASH_RECEIPT_LIMIT - 1, mode: 'cash' },   // lower-case still counts as cash
          { paymentDate: today(), amount: 60000, mode: 'UPI' },
        ],
      });
      invoiceIds.push(inv.id);
      expect(Number(inv.paidAmount)).toBe(CASH_RECEIPT_LIMIT - 1 + 60000);
    });

    it('adds up cash across payments on the same day — including a later standalone advance', async () => {
      const client = await cashClient();
      const inv = await createInvoice({
        clientId: client.id, invoiceDate: today(), invoiceType: 'RETAIL', items: [line(50000)],
        payments: [{ paymentDate: today(), amount: 50000, mode: 'CASH' }],   // ₹50,000 cash
      });
      invoiceIds.push(inv.id);

      // +₹1,00,000 -> ₹1,50,000: fine
      const p1 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 100000, mode: 'CASH' }, tenant.ctx, userId);
      paymentIds.push(p1.id);
      // +₹50,000 more would make exactly ₹2,00,000: refused
      await expect(
        recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 50000, mode: 'CASH' }, tenant.ctx, userId)
      ).rejects.toThrow(/Cash limit \(Sec 269ST\).*₹1,50,000 already received/);
      // ...but ₹49,999 is fine, and the same amount by UPI never was a problem
      const p2 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 49999, mode: 'CASH' }, tenant.ctx, userId);
      paymentIds.push(p2.id);
      const p3 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 500000, mode: 'UPI' }, tenant.ctx, userId);
      paymentIds.push(p3.id);
    });

    it('is per client and per day: another client, or another day, starts from zero', async () => {
      const a = await cashClient();
      const b = await cashClient();
      const day1 = new Date('2026-03-10T10:00:00Z');
      const day2 = new Date('2026-03-11T10:00:00Z');

      const pa = await recordClientPayment({ clientId: a.id, paymentDate: day1, amount: 199999, mode: 'CASH' }, tenant.ctx, userId);
      paymentIds.push(pa.id);
      // a different client the same day
      paymentIds.push((await recordClientPayment({ clientId: b.id, paymentDate: day1, amount: 199999, mode: 'CASH' }, tenant.ctx, userId)).id);
      // the same client the next day
      paymentIds.push((await recordClientPayment({ clientId: a.id, paymentDate: day2, amount: 199999, mode: 'CASH' }, tenant.ctx, userId)).id);
      // ...but not the same day again
      await expect(
        recordClientPayment({ clientId: a.id, paymentDate: day1, amount: 1, mode: 'CASH' }, tenant.ctx, userId)
      ).rejects.toThrow(/Cash limit/);
    });

    it("draws the day boundary at midnight IST, not UTC", async () => {
      const client = await cashClient();
      // 23:00 IST on 20 Mar = 17:30 UTC on 20 Mar; 01:00 IST on 21 Mar = 19:30 UTC on 20 Mar — the SAME UTC date,
      // but two different business days. Each may take almost the full limit.
      paymentIds.push((await recordClientPayment({ clientId: client.id, paymentDate: new Date('2026-03-20T17:30:00Z'), amount: 199999, mode: 'CASH' }, tenant.ctx, userId)).id);
      paymentIds.push((await recordClientPayment({ clientId: client.id, paymentDate: new Date('2026-03-20T19:30:00Z'), amount: 199999, mode: 'CASH' }, tenant.ctx, userId)).id);
      // 02:00 IST and 10:00 IST on 21 Mar are one business day but two different UTC dates
      await expect(
        recordClientPayment({ clientId: client.id, paymentDate: new Date('2026-03-21T04:30:00Z'), amount: 1, mode: 'CASH' }, tenant.ctx, userId)
      ).rejects.toThrow(/Cash limit/);
    });

    it('also guards a payment recorded later against an existing invoice', async () => {
      const client = await cashClient();
      const inv = await createInvoice({ clientId: client.id, invoiceDate: today(), invoiceType: 'RETAIL', items: [line(300000)] });
      invoiceIds.push(inv.id);
      await expect(
        recordPayment({ invoiceId: inv.id, paymentDate: today(), amount: 250000, mode: 'CASH' }, tenant.ctx, userId)
      ).rejects.toThrow(/Cash limit/);
      await recordPayment({ invoiceId: inv.id, paymentDate: today(), amount: 250000, mode: 'BANK_TRANSFER' }, tenant.ctx, userId);
    });

    // J3.5 Finding 4: a reversed cash receipt didn't actually leave cash in hand — it must stop
    // counting toward the client's daily ceiling, without weakening the check for a still-active one.
    it('excludes a reversed cash payment from the daily total, but an active one still counts and still blocks', async () => {
      const client = await cashClient();

      const p1 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 150000, mode: 'CASH' }, tenant.ctx, userId);
      paymentIds.push(p1.id);

      // Without the fix, this would still fail: 150000 (reversed) + 199999 >= 200000.
      await reverseInvoicePayment(p1.id, tenant.ctx, userId, 'keyed against the wrong client');
      const p2 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 199999, mode: 'CASH' }, tenant.ctx, userId);
      paymentIds.push(p2.id);

      // No loophole: p2 is a real, active cash receipt — it still blocks a further cash payment the same day.
      await expect(
        recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 1, mode: 'CASH' }, tenant.ctx, userId)
      ).rejects.toThrow(/Cash limit \(Sec 269ST\).*₹1,99,999 already received/);

      // ...but a non-cash payment of any size is still fine, exactly as before.
      const p3 = await recordClientPayment({ clientId: client.id, paymentDate: today(), amount: 500000, mode: 'UPI' }, tenant.ctx, userId);
      paymentIds.push(p3.id);
    });
  });
});
