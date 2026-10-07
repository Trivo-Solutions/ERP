import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // fixtures/verification as the platform role; the code under test uses the runtime client
import { createInvoice, createMaterialPurchase, listMaterialPurchases, reverseInvoicePayment, getClientCredit } from './sales.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { getJournalEntry, lineAmount } from '../../test/ledger';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { getRateSheet, saveRateSheet } from '../product-design/design.service';
import { consumeVaultMetal } from '../../shared/metalMovement';
import { tenantTransaction } from '../../shared/tenantContext';

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
    // Silver 999 base: normal 230 vs Old 200 — each purchase type must use ITS family.
    await prisma.metalRate.create({ data: { companyId: A.company.id, date: today, karat: '999', purity: 0.999, ratePerGram: 230, ogRatePerGram: 200 } });
  });
  afterAll(async () => {
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  describe('valuation', () => {
    it('47.925 g at 91.60% on a ₹14,000 24K/999 Old Gold rate is worth ₹6,15,204.80 (999-equivalent 43.9432 g), with every snapshot stored', async () => {
      const before = await balance();
      const p = await buy();
      expect(Number(p.valuedAmount)).toBe(615204.8);
      expect(Number(p.fineWeight)).toBe(43.8993);
      expect(Number(p.testedPurityPercent)).toBe(91.6);
      expect(Number(p.baseRate24K)).toBe(OG_24K);
      expect(Number(p.effectivePurchaseRate)).toBe(12836.8368); // 14,000 x 91.6 / 99.9 - not x 91.6%
      expect(Number(p.grossWeight)).toBe(47.925);
      expect(p.metalType).toBe('GOLD');
      expect(p.branchId).toBe(branchId);
      expect(p.createdById).toBe(userId);
      expect(p.tagId).toBeNull();
      // exactly the purchase value becomes credit (a negative receivable)
      expect(before - (await balance())).toBeCloseTo(615204.8, 2);
    });

    it('a different purity values correctly (75% of 10 g -> 7.5 g true fine, 7.5075 g 999-equivalent -> ₹1,05,105)', async () => {
      const p = await buy({ grossWeight: 10, testedPurityPercent: 75 });
      expect(Number(p.fineWeight)).toBe(7.5);
      expect(Number(p.valuedAmount)).toBe(105105); // 10 x 75 / 99.9 = 7.5075 g x 14,000
    });

    it('uses the 24K Old Gold rate, never the normal gold rate', async () => {
      const p = await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
      expect(Number(p.valuedAmount)).toBe(OG_24K); // 1 g of 99.9% metal = 1 g of 999 - not the normal 15,000
    });

    it('ignores any client-submitted value, fine weight or rate', async () => {
      const p = await buy({ grossWeight: 10, testedPurityPercent: 99.9, purchaseValue: 999999, valuedAmount: 999999, fineWeight: 1, baseRate24K: 1 });
      expect(Number(p.valuedAmount)).toBe(140000);
      expect(Number(p.fineWeight)).toBe(9.99);
    });

    it('a later rate change never reprices a past purchase', async () => {
      const p = await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
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
      ['an unsupported material', { metalType: 'PLATINUM' }],
      ['a non-string material', { metalType: 7 }],
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

  describe('purchase type (OLD / PURE rate families)', () => {
    const NORMAL_24K = 15000;
    it('Gold + Old at 91.60% uses the 24K Old Gold rate: 14,000 x 91.6 / 99.9 = 12,836.84/g', async () => {
      const p = await buy({ purchaseType: 'OLD', grossWeight: 10, testedPurityPercent: 91.6 });
      expect(p.purchaseType).toBe('OLD');
      expect(Number(p.baseRate24K)).toBe(OG_24K);
      expect(Number(p.effectivePurchaseRate)).toBe(12836.8368);
      expect(Number(p.fineWeight)).toBe(9.16);
      expect(Number(p.valuedAmount)).toBe(128368.8); // 9.1692 g (999-equivalent) x 14,000
    });

    it('Gold + Pure at 99.90% uses the 24K normal Gold rate: 15,000 x 99.9 / 99.9 = 15,000/g', async () => {
      const before = await balance();
      const p = await buy({ purchaseType: 'PURE', grossWeight: 10, testedPurityPercent: 99.9 });
      expect(p.purchaseType).toBe('PURE');
      expect(p.metalType).toBe('GOLD');
      expect(Number(p.baseRate24K)).toBe(NORMAL_24K);
      expect(Number(p.effectivePurchaseRate)).toBe(15000);
      expect(Number(p.fineWeight)).toBe(9.99);
      expect(Number(p.valuedAmount)).toBe(150000);
      expect(before - (await balance())).toBeCloseTo(150000, 2); // same Store Credit mechanism
    });

    it('purity alone changes the effective rate and value - the type does not fix the purity', async () => {
      const a = await buy({ purchaseType: 'PURE', grossWeight: 10, testedPurityPercent: 91.6 });
      const b = await buy({ purchaseType: 'PURE', grossWeight: 10, testedPurityPercent: 99.9 });
      const c = await buy({ purchaseType: 'OLD', grossWeight: 10, testedPurityPercent: 99.9 });
      expect(Number(a.effectivePurchaseRate)).toBe(13753.7538); // 15,000 x 91.6 / 99.9
      expect(Number(b.effectivePurchaseRate)).toBe(15000);
      expect(Number(c.effectivePurchaseRate)).toBe(14000);
      expect(Number(a.valuedAmount)).toBe(137538);
    });

    it('omitted purchaseType means OLD; an unknown or non-string type is a 400 and books nothing', async () => {
      expect((await buy({ grossWeight: 1, testedPurityPercent: 99.9 })).purchaseType).toBe('OLD');
      const moves = (await vault()).length;
      for (const bad of ['SILVER', 'pure gold', '', 7, { not: 'x' }]) {
        await expect(buy({ purchaseType: bad })).rejects.toMatchObject({ statusCode: 400 });
      }
      expect((await vault()).length).toBe(moves);
    });

    it('ignores a client-supplied rate/value on a PURE purchase too', async () => {
      const p = await buy({ purchaseType: 'PURE', grossWeight: 10, testedPurityPercent: 99.9, effectivePurchaseRate: 1, baseRate24K: 1, valuedAmount: 5, purchaseValue: 5 });
      expect(Number(p.valuedAmount)).toBe(150000);
      expect(Number(p.baseRate24K)).toBe(NORMAL_24K);
    });

    it('no fallback between families: OLD without an Old Gold rate and PURE without a normal rate are each refused', async () => {
      const today = new Date(new Date().toISOString().split('T')[0]);
      const T1 = await createTestTenant(`${suffix}O`, ['invoice:create']);
      const T2 = await createTestTenant(`${suffix}P`, ['invoice:create']);
      try {
        await prisma.metalRate.create({ data: { companyId: T1.company.id, date: today, karat: '24K', purity: 1, ratePerGram: 15000 } }); // normal only
        await prisma.metalRate.create({ data: { companyId: T2.company.id, date: today, karat: '24K', purity: 1, ratePerGram: 0, ogRatePerGram: 14000 } }); // old only
        const c1 = await prisma.client.create({ data: { companyId: T1.company.id, clientCode: `CL-${suffix}-O`, name: 'O', type: 'RETAIL' } });
        const c2 = await prisma.client.create({ data: { companyId: T2.company.id, clientCode: `CL-${suffix}-P`, name: 'P', type: 'RETAIL' } });
        const mk = (T: TestTenant, cid: string, purchaseType: string) =>
          createMaterialPurchase({ clientId: cid, branchId: T.branch.id, purchaseType, grossWeight: 5, testedPurityPercent: 90 }, T.ctx, T.user.id);
        await expect(mk(T1, c1.id, 'OLD')).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Old Gold') });
        await expect(mk(T2, c2.id, 'PURE')).rejects.toMatchObject({ statusCode: 404 });
        expect(await prisma.oldGoldExchange.count({ where: { companyId: { in: [T1.company.id, T2.company.id] } } })).toBe(0);
        await expect(mk(T1, c1.id, 'PURE')).resolves.toMatchObject({ purchaseType: 'PURE' });
        await expect(mk(T2, c2.id, 'OLD')).resolves.toMatchObject({ purchaseType: 'OLD' });
      } finally { await cleanupTestTenant(T1); await cleanupTestTenant(T2); }
    });

    it('a historical NULL purchaseType is listed as OLD, and the filter treats it as OLD', async () => {
      const p = await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
      await prisma.oldGoldExchange.update({ where: { id: p.id }, data: { purchaseType: null } });
      const pure = await buy({ purchaseType: 'PURE', grossWeight: 1, testedPurityPercent: 99.9 });
      const all = await listMaterialPurchases(A.ctx);
      expect(all.find((r) => r.id === p.id)!.purchaseType).toBe('OLD');
      const olds = (await listMaterialPurchases(A.ctx, { purchaseType: 'OLD' })).map((r) => r.id);
      expect(olds).toContain(p.id);
      expect(olds).not.toContain(pure.id);
      const pures = (await listMaterialPurchases(A.ctx, { purchaseType: 'PURE' })).map((r) => r.id);
      expect(pures).toContain(pure.id);
      expect(pures).not.toContain(p.id);
      await expect(listMaterialPurchases(A.ctx, { purchaseType: 'BOGUS' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a PURE purchase is the same atomic booking: one vault lot + CUSTOMER_PURCHASE movement + balanced journal, replay and race refused, rollback clean', async () => {
      const p = await buy({ purchaseType: 'PURE', grossWeight: 20, testedPurityPercent: 99.9 });
      const mv = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, referenceType: 'OldGoldExchange', referenceId: p.id } });
      expect(mv.movementType).toBe('CUSTOMER_PURCHASE');
      expect(Number(mv.quantity)).toBe(20);
      const lot = await prisma.metalStock.findUniqueOrThrow({ where: { id: p.metalStockId! } });
      expect(Number(lot.avgCostPerGram)).toBeCloseTo(15000, 2); // its own lot, costed at what was paid per gram
      const je = await getJournalEntry(p.id);
      expect(lineAmount(je!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(Number(p.valuedAmount), 2);

      const k = key();
      const r = await Promise.allSettled([buy({ purchaseType: 'PURE', idempotencyKey: k, grossWeight: 2 }), buy({ purchaseType: 'PURE', idempotencyKey: k, grossWeight: 2 })]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      await expect(buy({ purchaseType: 'PURE', idempotencyKey: k, grossWeight: 2 })).rejects.toMatchObject({ statusCode: 409 });

      const bal = await balance();
      const lots = await prisma.metalStock.count({ where: { companyId: A.company.id } });
      const dead = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-${suffix}-dead2`, name: 'Dead2', type: 'RETAIL', isActive: false } });
      await expect(buy({ purchaseType: 'PURE', clientId: dead.id })).rejects.toMatchObject({ statusCode: 409 });
      expect(await balance()).toBe(bal);
      expect(await prisma.metalStock.count({ where: { companyId: A.company.id } })).toBe(lots);
    });

    it('PURE enforces the same tenant and branch security', async () => {
      const foreign = await prisma.client.create({ data: { companyId: B.company.id, clientCode: `CL-${suffix}-B2`, name: 'F2', type: 'RETAIL' } });
      await expect(buy({ purchaseType: 'PURE', clientId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
      await expect(buy({ purchaseType: 'PURE', branchId: B.branch.id })).rejects.toMatchObject({ statusCode: expect.any(Number) });
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branchId] } } as any;
      await expect(createMaterialPurchase({ clientId, branchId: otherBranchId, purchaseType: 'PURE', grossWeight: 5, testedPurityPercent: 99 }, restricted, userId))
        .rejects.toMatchObject({ statusCode: expect.any(Number) });
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
      await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
      const rows = await listMaterialPurchases(A.ctx);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.companyId === A.company.id && r.testedPurityPercent !== null)).toBe(true);
      expect(rows[0]).toMatchObject({ metalType: 'GOLD' });
      expect(rows[0].createdByName).toBeTruthy();
      expect(await listMaterialPurchases(B.ctx)).toHaveLength(0);
    });

    it('filters by branch, material, purchase number and creator, and caps a branch-restricted caller', async () => {
      const p = await buy({ grossWeight: 2, testedPurityPercent: 90 });
      const num = p.exchangeNumber;
      expect((await listMaterialPurchases(A.ctx, { exchangeNumber: num.toLowerCase() })).map((r) => r.id)).toContain(p.id);
      expect(await listMaterialPurchases(A.ctx, { exchangeNumber: 'NO-SUCH-NUMBER' })).toHaveLength(0);
      expect((await listMaterialPurchases(A.ctx, { branchId, metalType: 'GOLD', createdById: userId })).map((r) => r.id)).toContain(p.id);
      expect(await listMaterialPurchases(A.ctx, { metalType: 'SILVER' })).toHaveLength(0);
      expect(await listMaterialPurchases(A.ctx, { createdById: 'someone-else' })).toHaveLength(0);
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [otherBranchId] } } as any;
      expect(await listMaterialPurchases(restricted)).toHaveLength(0);
      await expect(listMaterialPurchases(restricted, { branchId })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    });
  });

  describe('Store Credit as the invoice payment — the purchase is never booked twice', () => {
    it('buy once -> spend part of the credit: credit drops by exactly that, excess stays, and NO second purchase / movement / credit is created', async () => {
      const cid = await makeClient('Spender');
      const p = await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 47.925, testedPurityPercent: 91.6, idempotencyKey: key() }, A.ctx, userId);
      expect(await credit(cid)).toBeCloseTo(615204.8, 2);
      const exchanges = await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid } });
      const moves = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      const lots = await prisma.metalStock.findMany({ where: { companyId: A.company.id }, select: { id: true, availableWt: true } });

      const inv = await sellFor(500000, [{ paymentDate: new Date(), amount: 515000, mode: 'STORE_CREDIT' }], cid); // 500,000 + 3% GST
      expect(Number(inv.balanceDue)).toBe(0);
      expect(await credit(cid)).toBeCloseTo(615204.8 - 515000, 2); // 1,00,204.80 left, not auto-refunded

      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid } })).toBe(exchanges);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(moves);
      expect(await prisma.metalStock.findMany({ where: { companyId: A.company.id }, select: { id: true, availableWt: true } })).toEqual(lots);
      expect(p.id).toBeTruthy();
    });

    it('credit + cash: the credit pays what it covers and the cash the rest', async () => {
      const cid = await makeClient('Mixed');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 99.9, idempotencyKey: key() }, A.ctx, userId); // 1,40,000
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
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 1, testedPurityPercent: 99.9, idempotencyKey: key() }, A.ctx, userId); // 14,000
      const invoices = await prisma.salesInvoice.count({ where: { companyId: A.company.id, clientId: cid } });
      await expect(sellFor(50000, [{ paymentDate: new Date(), amount: 20000, mode: 'STORE_CREDIT' }], cid)).rejects.toMatchObject({ statusCode: 400 });
      expect(await credit(cid)).toBeCloseTo(14000, 2);
      expect(await prisma.salesInvoice.count({ where: { companyId: A.company.id, clientId: cid } })).toBe(invoices);
    });

    it('two simultaneous invoices cannot both spend the same credit', async () => {
      const cid = await makeClient('Racer');
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 99.9, idempotencyKey: key() }, A.ctx, userId);
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
      await createMaterialPurchase({ clientId: cid, branchId, grossWeight: 10, testedPurityPercent: 99.9, idempotencyKey: key() }, A.ctx, userId);
      const inv = await sellFor(100000, [{ paymentDate: new Date(), amount: 103000, mode: 'STORE_CREDIT' }], cid);
      const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'STORE_CREDIT' } });
      const moves = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      await reverseInvoicePayment(pay.id, A.ctx, userId, 'test reversal');
      expect(Number((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).balanceDue)).toBe(103000);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(moves);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, clientId: cid, reversedAt: { not: null } } })).toBe(0);
    });
  });

  describe('Silver material purchases', () => {
    const SILVER = 230;
    const SILVER_OLD = 200;
    const buyS = (over: Record<string, unknown> = {}, tenant = A) => buy({ metalType: 'SILVER', grossWeight: 100, testedPurityPercent: 92.5, ...over }, tenant);
    const todayD = () => new Date(new Date().toISOString().split('T')[0]);

    it('Silver + Pure: 100 g at 92.5% on a ₹230 Silver 999 base -> 92.5 g true fine, 92.5926 g 999-equivalent, ₹212.963/g, ₹21,296.30, snapshot stored', async () => {
      const before = await balance();
      const p = await buyS({ purchaseType: 'PURE' });
      expect(p.metalType).toBe('SILVER');
      expect(p.purchaseType).toBe('PURE');
      expect(Number(p.fineWeight)).toBe(92.5);
      expect(Number(p.baseRate24K)).toBe(SILVER);
      expect(Number(p.effectivePurchaseRate)).toBe(212.963); // 230 x 92.5 / 99.9 - not 212.75
      expect(Number(p.valuedAmount)).toBe(21296.3);   // 92.5926 g x 230
      expect(Number(p.testedPurityPercent)).toBe(92.5);
      expect(p.createdById).toBe(userId);
      expect(before - (await balance())).toBeCloseTo(21296.3, 2); // Store Credit = the purchase value
    });

    it('Silver + Old uses the Old Silver 999 base: 200 x 92.5 / 99.9 = 185.185/g -> ₹18,518.52; purity changes the effective rate', async () => {
      const a = await buyS({ purchaseType: 'OLD' });
      expect(Number(a.baseRate24K)).toBe(SILVER_OLD);
      expect(Number(a.effectivePurchaseRate)).toBe(185.1852);
      expect(Number(a.valuedAmount)).toBe(18518.52);
      const b = await buyS({ purchaseType: 'OLD', testedPurityPercent: 99.9 });
      expect(Number(b.effectivePurchaseRate)).toBe(200); // 99.9% silver = the 999 benchmark itself
      expect(Number(b.fineWeight)).toBe(99.9);
    });

    it('Gold families are unchanged beside it: Gold+Old still 24K Old, Gold+Pure still 24K normal', async () => {
      expect(Number((await buy({ purchaseType: 'OLD', grossWeight: 1, testedPurityPercent: 99.9 })).valuedAmount)).toBe(OG_24K);
      expect(Number((await buy({ purchaseType: 'PURE', grossWeight: 1, testedPurityPercent: 99.9 })).valuedAmount)).toBe(15000);
    });

    it('an omitted material is Gold, never Silver; a lowercase silver is accepted', async () => {
      expect((await buy({ grossWeight: 1, testedPurityPercent: 99.9 })).metalType).toBe('GOLD');
      expect((await buyS({ metalType: 'silver', grossWeight: 1, testedPurityPercent: 99.9 })).metalType).toBe('SILVER');
    });

    it('ignores client-supplied rate, effective rate, fine weight and value', async () => {
      const p = await buyS({ purchaseType: 'PURE', purchaseValue: 999999, valuedAmount: 999999, fineWeight: 1, baseRate24K: 1, effectivePurchaseRate: 1, ratePerGram: 1 });
      expect(Number(p.valuedAmount)).toBe(21296.3);
      expect(Number(p.fineWeight)).toBe(92.5);
      expect(Number(p.baseRate24K)).toBe(SILVER);
    });

    it('no fallback: Old Silver without an Old base and Pure Silver without a normal base are refused, and a Gold 24K rate never stands in', async () => {
      const T1 = await createTestTenant(`${suffix}SO`, ['invoice:create']);
      const T2 = await createTestTenant(`${suffix}SP`, ['invoice:create']);
      try {
        for (const T of [T1, T2]) await prisma.metalRate.create({ data: { companyId: T.company.id, date: todayD(), karat: '24K', purity: 1, ratePerGram: 15000, ogRatePerGram: 14000 } });
        await prisma.metalRate.create({ data: { companyId: T1.company.id, date: todayD(), karat: '999', purity: 0.999, ratePerGram: 230 } }); // normal only
        await prisma.metalRate.create({ data: { companyId: T2.company.id, date: todayD(), karat: '999', purity: 0.999, ratePerGram: 0, ogRatePerGram: 200 } }); // old only
        const c1 = await prisma.client.create({ data: { companyId: T1.company.id, clientCode: `CL-${suffix}-SO`, name: 'SO', type: 'RETAIL' } });
        const c2 = await prisma.client.create({ data: { companyId: T2.company.id, clientCode: `CL-${suffix}-SP`, name: 'SP', type: 'RETAIL' } });
        const mk = (T: TestTenant, cid: string, purchaseType: string) =>
          createMaterialPurchase({ clientId: cid, branchId: T.branch.id, metalType: 'SILVER', purchaseType, grossWeight: 5, testedPurityPercent: 90 }, T.ctx, T.user.id);
        await expect(mk(T1, c1.id, 'OLD')).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Old Silver') });
        await expect(mk(T2, c2.id, 'PURE')).rejects.toMatchObject({ statusCode: 404 });
        expect(await prisma.oldGoldExchange.count({ where: { companyId: { in: [T1.company.id, T2.company.id] } } })).toBe(0);
        await expect(mk(T1, c1.id, 'PURE')).resolves.toMatchObject({ metalType: 'SILVER' });
        await expect(mk(T2, c2.id, 'OLD')).resolves.toMatchObject({ metalType: 'SILVER' });
      } finally { await cleanupTestTenant(T1); await cleanupTestTenant(T2); }
    });

    it('a company with no Silver rate at all cannot buy Silver', async () => {
      const T = await createTestTenant(`${suffix}SN`, ['invoice:create']);
      try {
        await prisma.metalRate.create({ data: { companyId: T.company.id, date: todayD(), karat: '24K', purity: 1, ratePerGram: 15000, ogRatePerGram: 14000 } });
        const c = await prisma.client.create({ data: { companyId: T.company.id, clientCode: `CL-${suffix}-SN`, name: 'SN', type: 'RETAIL' } });
        await expect(createMaterialPurchase({ clientId: c.id, branchId: T.branch.id, metalType: 'SILVER', grossWeight: 5, testedPurityPercent: 90 }, T.ctx, T.user.id))
          .rejects.toMatchObject({ statusCode: 404 });
      } finally { await cleanupTestTenant(T); }
    });

    it('books a Silver vault lot (own metal type, own cost) with a CUSTOMER_PURCHASE movement and a balanced journal; Old and Pure stay separate lots', async () => {
      const old = await buyS({ purchaseType: 'OLD' });
      const pure = await buyS({ purchaseType: 'PURE' });
      expect(old.metalStockId).not.toBe(pure.metalStockId);
      const lotO = await prisma.metalStock.findUniqueOrThrow({ where: { id: old.metalStockId! } });
      const lotP = await prisma.metalStock.findUniqueOrThrow({ where: { id: pure.metalStockId! } });
      expect(lotO.metalType).toBe('SILVER');
      expect(lotP.metalType).toBe('SILVER');
      expect(Number(lotO.availableWt)).toBe(100);
      expect(Number(lotO.avgCostPerGram)).toBe(185.1852);
      expect(Number(lotP.avgCostPerGram)).toBe(212.963);
      const mv = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, referenceType: 'OldGoldExchange', referenceId: pure.id } });
      expect(mv.movementType).toBe('CUSTOMER_PURCHASE');
      expect(Number(mv.quantity)).toBe(100);
      expect(mv.branchId).toBe(branchId);
      const je = await getJournalEntry(pure.id);
      expect(lineAmount(je!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(21296.3, 2);
      expect(lineAmount(je!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(21296.3, 2);
      const gold = await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
      expect((await prisma.metalStock.findUniqueOrThrow({ where: { id: gold.metalStockId! } })).metalType).toBe('GOLD');
    });

    it('a Silver lot cannot be drawn as Gold, and a Gold (or legacy NULL) lot cannot be drawn as Silver', async () => {
      // Two lots with the SAME karat label but different metals, on a tenant of their own so the draw is unambiguous.
      const T = await createTestTenant(`${suffix}VL`, ['invoice:create']);
      try {
        const mk = (metalType: string | null, wt: number) => prisma.metalStock.create({ data: {
          companyId: T.company.id, stockCode: `VL-${metalType ?? 'NULL'}-${wt}`, materialName: 'x', karat: 'SHARED', purity: 0.925,
          grossWeight: wt, netWeight: wt, availableWt: wt, sourceType: 'CUSTOMER_SUPPLIED', avgCostPerGram: 1, metalType,
        } });
        const silver = await mk('SILVER', 10);
        const legacy = await mk(null, 10);
        const draw = (metalType: 'GOLD' | 'SILVER' | undefined, weight: number) => tenantTransaction(T.company.id, (tx) =>
          consumeVaultMetal(tx, T.company.id, { karat: 'SHARED', weight, ...(metalType && { metalType }), meta: { referenceType: 'InvoiceItem', referenceId: `x-${Math.random()}`, userId: T.user.id } }));
        // 15 g is available in total but only 10 g of each metal: neither metal can borrow the other's lot.
        await expect(draw(undefined, 15)).rejects.toMatchObject({ statusCode: 409 });
        await expect(draw('SILVER', 15)).rejects.toMatchObject({ statusCode: 409 });
        await draw(undefined, 4);
        await draw('SILVER', 3);
        expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: legacy.id } })).availableWt)).toBe(6);
        expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: silver.id } })).availableWt)).toBe(7);
      } finally { await prisma.metalStockMovement.deleteMany({ where: { companyId: T.company.id } }); await prisma.metalStock.deleteMany({ where: { companyId: T.company.id } }); await cleanupTestTenant(T); }
    });

    it('replay and a simultaneous duplicate book exactly once', async () => {
      const k = key();
      const r = await Promise.allSettled([buyS({ idempotencyKey: k, grossWeight: 3 }), buyS({ idempotencyKey: k, grossWeight: 3 })]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const bal = await balance();
      await expect(buyS({ idempotencyKey: k, grossWeight: 3 })).rejects.toMatchObject({ statusCode: 409 });
      expect(await balance()).toBe(bal);
      expect(await prisma.oldGoldExchange.count({ where: { companyId: A.company.id, idempotencyKey: k } })).toBe(1);
    });

    it('a failed Silver booking leaves no credit, lot, movement or journal', async () => {
      const bal = await balance();
      const lots = await prisma.metalStock.count({ where: { companyId: A.company.id } });
      const moves = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      const entries = await prisma.journalEntry.count({ where: { companyId: A.company.id } });
      const dead = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-${suffix}-deadS`, name: 'DeadS', type: 'RETAIL', isActive: false } });
      await expect(buyS({ clientId: dead.id })).rejects.toMatchObject({ statusCode: 409 });
      expect(await balance()).toBe(bal);
      expect(await prisma.metalStock.count({ where: { companyId: A.company.id } })).toBe(lots);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(moves);
      expect(await prisma.journalEntry.count({ where: { companyId: A.company.id } })).toBe(entries);
    });

    it('enforces tenant and branch security for Silver', async () => {
      const foreign = await prisma.client.create({ data: { companyId: B.company.id, clientCode: `CL-${suffix}-BS`, name: 'FS', type: 'RETAIL' } });
      await expect(buyS({ clientId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
      await expect(buyS({ branchId: B.branch.id })).rejects.toMatchObject({ statusCode: expect.any(Number) });
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branchId] } } as any;
      await expect(createMaterialPurchase({ clientId, branchId: otherBranchId, metalType: 'SILVER', grossWeight: 5, testedPurityPercent: 90 }, restricted, userId))
        .rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect(await listMaterialPurchases(B.ctx, { metalType: 'SILVER' })).toHaveLength(0);
    });

    it('the rate sheet carries the Silver 999 master row (normal + Old) as the editable base, saves it, and a purchase then resolves it', async () => {
      const T = await createTestTenant(`${suffix}RS`, ['invoice:create']);
      try {
        const d = new Date(new Date().toISOString().split('T')[0]);
        const sheet = await getRateSheet(T.company.id, d);
        const row = sheet.find((r) => r.karat === '999')!;
        expect(row).toMatchObject({ metalType: 'SILVER', isDerived: false, ratePerGram: null, ogRatePerGram: null });
        expect(Number(row.purity)).toBe(0.999);
        expect(sheet.filter((r) => r.karat === '999')).toHaveLength(1);                 // no duplicate 999 row
        expect(sheet.find((r) => r.karat === '925')!.isDerived).toBe(true);             // the existing 925 masters stay, now calculated
        await saveRateSheet(T.company.id, d, [{ karat: '999', ratePerGram: 230, ogRatePerGram: 200 }]);
        const after = await getRateSheet(T.company.id, d);
        const base = after.find((r) => r.karat === '999')!;
        expect([Number(base.ratePerGram), Number(base.ogRatePerGram)]).toEqual([230, 200]); // the entered rate, as typed
        expect(Number(after.find((r) => r.karat === '925')!.ratePerGram)).toBe(212.96);
        expect(Number(after.find((r) => r.karat === '925')!.ogRatePerGram)).toBe(185.19);
        const c = await prisma.client.create({ data: { companyId: T.company.id, clientCode: `CL-${suffix}-RS`, name: 'RS', type: 'RETAIL' } });
        const p = await createMaterialPurchase({ clientId: c.id, branchId: T.branch.id, metalType: 'SILVER', purchaseType: 'PURE', grossWeight: 100, testedPurityPercent: 92.5 }, T.ctx, T.user.id);
        expect(Number(p.valuedAmount)).toBe(21296.3);
      } finally { await cleanupTestTenant(T); }
    });

    it('the register filters by material and rejects an unknown material', async () => {
      const s = await buyS({ purchaseType: 'PURE', grossWeight: 1, testedPurityPercent: 99.9 });
      const g = await buy({ grossWeight: 1, testedPurityPercent: 99.9 });
      const silvers = (await listMaterialPurchases(A.ctx, { metalType: 'SILVER' })).map((r) => r.id);
      const golds = (await listMaterialPurchases(A.ctx, { metalType: 'GOLD' })).map((r) => r.id);
      expect(silvers).toContain(s.id);
      expect(silvers).not.toContain(g.id);
      expect(golds).toContain(g.id);
      expect(golds).not.toContain(s.id);
      expect((await listMaterialPurchases(A.ctx, { metalType: 'SILVER', purchaseType: 'OLD' })).map((r) => r.id)).not.toContain(s.id);
      await expect(listMaterialPurchases(A.ctx, { metalType: 'PLATINUM' })).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
