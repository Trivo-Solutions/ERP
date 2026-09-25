import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';
import {
  createDesign, getDesignById, updateDesign, saveBom, generateCostEstimate, upsertMetalRate,
} from '../modules/product-design/design.service';
import {
  createJobCard, recordWipEntry, advanceProcess, submitQcCheckpoint, listJobCards,
} from '../modules/manufacturing/manufacturing.service';
import {
  addMetalStock, adjustMetalStock, createStoneLot, splitStoneLot, consumableTransaction,
} from '../modules/inventory/inventory.service';
import {
  createArtisan, issueToArtisan, returnFromArtisan, getArtisanLedger, generateSubcontractorInvoice,
} from '../modules/outsourcing/outsourcing.service';
import { createOrder, getOrder, updateOrderStatus } from '../modules/orders/orders.service';

// ═══════════════════════════════════════════════════
// Phase 3 tenant isolation: design/BOM/cost-estimate, manufacturing (JobCard/WIP/QC), inventory
// (MetalStock/StoneLot/Consumable), outsourcing (Artisan/KarigarLedger/SubcontractorInvoice), and
// orders (SalesOrder/reservations) — the five module groups the Phase 3 full-rollout instructions
// (section 15) call out by name as needing their own cross-company isolation coverage, beyond the
// procurement/quality suite already closed in Phase 2b.
// ═══════════════════════════════════════════════════

