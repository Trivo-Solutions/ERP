import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // fixtures/verification as the platform role; the code under test uses the runtime client
import { createInvoice, createSalesReturn, createOldGoldExchange, voidInvoice, amendInvoice, reverseInvoicePayment } from './sales.service';
import { addMetalStock } from '../inventory/inventory.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { getJournalEntry, lineAmount } from '../../test/ledger';

// Stock-movement correctness for the sell / return / buy-back flows: tagged return -> back to stock, material (loose
// metal) sale -> Metal Vault, material return -> Metal Vault, customer old-gold purchase -> Metal Vault, tagged old piece ->
// RETIRED + vault, and that none of it can be applied twice.
describe('Metal Vault / tag stock movements', () => {
  const suffix = `MV${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const KARAT = '22K'; // seeded for every tenant by seedStarterMasters

  let A: TestTenant; // the tenant under test
  let B: TestTenant; // a second company, for isolation
  let userId: string;
  let branchId: string;
  let clientId: string;
  let tagSeq = 0;

  const invoiceFor = (data: Omit<Parameters<typeof createInvoice>[0], 'branchId' | 'invoiceDate' | 'invoiceType' | 'clientId'> & { clientId?: string }) =>
    createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', ...data }, A.ctx, userId);

  const materialLine = (grams: number, overrides: Record<string, unknown> = {}) => ({
    productCode: 'MAT-22K', description: 'Loose gold 22K', quantity: 1, grossWeight: grams, netGoldWeight: grams,
    rateType: 'PER_GRAM', goldRate: 5000, makingCharge: 0, karat: KARAT, materialSale: true, ...overrides,
  });

  async function makeTag(overrides: Record<string, unknown> = {}) {
    return prisma.jewelryTag.create({
      data: {
        tagNumber: `TAG-${suffix}-${tagSeq++}`, companyId: A.company.id, branchId, name: 'Ring', metalType: 'GOLD', metalKarat: KARAT,
        grossWeight: 10, netWeight: 9, stoneWeight: 1, costPrice: 40000, sellingPrice: 48000, createdById: userId, ...overrides,
      },
    });
  }
  const taggedLine = (tagId: string) => ({
    productCode: 'TAGGED', description: 'Tagged ring', quantity: 1, grossWeight: 10, netGoldWeight: 9,
    rateType: 'FIXED', goldRate: 48000, makingCharge: 0, tagId,
  });

  let currentLot: { id: string };
  const lots = (companyId = A.company.id) => prisma.metalStock.findMany({ where: { companyId, karat: KARAT, isActive: true }, orderBy: { createdAt: 'asc' } });
  const vaultTotal = async (companyId = A.company.id) => (await lots(companyId)).reduce((s, l) => s + Number(l.availableWt), 0);
  async function seedLot(weight: number, cost = 4500, tenant = A) {
    return addMetalStock(
      { materialName: 'Gold 22K', karat: KARAT, purity: 0.916, grossWeight: weight, netWeight: weight, sourceType: 'PURCHASE', avgCostPerGram: cost },
      tenant.company.id, tenant.user.id,
    );
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['invoice:create']);
    B = await createTestTenant(`${suffix}B`, ['invoice:create']);
    userId = A.user.id;
    branchId = A.branch.id;
    const client = await prisma.client.create({
      data: { companyId: A.company.id, clientCode: `CL-${suffix}`, name: 'Vault Client', panNumber: 'ABCDE1234F', type: 'RETAIL' },
    });
    clientId = client.id;
    const today = new Date(new Date().toISOString().split('T')[0]);
    await prisma.metalRate.create({ data: { companyId: A.company.id, date: today, karat: KARAT, purity: 0.916, ratePerGram: 5000 } });
  });

  // Each test starts with ONE fresh 10 g lot of 22K at ₹4,500/g; whatever earlier tests left in the vault is retired.
  beforeEach(async () => {
    await prisma.metalStock.updateMany({ where: { companyId: A.company.id }, data: { isActive: false } });
    currentLot = await seedLot(10);
  });

  afterAll(async () => {
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  describe('1-2. tagged sale return restores the SAME tag, once', () => {
    it('returns the original tag, pending inspection, in its own branch, with a history event and no new tag', async () => {
      const tag = await makeTag();
      const tagCountBefore = await prisma.jewelryTag.count({ where: { companyId: A.company.id } });
      const inv = await invoiceFor({ items: [taggedLine(tag.id)] });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');

      const ret = await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, A.ctx, userId);

      const after = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(after.status).toBe('RETURNED_PENDING_INSPECTION'); // not saleable until Head Office inspects it
      expect(after.tagNumber).toBe(tag.tagNumber);
      expect(after.branchId).toBe(branchId);
      expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id } })).toBe(tagCountBefore); // no new tag
      expect(ret.items[0].tagId).toBe(tag.id);
      expect(ret.items[0].returnedWeight).toBeNull();

      const history = await prisma.tagHistory.findMany({ where: { tagId: tag.id, event: 'STATUS_CHANGE' }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.status)).toEqual(['SOLD', 'RETURNED_PENDING_INSPECTION']);
    });

    it('a second return of the same line is refused and changes nothing', async () => {
      const tag = await makeTag();
      const inv = await invoiceFor({ items: [taggedLine(tag.id)] });
      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, A.ctx, userId);
      const historyBefore = await prisma.tagHistory.count({ where: { tagId: tag.id } });
      const balanceBefore = Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);

      await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, A.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409 });

      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('RETURNED_PENDING_INSPECTION');
      expect(await prisma.tagHistory.count({ where: { tagId: tag.id } })).toBe(historyBefore);
      expect(Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance)).toBeCloseTo(balanceBefore);
      expect(await prisma.salesReturnItem.count({ where: { invoiceItemId: inv.items[0].id } })).toBe(1);
    });

    it('replaying the OLD return cannot pull a re-sold tag off its new sale', async () => {
      const tag = await makeTag();
      const first = await invoiceFor({ items: [taggedLine(tag.id)] });
      await createSalesReturn({ invoiceId: first.id, items: [{ invoiceItemId: first.items[0].id }] }, A.ctx, userId);
      await prisma.jewelryTag.update({ where: { id: tag.id }, data: { status: 'IN_STOCK' } }); // inspection passed (see returnRepair.service.test.ts)
      await invoiceFor({ items: [taggedLine(tag.id)] }); // sold again

      await expect(createSalesReturn({ invoiceId: first.id, items: [{ invoiceItemId: first.items[0].id }] }, A.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');
    });
  });

  describe('3-5, 9. material sale / return against the Metal Vault', () => {
    it('a 4 g material sale takes 4 g out of the vault, with a traceable movement and COGS at the lot cost', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });

      expect(inv.items[0].materialSale).toBe(true);
      expect(inv.items[0].tagId).toBeNull();
      expect(await vaultTotal()).toBeCloseTo(6);

      const moves = await prisma.metalStockMovement.findMany({ where: { companyId: A.company.id, referenceId: inv.items[0].id } });
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ movementType: 'MATERIAL_SALE', referenceType: 'InvoiceItem', karat: KARAT, branchId, userId });
      expect(Number(moves[0].quantity)).toBeCloseTo(-4);
      expect(Number(moves[0].beforeAvailableWt)).toBeCloseTo(10);
      expect(Number(moves[0].afterAvailableWt)).toBeCloseTo(6);
      expect(Number(moves[0].unitCostPerGram)).toBeCloseTo(4500);

      const entry = await getJournalEntry(inv.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.COST_OF_GOODS).debit).toBeCloseTo(4 * 4500);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(4 * 4500);
    });

    it('a sale larger than the vault is rejected whole: no invoice, no tag flip, vault untouched', async () => {
      const tag = await makeTag();
      const invoicesBefore = await prisma.salesInvoice.count({ where: { companyId: A.company.id } });

      await expect(invoiceFor({ items: [taggedLine(tag.id), materialLine(10.5)] })).rejects.toMatchObject({ statusCode: 409 });

      expect(await prisma.salesInvoice.count({ where: { companyId: A.company.id } })).toBe(invoicesBefore);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect(await vaultTotal()).toBeCloseTo(10);
    });

    it('can sell the vault down to exactly zero but never below', async () => {
      await invoiceFor({ items: [materialLine(10)] });
      expect(await vaultTotal()).toBeCloseTo(0);
      await expect(invoiceFor({ items: [materialLine(0.001)] })).rejects.toMatchObject({ statusCode: 409 });
      expect(await vaultTotal()).toBeCloseTo(0);
    });

    it('a sale that spans two lots drains the oldest first and a return refills the same lots', async () => {
      await prisma.metalStock.updateMany({ where: { companyId: A.company.id }, data: { isActive: false } });
      const small = await seedLot(3, 4000);
      const big = await seedLot(10, 4600);

      const inv = await invoiceFor({ items: [materialLine(5)] });
      expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: small.id } })).availableWt)).toBeCloseTo(0);
      expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: big.id } })).availableWt)).toBeCloseTo(8);
      expect(lineAmount((await getJournalEntry(inv.id))!, LEDGER_ACCOUNT.COST_OF_GOODS).debit).toBeCloseTo(3 * 4000 + 2 * 4600);

      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, A.ctx, userId);
      expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: small.id } })).availableWt)).toBeCloseTo(3);
      expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: big.id } })).availableWt)).toBeCloseTo(10);
      const back = await prisma.metalStockMovement.findMany({ where: { companyId: A.company.id, movementType: 'MATERIAL_SALE_RETURN' } });
      expect(back.every((m) => m.reversesMovementId)).toBe(true);
      expect(back).toHaveLength(2);
    });

    it('returning a 4 g material line puts 4 g back and credits the customer', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });
      const balanceBefore = Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);

      const ret = await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, A.ctx, userId);

      expect(await vaultTotal()).toBeCloseTo(10);
      expect(ret.items[0].tagId).toBeNull();
      expect(Number(ret.items[0].returnedWeight)).toBeCloseTo(4);
      const balanceAfter = Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
      expect(balanceAfter).toBeCloseTo(balanceBefore - Number(ret.totalAmount));
      expect(Number(ret.totalAmount)).toBeCloseTo(4 * 5000 * 1.03);

      const move = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, movementType: 'MATERIAL_SALE_RETURN', metalStockId: currentLot.id } });
      expect(move).toMatchObject({ referenceType: 'SalesReturnItem', referenceId: ret.items[0].id });
      expect(Number(move.quantity)).toBeCloseTo(4);
      // Dr Inventory / Cr COGS at the cost the metal left at
      const entry = await getJournalEntry(ret.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(4 * 4500);
    });

    it('the same material return twice adds nothing the second time (also when raced)', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });
      const lineId = inv.items[0].id;
      const results = await Promise.allSettled([
        createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId }] }, A.ctx, userId),
        createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId }] }, A.ctx, userId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await vaultTotal()).toBeCloseTo(10); // not 14

      await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId }] }, A.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await vaultTotal()).toBeCloseTo(10);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id, movementType: 'MATERIAL_SALE_RETURN', metalStockId: currentLot.id } })).toBe(1);
    });

    it('partial returns add up to, and never past, what was sold', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });
      const lineId = inv.items[0].id;
      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId, weight: 1 }] }, A.ctx, userId);
      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId, weight: 1 }] }, A.ctx, userId);
      expect(await vaultTotal()).toBeCloseTo(8);
      await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId, weight: 2.5 }] }, A.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409 });
      await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: lineId }] }, A.ctx, userId); // the remaining 2 g
      expect(await vaultTotal()).toBeCloseTo(10);
    });

    it('voiding a material invoice restores the vault; a void after a return cannot double-restore', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });
      await voidInvoice(inv.id, A.ctx, userId, 'entered in error');
      expect(await vaultTotal()).toBeCloseTo(10);

      const inv2 = await invoiceFor({ items: [materialLine(4)] });
      await createSalesReturn({ invoiceId: inv2.id, items: [{ invoiceItemId: inv2.items[0].id }] }, A.ctx, userId);
      await expect(voidInvoice(inv2.id, A.ctx, userId, 'again')).rejects.toMatchObject({ statusCode: 409 }); // already has a return
      expect(await vaultTotal()).toBeCloseTo(10);
    });

    it('a material invoice cannot be amended in place', async () => {
      const inv = await invoiceFor({ items: [materialLine(4)] });
      await expect(amendInvoice(inv.id, { items: [materialLine(5, { id: inv.items[0].id })] }, A.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await vaultTotal()).toBeCloseTo(6);
    });

    it('a mixed bill (tagged + material, rate edited) is priced by the server: weight x rate, tag sold, vault drawn', async () => {
      const tag = await makeTag();
      const inv = await invoiceFor({ items: [taggedLine(tag.id), materialLine(2.5, { goldRate: 5200 })] });

      const mat = inv.items.find((i) => i.materialSale)!;
      expect(Number(mat.totalPrice)).toBeCloseTo(2.5 * 5200);
      expect(Number(inv.subtotal)).toBeCloseTo(48000 + 2.5 * 5200);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');
      expect(inv.items.find((i) => i.tagId)!.materialSale).toBe(false);
      expect(await vaultTotal()).toBeCloseTo(7.5);
    });

    it('rejects a material line without a karat or a weight', async () => {
      await expect(invoiceFor({ items: [materialLine(4, { karat: undefined })] })).rejects.toMatchObject({ statusCode: 400 });
      await expect(invoiceFor({ items: [materialLine(0)] })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('6-8. customer old gold purchase', () => {
    it('adds the metal to the vault as CUSTOMER_SUPPLIED with a movement, and credits the client through the existing balance + journal', async () => {
      const client = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CP-${suffix}`, name: 'Seller', type: 'RETAIL' } });
      const before = await vaultTotal();

      const ex = await createOldGoldExchange(
        { clientId: client.id, description: 'Old chain', karat: KARAT, grossWeight: 12, stoneWeight: 2, branchId },
        A.ctx, userId,
      );

      expect(await vaultTotal()).toBeCloseTo(before + 10);
      const stock = await prisma.metalStock.findUniqueOrThrow({ where: { id: ex.metalStockId! } });
      expect(stock).toMatchObject({ sourceType: 'CUSTOMER_SUPPLIED', sourceRef: ex.exchangeNumber, karat: KARAT });
      expect(Number(stock.grossWeight)).toBeCloseTo(12);
      expect(Number(stock.netWeight)).toBeCloseTo(10);
      expect(Number(ex.valuedAmount)).toBeCloseTo(10 * 5000);
      expect(ex.branchId).toBe(branchId);

      const move = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, referenceId: ex.id } });
      expect(move).toMatchObject({ movementType: 'CUSTOMER_PURCHASE', referenceType: 'OldGoldExchange', branchId, metalStockId: stock.id });
      expect(Number(move.quantity)).toBeCloseTo(10);
      expect(Number(move.beforeAvailableWt)).toBeCloseTo(0);
      expect(Number(move.afterAvailableWt)).toBeCloseTo(10);

      expect(Number((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).currentBalance)).toBeCloseTo(-50000);
      const entry = await getJournalEntry(ex.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(50000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(50000);
      expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id, name: 'Old chain' } })).toBe(0); // no tag created
    });

    it('an old-gold payment on a bill records an OLD_GOLD_EXCHANGE movement, and its reversal takes exactly that metal out once', async () => {
      const client = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CQ-${suffix}`, name: 'Payer', type: 'RETAIL' } });
      const inv = await invoiceFor({
        clientId: client.id,
        items: [{ productCode: 'X', description: 'Misc', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 30000, makingCharge: 0 }],
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Old bangle', karat: KARAT, grossWeight: 5 } }],
      });
      const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'OLD_GOLD' } });
      const ex = await prisma.oldGoldExchange.findFirstOrThrow({ where: { companyId: A.company.id, exchangeNumber: payment.referenceNo! } });
      const inMove = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, referenceId: ex.id } });
      expect(inMove.movementType).toBe('OLD_GOLD_EXCHANGE');
      expect(inMove.branchId).toBe(branchId);
      const vaultWithMetal = await vaultTotal();

      await reverseInvoicePayment(payment.id, A.ctx, userId, 'customer changed mind');

      const out = await prisma.metalStockMovement.findFirstOrThrow({ where: { companyId: A.company.id, movementType: 'OLD_GOLD_EXCHANGE_REVERSAL', referenceId: ex.id } });
      expect(Number(out.quantity)).toBeCloseTo(-5);
      expect(Number(out.afterAvailableWt)).toBeCloseTo(0);
      expect(await vaultTotal()).toBeCloseTo(vaultWithMetal - 5);

      await expect(reverseInvoicePayment(payment.id, A.ctx, userId, 'again')).rejects.toMatchObject({ statusCode: 409 });
      expect(await vaultTotal()).toBeCloseTo(vaultWithMetal - 5);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id, movementType: 'OLD_GOLD_EXCHANGE_REVERSAL', referenceId: ex.id } })).toBe(1);
    });

    it('a reversal is refused (never negative stock) once the metal has been sold on', async () => {
      await prisma.metalStock.updateMany({ where: { companyId: A.company.id }, data: { isActive: false } }); // vault holds ONLY the old gold below
      const client = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CR-${suffix}`, name: 'Payer 2', type: 'RETAIL' } });
      const inv = await invoiceFor({
        clientId: client.id,
        items: [{ productCode: 'X', description: 'Misc', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 30000, makingCharge: 0 }],
        payments: [{ paymentDate: new Date(), amount: 0, mode: 'OLD_GOLD', oldGold: { description: 'Old bangle', karat: KARAT, grossWeight: 5 } }],
      });
      await invoiceFor({ items: [materialLine(2)] }); // sells 2 g of that very metal
      expect(await vaultTotal()).toBeCloseTo(3);
      const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id, mode: 'OLD_GOLD' } });

      await expect(reverseInvoicePayment(payment.id, A.ctx, userId, 'too late')).rejects.toMatchObject({ statusCode: 409 });

      expect(await vaultTotal()).toBeCloseTo(3); // untouched, not negative
      expect((await prisma.metalStock.findMany({ where: { companyId: A.company.id } })).every((l) => Number(l.availableWt) >= 0)).toBe(true);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id, movementType: 'OLD_GOLD_EXCHANGE_REVERSAL' } })).toBe(1); // only the previous test's
    });
  });

  describe('8. tagged old jewellery purchase', () => {
    it('retires the original tag (kept, with history) and brings its metal into the vault, once', async () => {
      const seller = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CT-${suffix}`, name: 'Tag Seller', type: 'RETAIL' } });
      const tag = await makeTag({ status: 'SOLD', grossWeight: 8, netWeight: 7, stoneWeight: 1 });
      const vaultBefore = await vaultTotal();

      const ex = await createOldGoldExchange({ clientId: seller.id, tagId: tag.id }, A.ctx, userId);

      const after = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(after.status).toBe('RETIRED'); // retired, not deleted
      expect(ex.tagId).toBe(tag.id);
      expect(ex.branchId).toBe(branchId); // defaults to the tag's own branch
      expect(Number(ex.netWeight)).toBeCloseTo(7);
      expect(await vaultTotal()).toBeCloseTo(vaultBefore + 7);
      expect(Number((await prisma.client.findUniqueOrThrow({ where: { id: seller.id } })).currentBalance)).toBeCloseTo(-7 * 5000);
      const history = await prisma.tagHistory.findMany({ where: { tagId: tag.id, event: 'STATUS_CHANGE' } });
      expect(history.map((h) => h.status)).toContain('RETIRED');

      // the same tag cannot be bought back twice
      await expect(createOldGoldExchange({ clientId: seller.id, tagId: tag.id }, A.ctx, userId)).rejects.toMatchObject({ statusCode: 409 });
      expect(await vaultTotal()).toBeCloseTo(vaultBefore + 7);
      expect(await prisma.oldGoldExchange.count({ where: { tagId: tag.id } })).toBe(1);
    });

    it('refuses a piece that is still in our own stock', async () => {
      const seller = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CU-${suffix}`, name: 'Tag Seller 2', type: 'RETAIL' } });
      const tag = await makeTag(); // IN_STOCK
      const vaultBefore = await vaultTotal();
      await expect(createOldGoldExchange({ clientId: seller.id, tagId: tag.id }, A.ctx, userId)).rejects.toMatchObject({ statusCode: 409 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
      expect(await vaultTotal()).toBeCloseTo(vaultBefore);
    });
  });

  describe('10. company isolation', () => {
    it("another company's tag cannot be bought back, and its vault is neither read nor drained", async () => {
      const bTag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TAG-${suffix}-B`, companyId: B.company.id, branchId: B.branch.id, name: 'B ring', metalType: 'GOLD', metalKarat: KARAT,
          grossWeight: 5, netWeight: 5, costPrice: 1, sellingPrice: 2, status: 'SOLD', createdById: B.user.id,
        },
      });
      await expect(createOldGoldExchange({ clientId, tagId: bTag.id }, A.ctx, userId)).rejects.toMatchObject({ statusCode: 404 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: bTag.id } })).status).toBe('SOLD');

      // B holds 50 g; A's vault is 10 g. A selling 20 g must fail and B's metal must not move.
      const bLot = await seedLot(50, 4500, B);
      await expect(invoiceFor({ items: [materialLine(20)] })).rejects.toMatchObject({ statusCode: 409 });
      expect(Number((await prisma.metalStock.findUniqueOrThrow({ where: { id: bLot.id } })).availableWt)).toBeCloseTo(50);
      expect(await prisma.metalStockMovement.count({ where: { companyId: B.company.id, movementType: 'MATERIAL_SALE' } })).toBe(0);
    });

    it("another company's invoice cannot be returned against, and a foreign branch is refused", async () => {
      const inv = await invoiceFor({ items: [materialLine(1)] });
      await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, B.ctx, B.user.id))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(await vaultTotal()).toBeCloseTo(9);
      await expect(createOldGoldExchange({ clientId, description: 'x', karat: KARAT, grossWeight: 1, branchId: B.branch.id }, A.ctx, userId))
        .rejects.toBeDefined();
    });
  });
});
