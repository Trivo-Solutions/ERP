import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { createPO, createGRN, createPurchaseReturn } from './procurement.service';
import { createTagFromGrnItem } from '../tagging/tagging.service';
import { getPurchaseGstSummary } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Purchase-side (input) GST: the rate snapshotted onto the PO line, split CGST+SGST / IGST at intake
// by supplier state vs company state (the tenant fixture's company is state 24), booked to the ITC
// accounts, stamped on the GRN line, and given back — exactly — by a purchase return.
describe('purchase input GST (PO -> intake -> return)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let categoryId: string;
  let sameStateSupplierId: string;   // GSTIN prefix 24 == company state 24
  let otherStateSupplierId: string;  // GSTIN prefix 27
  let unregisteredSupplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];

  const line = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'RING-G', materialName: 'GST ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  // PO -> GRN -> tag for one finished piece from `supplierId`; returns the tag and its GRN item.
  async function intake(supplierId: string, price: number, lineExtra: Record<string, unknown> = {}, poExtra: Record<string, unknown> = {}) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(price, lineExtra)], ...poExtra }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `SUP-INV-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, tenant.ctx, userId);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'GST ring', metalType: 'GOLD',
    }, tenant.ctx, userId);
    tagIds.push(tag.id);
    return { po, grn, tag, grnItemId: grn.grnItems[0].id };
  }

  const supplierDue = async (id: string) => Number((await prisma.supplier.findUniqueOrThrow({ where: { id } })).currentDue);

  beforeAll(async () => {
    tenant = await createTestTenant(`GST${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `G${suffix}`.slice(0, 8).toUpperCase(), name: 'GST Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `GSTCAT-${suffix}`, name: 'GST Category' },
    })).id;
    const mk = async (code: string, extra: Record<string, unknown>) => (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `${code}-${suffix}`, name: `Supplier ${code}`, type: 'OTHER', ...extra },
    })).id;
    sameStateSupplierId = await mk('SAME', { gstNumber: '24AAAAA0000A1Z5' });
    otherStateSupplierId = await mk('OTHER', { gstNumber: '27AAAAA0000A1Z5' });
    unregisteredSupplierId = await mk('URD', {});
  });

  afterAll(async () => {
    await cleanupJournalEntries([...tagIds, ...returnIds]);
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: [sameStateSupplierId, otherStateSupplierId, unregisteredSupplierId] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('PO line rate', () => {
    it("snapshots the HSN master's rate (3%) for a GST-registered supplier and adds it to the PO total", async () => {
      const po = await createPO({ supplierId: sameStateSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(45000)] }, tenant.ctx, userId);
      poIds.push(po.id);
      expect(Number(po.poItems[0].taxRate)).toBeCloseTo(0.03);
      expect(po.poItems[0].hsnCodeId).not.toBeNull();
      expect(Number(po.subtotal)).toBe(45000);
      expect(Number(po.taxAmount)).toBeCloseTo(1350);
      expect(Number(po.totalAmount)).toBeCloseTo(46350);
    });

    it('charges no GST on a bill from an unregistered supplier', async () => {
      const po = await createPO({ supplierId: unregisteredSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(45000)] }, tenant.ctx, userId);
      poIds.push(po.id);
      expect(Number(po.poItems[0].taxRate)).toBe(0);
      expect(Number(po.taxAmount)).toBe(0);
      expect(Number(po.totalAmount)).toBe(45000);
    });

    it('takes an explicit rate exactly as entered off the bill, and rejects a percent typed as a fraction', async () => {
      const po = await createPO({ supplierId: sameStateSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(10000, { taxRate: 0.05 })] }, tenant.ctx, userId);
      poIds.push(po.id);
      expect(Number(po.poItems[0].taxRate)).toBeCloseTo(0.05);
      await expect(
        createPO({ supplierId: sameStateSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(10000, { taxRate: 3 })] }, tenant.ctx, userId)
      ).rejects.toThrow(/fraction/);
    });

    it('carries no GST on a non-INR PO, and rejects an unknown HSN code', async () => {
      const po = await createPO({ supplierId: sameStateSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), currency: 'USD', items: [line(500)] }, tenant.ctx, userId);
      poIds.push(po.id);
      expect(Number(po.poItems[0].taxRate)).toBe(0);
      await expect(
        createPO({ supplierId: sameStateSupplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(500, { hsnCode: '0000' })] }, tenant.ctx, userId)
      ).rejects.toThrow(/Unknown HSN/);
    });
  });

  describe('intake (createTagFromGrnItem)', () => {
    it('same-state supplier: books CGST + SGST to input credit, cost stays the bare taxable value, supplier owed goods + GST', async () => {
      const before = await supplierDue(sameStateSupplierId);
      const { tag, grnItemId } = await intake(sameStateSupplierId, 45000);

      expect(Number(tag.costPrice)).toBe(45000); // recoverable GST is never part of stock cost

      const entry = await getJournalEntry(tag.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(45000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).debit).toBeCloseTo(675);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).debit).toBeCloseTo(675);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(46350);

      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
      expect(Number(g.taxableValue)).toBe(45000);
      expect(Number(g.inputCgst)).toBeCloseTo(675);
      expect(Number(g.inputSgst)).toBeCloseTo(675);
      expect(Number(g.inputIgst)).toBe(0);

      expect((await supplierDue(sameStateSupplierId)) - before).toBeCloseTo(46350);
    });

    it('other-state supplier: books IGST instead', async () => {
      const { tag, grnItemId } = await intake(otherStateSupplierId, 45000);
      const entry = await getJournalEntry(tag.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).debit).toBeCloseTo(1350);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(46350);
      expect(Number((await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } })).inputIgst)).toBeCloseTo(1350);
    });

    it('unregistered supplier: no input credit at all, payable is just the cost', async () => {
      const before = await supplierDue(unregisteredSupplierId);
      const { tag } = await intake(unregisteredSupplierId, 45000);
      const entry = await getJournalEntry(tag.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).debit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(45000);
      expect((await supplierDue(unregisteredSupplierId)) - before).toBeCloseTo(45000);
    });
  });

  describe('purchase return', () => {
    it('gives the input GST back exactly as booked and reduces what the supplier is owed by goods + GST', async () => {
      const before = await supplierDue(sameStateSupplierId);
      const { tag } = await intake(sameStateSupplierId, 20000);
      expect((await supplierDue(sameStateSupplierId)) - before).toBeCloseTo(20600); // 20000 + 600

      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }], reason: 'Defective' }, tenant.ctx, userId);
      returnIds.push(ret.id);

      expect(Number(ret.totalAmount)).toBe(20000);
      expect(Number(ret.taxAmount)).toBeCloseTo(600);
      expect(Number(ret.items[0].cgst)).toBeCloseTo(300);
      expect(Number(ret.items[0].sgst)).toBeCloseTo(300);

      const entry = await getJournalEntry(ret.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).debit).toBeCloseTo(20600);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(20000);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).credit).toBeCloseTo(300);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).credit).toBeCloseTo(300);

      expect(await supplierDue(sameStateSupplierId)).toBeCloseTo(before); // back to where it started
    });

    it('reverses pro-rata when the return amount is overridden, and IGST stays IGST', async () => {
      const { tag } = await intake(otherStateSupplierId, 10000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id, amount: 5000 }] }, tenant.ctx, userId);
      returnIds.push(ret.id);
      expect(Number(ret.taxAmount)).toBeCloseTo(150); // 3% of the 5000 returned
      expect(Number(ret.items[0].igst)).toBeCloseTo(150);
      expect(Number(ret.items[0].cgst)).toBe(0);
    });

    it('reverses no GST for a piece whose intake booked none (predates input GST / unregistered supplier)', async () => {
      const { tag } = await intake(unregisteredSupplierId, 8000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId);
      returnIds.push(ret.id);
      expect(Number(ret.taxAmount)).toBe(0);
    });
  });

  describe('purchase GST summary (ITC prep)', () => {
    it('rolls intake up by HSN and rate, nets purchase returns, and lists the supplier bills', async () => {
      // Fresh company so the totals are exactly this test's own.
      const t2 = await createTestTenant(`GSU${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
      const st = await prisma.stockType.create({ data: { companyId: t2.company.id, code: `S${suffix}`.slice(0, 8).toUpperCase(), name: 'S' } });
      const cat = await prisma.productCategory.create({ data: { companyId: t2.company.id, code: `SUMCAT-${suffix}`, name: 'C' } });
      const sup = await prisma.supplier.create({
        data: { companyId: t2.company.id, supplierCode: `SUM-${suffix}`, name: 'Summary Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z5' },
      });
      const localPoIds: string[] = [];
      const localTagIds: string[] = [];
      const localReturnIds: string[] = [];
      try {
        for (const price of [10000, 20000]) {
          const po = await createPO({ supplierId: sup.id, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(price)] }, t2.ctx, t2.user.id);
          localPoIds.push(po.id);
          const grn = await createGRN({
            poId: po.id, receivedDate: new Date(), branchId: t2.branch.id, invoiceNumber: `BILL-${price}`, invoiceDate: new Date(),
            items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
          }, t2.ctx, t2.user.id);
          const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId: st.id, categoryId: cat.id, name: 'r', metalType: 'GOLD' }, t2.ctx, t2.user.id);
          localTagIds.push(tag.id);
        }
        const ret = await createPurchaseReturn({ items: [{ tagId: localTagIds[0] }] }, t2.ctx, t2.user.id);
        localReturnIds.push(ret.id);

        const from = new Date(Date.now() - 86_400_000), to = new Date(Date.now() + 86_400_000);
        const summary = await getPurchaseGstSummary(t2.company.id, from, to);

        expect(summary.rows).toHaveLength(1);
        expect(summary.rows[0].hsnCode).toBe('7113');
        expect(summary.rows[0].taxRate).toBeCloseTo(0.03);
        // (10000 + 20000) bought - 10000 returned = 20000 net taxable, 3% = 600 → 300 + 300
        expect(summary.totals.taxableValue).toBeCloseTo(20000);
        expect(summary.totals.cgst).toBeCloseTo(300);
        expect(summary.totals.sgst).toBeCloseTo(300);
        expect(summary.totals.igst).toBe(0);
        expect(summary.totals.totalTax).toBeCloseTo(600);

        // Bills are the gross purchases (a return is its own credit note), one per supplier invoice.
        expect(summary.bills.map((b) => b.invoiceNumber).sort()).toEqual(['BILL-10000', 'BILL-20000']);
        expect(summary.bills[0].supplierGstin).toBe('24AAAAA0000A1Z5');
      } finally {
        await cleanupJournalEntries([...localTagIds, ...localReturnIds]);
        await prisma.purchaseReturn.deleteMany({ where: { id: { in: localReturnIds } } });
        await prisma.jewelryTag.deleteMany({ where: { id: { in: localTagIds } } });
        await prisma.auditLog.deleteMany({ where: { userId: t2.user.id } });
        await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: localPoIds } } });
        await prisma.purchaseOrder.deleteMany({ where: { id: { in: localPoIds } } });
        await prisma.supplier.deleteMany({ where: { id: sup.id } });
        await prisma.stockType.deleteMany({ where: { id: st.id } });
        await prisma.productCategory.deleteMany({ where: { id: cat.id } });
        await cleanupTestTenant(t2);
      }
    });
  });
});