describe('Phase 3: design/manufacturing/inventory/outsourcing/orders tenant isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let companyA: TestTenant;
  let companyB: TestTenant;
  // DesignCategory is company-owned — one per tenant, keyed by companyId.
  const categoryIds: Record<string, string> = {};
  let clientAId: string;
  let clientBId: string;

  beforeAll(async () => {
    companyA = await createTestTenant(`P3A${suffix}`, ['design:manage', 'job:manage', 'inventory:manage', 'artisan:manage', 'order:manage']);
    companyB = await createTestTenant(`P3B${suffix}`, ['design:manage', 'job:manage', 'inventory:manage', 'artisan:manage', 'order:manage']);

    for (const t of [companyA, companyB]) {
      const category = await prisma.designCategory.create({ data: { companyId: t.company.id, code: `P3CAT-${suffix}`, name: 'P3 Category' } });
      categoryIds[t.company.id] = category.id;
    }

    const clientA = await prisma.client.create({ data: { companyId: companyA.company.id, clientCode: `P3CL-A-${suffix}`, name: 'Client A', type: 'RETAIL' } });
    clientAId = clientA.id;
    const clientB = await prisma.client.create({ data: { companyId: companyB.company.id, clientCode: `P3CL-B-${suffix}`, name: 'Client B', type: 'RETAIL' } });
    clientBId = clientB.id;
  });

  afterAll(async () => {
    await prisma.materialReservation.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.clientNotification.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.orderItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.salesOrder.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.wipTracking.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.qcCheckpoint.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.jobProcess.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.jobCard.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.karigarLedger.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.subcontractorInvoice.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.artisan.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.consumableTransaction.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.consumable.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.stoneLotSplit.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.stoneLot.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.metalStock.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.costEstimate.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.bomItem.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.bomProcess.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.metalRate.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.design.deleteMany({ where: { companyId: { in: [companyA.company.id, companyB.company.id] } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientAId, clientBId] } } });
    await prisma.designCategory.deleteMany({ where: { id: { in: Object.values(categoryIds) } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  async function makeDesign(tenant: TestTenant, code: string) {
    return createDesign({
      designCode: code, name: 'Test Ring', categoryId: categoryIds[tenant.company.id], metalKarat: '22K',
      grossWeightMin: 4, grossWeightMax: 6, netWeightMin: 3, netWeightMax: 5,
    }, tenant.company.id, tenant.user.id);
  }

  describe('design / BOM / cost estimate', () => {
    it('createDesign stamps the caller\'s own companyId', async () => {
      const design = await makeDesign(companyA, `P3DES-A1-${suffix}`);
      expect(design.companyId).toBe(companyA.company.id);
    });

    it('Company B cannot read, update, or BOM a Company A design (IDOR)', async () => {
      const design = await makeDesign(companyA, `P3DES-A2-${suffix}`);
      await expect(getDesignById(companyB.company.id, design.id)).rejects.toThrow('Design not found');
      await expect(updateDesign(design.id, { name: 'Hijacked' }, companyB.company.id, companyB.user.id)).rejects.toThrow('Design not found');
      await expect(
        saveBom(design.id, [], [], companyB.company.id, companyB.user.id)
      ).rejects.toThrow('Design not found');

      // Company A itself can.
      const fetched = await getDesignById(companyA.company.id, design.id);
      expect(fetched.id).toBe(design.id);
    });

    it('generateCostEstimate rejects a Company B designId (IDOR) and only resolves the caller\'s own MetalRate', async () => {
      const designA = await makeDesign(companyA, `P3DES-A3-${suffix}`);
      await expect(generateCostEstimate(designA.id, companyB.ctx)).rejects.toThrow('Design not found');

      // Only Company A has a metal rate — proves generateCostEstimate never falls through to
      // another company's rate row when the caller's own is missing.
      await upsertMetalRate(companyA.company.id, { date: new Date(), karat: '22K', ratePerGram: 6000 });
      const estimate = await generateCostEstimate(designA.id, companyA.ctx);
      expect(estimate.companyId).toBe(companyA.company.id);
    });

    it('two companies creating designs concurrently never cross-contaminate companyId', async () => {
      const [designA, designB] = await Promise.all([
        makeDesign(companyA, `P3DES-CONC-A-${suffix}`),
        makeDesign(companyB, `P3DES-CONC-B-${suffix}`),
      ]);
      expect(designA.companyId).toBe(companyA.company.id);
      expect(designB.companyId).toBe(companyB.company.id);
    });
  });

  describe('manufacturing (JobCard / WIP / QC)', () => {
    it('createJobCard rejects a Company B designId (cross-company forgery)', async () => {
      const designB = await makeDesign(companyB, `P3DES-JCFORGE-${suffix}`);
      await expect(
        createJobCard({ designId: designB.id, issuedWeight: 5 }, companyA.ctx, companyA.user.id)
      ).rejects.toThrow('Design not found');
    });

    it('Company B cannot record WIP, advance process, or submit QC on a Company A job card (IDOR)', async () => {
      const design = await makeDesign(companyA, `P3DES-JC-${suffix}`);
      await saveBom(design.id, [], [
        { processName: 'MELTING', sequence: 1, makingChargeType: 'FLAT', makingChargeValue: 100 },
        { processName: 'CASTING', sequence: 2, makingChargeType: 'FLAT', makingChargeValue: 100 },
      ], companyA.company.id, companyA.user.id);

      const jobCard = await createJobCard({ designId: design.id, issuedWeight: 5 }, companyA.ctx, companyA.user.id);
      expect(jobCard.companyId).toBe(companyA.company.id);
      const firstProcess = jobCard.processes[0];

      await expect(
        recordWipEntry(
          { jobCardId: jobCard.id, processId: firstProcess.id, workerId: 'w1', issuedWeight: 5, returnedWeight: 4.8, scrapWeight: 0.1 },
          companyB.ctx, companyB.user.id,
        )
      ).rejects.toThrow('Job card not found');
      await expect(advanceProcess(jobCard.id, firstProcess.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Job card not found');
      await expect(
        submitQcCheckpoint(
          { jobCardId: jobCard.id, processId: firstProcess.id, inspectorId: 'i1', result: 'PASSED' },
          companyB.ctx, companyB.user.id,
        )
      ).rejects.toThrow('Job card not found');

      // Company A itself can operate on its own job card.
      const { entry } = await recordWipEntry(
        { jobCardId: jobCard.id, processId: firstProcess.id, workerId: companyA.user.id, issuedWeight: 5, returnedWeight: 4.8, scrapWeight: 0.1 },
        companyA.ctx, companyA.user.id,
      );
      expect(entry.companyId).toBe(companyA.company.id);
    });

    it('listJobCards scopes results to the caller\'s own companyId', async () => {
      const design = await makeDesign(companyA, `P3DES-LIST-${suffix}`);
      const jobCard = await createJobCard({ designId: design.id, issuedWeight: 5 }, companyA.ctx, companyA.user.id);

      const { jobCards: listA } = await listJobCards(companyA.company.id, {});
      const { jobCards: listB } = await listJobCards(companyB.company.id, {});
      expect(listA.some((j) => j.id === jobCard.id)).toBe(true);
      expect(listB.some((j) => j.id === jobCard.id)).toBe(false);
    });
  });

  describe('inventory (MetalStock / StoneLot / Consumable)', () => {
    it('Company B cannot adjust a Company A metal stock row (IDOR)', async () => {
      const stock = await addMetalStock(
        { materialName: 'Gold bar', karat: '22K', purity: 0.916, grossWeight: 100, netWeight: 100, sourceType: 'PURCHASE', avgCostPerGram: 5500 },
        companyA.company.id, companyA.user.id,
      );
      await expect(adjustMetalStock(stock.id, -10, 'test', companyB.ctx, companyB.user.id)).rejects.toThrow('Metal stock not found');
      const adjusted = await adjustMetalStock(stock.id, -10, 'test', companyA.ctx, companyA.user.id);
      expect(Number(adjusted.availableWt)).toBe(90);
    });

    it('Company B cannot split a Company A stone lot (IDOR)', async () => {
      const lot = await createStoneLot({
        stoneType: 'DIAMOND', shape: 'ROUND', caratWeight: 10, pieces: 20, avgCostPerCt: 3000, totalCost: 30000,
      }, companyA.company.id, companyA.user.id);
      await expect(
        splitStoneLot(lot.id, [{ weight: 2, pieces: 4 }], companyB.ctx, companyB.user.id)
      ).rejects.toThrow('Stone lot not found');
      const children = await splitStoneLot(lot.id, [{ weight: 2, pieces: 4 }], companyA.ctx, companyA.user.id);
      expect(children[0].companyId).toBe(companyA.company.id);
    });

    it('Company B cannot transact against a Company A consumable (IDOR)', async () => {
      const consumable = await prisma.consumable.create({
        data: { companyId: companyA.company.id, itemCode: `P3CONS-${suffix}`, name: 'Polish compound', category: 'CONSUMABLE', currentQty: 50, unit: 'KG', reorderLevel: 5 },
      });
      await expect(
        consumableTransaction(consumable.id, 'OUT', 5, companyB.ctx)
      ).rejects.toThrow('Consumable not found');
      const updated = await consumableTransaction(consumable.id, 'OUT', 5, companyA.ctx);
      expect(Number(updated.currentQty)).toBe(45);
    });
  });

  describe('outsourcing (Artisan / KarigarLedger / SubcontractorInvoice)', () => {
    it('createArtisan rejects a Company B supplierId (cross-company forgery)', async () => {
      const supplierB = await prisma.supplier.create({
        data: { companyId: companyB.company.id, supplierCode: `P3SUP-B-${suffix}`, name: 'Supplier B', type: 'OTHER' },
      });
      await expect(
        createArtisan({ name: 'Forged Artisan', type: 'KARIGAR', supplierId: supplierB.id }, companyA.ctx)
      ).rejects.toThrow('Supplier not found');
      await prisma.supplier.deleteMany({ where: { id: supplierB.id } });
    });

    it('Company B cannot issue to, return from, read the ledger of, or invoice a Company A artisan (IDOR)', async () => {
      const artisan = await createArtisan({ name: 'Artisan A', type: 'KARIGAR' }, companyA.ctx);
      expect(artisan.companyId).toBe(companyA.company.id);

      await expect(
        issueToArtisan({ artisanId: artisan.id, metalType: 'GOLD', karat: '22K', issuedWeight: 10 }, companyB.ctx, companyB.user.id)
      ).rejects.toThrow('Artisan not found');
      await expect(
        returnFromArtisan({ artisanId: artisan.id, metalType: 'GOLD', returnedWeight: 9, scrapWeight: 0.5 }, companyB.ctx, companyB.user.id)
      ).rejects.toThrow('Artisan not found');
      await expect(getArtisanLedger(companyB.ctx, artisan.id)).rejects.toThrow('Artisan not found');
      await expect(
        generateSubcontractorInvoice(
          { artisanId: artisan.id, periodFrom: new Date(), periodTo: new Date(), chargeType: 'FLAT', baseAmount: 1000 },
          companyB.ctx, companyB.user.id,
        )
      ).rejects.toThrow('Artisan not found');

      // Company A itself can.
      const entry = await issueToArtisan({ artisanId: artisan.id, metalType: 'GOLD', karat: '22K', issuedWeight: 10 }, companyA.ctx, companyA.user.id);
      expect(entry.companyId).toBe(companyA.company.id);
    });
  });

  describe('orders (SalesOrder / reservations)', () => {
    it('createOrder rejects a Company B clientId (cross-company forgery)', async () => {
      const design = await makeDesign(companyA, `P3DES-ORD1-${suffix}`);
      await expect(
        createOrder({ clientId: clientBId, orderDate: new Date(), items: [{ designId: design.id, quantity: 1, unitPrice: 50000 }] }, companyA.ctx, companyA.user.id)
      ).rejects.toThrow('Client not found');
    });

    it('createOrder rejects a Company B designId in its items (cross-company forgery)', async () => {
      const designB = await makeDesign(companyB, `P3DES-ORD2-${suffix}`);
      await expect(
        createOrder({ clientId: clientAId, orderDate: new Date(), items: [{ designId: designB.id, quantity: 1, unitPrice: 50000 }] }, companyA.ctx, companyA.user.id)
      ).rejects.toThrow('Design not found');
    });

    it('Company B cannot read or update the status of a Company A order (IDOR)', async () => {
      const design = await makeDesign(companyA, `P3DES-ORD3-${suffix}`);
      const order = await createOrder(
        { clientId: clientAId, orderDate: new Date(), items: [{ designId: design.id, quantity: 1, unitPrice: 50000 }] },
        companyA.ctx, companyA.user.id,
      );
      expect(order.companyId).toBe(companyA.company.id);

      await expect(getOrder(companyB.company.id, order.id)).rejects.toThrow('Order not found');
      await expect(updateOrderStatus(order.id, 'IN_PRODUCTION', companyB.ctx, companyB.user.id)).rejects.toThrow('Order not found');

      const updated = await updateOrderStatus(order.id, 'IN_PRODUCTION', companyA.ctx, companyA.user.id);
      expect(updated.status).toBe('IN_PRODUCTION');
    });

    it('autoReserveMaterials only ever draws from the ordering company\'s own MetalStock', async () => {
      // Company B gets a much larger, more-recently-created 22K stock lot than Company A's own
      // (left over from the inventory describe block above, ~90g available) — if the reservation
      // lookup ever ignored the companyId filter, it could satisfy Company A's 5g requirement
      // from Company B's pool instead of (or as well as) its own.
      const stockB = await prisma.metalStock.create({
        data: { companyId: companyB.company.id, stockCode: `P3MS-B-${suffix}`, materialName: 'Gold', karat: '22K', purity: 0.916, grossWeight: 500, netWeight: 500, availableWt: 500, sourceType: 'PURCHASE', avgCostPerGram: 5500 },
      });

      const design = await makeDesign(companyA, `P3DES-ORD4-${suffix}`);
      await saveBom(design.id, [
        { materialType: 'METAL', materialCode: 'GOLD22K', materialName: 'Gold 22K', quantity: 5, unit: 'GM', karat: '22K' },
      ], [], companyA.company.id, companyA.user.id);

      const order = await createOrder(
        { clientId: clientAId, orderDate: new Date(), items: [{ designId: design.id, quantity: 1, unitPrice: 50000 }] },
        companyA.ctx, companyA.user.id,
      );

      const fullOrder = await getOrder(companyA.company.id, order.id);
      expect(fullOrder.reservations.length).toBe(1);
      // Whichever stock row it reserved against, it must be one of Company A's own.
      const reservedStock = await prisma.metalStock.findUniqueOrThrow({ where: { id: fullOrder.reservations[0].metalStockId! } });
      expect(reservedStock.companyId).toBe(companyA.company.id);
      expect(reservedStock.id).not.toBe(stockB.id);
    });
  });
});
