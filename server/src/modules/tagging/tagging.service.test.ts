import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import {
  createTag as _createTag, updateTag, createTagFromGrnItem as _createTagFromGrnItem, searchTags as _searchTags,
  getBranchStockSummary,
  startStockAudit, scanAuditItem, completeStockAudit, getStockOnHand, getDeadStock, getStockBook,
  getTagPrintTspl, listTagTemplates, getTagTemplateById, createTagTemplate, updateTagTemplate,
} from './tagging.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

describe('createTagFromGrnItem (finished-goods intake)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let poId: string;
  let grnId: string;
  let finishedGrnItemId: string;
  let rawGrnItemId: string;
  const createdTagIds: string[] = [];

  // Local shims absorbing the multi-tenant signature change (ctx now required) so the ~15
  // existing call sites below don't each need editing — they keep calling createTag(data,
  // userId)/createTagFromGrnItem(data, userId) exactly as before; only this one place threads
  // the test tenant's context through.
  function createTag(data: Parameters<typeof _createTag>[1], uid: string) {
    return _createTag(tenant.ctx, data, uid);
  }
  function createTagFromGrnItem(data: Parameters<typeof _createTagFromGrnItem>[0], uid: string) {
    return _createTagFromGrnItem(data, tenant.ctx, uid);
  }
  function searchTags(query: string, branchId?: string, status?: string) {
    return _searchTags(tenant.ctx, query, branchId, status);
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, ['tag:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    // createTag/createTagFromGrnItem now require both — the tag number is built from their codes.
    const stockType = await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `T${suffix}`.slice(0, 8).toUpperCase(), name: 'Test Stock Type' },
    });
    stockTypeId = stockType.id;

    const category = await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `TSTCAT-${suffix}`, name: 'Test Category' },
    });
    categoryId = category.id;

    const supplier = await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `TSTSUP-${suffix}`, name: 'Test Supplier', type: 'OTHER' },
    });
    supplierId = supplier.id;

    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: tenant.company.id,
        poNumber: `TSTPO-${suffix}`,
        supplierId,
        poType: 'OUTRIGHT',
        orderDate: new Date(),
        poItems: {
          createMany: {
            data: [
              {
                // one finished piece bought ready-to-sell: quantity is always 1 (gap #1 assumption)
                materialCode: 'RING-001',
                materialName: 'Gold Ring 22K',
                materialType: FINISHED_GOODS_MATERIAL_TYPE,
                quantity: 1,
                weight: 8.5,
                unit: 'PC',
                karat: '22K',
                ratePerUnit: 45000,
                totalAmount: 45000,
              },
              {
                // a normal raw-material line, to prove it's rejected by the new path
                materialCode: 'GOLD-BAR',
                materialName: 'Gold Bullion',
                materialType: 'GOLD',
                quantity: 1,
                weight: 100,
                unit: 'GM',
                karat: '24K',
                ratePerUnit: 6000,
                totalAmount: 600000,
              },
            ],
          },
        },
      },
      include: { poItems: true },
    });
    poId = po.id;
    const finishedPoItemId = po.poItems.find((i) => i.materialType === FINISHED_GOODS_MATERIAL_TYPE)!.id;
    const rawPoItemId = po.poItems.find((i) => i.materialType === 'GOLD')!.id;

    const grn = await prisma.goodsReceiptNote.create({
      data: {
        companyId: tenant.company.id,
        grnNumber: `TSTGRN-${suffix}`,
        poId: po.id,
        receivedDate: new Date(),
        branchId,
        grnItems: {
          createMany: {
            data: [
              {
                poItemId: finishedPoItemId,
                invoiceQty: 1, invoiceWeight: 8.5, scaleWeight: 8.4, acceptedWeight: 8.4,
                variance: -0.1, variancePercent: -1.18, isVerified: true,
              },
              {
                poItemId: rawPoItemId,
                invoiceQty: 1, invoiceWeight: 100, scaleWeight: 100, acceptedWeight: 100,
                variance: 0, variancePercent: 0, isVerified: true,
              },
            ],
          },
        },
      },
      include: { grnItems: true },
    });
    grnId = grn.id;
    finishedGrnItemId = grn.grnItems.find((i) => i.poItemId === finishedPoItemId)!.id;
    rawGrnItemId = grn.grnItems.find((i) => i.poItemId === rawPoItemId)!.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(createdTagIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: createdTagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { id: grnId } }); // cascades grn_items
    await prisma.purchaseOrder.deleteMany({ where: { id: poId } });    // cascades po_items
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('creates an IN_STOCK tag linked back to the GRN item, with derived cost/weights', async () => {
    const tag = await createTagFromGrnItem(
      {
        grnItemId: finishedGrnItemId,
        branchId,
        stockTypeId, categoryId,
        name: 'Gold Ring 22K',
        metalType: 'GOLD',
        stoneWeight: 0.4,
      },
      userId
    );
    createdTagIds.push(tag.id);

    expect(tag.status).toBe('IN_STOCK');
    expect(tag.grnItemId).toBe(finishedGrnItemId);
    expect(tag.branchId).toBe(branchId);
    expect(Number(tag.costPrice)).toBe(45000);          // PO line totalAmount (v1: no separate making/wastage)
    expect(Number(tag.grossWeight)).toBeCloseTo(8.4);    // defaults to GrnItem.acceptedWeight
    expect(Number(tag.stoneWeight)).toBeCloseTo(0.4);
    expect(Number(tag.netWeight)).toBeCloseTo(8.0);      // gross - stone, never gross === net here
    expect(tag.metalKarat).toBe('22K');                  // falls back to PoItem.karat
    // No MakingCharge master row matches: the SALE making charge / VA stay unset (never the PO's cost figures, never 0).
    expect(tag.saleMcRate).toBeNull();
    expect(tag.saleVaPercent).toBeNull();

    const auditEntry = await prisma.auditLog.findFirst({
      where: { tableName: 'jewelry_tags', recordId: tag.id, action: 'CREATE' },
    });
    expect(auditEntry).not.toBeNull();

    // F1: the buy-side of the buy->stock->sell loop — the piece's costPrice enters the books as
    // Dr Inventory / Cr Accounts Payable, mirroring createInvoice's COGS/Inventory entry on sale.
    const entry = await getJournalEntry(tag.id);
    expect(entry).not.toBeNull();
    expect(entry!.referenceType).toBe('JewelryTag');
    expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(45000);
    expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).credit).toBeCloseTo(45000);
  });

  it('fills the SALE making charge + VA from the MakingCharge master (most specific row), never from the PO cost side', async () => {
    const first = await prisma.grnItem.findUniqueOrThrow({ where: { id: finishedGrnItemId } });
    const item2 = await prisma.grnItem.create({
      data: { companyId: tenant.company.id, grnId, poItemId: first.poItemId, invoiceQty: 1, invoiceWeight: 8.5, scaleWeight: 8.4, acceptedWeight: 8.4, variance: -0.1, variancePercent: -1.18, isVerified: true },
    });
    const master = await prisma.makingCharge.create({
      data: { companyId: tenant.company.id, karat: '22K', categoryId, saleWastagePercent: 7, makingCharge: 350, makingChargeType: 'PER_GRAM' },
    });
    try {
      const tag = await createTagFromGrnItem({ grnItemId: item2.id, branchId, stockTypeId, categoryId, name: 'Gold Ring 22K', metalType: 'GOLD', stoneWeight: 0.4 }, userId);
      createdTagIds.push(tag.id);
      expect(Number(tag.saleMcRate)).toBe(350);
      expect(Number(tag.saleVaPercent)).toBe(7);
      expect(Number(tag.costPrice)).toBe(45000); // cost untouched
    } finally {
      await prisma.makingCharge.delete({ where: { id: master.id } });
    }
  });

  it('rejects a second tag for the same GRN item (no double-tagging)', async () => {
    await expect(
      createTagFromGrnItem(
        { grnItemId: finishedGrnItemId, branchId, stockTypeId, categoryId, name: 'Gold Ring 22K (dup)', metalType: 'GOLD' },
        userId
      )
    ).rejects.toThrow(AppError);
  });

  it('rejects concurrent double-tag attempts on a fresh GRN item (DB-level guarantee)', async () => {
    // A second finished-goods line/GRN item so this test doesn't collide with the one above.
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const extraPoItem = await prisma.poItem.create({
      data: {
        companyId: tenant.company.id,
        poId: po.id, materialCode: 'RING-002', materialName: 'Gold Ring 22K #2',
        materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 7.0, unit: 'PC',
        karat: '22K', ratePerUnit: 38000, totalAmount: 38000,
      },
    });
    const extraGrnItem = await prisma.grnItem.create({
      data: {
        companyId: tenant.company.id,
        grnId, poItemId: extraPoItem.id, invoiceQty: 1, invoiceWeight: 7.0, scaleWeight: 7.0,
        acceptedWeight: 7.0, variance: 0, variancePercent: 0, isVerified: true,
      },
    });

    const attempt = (n: number) =>
      createTagFromGrnItem(
        { grnItemId: extraGrnItem.id, branchId, stockTypeId, categoryId, name: `Race ${n}`, metalType: 'GOLD' },
        userId
      );

    const results = await Promise.allSettled([attempt(1), attempt(2), attempt(3)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    createdTagIds.push(fulfilled[0].value.id);

    const tagCount = await prisma.jewelryTag.count({ where: { grnItemId: extraGrnItem.id } });
    expect(tagCount).toBe(1);
  });

  it('rejects a GRN item whose PO line is not FINISHED_GOODS', async () => {
    await expect(
      createTagFromGrnItem(
        { grnItemId: rawGrnItemId, branchId, stockTypeId, categoryId, name: 'Should not tag', metalType: 'GOLD' },
        userId
      )
    ).rejects.toThrow(/not a FINISHED_GOODS line/);
  });

  it('rejects stoneWeight greater than grossWeight', async () => {
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const extraPoItem = await prisma.poItem.create({
      data: {
        companyId: tenant.company.id,
        poId: po.id, materialCode: 'RING-003', materialName: 'Gold Ring 22K #3',
        materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 5.0, unit: 'PC',
        karat: '22K', ratePerUnit: 20000, totalAmount: 20000,
      },
    });
    const extraGrnItem = await prisma.grnItem.create({
      data: {
        companyId: tenant.company.id,
        grnId, poItemId: extraPoItem.id, invoiceQty: 1, invoiceWeight: 5.0, scaleWeight: 5.0,
        acceptedWeight: 5.0, variance: 0, variancePercent: 0, isVerified: true,
      },
    });

    await expect(
      createTagFromGrnItem(
        { grnItemId: extraGrnItem.id, branchId, stockTypeId, categoryId, name: 'Bad stone weight', metalType: 'GOLD', stoneWeight: 9.0 },
        userId
      )
    ).rejects.toThrow(/Stone weight cannot exceed gross weight/);
  });

  it('rejects an unknown karat/purity code on direct tag creation', async () => {
    await expect(
      createTag(
        { branchId, stockTypeId, categoryId, name: 'Bad karat direct', metalType: 'GOLD', metalKarat: '99K', grossWeight: 5, netWeight: 5 },
        userId
      )
    ).rejects.toThrow(/Unknown karat\/purity code/);
  });

  // The MC rate/VA% an executive settles on at tagging time (NewTagPage's MC & VA tab, auto-
  // suggested from the MakingCharge master but overridable) must be persisted verbatim, so
  // Estimation/direct-invoice pricing can reflect that exact decision later instead of re-deriving
  // from a master that may have since changed.
  it('persists the settled saleMcRate/saleVaPercent on a direct tag', async () => {
    const tag = await createTag(
      { branchId, stockTypeId, categoryId, name: 'MC/VA persisted', metalType: 'GOLD', grossWeight: 5, netWeight: 5, saleMcRate: 450, saleVaPercent: 8 },
      userId
    );
    createdTagIds.push(tag.id);
    expect(Number(tag.saleMcRate)).toBe(450);
    expect(Number(tag.saleVaPercent)).toBe(8);
  });

  it('leaves saleMcRate/saleVaPercent null when not supplied (regression)', async () => {
    const tag = await createTag(
      { branchId, stockTypeId, categoryId, name: 'MC/VA omitted', metalType: 'GOLD', grossWeight: 5, netWeight: 5 },
      userId
    );
    createdTagIds.push(tag.id);
    expect(tag.saleMcRate).toBeNull();
    expect(tag.saleVaPercent).toBeNull();
  });

  it('accepts each seeded karat/purity code on direct tag creation', async () => {
    for (const karat of ['24K', '22K', '18K', '14K', '10K', '925', 'SILVER', 'PT']) {
      const tag = await createTag(
        { branchId, stockTypeId, categoryId, name: `Karat check ${karat}`, metalType: 'GOLD', metalKarat: karat, grossWeight: 1, netWeight: 1 },
        userId
      );
      createdTagIds.push(tag.id);
      expect(tag.metalKarat).toBe(karat);
    }
  });

  it('rejects an unknown karat/purity code on finished-goods intake when explicitly supplied', async () => {
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const extraPoItem = await prisma.poItem.create({
      data: {
        companyId: tenant.company.id,
        poId: po.id, materialCode: 'RING-004', materialName: 'Gold Ring #4',
        materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 5.0, unit: 'PC',
        karat: '22K', ratePerUnit: 20000, totalAmount: 20000,
      },
    });
    const extraGrnItem = await prisma.grnItem.create({
      data: {
        companyId: tenant.company.id,
        grnId, poItemId: extraPoItem.id, invoiceQty: 1, invoiceWeight: 5.0, scaleWeight: 5.0,
        acceptedWeight: 5.0, variance: 0, variancePercent: 0, isVerified: true,
      },
    });

    await expect(
      createTagFromGrnItem(
        { grnItemId: extraGrnItem.id, branchId, stockTypeId, categoryId, name: 'Bad karat via GRN', metalType: 'GOLD', metalKarat: '99K' },
        userId
      )
    ).rejects.toThrow(/Unknown karat\/purity code/);
  });

  // C2: an intake line that doesn't hand-price the piece gets a suggested sellingPrice from the
  // MetalRate as of the GRN's receivedDate (the day it actually came in), not "today".
  describe('sellingPrice suggested from MetalRate at GRN date (C2)', () => {
    const testKarat = `TSTKAR-${suffix}`;
    const rateIds: string[] = [];

    beforeAll(async () => {
      const grn = await prisma.goodsReceiptNote.findUniqueOrThrow({ where: { id: grnId } });
      const dateOnly = (d: Date) => new Date(d.toISOString().split('T')[0]);
      const rate = await prisma.metalRate.create({
        data: { companyId: tenant.company.id, date: dateOnly(grn.receivedDate), karat: testKarat, purity: 0.916, ratePerGram: 5000 },
      });
      rateIds.push(rate.id);
    });

    afterAll(async () => {
      await prisma.metalRate.deleteMany({ where: { id: { in: rateIds } } });
    });

    it('stamps sellingPrice from the GRN-date rate when not explicitly supplied', async () => {
      const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
      const extraPoItem = await prisma.poItem.create({
        data: {
          companyId: tenant.company.id,
          poId: po.id, materialCode: 'RING-005', materialName: 'Gold Ring #5',
          materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 6.0, unit: 'PC',
          karat: testKarat, ratePerUnit: 25000, totalAmount: 25000,
        },
      });
      const extraGrnItem = await prisma.grnItem.create({
        data: {
          companyId: tenant.company.id,
          grnId, poItemId: extraPoItem.id, invoiceQty: 1, invoiceWeight: 6.0, scaleWeight: 6.0,
          acceptedWeight: 6.0, variance: 0, variancePercent: 0, isVerified: true,
        },
      });

      const tag = await createTagFromGrnItem(
        { grnItemId: extraGrnItem.id, branchId, stockTypeId, categoryId, name: 'Priced from GRN-date rate', metalType: 'GOLD' },
        userId
      );
      createdTagIds.push(tag.id);

      expect(tag.metalKarat).toBe(testKarat);         // falls back to PoItem.karat
      expect(Number(tag.netWeight)).toBeCloseTo(6.0);  // acceptedWeight, no stone
      expect(Number(tag.sellingPrice)).toBeCloseTo(6.0 * 5000); // netWeight * that day's rate
    });

    it('still honors an explicit sellingPrice override even when a MetalRate exists (regression)', async () => {
      const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
      const extraPoItem = await prisma.poItem.create({
        data: {
          companyId: tenant.company.id,
          poId: po.id, materialCode: 'RING-006', materialName: 'Gold Ring #6',
          materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 6.0, unit: 'PC',
          karat: testKarat, ratePerUnit: 25000, totalAmount: 25000,
        },
      });
      const extraGrnItem = await prisma.grnItem.create({
        data: {
          companyId: tenant.company.id,
          grnId, poItemId: extraPoItem.id, invoiceQty: 1, invoiceWeight: 6.0, scaleWeight: 6.0,
          acceptedWeight: 6.0, variance: 0, variancePercent: 0, isVerified: true,
        },
      });

      const tag = await createTagFromGrnItem(
        {
          grnItemId: extraGrnItem.id, branchId, stockTypeId, categoryId, name: 'Explicit price wins', metalType: 'GOLD',
          sellingPrice: 12345,
        },
        userId
      );
      createdTagIds.push(tag.id);

      expect(Number(tag.sellingPrice)).toBe(12345);
    });
  });

  // C4: a non-METAL material row (createTag's materials-array path) with a stoneGradeId but no
  // explicit saleAmount resolves one from the PriceMaster rate card, by weight. StoneGrade is
  // the reusable shape/clarity/cut combination — the same combination can be priced repeatedly
  // over time without re-entering its classification.
  describe('stone valuation from PriceMaster (C4)', () => {
    let stoneTypeId: string;
    let stoneGradeId: string;
    let priceMasterId: string;

    beforeAll(async () => {
      const stoneType = await prisma.stoneType.create({
        data: { companyId: tenant.company.id, code: `TSTSTONE-${suffix}`, name: 'Test Diamond', itemType: 'DIAMOND' },
      });
      stoneTypeId = stoneType.id;

      const stoneGrade = await prisma.stoneGrade.create({
        data: { companyId: tenant.company.id, stoneTypeId, shape: 'Round', clarity: 'VS1', color: 'F', cut: 'Excellent' },
      });
      stoneGradeId = stoneGrade.id;

      const price = await prisma.priceMaster.create({
        data: {
          companyId: tenant.company.id,
          itemType: 'DIAMOND', stoneGradeId, weightFrom: 0.5, weightTo: 2.0,
          pricePerCarat: 40000, isActive: true,
        },
      });
      priceMasterId = price.id;
    });

    afterAll(async () => {
      await prisma.priceMaster.deleteMany({ where: { id: priceMasterId } });
      // stone grade / type are removed by cleanupTestTenant after the tags whose materials reference them
    });

    it('resolves saleRate/saleAmount from PriceMaster for a stone row with no explicit saleAmount', async () => {
      const tag = await createTag(
        {
          branchId, stockTypeId, categoryId, name: 'Ring with diamond', metalType: 'GOLD', grossWeight: 5, netWeight: 5,
          materials: [{ code: 'DIA-1', materialType: 'DIAMOND', stoneGradeId, weight: 1.5, unit: 'CT' }],
        },
        userId
      );
      createdTagIds.push(tag.id);

      const rows = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].stoneGradeId).toBe(stoneGradeId);
      expect(Number(rows[0].saleRate)).toBe(40000);
      expect(Number(rows[0].saleAmount)).toBe(40000 * 1.5);
      // Resolved saleAmount rolls into the tag's own sellingPrice, same as a hand-entered one would.
      expect(Number(tag.sellingPrice)).toBe(40000 * 1.5);
    });

    it('still honors an explicit saleAmount even when a PriceMaster row matches (regression)', async () => {
      const tag = await createTag(
        {
          branchId, stockTypeId, categoryId, name: 'Ring with priced diamond', metalType: 'GOLD', grossWeight: 5, netWeight: 5,
          materials: [{
            code: 'DIA-2', materialType: 'DIAMOND', stoneGradeId, weight: 1.5, unit: 'CT',
            saleRate: 99999, saleAmount: 149999,
          }],
        },
        userId
      );
      createdTagIds.push(tag.id);

      const rows = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id } });
      expect(Number(rows[0].saleAmount)).toBe(149999);
    });

    it('leaves saleAmount unset when the weight falls outside every PriceMaster row\'s range', async () => {
      const tag = await createTag(
        {
          branchId, stockTypeId, categoryId, name: 'Ring with oversize diamond', metalType: 'GOLD', grossWeight: 5, netWeight: 5,
          materials: [{ code: 'DIA-3', materialType: 'DIAMOND', stoneGradeId, weight: 5.0, unit: 'CT' }],
        },
        userId
      );
      createdTagIds.push(tag.id);

      const rows = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id } });
      expect(rows[0].saleAmount).toBeNull();
      expect(Number(tag.sellingPrice)).toBe(0);
    });

    it('ignores stoneGradeId on a METAL row (regression — stone valuation is non-METAL only)', async () => {
      const tag = await createTag(
        {
          branchId, stockTypeId, categoryId, name: 'Metal row with stray stoneGradeId', metalType: 'GOLD', grossWeight: 5, netWeight: 5,
          materials: [{ code: 'GOLD-BAR', materialType: 'METAL', stoneGradeId, weight: 5, unit: 'GM' }],
        },
        userId
      );
      createdTagIds.push(tag.id);

      const rows = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id } });
      expect(rows[0].saleAmount).toBeNull();
    });
  });

  // B4: the counter lookup screen needs to find a tag regardless of status (e.g. show "already
  // SOLD" instead of silently missing it) — searchTags now searches every status when the status
  // filter is omitted (or 'ALL'), instead of always defaulting to IN_STOCK.
  describe('searchTags status filtering (B4)', () => {
    const searchName = `LookupSearch-${suffix}`;
    let inStockId: string;
    let soldId: string;

    beforeAll(async () => {
      const inStock = await createTag(
        { branchId, stockTypeId, categoryId, name: searchName, metalType: 'GOLD', grossWeight: 3, netWeight: 3 },
        userId
      );
      inStockId = inStock.id;
      createdTagIds.push(inStockId);

      const sold = await createTag(
        { branchId, stockTypeId, categoryId, name: searchName, metalType: 'GOLD', grossWeight: 3, netWeight: 3 },
        userId
      );
      soldId = sold.id;
      createdTagIds.push(soldId);
      await prisma.jewelryTag.update({ where: { id: soldId }, data: { status: 'SOLD' } });
    });

    it('finds tags across every status when status is omitted', async () => {
      const results = await searchTags(searchName);
      const foundIds = results.map((r) => r.id);
      expect(foundIds).toContain(inStockId);
      expect(foundIds).toContain(soldId);
    });

    it('finds tags across every status when status is "ALL"', async () => {
      const results = await searchTags(searchName, undefined, 'ALL');
      const foundIds = results.map((r) => r.id);
      expect(foundIds).toContain(inStockId);
      expect(foundIds).toContain(soldId);
    });

    it('still filters to a single status when explicitly requested (regression)', async () => {
      const results = await searchTags(searchName, undefined, 'IN_STOCK');
      const foundIds = results.map((r) => r.id);
      expect(foundIds).toContain(inStockId);
      expect(foundIds).not.toContain(soldId);
    });
  });

  // E2: inter-branch stock visibility. Other test files/describes create their own branches
  // concurrently, so this only asserts on the two branches it creates itself, never on the
  // returned array's overall length/contents.
  describe('getBranchStockSummary (E2)', () => {
    let branchAId: string;
    let branchBId: string;
    const summaryTagIds: string[] = [];

    beforeAll(async () => {
      const branchA = await prisma.branch.create({ data: { companyId: tenant.company.id, branchCode: `TSTBR-E2A-${suffix}`, name: 'Test Branch E2-A' } });
      branchAId = branchA.id;
      const branchB = await prisma.branch.create({ data: { companyId: tenant.company.id, branchCode: `TSTBR-E2B-${suffix}`, name: 'Test Branch E2-B' } });
      branchBId = branchB.id;

      // Sale value in the reports is LIVE (gold at today's rate on the piece's own rates), not the stored sellingPrice: a bought-in
      // piece (no material rows, MC 0 / VA 0) is worth net weight x the day's 22K rate - 5000 here, so 10 g = 50000 and 6 g = 30000.
      await seedMetalRate(tenant.company.id, '22K', 5000);
      async function makeSummaryTag(branchId: string, status: string, sellingPrice: number, costPrice: number, grossWeight: number) {
        const tag = await prisma.jewelryTag.create({
          data: {
            metalKarat: '22K', saleMcRate: 0, saleVaPercent: 0,
            tagNumber: `TSTTAG-E2-${suffix}-${summaryTagIds.length}`,
            companyId: tenant.company.id,
            branchId, name: 'Summary Test Tag', metalType: 'GOLD',
            grossWeight, netWeight: grossWeight, stoneWeight: 0,
            costPrice, sellingPrice, status, createdById: userId,
          },
        });
        summaryTagIds.push(tag.id);
        return tag;
      }

      await makeSummaryTag(branchAId, 'IN_STOCK', 50000, 40000, 10);
      await makeSummaryTag(branchAId, 'IN_STOCK', 30000, 24000, 6);
      await makeSummaryTag(branchAId, 'ON_APPROVAL', 20000, 16000, 4);
      await makeSummaryTag(branchAId, 'SOLD', 99999, 88888, 99); // must be excluded — not "stock"
      await makeSummaryTag(branchBId, 'TRANSFERRED', 10000, 8000, 2);
    });

    afterAll(async () => {
      await prisma.jewelryTag.deleteMany({ where: { id: { in: summaryTagIds } } });
      await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
    });

    it('aggregates IN_STOCK count/value/weight per branch, and counts ON_APPROVAL/TRANSFERRED separately', async () => {
      const summary = await getBranchStockSummary(tenant.company.id);
      const a = summary.find((s) => s.branchId === branchAId)!;
      const b = summary.find((s) => s.branchId === branchBId)!;

      expect(a.inStock.count).toBe(2);
      expect(a.inStock.sellingValue).toBeCloseTo(80000);
      expect(a.inStock.costValue).toBeCloseTo(64000);
      expect(a.inStock.grossWeight).toBeCloseTo(16);
      expect(a.onApprovalCount).toBe(1);
      expect(a.inTransitCount).toBe(0);

      expect(b.inStock.count).toBe(0);
      expect(b.inTransitCount).toBe(1);
    });
  });

  // E3: physical stock count for one branch, report-only. Each test gets its own fresh branch —
  // startStockAudit snapshots *every* IN_STOCK tag at a branch, so sharing one branch across
  // tests (the way E2's tests share theirs, which only ever reads/aggregates) would let one
  // test's leftover IN_STOCK tags silently inflate a later test's snapshot.
  describe('stock audits (E3)', () => {
    const auditBranchIds: string[] = [];
    const auditTagIds: string[] = [];
    const auditIds: string[] = [];

    async function makeAuditBranch() {
      const branch = await prisma.branch.create({
        data: { companyId: tenant.company.id, branchCode: `TSTBR-E3-${suffix}-${auditBranchIds.length}`, name: 'Test Audit Branch' },
      });
      auditBranchIds.push(branch.id);
      return branch.id;
    }

    async function makeAuditTag(branchId: string, status = 'IN_STOCK') {
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TSTTAG-E3-${suffix}-${auditTagIds.length}`,
          companyId: tenant.company.id,
          branchId, name: 'Audit Test Tag', metalType: 'GOLD',
          grossWeight: 5, netWeight: 5, stoneWeight: 0,
          costPrice: 20000, sellingPrice: 25000, status, createdById: userId,
        },
      });
      auditTagIds.push(tag.id);
      return tag;
    }

    afterAll(async () => {
      await prisma.stockAudit.deleteMany({ where: { id: { in: auditIds } } }); // cascades stock_audit_items
      await prisma.jewelryTag.deleteMany({ where: { id: { in: auditTagIds } } });
      await prisma.branch.deleteMany({ where: { id: { in: auditBranchIds } } });
    });

    it('snapshots exactly the branch\'s current IN_STOCK tags as expected', async () => {
      const branchA = await makeAuditBranch();
      const branchB = await makeAuditBranch();
      const inStockA1 = await makeAuditTag(branchA, 'IN_STOCK');
      const inStockA2 = await makeAuditTag(branchA, 'IN_STOCK');
      await makeAuditTag(branchA, 'SOLD'); // not IN_STOCK — must not be snapshotted
      await makeAuditTag(branchB, 'IN_STOCK'); // different branch — must not be snapshotted

      const audit = await startStockAudit(branchA, tenant.ctx, userId);
      auditIds.push(audit.id);

      expect(audit.auditNumber).toMatch(/^SA-/);
      expect(audit.status).toBe('IN_PROGRESS');
      expect(audit.summary.expectedCount).toBe(2);
      const expectedTagIds = audit.items.filter((i) => i.expected).map((i) => i.tagId);
      expect(expectedTagIds.sort()).toEqual([inStockA1.id, inStockA2.id].sort());
    });

    it('marks an expected tag found on scan, is idempotent on re-scan, and rejects an unknown tag', async () => {
      const branchA = await makeAuditBranch();
      const tag = await makeAuditTag(branchA, 'IN_STOCK');
      const audit = await startStockAudit(branchA, tenant.ctx, userId);
      auditIds.push(audit.id);

      const scanned = await scanAuditItem(audit.id, tag.id, tenant.ctx, userId);
      expect(scanned.summary.foundCount).toBe(1);
      expect(scanned.summary.missingCount).toBe(0);

      const rescanned = await scanAuditItem(audit.id, tag.id, tenant.ctx, userId);
      expect(rescanned.summary.foundCount).toBe(1); // no duplicate row / double-count

      await expect(scanAuditItem(audit.id, 'nonexistent-tag-id', tenant.ctx, userId)).rejects.toThrow(/Tag not found/);
    });

    it('flags a tag as unexpected when scanned but not expected at this branch (wrong branch / status)', async () => {
      const branchA = await makeAuditBranch();
      const branchB = await makeAuditBranch();
      const wrongBranchTag = await makeAuditTag(branchB, 'IN_STOCK');
      const audit = await startStockAudit(branchA, tenant.ctx, userId); // branch A has nothing IN_STOCK

      const scanned = await scanAuditItem(audit.id, wrongBranchTag.id, tenant.ctx, userId);
      auditIds.push(audit.id);
      const item = scanned.items.find((i) => i.tagId === wrongBranchTag.id)!;
      expect(item.expected).toBe(false);
      expect(item.found).toBe(true);
      expect(scanned.summary.unexpectedCount).toBe(1);
    });

    it('computes missing/found correctly on completion and leaves tag status/branch untouched', async () => {
      const branchA = await makeAuditBranch();
      const found = await makeAuditTag(branchA, 'IN_STOCK');
      const missing = await makeAuditTag(branchA, 'IN_STOCK');
      const audit = await startStockAudit(branchA, tenant.ctx, userId);
      auditIds.push(audit.id);

      await scanAuditItem(audit.id, found.id, tenant.ctx, userId);
      const completed = await completeStockAudit(audit.id, tenant.ctx, userId);

      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();
      expect(completed.summary.foundCount).toBe(1);
      expect(completed.summary.missingCount).toBe(1);

      // Report-only — nothing about the tags themselves changed.
      const missingTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: missing.id } });
      expect(missingTag.status).toBe('IN_STOCK');
      expect(missingTag.branchId).toBe(branchA);
    });

    it('rejects starting a second audit while one is already IN_PROGRESS for that branch', async () => {
      const branchA = await makeAuditBranch();
      const first = await startStockAudit(branchA, tenant.ctx, userId);
      auditIds.push(first.id);

      await expect(startStockAudit(branchA, tenant.ctx, userId)).rejects.toThrow(/already has an in-progress audit/);
    });

    it('rejects scanning or completing a non-IN_PROGRESS audit', async () => {
      const branchA = await makeAuditBranch();
      const tag = await makeAuditTag(branchA, 'IN_STOCK');
      const audit = await startStockAudit(branchA, tenant.ctx, userId);
      auditIds.push(audit.id);
      await completeStockAudit(audit.id, tenant.ctx, userId);

      await expect(scanAuditItem(audit.id, tag.id, tenant.ctx, userId)).rejects.toThrow(/Only an IN_PROGRESS audit can be scanned/);
      await expect(completeStockAudit(audit.id, tenant.ctx, userId)).rejects.toThrow(/Only an IN_PROGRESS audit can be completed/);
    });
  });
});

// H2/H3: read-only stock reports — no schema change, pure aggregation over whatever tags already
// exist, same shape as E2's getBranchStockSummary.
describe('Stock reports (H2/H3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let categoryAId: string;
  let categoryBId: string;
  const tagIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`STOCKRPT${suffix}`, []);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const [catA, catB] = await Promise.all([
      prisma.productCategory.create({ data: { companyId: tenant.company.id, code: `TSTCAT-STOCKRPT-A-${suffix}`, name: 'Rings' } }),
      prisma.productCategory.create({ data: { companyId: tenant.company.id, code: `TSTCAT-STOCKRPT-B-${suffix}`, name: 'Bangles' } }),
    ]);
    categoryAId = catA.id;
    categoryBId = catB.id;

    async function makeTag(categoryId: string, status: string, costPrice: number, sellingPrice: number) {
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TSTTAG-STOCKRPT-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, categoryId, status,
          name: 'Test Piece', metalType: 'GOLD', metalKarat: '22K',
          grossWeight: 10, netWeight: 10, costPrice, sellingPrice, createdById: userId,
        },
      });
      tagIds.push(tag.id);
      return tag;
    }

    await makeTag(categoryAId, 'IN_STOCK', 40000, 48000);
    await makeTag(categoryAId, 'IN_STOCK', 20000, 24000);
    await makeTag(categoryBId, 'IN_STOCK', 30000, 36000);
    await makeTag(categoryAId, 'SOLD', 40000, 48000); // excluded from both reports

    // Backdate one IN_STOCK tag's updatedAt so it shows up as dead stock — @updatedAt is
    // Prisma-managed on every write, so a raw UPDATE is the only way to set it to the past.
    const oldTag = tagIds[1];
    await prisma.$executeRaw`UPDATE jewelry_tags SET "updatedAt" = NOW() - INTERVAL '200 days' WHERE id = ${oldTag}`;
  });

  afterAll(async () => {
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: [categoryAId, categoryBId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('getStockOnHand slices IN_STOCK tags by branch x category, excluding SOLD', async () => {
    const result = await getStockOnHand(tenant.company.id, { branchId });
    const ringsRow = result.rows.find((r) => r.categoryId === categoryAId)!;
    const banglesRow = result.rows.find((r) => r.categoryId === categoryBId)!;

    expect(ringsRow.count).toBe(2); // the two IN_STOCK rings, not the SOLD one
    expect(ringsRow.costValue).toBeCloseTo(60000);
    expect(banglesRow.count).toBe(1);
    expect(result.totals.count).toBe(3);
  });

  it('getStockOnHand filters by categoryId', async () => {
    const result = await getStockOnHand(tenant.company.id, { branchId, categoryId: categoryBId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].count).toBe(1);
  });

  it('getDeadStock buckets IN_STOCK tags by days since updatedAt', async () => {
    const result = await getDeadStock(tenant.company.id);
    const oldRow = result.rows.find((r) => r.id === tagIds[1])!;
    expect(oldRow.bucket).toBe('181-365');
    expect(oldRow.daysInStock).toBeGreaterThanOrEqual(199);

    const freshRow = result.rows.find((r) => r.id === tagIds[0])!;
    expect(freshRow.bucket).toBe('0-90');
  });

  it('getDeadStock excludes non-IN_STOCK tags', async () => {
    const result = await getDeadStock(tenant.company.id);
    expect(result.rows.find((r) => r.id === tagIds[3])).toBeUndefined();
  });
});

// Stock Book: one row per tag, and — the part that matters — scoped to the caller's own branch grants.
describe('getStockBook', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchAId: string;
  let branchBId: string;
  const tagIds: string[] = [];
  const asRestrictedTo = (...ids: string[]) => ({ ...tenant.ctx, branchAccess: { allBranches: false, branchIds: ids } });
  let diaTagId: string;

  beforeAll(async () => {
    tenant = await createTestTenant(`STOCKBOOK${suffix}`, []);
    userId = tenant.user.id;
    branchAId = tenant.branch.id;
    branchBId = (await prisma.branch.create({ data: { companyId: tenant.company.id, branchCode: `TSTBR-SB-${suffix}`, name: 'Second Branch' } })).id;

    async function makeTag(branchId: string, status: string, n: number) {
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TSTTAG-SB-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId, status,
          name: 'Piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10 + n, netWeight: 9 + n,
          costPrice: 1000 * (n + 1), sellingPrice: 1200 * (n + 1), createdById: userId,
        },
      });
      tagIds.push(tag.id);
      return tag;
    }
    diaTagId = (await makeTag(branchAId, 'IN_STOCK', 0)).id;
    await makeTag(branchAId, 'SOLD', 1);
    await makeTag(branchBId, 'IN_STOCK', 2);
    await makeTag(branchBId, 'ON_APPROVAL', 3);

    // METAL is neither stone column; DIAMOND -> Dia Wt; anything else non-metal -> CS Wt.
    await prisma.jewelryTagMaterial.createMany({
      data: [
        { companyId: tenant.company.id, tagId: diaTagId, code: 'G22', materialType: 'METAL', weight: 8 },
        { companyId: tenant.company.id, tagId: diaTagId, code: 'DIA', materialType: 'DIAMOND', weight: 0.5, pieces: 4 },
        { companyId: tenant.company.id, tagId: diaTagId, code: 'RUB', materialType: 'STONE', weight: 1.25, pieces: 2 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } }); // materials cascade
    await prisma.branch.deleteMany({ where: { id: branchBId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('defaults to On Hand (IN_STOCK) across every branch for an all-branches user', async () => {
    const r = await getStockBook(tenant.ctx);
    expect(r.rows.map((x) => x.id).sort()).toEqual([tagIds[0], tagIds[2]].sort());
    expect(r.branches.map((b) => b.id).sort()).toEqual([branchAId, branchBId].sort());
  });

  it('status filters: STOCK = in stock + memo + transit (no SOLD), ALL = everything', async () => {
    expect((await getStockBook(tenant.ctx, { status: 'STOCK' })).rows).toHaveLength(3);
    expect((await getStockBook(tenant.ctx, { status: 'ALL' })).rows).toHaveLength(4);
    expect((await getStockBook(tenant.ctx, { status: 'SOLD' })).rows.map((x) => x.id)).toEqual([tagIds[1]]);
    await expect(getStockBook(tenant.ctx, { status: 'BOGUS' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a branch-restricted user only ever sees their own branch — asked for or not', async () => {
    const onlyA = asRestrictedTo(branchAId);
    const noFilter = await getStockBook(onlyA, { status: 'ALL' });
    expect(noFilter.rows.every((x) => x.branchId === branchAId)).toBe(true);
    expect(noFilter.rows).toHaveLength(2);
    expect(noFilter.branches.map((b) => b.id)).toEqual([branchAId]); // the picker never offers branch B

    // Asking for the other branch by id must match nothing, not redirect or widen.
    const forged = await getStockBook(onlyA, { branchId: branchBId, status: 'ALL' });
    expect(forged.rows).toEqual([]);
  });

  it('a user granted no branches sees no stock at all', async () => {
    const none = await getStockBook(asRestrictedTo(), { status: 'ALL' });
    expect(none.rows).toEqual([]);
    expect(none.branches).toEqual([]);
  });

  it('splits stone weight into Dia Wt (DIAMOND) and CS Wt (other non-metal); metal counts as neither', async () => {
    const row = (await getStockBook(tenant.ctx, { branchId: branchAId })).rows.find((x) => x.id === diaTagId)!;
    expect(row.diaWt).toBeCloseTo(0.5);
    expect(row.csWt).toBeCloseTo(1.25);
    expect(row.stonePieces).toBe(6);
    expect(row.qty).toBe(1);
    expect(row.costPrice).toBe(1000);
  });
});

describe('getTagPrintTspl (Stage 2 print path)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let categoryId: string;
  let stockTypeId: string;
  let tagId: string;
  let customTemplateId: string;
  let defaultTemplateId: string;

  beforeAll(async () => {
    tenant = await createTestTenant(`PRINT${suffix}`, []);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const category = await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `TSTCAT-PRINT-${suffix}`, name: 'Test Category' },
    });
    categoryId = category.id;

    const stockType = await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `TPR${suffix}`.slice(0, 8).toUpperCase(), name: 'Test Stock Type' },
    });
    stockTypeId = stockType.id;

    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-PRINT-${suffix}`, companyId: tenant.company.id, branchId, categoryId, stockTypeId,
        name: 'Test Print Piece', metalType: 'GOLD', metalKarat: '18K',
        grossWeight: 5, netWeight: 4.8, sellingPrice: 30000, createdById: userId,
      },
    });
    tagId = tag.id;

    // Phase 2 made TagTemplate company-owned (no more single global default row) — this test's
    // own tenant needs its own default template for the "no templateId given" fallback path.
    const defaultTemplate = await prisma.tagTemplate.create({
      data: {
        companyId: tenant.company.id,
        name: `Test Default Template ${suffix}`, isDefault: true,
        widthMm: 30, heightMm: 15, gapMm: 2,
        layout: { elements: [{ id: 'd1', wing: 'front', type: 'text', xMm: 1, yMm: 1, boundField: 'tagNumber' }] },
      },
    });
    defaultTemplateId = defaultTemplate.id;

    const template = await prisma.tagTemplate.create({
      data: {
        companyId: tenant.company.id,
        name: `Test Custom Template ${suffix}`, isDefault: false,
        widthMm: 40, heightMm: 20, gapMm: 2,
        layout: { elements: [{ id: 'e1', wing: 'front', type: 'text', xMm: 1, yMm: 1, boundField: 'tagNumber' }] },
      },
    });
    customTemplateId = template.id;
  });

  afterAll(async () => {
    await prisma.tagTemplate.deleteMany({ where: { id: { in: [customTemplateId, defaultTemplateId] } } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('generates TSPL for a real tag using the default template when none is specified', async () => {
    const result = await getTagPrintTspl(tenant.ctx, tagId);
    expect(result.templateName).toMatch(/Default/i);
    expect(result.tspl).toContain('SIZE');
    expect(result.tspl).toContain(`TSTTAG-PRINT-${suffix}`);
  });

  it('generates TSPL using an explicit templateId, honoring that template\'s own dimensions', async () => {
    const result = await getTagPrintTspl(tenant.ctx, tagId, customTemplateId);
    expect(result.templateId).toBe(customTemplateId);
    expect(result.tspl).toContain('SIZE 40 mm,20 mm');
    expect(result.tspl).toContain(`"TSTTAG-PRINT-${suffix}"`);
  });

  it('throws for an unknown tag id', async () => {
    await expect(getTagPrintTspl(tenant.ctx, 'nonexistent-id')).rejects.toThrow('Tag not found');
  });

  it('throws for an unknown templateId', async () => {
    await expect(getTagPrintTspl(tenant.ctx, tagId, 'nonexistent-template-id')).rejects.toThrow('Tag template not found');
  });
});

describe('Tag Template CRUD (Stage 3: the visual designer)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const validLayout = { elements: [{ id: 'e1', wing: 'front', type: 'text', xMm: 1, yMm: 1, literalText: 'Test' }] };

  let tenant: TestTenant;
  let userId: string;
  let originalDefaultId: string | null = null;
  const createdIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`TPL${suffix}`, []);
    userId = tenant.user.id;

    // Creating/updating a template with isDefault:true unsets whatever else was default (see
    // createTagTemplate/updateTagTemplate) — capture the real seeded default so it can be
    // restored afterward, otherwise a re-run of this suite (or the running dev app) would lose
    // its default template.
    const existingDefault = await prisma.tagTemplate.findFirst({ where: { companyId: tenant.company.id, isDefault: true } });
    originalDefaultId = existingDefault?.id ?? null;
  });

  afterAll(async () => {
    await prisma.tagTemplate.deleteMany({ where: { id: { in: createdIds } } });
    if (originalDefaultId) {
      await prisma.tagTemplate.update({ where: { id: originalDefaultId }, data: { isDefault: true } });
    }
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('creates a template with default gapMm and isDefault:false', async () => {
    const t = await createTagTemplate(tenant.company.id, { name: `Test Template ${suffix}`, widthMm: 40, heightMm: 20, layout: validLayout }, userId);
    createdIds.push(t.id);
    expect(t.name).toBe(`Test Template ${suffix}`);
    expect(Number(t.gapMm)).toBe(2);
    expect(t.isDefault).toBe(false);
  });

  it('rejects a layout without an elements array', async () => {
    await expect(
      createTagTemplate(tenant.company.id, { name: `Bad ${suffix}`, widthMm: 10, heightMm: 10, layout: { foo: 1 } }, userId)
    ).rejects.toThrow(/elements/);
  });

  it('rejects an empty name', async () => {
    await expect(
      createTagTemplate(tenant.company.id, { name: '  ', widthMm: 10, heightMm: 10, layout: validLayout }, userId)
    ).rejects.toThrow('Template name is required');
  });

  it('creating a new default unsets the previous default', async () => {
    const t1 = await createTagTemplate(
      tenant.company.id, { name: `Default A ${suffix}`, widthMm: 10, heightMm: 10, layout: validLayout, isDefault: true }, userId
    );
    createdIds.push(t1.id);
    const t2 = await createTagTemplate(
      tenant.company.id, { name: `Default B ${suffix}`, widthMm: 10, heightMm: 10, layout: validLayout, isDefault: true }, userId
    );
    createdIds.push(t2.id);

    expect((await getTagTemplateById(tenant.company.id, t1.id)).isDefault).toBe(false);
    expect((await getTagTemplateById(tenant.company.id, t2.id)).isDefault).toBe(true);
  });

  it('updates a template, including its layout', async () => {
    const t = await createTagTemplate(tenant.company.id, { name: `To Update ${suffix}`, widthMm: 10, heightMm: 10, layout: validLayout }, userId);
    createdIds.push(t.id);

    const updated = await updateTagTemplate(tenant.company.id, t.id, { name: 'Updated Name', widthMm: 55, layout: { elements: [] } });
    expect(updated.name).toBe('Updated Name');
    expect(Number(updated.widthMm)).toBe(55);
    expect((updated.layout as any).elements).toEqual([]);
  });

  it('setting isDefault on update unsets any other default, not itself', async () => {
    const t = await createTagTemplate(tenant.company.id, { name: `Becomes Default ${suffix}`, widthMm: 10, heightMm: 10, layout: validLayout }, userId);
    createdIds.push(t.id);

    const updated = await updateTagTemplate(tenant.company.id, t.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);

    const defaults = await prisma.tagTemplate.findMany({ where: { companyId: tenant.company.id, isDefault: true } });
    expect(defaults.map((d) => d.id)).toEqual([t.id]);
  });

  it('throws for an unknown template id on update', async () => {
    await expect(updateTagTemplate(tenant.company.id, 'nonexistent-id', { name: 'x' })).rejects.toThrow('Tag template not found');
  });

  it('lists templates with the default first', async () => {
    const list = await listTagTemplates(tenant.company.id);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].isDefault).toBe(true);
  });
});

