import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { createPO, createGRN, createPurchaseReturn, recordSupplierPayment, listSupplierPayments } from './procurement.service';
import { createTagFromGrnItem } from '../tagging/tagging.service';
import { getSupplierLedger } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Money paid OUT to a supplier: Dr Accounts Payable / Cr Cash-or-Bank, and the supplier's live
// payable (Supplier.currentDue) — which intake now adds to and a return reduces — goes down.
describe('supplier payments and the supplier payable', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let otherSupplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];
  const paymentIds: string[] = [];

  const due = async (id = supplierId) => Number((await prisma.supplier.findUniqueOrThrow({ where: { id } })).currentDue);

  async function buy(price: number) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
      items: [{ materialCode: 'R', materialName: 'Ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 5, unit: 'PC', karat: '22K', ratePerUnit: price }],
    }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId: tenant.branch.id, invoiceNumber: `B-${price}`,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 5, scaleWeight: 5 }],
    }, tenant.ctx, userId);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId);
    tagIds.push(tag.id);
    return tag;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`SPM${suffix}`, ['po:create', 'grn:create', 'tag:create', 'journal:create']);
    userId = tenant.user.id;
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `P${suffix}`.slice(0, 8).toUpperCase(), name: 'Pay Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `PAYCAT-${suffix}`, name: 'Pay Category' },
    })).id;
    // Unregistered supplier: bills carry no GST, so the arithmetic below is just the cost.
    supplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `SPM-${suffix}`, name: 'Paid Supplier', type: 'OTHER' },
    })).id;
    otherSupplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `SPM2-${suffix}`, name: 'Other Supplier', type: 'OTHER' },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries([...tagIds, ...returnIds, ...paymentIds]);
    await prisma.supplierPayment.deleteMany({ where: { id: { in: paymentIds } } });
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierId, otherSupplierId] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('intake puts the bill on the supplier\'s account', async () => {
    expect(await due()).toBe(0);
    await buy(30000);
    expect(await due()).toBeCloseTo(30000);
  });

  it('a bank payment posts Dr Accounts Payable / Cr Bank and reduces what is owed', async () => {
    const p = await recordSupplierPayment(
      { supplierId, amount: 10000, mode: 'upi', paymentDate: new Date(), referenceNo: 'UTR123' },
      tenant.ctx, userId
    );
    paymentIds.push(p.id);

    expect(p.paymentNumber).toMatch(/^SPMT-/);
    expect(p.mode).toBe('UPI');
    expect(Number(p.amount)).toBe(10000);
    expect(await due()).toBeCloseTo(20000);

    const entry = await getJournalEntry(p.id);
    expect(entry!.referenceType).toBe('SupplierPayment');
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).debit).toBeCloseTo(10000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.BANK_ACCOUNT).credit).toBeCloseTo(10000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.CASH_IN_HAND).credit).toBe(0);
  });

  it('a cash payment credits Cash in Hand, not the bank', async () => {
    const p = await recordSupplierPayment({ supplierId, amount: 5000, mode: 'CASH', paymentDate: new Date() }, tenant.ctx, userId);
    paymentIds.push(p.id);
    const entry = await getJournalEntry(p.id);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.CASH_IN_HAND).credit).toBeCloseTo(5000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.BANK_ACCOUNT).credit).toBe(0);
    expect(await due()).toBeCloseTo(15000);
  });

  it('a purchase return also reduces the payable', async () => {
    const tag = await buy(4000);
    expect(await due()).toBeCloseTo(19000);
    const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId);
    returnIds.push(ret.id);
    expect(await due()).toBeCloseTo(15000);
  });

  it('a payment larger than what is owed leaves a negative payable — an advance to the supplier', async () => {
    const p = await recordSupplierPayment({ supplierId: otherSupplierId, amount: 2500, mode: 'CASH', paymentDate: new Date() }, tenant.ctx, userId);
    paymentIds.push(p.id);
    expect(await due(otherSupplierId)).toBeCloseTo(-2500);
  });

  it('rejects a zero/negative amount, a missing mode, and another company\'s supplier', async () => {
    await expect(recordSupplierPayment({ supplierId, amount: 0, mode: 'CASH', paymentDate: new Date() }, tenant.ctx, userId)).rejects.toThrow(/positive/);
    await expect(recordSupplierPayment({ supplierId, amount: -5, mode: 'CASH', paymentDate: new Date() }, tenant.ctx, userId)).rejects.toThrow(AppError);
    await expect(recordSupplierPayment({ supplierId, amount: 5, mode: ' ', paymentDate: new Date() }, tenant.ctx, userId)).rejects.toThrow(/mode/);

    const other = await createTestTenant(`SPX${suffix}`, ['journal:create']);
    try {
      const foreign = await prisma.supplier.create({
        data: { companyId: other.company.id, supplierCode: `FOREIGN-${suffix}`, name: 'Foreign', type: 'OTHER' },
      });
      await expect(
        recordSupplierPayment({ supplierId: foreign.id, amount: 100, mode: 'CASH', paymentDate: new Date() }, tenant.ctx, userId)
      ).rejects.toThrow(/not found/i);
      await expect(listSupplierPayments(tenant.ctx, foreign.id)).rejects.toThrow(/not found/i);
      await prisma.supplier.delete({ where: { id: foreign.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });

  it("lists a supplier's payments, newest first", async () => {
    const list = await listSupplierPayments(tenant.ctx, supplierId);
    expect(list.map((p) => Number(p.amount))).toEqual([5000, 10000]);
  });

  it('the supplier statement lines up purchases, returns and payments into the same running payable', async () => {
    const ledger = await getSupplierLedger(tenant.ctx, supplierId);
    const types = ledger.rows.map((r) => r.type);
    expect(types.filter((t) => t === 'PURCHASE')).toHaveLength(2);
    expect(types.filter((t) => t === 'RETURN')).toHaveLength(1);
    expect(types.filter((t) => t === 'PAYMENT')).toHaveLength(2);
    // 30000 + 4000 bought, 4000 returned, 15000 paid
    expect(ledger.closingBalance).toBeCloseTo(15000);
    expect(ledger.closingBalance).toBeCloseTo(ledger.supplier.currentDue); // statement and live payable agree
  });
});
