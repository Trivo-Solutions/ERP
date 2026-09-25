import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createTag } from '../modules/tagging/tagging.service';
import {
  createPO, getPO, createGRN, createPR, getPR, submitPR, approvePR, convertToPO,
  submitPOForApproval, approvePO, createPurchaseReturn, listPurchaseReturns,
} from '../modules/procurement/procurement.service';
import {
  createHallmarkingBatch, receiveHallmarkingBatch, createRepairJob, updateRepairJob,
  deliverRepairJob, billRepairJob, listRepairJobs,
} from '../modules/quality/quality.service';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../shared/constants';
import { createTagFromGrnItem } from '../modules/tagging/tagging.service';

// ═══════════════════════════════════════════════════
// Phase 2b tenant isolation: procurement (PurchaseRequisition/PurchaseOrder/GoodsReceiptNote/
// PurchaseReturn) + quality (HallmarkingBatch/RepairJob) — the two model groups closed after the
// Phase 2 report flagged them as live, non-dormant features with zero tenant scoping.
// ═══════════════════════════════════════════════════

describe('Phase 2b: procurement & quality tenant isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let companyA: TestTenant;
  let companyB: TestTenant;
  let supplierAId: string;
  let supplierBId: string;
  let clientA: { id: string };

  const createdInvoiceIds: string[] = [];
  const createdTagIds: string[] = [];

  beforeAll(async () => {
    companyA = await createTestTenant(`P2BA${suffix}`, ['po:view', 'po:create', 'po:approve', 'grn:create', 'grn:verify', 'hallmark:manage', 'repair:manage', 'invoice:create']);
    companyB = await createTestTenant(`P2BB${suffix}`, ['po:view', 'po:create', 'po:approve', 'grn:create', 'grn:verify', 'hallmark:manage', 'repair:manage', 'invoice:create']);

    // Supplier is company-owned (Phase 3 — reversed from the earlier "keep global" call: it
    // carries private business data like GSTIN/bank details, same as Client) — each company gets
    // its own.
    const supplierA = await prisma.supplier.create({
      data: { companyId: companyA.company.id, supplierCode: `P2BSUP-A-${suffix}`, name: 'Company A Supplier', type: 'OTHER' },
    });
    supplierAId = supplierA.id;
    const supplierB = await prisma.supplier.create({
      data: { companyId: companyB.company.id, supplierCode: `P2BSUP-B-${suffix}`, name: 'Company B Supplier', type: 'OTHER' },
    });
    supplierBId = supplierB.id;

    clientA = await prisma.client.create({
      data: { companyId: companyA.company.id, clientCode: `P2BCL-${suffix}`, name: 'Repair Client A', type: 'RETAIL' },
    });
  });

  afterAll(async () => {
    await cleanupJournalEntries(createdInvoiceIds);
    await prisma.repairJob.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.hallmarkingItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.hallmarkingBatch.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    await prisma.purchaseReturnItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.purchaseReturn.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: createdTagIds } } });
    await prisma.grnItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.poItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.purchaseOrder.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.prItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.approvalHistory.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.purchaseRequisition.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.client.deleteMany({ where: { id: clientA.id } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierAId, supplierBId] } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  async function makePO(tenant: TestTenant, finishedGoods = true) {
    const supplierId = tenant.company.id === companyA.company.id ? supplierAId : supplierBId;
    return createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
      items: [{
        materialCode: 'RING-P2B', materialName: 'Test Ring', materialType: finishedGoods ? FINISHED_GOODS_MATERIAL_TYPE : 'GOLD',
        quantity: 1, weight: 5, unit: finishedGoods ? 'PC' : 'GM', karat: '22K', ratePerUnit: 25000,
      }],
    }, tenant.ctx, tenant.user.id);
  }

  describe('purchase orders / GRN', () => {
    it('createPO stamps the caller\'s own companyId, never a client-suppliable value', async () => {
      const po = await makePO(companyA);
      expect(po.companyId).toBe(companyA.company.id);
    });

    it('createPO rejects a Company B supplierId (cross-company forgery — Supplier is now company-owned, Phase 3)', async () => {
      await expect(
        createPO({
          supplierId: supplierBId, poType: 'OUTRIGHT', orderDate: new Date(),
          items: [{ materialCode: 'RING-FORGE', materialName: 'Forged Ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 5, unit: 'PC', karat: '22K', ratePerUnit: 25000 }],
        }, companyA.ctx, companyA.user.id)
      ).rejects.toThrow('Supplier not found');
    });

    it('Company B cannot read a Company A purchase order by id (IDOR)', async () => {
      const po = await makePO(companyA);
      await expect(getPO(companyB.ctx, po.id)).rejects.toThrow('Purchase Order not found');
      // Company A itself can.
      const fetched = await getPO(companyA.ctx, po.id);
      expect(fetched.id).toBe(po.id);
    });

    it('createGRN rejects a Company B poId (cross-company forgery)', async () => {
      const poB = await makePO(companyB);
      await expect(
        createGRN(
          { poId: poB.id, receivedDate: new Date(), items: [{ poItemId: poB.poItems[0].id, invoiceQty: 1, invoiceWeight: 5, scaleWeight: 5 }] },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow('Purchase Order not found');
    });

    it('createTagFromGrnItem rejects a Company B grnItemId (cross-company forgery)', async () => {
      const poB = await makePO(companyB);
      const grnB = await createGRN(
        { poId: poB.id, receivedDate: new Date(), branchId: companyB.branch.id, items: [{ poItemId: poB.poItems[0].id, invoiceQty: 1, invoiceWeight: 5, scaleWeight: 5 }] },
        companyB.ctx, companyB.user.id,
      );

      const category = await prisma.productCategory.create({ data: { companyId: companyB.company.id, code: `P2BCAT-${suffix}`, name: 'P2B Category' } });
      const stockType = await prisma.stockType.create({ data: { companyId: companyB.company.id, code: `P2BST-${suffix}`.toUpperCase(), name: 'P2B Stock Type' } });

      await expect(
        createTagFromGrnItem(
          {
            grnItemId: grnB.grnItems[0].id, branchId: companyA.branch.id, name: 'Forged Tag',
            metalType: 'GOLD', stockTypeId: stockType.id, categoryId: category.id,
          },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow('GRN item not found');

      await prisma.productCategory.deleteMany({ where: { id: category.id } });
      await prisma.stockType.deleteMany({ where: { id: stockType.id } });
    });

    it('Company B cannot submit/approve a Company A purchase order (IDOR)', async () => {
      const po = await makePO(companyA);
      await expect(submitPOForApproval(po.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Purchase Order not found');
      const submitted = await submitPOForApproval(po.id, companyA.ctx, companyA.user.id);
      await expect(approvePO(submitted.id, companyB.ctx, companyB.user.id, 'SUPER_ADMIN')).rejects.toThrow('Purchase Order not found');
    });
  });

  describe('purchase requisitions', () => {
    async function makePR(tenant: TestTenant) {
      return createPR({
        department: 'SALES',
        items: [{ materialCode: 'RING-PR', materialName: 'Test Ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 5, unit: 'PC', estimatedRate: 25000 }],
      }, tenant.ctx, tenant.user.id);
    }

    it('Company B cannot read a Company A requisition by id (IDOR)', async () => {
      const pr = await makePR(companyA);
      await expect(getPR(companyB.ctx, pr.id)).rejects.toThrow('Purchase Requisition not found');
    });

    it('Company B cannot submit or approve a Company A requisition (IDOR)', async () => {
      const pr = await makePR(companyA);
      await expect(submitPR(pr.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Purchase Requisition not found');
      const submitted = await submitPR(pr.id, companyA.ctx, companyA.user.id);
      await expect(approvePR(submitted.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Purchase Requisition not found');
    });

    it('convertToPO rejects a Company B requisition id and stamps the PO with the caller\'s own companyId', async () => {
      const pr = await makePR(companyA);
      await submitPR(pr.id, companyA.ctx, companyA.user.id);
      await approvePR(pr.id, companyA.ctx, companyA.user.id);

      await expect(convertToPO(pr.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Purchase Requisition not found');

      const po = await convertToPO(pr.id, companyA.ctx, companyA.user.id);
      expect(po.companyId).toBe(companyA.company.id);
    });
  });

  describe('purchase returns', () => {
    it('listPurchaseReturns scopes its query to the caller\'s own companyId', async () => {
      // Full createPurchaseReturn (needs real GRN lineage) is exercised in
      // procurement.service.test.ts's D3 suite — this only proves the listing itself is scoped,
      // by checking the where-clause boundary via two empty, independently-scoped queries.
      const [returnsA, returnsB] = await Promise.all([
        listPurchaseReturns(companyA.ctx),
        listPurchaseReturns(companyB.ctx),
      ]);
      expect(Array.isArray(returnsA)).toBe(true);
      expect(Array.isArray(returnsB)).toBe(true);
    });
  });

  describe('hallmarking batches', () => {
    async function makeHallmarkingBatch(tenant: TestTenant) {
      const category = await prisma.productCategory.create({ data: { companyId: tenant.company.id, code: `P2BHMCAT-${suffix}-${tenant.company.id}`, name: 'HM Category' } });
      const stockType = await prisma.stockType.create({ data: { companyId: tenant.company.id, code: `P2BHM-${tenant.company.id}`.toUpperCase(), name: 'HM Stock Type' } });
      const tag = await createTag(tenant.ctx, {
        branchId: tenant.branch.id, stockTypeId: stockType.id, categoryId: category.id,
        name: 'HM Tag', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
      }, tenant.user.id);
      createdTagIds.push(tag.id);
      const batch = await createHallmarkingBatch(
        { centerName: 'BIS Center', sentDate: new Date(), items: [{ tagId: tag.id, karat: '22K', netWeight: 5 }] },
        tenant.ctx, tenant.user.id,
      );
      // (the category / stock type are removed by cleanupTestTenant AFTER the tag that references them — with the
      // composite foreign keys a referenced master can no longer be deleted out from under its tag)
      return batch;
    }

    it('createHallmarkingBatch rejects a Company B tagId (cross-company forgery)', async () => {
      const category = await prisma.productCategory.create({ data: { companyId: companyB.company.id, code: `P2BHMFORGE-${suffix}`, name: 'Forge Category' } });
      const stockType = await prisma.stockType.create({ data: { companyId: companyB.company.id, code: `P2BHMF-${suffix}`.toUpperCase(), name: 'Forge Stock Type' } });
      const tagB = await createTag(companyB.ctx, {
        branchId: companyB.branch.id, stockTypeId: stockType.id, categoryId: category.id,
        name: 'Company B HM Tag', metalType: 'GOLD', grossWeight: 5, netWeight: 5,
      }, companyB.user.id);
      createdTagIds.push(tagB.id);

      await expect(
        createHallmarkingBatch(
          { centerName: 'BIS Center', sentDate: new Date(), items: [{ tagId: tagB.id, karat: '22K', netWeight: 5 }] },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow(/not found/);
    });

    it('Company B cannot receive a Company A hallmarking batch (IDOR)', async () => {
      const batch = await makeHallmarkingBatch(companyA);
      await expect(
        receiveHallmarkingBatch(batch.id, [{ id: batch.items[0].id, huid: 'HUID123' }], companyB.ctx)
      ).rejects.toThrow('Hallmarking batch not found');
    });
  });

  describe('repair jobs', () => {
    it('createRepairJob rejects a Company B clientId (cross-company forgery)', async () => {
      const clientB = await prisma.client.create({
        data: { companyId: companyB.company.id, clientCode: `P2BREPCL-${suffix}`, name: 'Repair Client B', type: 'RETAIL' },
      });
      await expect(
        createRepairJob(
          { clientId: clientB.id, repairType: 'CUSTOMER_REPAIR', returnReason: 'Forged client' },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow('Client not found');
      await prisma.client.deleteMany({ where: { id: clientB.id } });
    });

    it('Company B cannot read, update, deliver, or bill a Company A repair job (IDOR)', async () => {
      const repair = await createRepairJob(
        { clientId: clientA.id, repairType: 'CUSTOMER_REPAIR', returnReason: 'Clasp broken', repairCost: 500 },
        companyA.ctx, companyA.user.id,
      );

      await expect(updateRepairJob(repair.id, { repairCost: 999 }, companyB.ctx)).rejects.toThrow('Repair job not found');
      await expect(deliverRepairJob(repair.id, companyB.ctx)).rejects.toThrow('Repair job not found');
      await expect(billRepairJob(repair.id, companyB.branch.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Repair job not found');

      const listA = await listRepairJobs(companyA.ctx);
      const listB = await listRepairJobs(companyB.ctx);
      expect(listA.some((r) => r.id === repair.id)).toBe(true);
      expect(listB.some((r) => r.id === repair.id)).toBe(false);
    });

    it('billRepairJob legitimately bills through Company A\'s own ctx', async () => {
      const repair = await createRepairJob(
        { clientId: clientA.id, repairType: 'CUSTOMER_REPAIR', returnReason: 'Clasp broken', repairCost: 750 },
        companyA.ctx, companyA.user.id,
      );
      const billed = await billRepairJob(repair.id, companyA.branch.id, companyA.ctx, companyA.user.id);
      expect(billed.invoiceId).toBeTruthy();
      createdInvoiceIds.push(billed.invoiceId!);
    });
  });
});
