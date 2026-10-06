import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // fixtures/verification as the platform role; the code under test uses the runtime client
import { createInvoice, createMaterialPurchase, listMaterialPurchases, reverseInvoicePayment, getClientCredit } from './sales.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { getJournalEntry, lineAmount } from '../../test/ledger';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';

// Material Purchase (non-tagged old gold at a tested purity, valued off the 24K Old Gold rate) -> Store Credit, and
// Store Credit as the payment on a tax invoice. The one rule under all of it: the physical metal is bought ONCE; spending
// the credit afterwards never books another purchase, vault movement or credit.
describe('Material Purchase + Store Credit', () => {
  const suffix = `MP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant;
  let B: TestTenant;
  let userId: string;
  let branchId: string;
  let otherBranchId: string;
  let clientId: string;
  let keySeq = 0;
  const key = () => `${suffix}-key-${keySeq++}`;
  const OG_24K = 14000;

  const buy = (over: Record<string, unknown> = {}, tenant = A) =>
    createMaterialPurchase({ clientId, branchId, grossWeight: 47.925, testedPurityPercent: 91.6, idempotencyKey: key(), ...over } as any, tenant.ctx, tenant.user.id);

  const balance = async (id = clientId) => Number((await prisma.client.findUniqueOrThrow({ where: { id } })).currentBalance);
  const credit = async (id = clientId) => (await getClientCredit(A.ctx, id)).available;
  const vault = () => prisma.metalStockMovement.findMany({ where: { companyId: A.company.id, movementType: 'CUSTOMER_PURCHASE' } });

  async function makeClient(name: string) {
    return (await prisma.client.create({
      data: { companyId: A.company.id, clientCode: `CL-${suffix}-${name}`, name, panNumber: 'ABCDE1234F', type: 'RETAIL' },
    })).id;
  }
  const sellFor = (amount: number, payments: any[], cid = clientId) => createInvoice({
    branchId, clientId: cid, invoiceDate: new Date(), invoiceType: 'RETAIL', currency: 'INR',
    items: [{ productCode: 'X', description: 'Ring', quantity: 1, grossWeight: 1, netGoldWeight: 0, rateType: 'FIXED', goldRate: amount, makingCharge: 0 } as any],
    payments,
  } as any, A.ctx, userId);

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['invoice:create']);
    B = await createTestTenant(`${suffix}B`, ['invoice:create']);
    userId = A.user.id;
    branchId = A.branch.id;
    otherBranchId = (await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `BR2-${suffix}`, name: 'Second', city: 'X' } as any })).id;
    clientId = await makeClient('Mat Client');
    const today = new Date(new Date().toISOString().split('T')[0]);
    // 24K: normal rate 15,000 vs Old Gold rate 14,000 — a purchase must use the OLD GOLD one.
    await prisma.metalRate.create({ data: { companyId: A.company.id, date: today, karat: '24K', purity: 1, ratePerGram: 15000, ogRatePerGram: OG_24K } });
  });
  afterAll(async () => {
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  describe('valuation', () => {
    it('47.925 g at 91.60% on a ₹14,000 24K Old Gold rate is worth ₹6,14,590.20, with every snapshot stored', async () => {
      const before = await balance();
      const p = await buy();
      expect(Number(p.valuedAmount)).toBe(614590.2);
      expect(Number(p.fineWeight)).toBe(43.8993);
      expect(Number(p.testedPurityPercent)).toBe(91.6);
      expect(Number(p.baseRate24K)).toBe(OG_24K);
      expect(Number(p.effectivePurchaseRate)).toBe(12824);
      expect(Number(p.grossWeight)).toBe(47.925);
      expect(p.metalType).toBe('GOLD');
      expect(p.branchId).toBe(branchId);
      expect(p.createdById).toBe(userId);
      expect(p.tagId).toBeNull();
      // exactly the purchase value becomes credit (a negative receivable)
      expect(before - (await balance())).toBeCloseTo(614590.2, 2);
    });

    it('a different purity values correctly (75% of 10 g -> 7.5 g fine -> ₹1,05,000)', async () => {
      const p = await buy({ grossWeight: 10, testedPurityPercent: 75 });
      expect(Number(p.fineWeight)).toBe(7.5);
      expect(Number(p.valuedAmount)).toBe(105000);
    });

    it('uses the 24K Old Gold rate, never the normal gold rate', async () => {
      const p = await buy({ grossWeight: 1, testedPurityPercent: 100 });
      expect(Number(p.valuedAmount)).toBe(OG_24K); // not 15,000
    });

    it('ignores any client-submitted value, fine weight or rate', async () => {
      const p = await buy({ grossWeight: 10, testedPurityPercent: 100, purchaseValue: 999999, valuedAmount: 999999, fineWeight: 1, baseRate24K: 1 });
      expect(Number(p.valuedAmount)).toBe(140000);
      expect(Number(p.fineWeight)).toBe(10);
    });

    it('a later rate change never reprices a past purchase', async () => {
      const p = await buy({ grossWeight: 1, testedPurityPercent: 100 });
      const today = new Date(new Date().toISOString().split('T')[0]);
      await prisma.metalRate.updateMany({ where: { companyId: A.company.id, date: today, karat: '24K' }, data: { ogRatePerGram: 20000 } });
      const again = await prisma.oldGoldExchange.findUniqueOrThrow({ where: { id: p.id } });
      expect(Number(again.valuedAmount)).toBe(OG_24K);
      expect(Number(again.baseRate24K)).toBe(OG_24K);
      await prisma.metalRate.updateMany({ where: { companyId: A.company.id, date: today, karat: '24K' }, data: { ogRatePerGram: OG_24K } });
    });

    it.each([
      ['zero weight', { grossWeight: 0 }],
      ['negative weight', { grossWeight: -1 }],
      ['zero purity', { testedPurityPercent: 0 }],
      ['purity above 100', { testedPurityPercent: 100.01 }],
      ['non-numeric purity', { testedPurityPercent: 'abc' }],
      ['silver (not supported yet)', { metalType: 'SILVER' }],
    ])('rejects %s and changes nothing', async (_n, over) => {
      const bal = await balance();
      const moves = (await vault()).length;
      await expect(buy(over)).rejects.toMatchObject({ statusCode: 400 });
      expect(await balance()).toBe(bal);
      expect((await vault()).length).toBe(moves);
    });

    it('is refused when there is no 24K Old Gold rate, and nothing is booked', async () => {
      const T = await createTestTenant(`${suffix}N`, ['invoice:create']);
      try {
        const c = await prisma.client.create({ data: { companyId: T.company.id, clientCode: `CL-${suffix}-N`, name: 'No Rate', type: 'RETAIL' } });
        await expect(createMaterialPurchase({ clientId: c.id, branchId: T.branch.id, grossWeight: 5, testedPurityPercent: 90 }, T.ctx, T.user.id))
          .rejects.toMatchObject({ statusCode: 404 });
        expect(await prisma.oldGoldExchange.count({ where: { companyId: T.company.id } })).toBe(0);
      } finally { await cleanupTestTenant(T); }
    });
  });

  describe('credit, vault and ledger — one atomic booking', () => {
    it('adds the physical gross weight to the vault with a CUSTOMER_PURCHASE movement, and posts Dr Inventory / Cr AR', async () => {
      const p = await buy({ grossWeight: 20, testedPurityPercent: 91.6 });
      const mv = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, referenceType: 'OldGoldExchange', referenceId: p.id } });
      expect(mv.movementType).toBe('CUSTOMER_PURCHASE');
      expect(Number(mv.quantity)).toBe(20);
      expect(Number(mv.beforeAvailableWt)).toBe(0);
      expect(Number(mv.afterAvailableWt)).toBe(20);
      expect(mv.branchId).toBe(branchId);
      expect(mv.userId).toBe(userId);
      expect(Number(mv.purity)).toBeCloseTo(0.916, 4);
      const lot = await prisma.metalStock.findUniqueOrThrow({ where: { id: p.metalStockId! } });
      expect(Number(lot.availableWt)).toBe(20);
      expect(lot.karat).toBe('22K'); // 91.6% is the company's 22K
      const je = await getJournalEntry(p.id);
      expect(je).not.toBeNull();
      expect(lineAmount(je!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(Number(p.valuedAmount), 2);
      expect(lineAmount(je!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(Number(p.valuedAmount), 2);
    });

    it('rolls back everything (no credit, no lot, no movement) when the booking fails midway', async () => {
      const bal = await balance();
      const lots = await prisma.metalStock.count({ where: { companyId: A.company.id } });
      const moves = (await vault()).length;
      const exchanges = await prisma.oldGoldExchange.count({ where: { companyId: A.company.id } });
      // a deactivated client is rejected inside the transaction, after the date/rate work
      const dead = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-${suffix}-dead`, name: 'Dead', type: 'RETAIL', isActive: false } });
      await expect(buy({ clientId: dead.id })).rejects.toMatchObject({ statusCode: 409 });
      expect(await balance()).toBe(bal);
      expect(await prisma.metalStock.count({ where: { companyId: A.company.id } })).toBe(lots);
      expect((await vault()).length).toBe(moves);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id } })).toBe(exchanges);
    });

    it('the same idempotency key is refused the second time and books nothing more', async () => {
      const k = key();
      const first = await buy({ idempotencyKey: k, grossWeight: 3 });
      const bal = await balance();
      const moves = (await vault()).length;
      await expect(buy({ idempotencyKey: k, grossWeight: 3 })).rejects.toMatchObject({ statusCode: 409 });
      expect(await balance()).toBe(bal);
      expect((await vault()).length).toBe(moves);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, idempotencyKey: k } })).toBe(1);
      expect(first.idempotencyKey).toBe(k);
    });

    it('two simultaneous submissions of the same key: exactly one is booked', async () => {
      const k = key();
      const r = await Promise.allSettled([buy({ idempotencyKey: k, grossWeight: 2 }), buy({ idempotencyKey: k, grossWeight: 2 })]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, idempotencyKey: k } })).toBe(1);
    });
  });

  describe('security', () => {
    it("another company's client is a 404 and nothing is booked", async () => {
      const foreign = await prisma.client.create({ data: { companyId: B.company.id, clientCode: `CL-${suffix}-B`, name: 'Foreign', type: 'RETAIL' } });
      await expect(buy({ clientId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
      expect(await prisma.oldGoldExchange.count({ where: { clientId: foreign.id } })).toBe(0);
      expect(Number((await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } })).currentBalance)).toBe(0);
    });

    it("another company's branch is refused", async () => {
      await expect(buy({ branchId: B.branch.id })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    });

    it('a branch the user has no access to is refused', async () => {
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branchId] } };
      await expect(createMaterialPurchase({ clientId, branchId: otherBranchId, grossWeight: 5, testedPurityPercent: 90 }, restricted as any, userId))
        .rejects.toMatchObject({ statusCode: expect.any(Number) });
      await expect(createMaterialPurchase({ clientId, branchId, grossWeight: 5, testedPurityPercent: 90, idempotencyKey: key() }, restricted as any, userId)).resolves.toBeTruthy();
    });

    it('history lists only this company\'s purchases, with the snapshot and creator', async () => {
      await buy({ grossWeight: 1, testedPurityPercent: 100 });
      const rows = await listMaterialPurchases(A.ctx);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.companyId === A.company.id && r.testedPurityPercent !== null)).toBe(true);
      expect(rows[0]).toMatchObject({ metalType: 'GOLD' });
      expect(rows[0].createdByName).toBeTruthy();
      expect(await listMaterialPurchases(B.ctx)).toHaveLength(0);
    });
  });

  describe('Store Credit as the invoice payment — the purchase is never booked twice', () => {
    it('buy once -> spend part of the credit: credit drops by exactly that, excess stays, and NO second purchase / movement / credit is created', async () => {
      const cid = await makeClient('Spender');
      const p = await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 47.925, testedPurityPercent: 91.6, idempotencyKey: key() }, A.ctx, userId);
      expect(await credit(cid)).toBeCloseTo(614590.2, 2);
      const exchanges = await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid } });
      const moves = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      const lots = await prisma.metalStock.findMany({ where: { companyId: A.company.id }, select: { id: true, availableWt: true } });

      const inv = await sellFor(500000, [{ paymentDate: new Date(), amount: 515000, mode: 'STORE_CREDIT' }], cid); // 500,000 + 3% GST
      expect(Number(inv.balanceDue)).toBe(0);
      expect(await credit(cid)).toBeCloseTo(614590.2 - 515000, 2); // 99,590.20 left, not auto-refunded

      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid } })).toBe(exchanges);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(moves);
      expect(await prisma.metalStock.findMany({ where: { companyId: A.company.id }, select: { id: true, availableWt: true } })).toEqual(lots);
      expect(p.id).toBeTruthy();
    });

    it('credit + cash: the credit pays what it covers and the cash the rest', async () => {
      const cid = await makeClient('Mixed');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 100, idempotencyKey: key() }, A.ctx, userId); // 1,40,000
      const inv = await sellFor(200000, [
        { paymentDate: new Date(), amount: 140000, mode: 'STORE_CREDIT' },
        { paymentDate: new Date(), amount: 66000, mode: 'CASH' }, // 206,000 incl. GST
      ], cid);
      expect(Number(inv.balanceDue)).toBe(0);
      expect(await credit(cid)).toBeCloseTo(0, 2);
      const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
      expect(pays.map((x) => x.mode).sort()).toEqual(['CASH', 'STORE_CREDIT']);
    });

    it('cannot spend more credit than the customer has, and nothing is booked', async () => {
      const cid = await makeClient('Short');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 1, testedPurityPercent: 100, idempotencyKey: key() }, A.ctx, userId); // 14,000
      const invoices = await prisma.salesInvoice.count({ where: { companyId: A.company.id, clientId: cid } });
      await expect(sellFor(50000, [{ paymentDate: new Date(), amount: 20000, mode: 'STORE_CREDIT' }], cid)).rejects.toMatchObject({ statusCode: 400 });
      expect(await credit(cid)).toBeCloseTo(14000, 2);
      expect(await prisma.salesInvoice.count({ where: { companyId: A.company.id, clientId: cid } })).toBe(invoices);
    });

    it('two simultaneous invoices cannot both spend the same credit', async () => {
      const cid = await makeClient('Racer');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 100, idempotencyKey: key() }, A.ctx, userId);
      const avail = await credit(cid); // 1,40,000 — enough for one 1,03,000 bill, not two
      const bill = () => sellFor(100000, [{ paymentDate: new Date(), amount: 103000, mode: 'STORE_CREDIT' }], cid);
      const r = await Promise.allSettled([bill(), bill()]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const left = await credit(cid);
      expect(left).toBeGreaterThanOrEqual(-0.005);
      expect(left).toBeCloseTo(avail - 103000, 1);
    });

    it('reversing the credit-settled payment reopens the invoice without touching the purchase, vault or credit books', async () => {
      const cid = await makeClient('Reverser');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 100, idempotencyKey: key() }, A.ctx, userId);
      const inv = await sellFor(100000, [{ paymentDate: new Date(), amount: 103000, mode: 'STORE_CREDIT' }], cid);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'STORE_CREDIT' } });
      const moves = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      await reverseInvoicePayment(pay.id, A.ctx, userId, 'test reversal');
      expect(Number((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).balanceDue)).toBe(103000);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(moves);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid, reversedAt: { not: null } } })).toBe(0);
    });
  });
});
