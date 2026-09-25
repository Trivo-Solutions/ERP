import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { createPO, createGRN } from './procurement.service';
import { createTagFromGrnItem } from '../tagging/tagging.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { addBranch, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Buy-side wiring behind the GRN screen: a finished-goods PO line, a GRN that records the receiving
// branch, and the tag created from that GRN line landing at that branch with its intake entry.
describe('finished-goods intake through PO -> GRN -> tag', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let otherBranchId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];

  const finishedLine = (name: string, price: number, weight = 8.5) => ({
    materialCode: 'RING-X', materialName: name, materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight, unit: 'PC', karat: '22K', ratePerUnit: price,
  });

  async function makePo(items: ReturnType<typeof finishedLine>[]) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items }, tenant.ctx, userId);
    poIds.push(po.id);
    return po;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`INT${suffix}`, ['po:create', 'grn:create', 'tag:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    otherBranchId = (await addBranch(tenant.company.id, `INT${suffix}`)).id;

    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `I${suffix}`.slice(0, 8).toUpperCase(), name: 'Intake Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `INTCAT-${suffix}`, name: 'Intake Category' },
    })).id;
    supplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `TSTSUP-INT-${suffix}`, name: 'Intake Supplier', type: 'OTHER' },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.branch.deleteMany({ where: { id: otherBranchId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('rejects a FINISHED_GOODS PO line with quantity other than 1 (one line = one piece = one tag)', async () => {
    await expect(
      createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [{ ...finishedLine('Bulk rings', 9000), quantity: 3 }],
      }, tenant.ctx, userId)
    ).rejects.toThrow(/one piece/);
  });

  it('requires a receiving branch on a GRN that receives finished goods', async () => {
    const po = await makePo([finishedLine('Ring no-branch', 45000)]);
    await expect(
      createGRN({
        poId: po.id, receivedDate: new Date(),
        items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8.5, scaleWeight: 8.5 }],
      }, tenant.ctx, userId)
    ).rejects.toThrow(/Receiving branch is required/);
  });

  it('does not require a branch when the GRN has no finished-goods line', async () => {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
      items: [{ materialCode: 'G', materialName: 'Gold', materialType: 'METAL', quantity: 1, weight: 10, unit: 'GM', karat: '24K', ratePerUnit: 6000 }],
    }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 10, scaleWeight: 10 }],
    }, tenant.ctx, userId);
    expect(grn.branchId).toBeNull();
  });

  it('records the receiving branch, and the tag created from the GRN line lands there and posts the intake entry', async () => {
    const po = await makePo([finishedLine('Ring at other branch', 45000)]);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId: otherBranchId,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8.5, scaleWeight: 8.5 }],
    }, tenant.ctx, userId);
    expect(grn.branchId).toBe(otherBranchId);

    // No branchId passed: falls back to the GRN's receiving branch.
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'Ring at other branch', metalType: 'GOLD',
    }, tenant.ctx, userId);
    tagIds.push(tag.id);

    expect(tag.status).toBe('IN_STOCK');
    expect(tag.branchId).toBe(otherBranchId);
    expect(tag.grnItemId).toBe(grn.grnItems[0].id);
    expect(Number(tag.costPrice)).toBe(45000);

    const entry = await getJournalEntry(tag.id);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(45000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(45000);
  });

  it('an explicit branchId still overrides the GRN branch', async () => {
    const po = await makePo([finishedLine('Ring override', 30000, 5)]);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId: otherBranchId,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 5, scaleWeight: 5 }],
    }, tenant.ctx, userId);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, branchId, stockTypeId, categoryId, name: 'Ring override', metalType: 'GOLD',
    }, tenant.ctx, userId);
    tagIds.push(tag.id);
    expect(tag.branchId).toBe(branchId);
  });

  it("rejects tagging a GRN line that has no branch anywhere (GRN has none, none supplied)", async () => {
    // A legacy GRN row created before the receiving-branch column existed.
    const po = await makePo([finishedLine('Legacy ring', 20000, 4)]);
    const legacyGrn = await prisma.goodsReceiptNote.create({
      data: {
        companyId: tenant.company.id, grnNumber: `LEGACY-${suffix}`, poId: po.id, receivedDate: new Date(),
        grnItems: {
          create: {
            poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 4, scaleWeight: 4, acceptedWeight: 4,
            variance: 0, variancePercent: 0, isVerified: true,
          },
        },
      },
      include: { grnItems: true },
    });
    await expect(
      createTagFromGrnItem({
        grnItemId: legacyGrn.grnItems[0].id, stockTypeId, categoryId, name: 'Legacy ring', metalType: 'GOLD',
      }, tenant.ctx, userId)
    ).rejects.toThrow(/Branch is required/);
  });
});
