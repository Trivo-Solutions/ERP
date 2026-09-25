import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { createPurchaseReturn } from './procurement.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

describe('createPurchaseReturn (D3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let supplierAId: string;
  let supplierBId: string;
  const tagIds: string[] = [];
  const returnIds: string[] = [];

  // Builds a GRN-sourced tag (grnItemId set) for the given supplier — the funnel gap #1's
  // createTagFromGrnItem produces, replicated directly here since this test only needs the
  // resulting shape (a tag with real PO/GRN lineage), not that function's own behavior.
  async function makePurchasedTag(supplierId: string, name: string, overrides: { status?: string } = {}) {
    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: tenant.company.id,
        poNumber: `TSTPO-D3-${suffix}-${tagIds.length}`,
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        poItems: {
          create: {
            materialCode: 'RING-D3', materialName: name, materialType: FINISHED_GOODS_MATERIAL_TYPE,
            quantity: 1, weight: 5, unit: 'PC', karat: '22K', ratePerUnit: 25000, totalAmount: 25000,
          },
        },
      },
      include: { poItems: true },
    });

    const grn = await prisma.goodsReceiptNote.create({
      data: {
        companyId: tenant.company.id,
        grnNumber: `TSTGRN-D3-${suffix}-${tagIds.length}`,
        poId: po.id, receivedDate: new Date(), branchId,
        grnItems: {
          create: {
            poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 5, scaleWeight: 5,
            acceptedWeight: 5, variance: 0, variancePercent: 0, isVerified: true,
          },
        },
      },
      include: { grnItems: true },
    });

    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-D3-${suffix}-${tagIds.length}`,
        companyId: tenant.company.id,
        branchId, name, metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 5, stoneWeight: 0,
        costPrice: 25000, sellingPrice: 30000,
        grnItemId: grn.grnItems[0].id,
        status: overrides.status ?? 'IN_STOCK',
        createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`D3${suffix}`, ['po:approve']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const supplierA = await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `TSTSUP-D3A-${suffix}`, name: 'Test Supplier A', type: 'OTHER' },
    });
    supplierAId = supplierA.id;

    const supplierB = await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `TSTSUP-D3B-${suffix}`, name: 'Test Supplier B', type: 'OTHER' },
    });
    supplierBId = supplierB.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(returnIds);

    // Must precede the jewelryTag/purchaseOrder deletes below — same RESTRICT-FK ordering used
    // for sales_return_items in sales.service.test.ts.
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } }); // cascades purchase_return_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } }); // frees grn_items' back-ref
    await prisma.goodsReceiptNote.deleteMany({ where: { po: { supplierId: { in: [supplierAId, supplierBId] } } } });
    await prisma.purchaseOrder.deleteMany({ where: { supplierId: { in: [supplierAId, supplierBId] } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierAId, supplierBId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('flips an IN_STOCK GRN-sourced tag to RETIRED and creates the return, amount defaulting to costPrice', async () => {
    const tag = await makePurchasedTag(supplierAId, 'Returnable Ring A');

    const purchaseReturn = await createPurchaseReturn(
      { items: [{ tagId: tag.id }], reason: 'Defective' },
      tenant.ctx, userId
    );
    returnIds.push(purchaseReturn.id);

    expect(purchaseReturn.returnNumber).toMatch(/^PRET-/);
    expect(purchaseReturn.supplierId).toBe(supplierAId);
    expect(Number(purchaseReturn.totalAmount)).toBe(25000); // costPrice, not sellingPrice
    expect(purchaseReturn.items[0].tagId).toBe(tag.id);

    const updatedTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(updatedTag.status).toBe('RETIRED');

    // F1: reverse of createTagFromGrnItem's intake entry — the piece leaves Inventory and what we
    // owed the supplier for it goes down too.
    const entry = await getJournalEntry(purchaseReturn.id);
    expect(entry).not.toBeNull();
    expect(entry!.referenceType).toBe('PurchaseReturn');
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).debit).toBeCloseTo(25000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(25000);
  });

  it('honors an explicit amount override', async () => {
    const tag = await makePurchasedTag(supplierAId, 'Returnable Ring B');

    const purchaseReturn = await createPurchaseReturn(
      { items: [{ tagId: tag.id, amount: 9999 }] },
      tenant.ctx, userId
    );
    returnIds.push(purchaseReturn.id);

    expect(Number(purchaseReturn.items[0].amount)).toBe(9999);
  });

  it('rejects a tag with no purchase lineage (manufactured, not purchased)', async () => {
    const manufacturedTag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-D3-MANUF-${suffix}`,
        companyId: tenant.company.id,
        branchId, name: 'Manufactured Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 5, stoneWeight: 0, costPrice: 20000, sellingPrice: 25000,
        status: 'IN_STOCK', createdById: userId,
      },
    });
    tagIds.push(manufacturedTag.id);

    await expect(
      createPurchaseReturn({ items: [{ tagId: manufacturedTag.id }] }, tenant.ctx, userId)
    ).rejects.toThrow(/no purchase lineage/);
  });

  it('rejects a tag that is not currently IN_STOCK', async () => {
    const tag = await makePurchasedTag(supplierAId, 'Already Sold Ring', { status: 'SOLD' });

    await expect(
      createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId)
    ).rejects.toThrow(/not IN_STOCK/);
  });

  it('rejects tags spanning more than one supplier in a single return', async () => {
    const tagA = await makePurchasedTag(supplierAId, 'Ring From A');
    const tagB = await makePurchasedTag(supplierBId, 'Ring From B');

    await expect(
      createPurchaseReturn({ items: [{ tagId: tagA.id }, { tagId: tagB.id }] }, tenant.ctx, userId)
    ).rejects.toThrow(/same supplier/);
  });

  it('rejects the same tag appearing twice in one return request', async () => {
    const tag = await makePurchasedTag(supplierAId, 'Duplicate Ring');

    await expect(
      createPurchaseReturn({ items: [{ tagId: tag.id }, { tagId: tag.id }] }, tenant.ctx, userId)
    ).rejects.toThrow(AppError);
  });
});