describe('updateTag (tag edit — corrects a tagged piece\'s own details, not a stock movement)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdTagIds: string[] = [];

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let otherBranchId: string;
  let stockTypeId: string;
  let categoryId: string;

  function createTag(data: Parameters<typeof _createTag>[1], uid: string) {
    return _createTag(tenant.ctx, data, uid);
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`UPD${suffix}`, ['tag:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const branch2 = await prisma.branch.create({ data: { companyId: tenant.company.id, branchCode: `TSTBRU2-${suffix}`, name: 'Test Branch 2' } });
    otherBranchId = branch2.id;
    // otherBranchId is added to this tenant's branch access explicitly — some tests in this
    // suite exercise a branch OTHER than the default one, and the caller must actually be
    // granted it (allBranches:true from createTestTenant already covers "every branch in this
    // company," so this grant is redundant-but-harmless, kept for clarity that it's deliberate).

    const stockType = await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `TU${suffix}`.slice(0, 8).toUpperCase(), name: 'Test Stock Type' },
    });
    stockTypeId = stockType.id;

    const category = await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `TSTCATU-${suffix}`, name: 'Test Category' },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(createdTagIds);
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: createdTagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: createdTagIds } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('updates plain fields without touching materials, tagNumber, or status', async () => {
    const tag = await createTag(
      {
        branchId, stockTypeId, categoryId, name: 'Edit Me Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 5, netWeight: 5, huid: 'OLDHUID1',
      },
      userId
    );
    createdTagIds.push(tag.id);

    const updated = await updateTag(tag.id, { huid: 'NEWHUID2', notes: 'fixed a typo' }, tenant.ctx, userId);

    expect(updated.tagNumber).toBe(tag.tagNumber);
    expect(updated.status).toBe('IN_STOCK');
    expect(updated.huid).toBe('NEWHUID2');
    expect(updated.notes).toBe('fixed a typo');
    expect(Number(updated.grossWeight)).toBe(5); // untouched — materials/weights not in the payload

    const auditEntry = await prisma.auditLog.findFirst({
      where: { tableName: 'jewelry_tags', recordId: tag.id, action: 'UPDATE' },
    });
    expect(auditEntry).not.toBeNull();
  });

  // Regression test for the exact bug reported live: a tag tagged with a Cost MC rate/VA% markup
  // (so costPrice > the plain sum of its material rows) got edited for something unrelated (HUID),
  // and Cost Price silently dropped back to materials-only because costMcRate/costVaPercent had
  // nowhere to be read back from on reload. Now that they're real columns, a narrow edit that
  // never mentions pricing at all must leave costPrice/costMcRate/costVaPercent exactly as they
  // were — this is what makes NewTagPage.tsx's edit-load-then-resubmit round-trip lossless.
  it('preserves costMcRate/costVaPercent/costPrice exactly through an unrelated field edit', async () => {
    const tag = await createTag(
      {
        branchId, stockTypeId, categoryId, name: 'Cost Markup Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 0, netWeight: 0,
        materials: [
          { code: 'GOLD-22K', materialType: 'METAL', weight: 10, costRate: 5000, costAmount: 50000, saleRate: 5500, saleAmount: 55000 },
        ],
        // Simulates the client having already folded a Cost MC/VA markup into costPrice (the way
        // NewTagPage.tsx's mutationFn does) while also sending the rate/VA% itself for storage.
        costPrice: 52600,
        costMcRate: 200,
        costVaPercent: 5,
      },
      userId
    );
    createdTagIds.push(tag.id);
    expect(Number(tag.costPrice)).toBe(52600);
    expect(Number(tag.costMcRate)).toBe(200);
    expect(Number(tag.costVaPercent)).toBe(5);

    // A narrow edit that touches neither materials nor pricing at all — e.g. just fixing the HUID.
    const updated = await updateTag(tag.id, { huid: 'FIXEDHUID' }, tenant.ctx, userId);

    expect(updated.huid).toBe('FIXEDHUID');
    expect(Number(updated.costPrice)).toBe(52600);     // unchanged, not dropped to materials-only (50000)
    expect(Number(updated.costMcRate)).toBe(200);       // readable back, not reset to blank
    expect(Number(updated.costVaPercent)).toBe(5);
  });

  it('replaces materials wholesale and recomputes weights/prices from the new rows', async () => {
    const tag = await createTag(
      {
        branchId, stockTypeId, categoryId, name: 'Reweigh Me', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 0, netWeight: 0,
        materials: [
          { code: 'GOLD-22K', materialType: 'METAL', weight: 10, costRate: 5000, costAmount: 50000, saleRate: 5500, saleAmount: 55000 },
        ],
      },
      userId
    );
    createdTagIds.push(tag.id);
    expect(Number(tag.netWeight)).toBeCloseTo(10);
    expect(Number(tag.sellingPrice)).toBe(55000);

    const updated = await updateTag(
      tag.id,
      {
        materials: [
          { code: 'GOLD-22K', materialType: 'METAL', weight: 12, costRate: 5000, costAmount: 60000, saleRate: 5500, saleAmount: 66000 },
        ],
      },
      tenant.ctx, userId
    );

    expect(Number(updated.grossWeight)).toBeCloseTo(12);
    expect(Number(updated.netWeight)).toBeCloseTo(12);
    expect(Number(updated.costPrice)).toBe(60000);
    expect(Number(updated.sellingPrice)).toBe(66000);

    const rows = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].weight)).toBeCloseTo(12);
  });

  it('can move a tag to a different branch and category', async () => {
    const tag = await createTag(
      { branchId, stockTypeId, categoryId, name: 'Move Me', metalType: 'GOLD', metalKarat: '22K', grossWeight: 3, netWeight: 3 },
      userId
    );
    createdTagIds.push(tag.id);

    const updated = await updateTag(tag.id, { branchId: otherBranchId }, tenant.ctx, userId);
    expect(updated.branchId).toBe(otherBranchId);
  });

  it('rejects an unknown karat/purity code', async () => {
    const tag = await createTag(
      { branchId, stockTypeId, categoryId, name: 'Bad Karat Edit', metalType: 'GOLD', metalKarat: '22K', grossWeight: 1, netWeight: 1 },
      userId
    );
    createdTagIds.push(tag.id);

    await expect(updateTag(tag.id, { metalKarat: '99K' }, tenant.ctx, userId)).rejects.toThrow(/Unknown karat\/purity code/);
  });

  it('throws for an unknown tag id', async () => {
    await expect(updateTag('nonexistent-id', { huid: 'X' }, tenant.ctx, userId)).rejects.toThrow('Tag not found');
  });
});
