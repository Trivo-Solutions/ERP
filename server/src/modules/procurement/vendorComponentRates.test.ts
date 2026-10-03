import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_LOT_MATERIAL_TYPE } from '../../shared/constants';
import { createPO, createGRN } from './procurement.service';
import { createVendorRate, updateVendorRate, listVendorRates, previewVendorRate } from './vendorRate.service';
import { createTag as _createTag } from '../tagging/tagging.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// Vendor component pricing: vendor master (default) -> PO agreed rate -> GRN snapshot -> tag.
describe('vendor component rates (PO -> GRN -> Tagging)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let ringCat: string;
  let supplierId: string;
  let diamondId: string;      // StoneType (unit CT)
  let vsGradeId: string;      // Diamond / VS
  let vvsGradeId: string;     // Diamond / VVS
  let pearlId: string;        // StoneType (unit CT) — priced grade-less
  let pearlGradeId: string;
  let otherStoneTypeId: string;
  const poIds: string[] = [];
  const lotIds: string[] = [];
  const tagIds: string[] = [];

  const createTag = (data: Partial<Parameters<typeof _createTag>[1]>) => _createTag(tenant.ctx, {
    branchId, name: 'Lot piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9,
    stockTypeId, categoryId: ringCat, ...data,
  }, userId).then((t) => { tagIds.push(t.id); return t; });

  const lump = (extra: Record<string, unknown> = {}) => ({
    materialCode: 'LOT-1', materialName: 'Finished Jewellery Lot', materialType: FINISHED_LOT_MATERIAL_TYPE,
    quantity: 1, weight: 25.65, unit: 'BAG', ratePerUnit: 0, lotAmount: 100000, ...extra,
  });
  const newPO = async (line: Record<string, unknown>, supplier = supplierId, orderDate = new Date()) => {
    const po = await createPO({ supplierId: supplier, poType: 'OUTRIGHT', orderDate, items: [line as any] }, tenant.ctx, userId);
    poIds.push(po.id);
    return po;
  };
  const receive = async (po: Awaited<ReturnType<typeof newPO>>) => {
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `VR-${poIds.length}`, invoiceDate: new Date(),
      items: po.poItems.map((i) => ({ poItemId: i.id, invoiceQty: Number(i.quantity), invoiceWeight: Number(i.weight), scaleWeight: Number(i.weight) })),
    }, tenant.ctx, userId);
    const lot = await prisma.purchaseLot.findUnique({ where: { grnItemId: grn.grnItems[0].id } });
    if (lot) lotIds.push(lot.id);
    return { grn, lot };
  };
  const vendorRate = (extra: Record<string, unknown> = {}) => createVendorRate(tenant.ctx, userId, {
    supplierId, stoneTypeId: diamondId, stoneGradeId: vsGradeId, unit: 'CT', costRate: 30000, effectiveDate: new Date('2026-01-01'), ...extra,
  } as any);

  beforeAll(async () => {
    tenant = await createTestTenant(`VR${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:view']);
    other = await createTestTenant(`VRO${suffix}`, ['po:create', 'po:view']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    stockTypeId = (await prisma.stockType.create({ data: { companyId: tenant.company.id, code: `V${suffix}`.slice(0, 8).toUpperCase(), name: 'VR Stock' } })).id;
    ringCat = (await prisma.productCategory.create({ data: { companyId: tenant.company.id, code: `VRING-${suffix}`, name: 'Rings' } })).id;
    supplierId = (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `VRSUP-${suffix}`, name: 'VR Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z5' },
    })).id;
    diamondId = (await prisma.stoneType.create({ data: { companyId: tenant.company.id, code: `DIA-${suffix}`, name: 'Diamond', itemType: 'DIAMOND', unit: 'CT' } })).id;
    pearlId = (await prisma.stoneType.create({ data: { companyId: tenant.company.id, code: `PRL-${suffix}`, name: 'Pearl', itemType: 'STONE', unit: 'CT' } })).id;
    vsGradeId = (await prisma.stoneGrade.create({ data: { companyId: tenant.company.id, stoneTypeId: diamondId, clarity: 'VS' } })).id;
    vvsGradeId = (await prisma.stoneGrade.create({ data: { companyId: tenant.company.id, stoneTypeId: diamondId, clarity: 'VVS' } })).id;
    pearlGradeId = (await prisma.stoneGrade.create({ data: { companyId: tenant.company.id, stoneTypeId: pearlId, quality: 'AA' } })).id;
    otherStoneTypeId = (await prisma.stoneType.create({ data: { companyId: other.company.id, code: `ODIA-${suffix}`, name: 'Other Diamond' } })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(lotIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.grnItemComponentRate.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.vendorComponentRate.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.purchaseLot.deleteMany({ where: { id: { in: lotIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.stoneType.deleteMany({ where: { companyId: { in: [tenant.company.id, other.company.id] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: ringCat } });
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(other);
    await prisma.$disconnect();
  });

  describe('Finished Lot PO — breakup is optional', () => {
    it('works as a lump-sum lot: gross weight + one amount, no category rows; received, and pieces tag out of it', async () => {
      const po = await newPO(lump());
      const l = po.poItems[0];
      expect(Number(l.totalAmount)).toBe(100000);
      expect(Number(l.weight)).toBe(25.65);
      expect(l.categories).toHaveLength(0);

      const { lot } = await receive(po);
      expect(lot).not.toBeNull();
      expect(Number(lot!.totalCost)).toBe(100000);
      expect(lot!.pieces).toBeNull();

      const tag = await createTag({ purchaseLotId: lot!.id });
      expect(tag.purchaseLotId).toBe(lot!.id);
      expect(Number(tag.costPrice)).toBeGreaterThan(0);  // its weight share of the bag's cost
    });

    it('still needs the lot weight when there is no breakup (nothing to cost-split by otherwise)', async () => {
      await expect(createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [lump({ weight: 0 }) as any] }, tenant.ctx, userId))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('keeps the detailed breakup possible, and still validates it when given', async () => {
      const po = await newPO(lump({ weight: 40, categories: [{ categoryId: ringCat, karat: '22K', grossWeight: 40, netWeight: 36, pieces: 4 }] }));
      expect(po.poItems[0].categories).toHaveLength(1);
      expect(Number(po.poItems[0].netWeight)).toBe(36);
      await expect(createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [lump({ weight: 40, categories: [{ categoryId: ringCat, karat: '22K', grossWeight: 40 }] }) as any],   // neither net nor stone
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('vendor rate -> PO default / override', () => {
    it('uses the vendor component rate as the PO default, and a buyer override leaves the vendor master alone', async () => {
      const vr = await vendorRate();
      const dflt = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId }] }));
      expect(dflt.poItems[0].components).toHaveLength(1);
      expect(Number(dflt.poItems[0].components[0].costRate)).toBe(30000);
      expect(dflt.poItems[0].components[0].rateSource).toBe('VENDOR_MASTER');

      const negotiated = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId, costRate: 28500 }] }));
      expect(Number(negotiated.poItems[0].components[0].costRate)).toBe(28500);
      expect(negotiated.poItems[0].components[0].rateSource).toBe('MANUAL');

      const master = await prisma.vendorComponentRate.findUniqueOrThrow({ where: { id: vr.id } });
      expect(Number(master.costRate)).toBe(30000);
    });

    it('refuses to guess: no rate anywhere, or two equally-current vendor rates, is a 400', async () => {
      // no vendor rate for VVS, none typed
      await expect(createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vvsGradeId }] }) as any],
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 400 });

      // two active VVS rows sharing the same effective date (only possible by bypassing the service)
      const d = new Date('2026-02-01');
      await prisma.vendorComponentRate.createMany({ data: [
        { companyId: tenant.company.id, supplierId, stoneTypeId: diamondId, stoneGradeId: vvsGradeId, unit: 'CT', costRate: 40000, effectiveDate: d },
        { companyId: tenant.company.id, supplierId, stoneTypeId: diamondId, stoneGradeId: vvsGradeId, unit: 'CT', costRate: 41000, effectiveDate: d },
      ] });
      await expect(createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vvsGradeId }] }) as any],
      }, tenant.ctx, userId)).rejects.toThrow(/more than one vendor rate/);
    });

    it('a grade-less vendor rate serves a graded component; a different unit or another grade\'s rate never does', async () => {
      await vendorRate({ stoneTypeId: pearlId, stoneGradeId: undefined, costRate: 500 });
      const po = await newPO(lump({ components: [{ stoneTypeId: pearlId, stoneGradeId: pearlGradeId }] }));
      expect(Number(po.poItems[0].components[0].costRate)).toBe(500);
      // the vendor has a CT rate only — a gram-priced component gets nothing
      await expect(createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [lump({ components: [{ stoneTypeId: pearlId, unit: 'G' }] }) as any],
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('the service refuses a duplicate active rate on the same date, and a grade from another stone type', async () => {
      await expect(vendorRate({ effectiveDate: new Date('2026-01-01') })).rejects.toMatchObject({ statusCode: 409 });
      await expect(vendorRate({ stoneTypeId: pearlId, stoneGradeId: vsGradeId })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('previewVendorRate shows the resolver\'s answer for the PO screen, and never crosses grade, unit or company', async () => {
      const hit = await previewVendorRate(tenant.ctx, { supplierId, stoneTypeId: diamondId, stoneGradeId: vsGradeId, unit: 'CT' });
      expect(hit).toMatchObject({ status: 'MATCH', unit: 'CT', rate: { costRate: 30000 } });
      // unit defaults from the stone type
      expect(await previewVendorRate(tenant.ctx, { supplierId, stoneTypeId: diamondId, stoneGradeId: vsGradeId })).toMatchObject({ status: 'MATCH', unit: 'CT' });
      // another unit / a grade with no rate of its own: nothing
      expect(await previewVendorRate(tenant.ctx, { supplierId, stoneTypeId: diamondId, stoneGradeId: vsGradeId, unit: 'GM' })).toMatchObject({ status: 'NONE' });
      // a grade from another stone type is refused; another company's stone type is a 404
      await expect(previewVendorRate(tenant.ctx, { supplierId, stoneTypeId: pearlId, stoneGradeId: vsGradeId })).rejects.toMatchObject({ statusCode: 400 });
      await expect(previewVendorRate(tenant.ctx, { supplierId, stoneTypeId: otherStoneTypeId })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('GRN snapshot -> tagging', () => {
    it('snapshots the PO rate on the GRN; a later vendor-rate change leaves it, and the PO, untouched', async () => {
      const po = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId, costRate: 28500 }] }));
      const { grn } = await receive(po);

      const snap = await prisma.grnItemComponentRate.findMany({ where: { grnItemId: grn.grnItems[0].id } });
      expect(snap).toHaveLength(1);
      expect(Number(snap[0].costRate)).toBe(28500);

      // November: the vendor's rate goes up, and the existing rate row is edited as well
      const vr = await prisma.vendorComponentRate.findFirstOrThrow({ where: { companyId: tenant.company.id, stoneGradeId: vsGradeId } });
      await updateVendorRate(tenant.ctx, userId, vr.id, { costRate: 33000 });
      await vendorRate({ costRate: 31000, effectiveDate: new Date('2026-11-01') });

      expect(Number((await prisma.grnItemComponentRate.findUniqueOrThrow({ where: { id: snap[0].id } })).costRate)).toBe(28500);
      expect(Number((await prisma.poItemComponent.findFirstOrThrow({ where: { poItemId: po.poItems[0].id } })).costRate)).toBe(28500);
    });

    it('tagging picks up the rate automatically: 0.25 ct Diamond VS at ₹28,500/ct = ₹7,125', async () => {
      const po = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId, costRate: 28500 }] }));
      const { lot } = await receive(po);
      const tag = await createTag({
        purchaseLotId: lot!.id,
        materials: [{ code: 'DIA', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.25, unit: 'CT' }],
      });
      const mat = await prisma.jewelryTagMaterial.findFirstOrThrow({ where: { tagId: tag.id } });
      expect(Number(mat.costRate)).toBe(28500);
      expect(Number(mat.costAmount)).toBe(7125);
      expect(Number(tag.costPrice)).toBe(7125);
    });

    it('costRate: null (empty field) is "not entered" and still auto-fills', async () => {
      const po = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId, costRate: 28500 }] }));
      const { lot } = await receive(po);
      const tag = await createTag({
        purchaseLotId: lot!.id,
        materials: [{ code: 'DIA', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.25, unit: 'CT', costRate: null as any }],
      });
      const mat = await prisma.jewelryTagMaterial.findFirstOrThrow({ where: { tagId: tag.id } });
      expect(Number(mat.costRate)).toBe(28500);
      expect(Number(mat.costAmount)).toBe(7125);
      expect(Number(tag.costPrice)).toBe(7125);
    });

    it('never overrides a rate the user entered, and leaves a stone with no PO rate as it was', async () => {
      const po = await newPO(lump({ components: [{ stoneTypeId: diamondId, stoneGradeId: vsGradeId, costRate: 28500 }] }));
      const { lot } = await receive(po);
      const tag = await createTag({
        purchaseLotId: lot!.id,
        materials: [
          { code: 'DIA', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.25, unit: 'CT', costRate: 20000 },
          { code: 'DIA2', materialType: 'DIAMOND', stoneGradeId: vvsGradeId, weight: 0.1, unit: 'CT' },   // PO carries no VVS rate
          { code: 'DIA3', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.5, unit: 'GM' },    // different unit: not converted
        ],
      });
      const mats = await prisma.jewelryTagMaterial.findMany({ where: { tagId: tag.id }, orderBy: { code: 'asc' } });
      expect(Number(mats[0].costRate)).toBe(20000);
      expect(mats[1].costRate).toBeNull();
      expect(mats[2].costRate).toBeNull();
    });

    it('a grade-less ("any quality") PO rate applies to any grade of that stone', async () => {
      const po = await newPO(lump({ components: [{ stoneTypeId: pearlId, costRate: 900 }] }));
      const { lot } = await receive(po);
      const tag = await createTag({
        purchaseLotId: lot!.id, materials: [{ code: 'PRL', materialType: 'PEARL', stoneGradeId: pearlGradeId, weight: 2, unit: 'CT' }],
      });
      const mat = await prisma.jewelryTagMaterial.findFirstOrThrow({ where: { tagId: tag.id } });
      expect(Number(mat.costAmount)).toBe(1800);
    });

    it('existing tagging is unaffected where no component rate exists (plain lot, and no lot at all)', async () => {
      const { lot } = await receive(await newPO(lump()));
      const a = await createTag({ purchaseLotId: lot!.id, materials: [{ code: 'DIA', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.25, unit: 'CT' }] });
      expect((await prisma.jewelryTagMaterial.findFirstOrThrow({ where: { tagId: a.id } })).costRate).toBeNull();
      const b = await createTag({ materials: [{ code: 'DIA', materialType: 'DIAMOND', stoneGradeId: vsGradeId, weight: 0.25, unit: 'CT', costRate: 100, costAmount: 25 }] });
      expect(Number(b.costPrice)).toBe(25);
    });
  });

  describe('company isolation', () => {
    it("another company's stone type / grade / supplier is a 404 on a PO line and on a vendor rate", async () => {
      await expect(createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [lump({ components: [{ stoneTypeId: otherStoneTypeId, costRate: 1 }] }) as any],
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(vendorRate({ stoneTypeId: otherStoneTypeId, stoneGradeId: undefined })).rejects.toMatchObject({ statusCode: 404 });
      await expect(createVendorRate(other.ctx, other.user.id, { supplierId, stoneTypeId: otherStoneTypeId, costRate: 1 } as any))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it("never lists, edits or resolves another company's vendor rates", async () => {
      const vr = await prisma.vendorComponentRate.findFirstOrThrow({ where: { companyId: tenant.company.id } });
      expect(await listVendorRates(other.ctx, {})).toHaveLength(0);
      await expect(updateVendorRate(other.ctx, other.user.id, vr.id, { costRate: 1 })).rejects.toMatchObject({ statusCode: 404 });
      expect(Number((await prisma.vendorComponentRate.findUniqueOrThrow({ where: { id: vr.id } })).costRate)).toBe(Number(vr.costRate));
    });
  });
});
