import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { tenantQuery } from '../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE, FINISHED_LOT_MATERIAL_TYPE } from '../shared/constants';
import { createGstRegistration } from '../modules/company/company.service';
import { createPO, createGRN, createSupplier } from '../modules/procurement/procurement.service';
import { createTagFromGrnItem } from '../modules/tagging/tagging.service';
import { isValidTaxCategory, TAX_CATEGORIES, DEFAULT_TAX_CATEGORY } from '../shared/taxCategory';
import { cleanupJournalEntries } from './ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// G2g-7a — Inward GST Foundation & Multi-GSTIN Attribution. Data-model/attribution foundation
// only (CLAUDE.md's G2g-7a entry): no GSTR-3B aggregation, ITC eligibility, RCM calculation, or
// journal-posting change happens anywhere in this phase.
//
// Three purely additive pieces under test:
//   1. GrnItem.buyerRegistrationId — resolved from the GRN's own receiving branch (else the
//      company's primary active registration, else null), stamped once by createTagFromGrnItem
//      (FINISHED_GOODS) / the FINISHED_LOT GRN-receipt path, alongside the existing
//      taxableValue/inputCgst/Sgst/Igst stamp. Composite FK to company_gst_registrations.
//   2. PoItem.taxCategory — TAXABLE | EXEMPT | NIL_RATED | NON_GST | ZERO_RATED
//      (shared/taxCategory.ts), independent of taxRate.
//   3. Supplier.isComposition — a plain boolean, default false.
//
// company_gst_registrations is FORCE RLS even for the platform/owner test role (G1 migration) —
// rows are created through the real service (createGstRegistration, which runs inside
// tenantTransaction) and read back through tenantQuery, never a bare prisma call. grn_items/
// po_items/suppliers need no such wrapper (same as every other existing procurement test file,
// e.g. procurement.inputGst.test.ts) — only company_gst_registrations has this quirk.
// ═══════════════════════════════════════════════════════════════════════════

describe('G2g-7a: inward GST foundation (buyerRegistrationId / taxCategory / Supplier.isComposition)', () => {
  const suffix = `g2g7a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let A: TestTenant;
  let B: TestTenant;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];

  const line = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'G7A-RING', materialName: 'G2g7a ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  // PO -> GRN -> tag for one finished piece, at the given receiving branch. Returns the tag and GRN item.
  async function intake(branchId: string, price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(price, lineExtra)] }, A.ctx, A.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `G7A-INV-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, A.ctx, A.user.id);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'G2g7a ring', metalType: 'GOLD',
    }, A.ctx, A.user.id);
    tagIds.push(tag.id);
    return { po, grn, tag, grnItemId: grn.grnItems[0].id };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
    B = await createTestTenant(`${suffix}B`, []);
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: A.company.id, code: `G7${suffix}`.slice(0, 8).toUpperCase(), name: 'G2g7a Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: A.company.id, code: `G7ACAT-${suffix}`, name: 'G2g7a Category' },
    })).id;
    supplierId = (await prisma.supplier.create({
      data: { companyId: A.company.id, supplierCode: `G7A-SUP-${suffix}`, name: 'G2g7a Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z5' },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: [A.user.id, B.user.id] } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    for (const t of [A, B]) {
      await tenantQuery(t.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: t.company.id } }));
    }
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  // ─── buyerRegistrationId: resolution ─────────────────────────────────────

  describe('GrnItem.buyerRegistrationId', () => {
    it('stays null when the company has no GST registration at all (never fabricated)', async () => {
      const { grnItemId } = await intake(A.branch.id, 10000);
      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
      expect(g.buyerRegistrationId).toBeNull();
    });

    it('resolves to the company\'s primary active registration once one exists, with no branch-specific link', async () => {
      const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA1000A1Z5', legalName: 'G2g7a Primary Co', stateCode: '24' });
      const { grnItemId } = await intake(A.branch.id, 11000);
      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
      expect(g.buyerRegistrationId).toBe(reg.id);
    });

    it('prefers the receiving branch\'s own linked registration over the primary', async () => {
      const branchReg = await createGstRegistration(A.ctx, { gstin: '24AAAAA2000A1Z5', legalName: 'G2g7a Branch Co', stateCode: '24', isPrimary: false });
      await prisma.branch.update({ where: { id: A.branch.id }, data: { gstRegistrationId: branchReg.id } });
      try {
        const { grnItemId } = await intake(A.branch.id, 12000);
        const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
        expect(g.buyerRegistrationId).toBe(branchReg.id);
      } finally {
        await prisma.branch.update({ where: { id: A.branch.id }, data: { gstRegistrationId: null } });
      }
    });

    it('does NOT silently substitute the primary when the branch\'s own link is inactive — resolves to null instead (mirrors resolveSellerRegistration\'s own branch-link-inactive behavior: an explicit-but-stale link is reported as unresolved, never swapped for a different registration the branch didn\'t ask for)', async () => {
      const inactiveReg = await createGstRegistration(A.ctx, { gstin: '24AAAAA3000A1Z5', legalName: 'G2g7a Inactive Co', stateCode: '24', isPrimary: false });
      await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.update({ where: { id: inactiveReg.id }, data: { isActive: false } }));
      await prisma.branch.update({ where: { id: A.branch.id }, data: { gstRegistrationId: inactiveReg.id } });
      try {
        const { grnItemId } = await intake(A.branch.id, 13000);
        const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
        expect(g.buyerRegistrationId).toBeNull();
      } finally {
        await prisma.branch.update({ where: { id: A.branch.id }, data: { gstRegistrationId: null } });
      }
    });

    it('is stamped at GRN-receipt time for a FINISHED_LOT line too (openPurchaseLot), not just a FINISHED_GOODS tag', async () => {
      const reg = await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.findFirstOrThrow({ where: { companyId: A.company.id, isPrimary: true } }));
      const po = await createPO({
        supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
        items: [{
          materialCode: 'G7A-LOT', materialName: 'G2g7a lot', materialType: FINISHED_LOT_MATERIAL_TYPE,
          quantity: 1, weight: 40, unit: 'BAG', ratePerUnit: 0, lotAmount: 200000,
          categories: [{ categoryId, karat: '22K', grossWeight: 40, stoneWeight: 4, netWeight: 36, pieces: 10 }],
        }],
      }, A.ctx, A.user.id);
      poIds.push(po.id);
      const grn = await createGRN({
        poId: po.id, receivedDate: new Date(), branchId: A.branch.id, invoiceNumber: `G7A-LOT-${poIds.length}`, invoiceDate: new Date(),
        items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 40, scaleWeight: 40 }],
      }, A.ctx, A.user.id);
      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grn.grnItems[0].id } });
      expect(g.buyerRegistrationId).toBe(reg.id);
      await prisma.purchaseLot.deleteMany({ where: { grnItemId: g.id } });
    });

    it('cross-company: a GRN line can never be pointed at another company\'s registration (composite FK)', async () => {
      const bReg = await createGstRegistration(B.ctx, { gstin: '27BBBBB0000B1Z5', legalName: 'G2g7a Co B', stateCode: '27' });
      const { grnItemId } = await intake(A.branch.id, 14000);
      await expect(
        prisma.grnItem.update({ where: { id: grnItemId }, data: { buyerRegistrationId: bReg.id } }),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('control: pointing the same GRN line at its OWN company\'s registration succeeds', async () => {
      const reg = await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.findFirstOrThrow({ where: { companyId: A.company.id, isPrimary: true } }));
      const { grnItemId } = await intake(A.branch.id, 15000);
      await expect(
        prisma.grnItem.update({ where: { id: grnItemId }, data: { buyerRegistrationId: reg.id } }),
      ).resolves.toMatchObject({ buyerRegistrationId: reg.id });
    });
  });

  // ─── Tax category: validation, independence from taxRate ────────────────

  describe('PoItem.taxCategory', () => {
    it('accepts all five statutory categories', () => {
      for (const c of TAX_CATEGORIES) expect(isValidTaxCategory(c)).toBe(true);
    });

    it('rejects an invalid category string', () => {
      expect(isValidTaxCategory('ZERO')).toBe(false);
      expect(isValidTaxCategory('')).toBe(false);
    });

    it('createPO defaults an unspecified line to TAXABLE', async () => {
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(5000)] }, A.ctx, A.user.id);
      poIds.push(po.id);
      expect(po.poItems[0].taxCategory).toBe(DEFAULT_TAX_CATEGORY);
    });

    it('createPO accepts an explicit category and keeps it exactly as given', async () => {
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(5000, { taxCategory: 'NIL_RATED' })] }, A.ctx, A.user.id);
      poIds.push(po.id);
      expect(po.poItems[0].taxCategory).toBe('NIL_RATED');
    });

    it('createPO rejects an unknown category string', async () => {
      await expect(
        createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(5000, { taxCategory: 'BOGUS' })] }, A.ctx, A.user.id),
      ).rejects.toThrow(/tax category/i);
    });

    it('a zero tax rate (unregistered-supplier bill) does NOT get auto-classified as EXEMPT/NIL_RATED/NON_GST/ZERO_RATED', async () => {
      const urd = await createSupplier({ name: 'G2g7a URD', type: 'OTHER' }, A.company.id);
      const po = await createPO({ supplierId: urd.id, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(5000)] }, A.ctx, A.user.id);
      poIds.push(po.id);
      expect(Number(po.poItems[0].taxRate)).toBe(0); // unregistered supplier -> no GST charged
      expect(po.poItems[0].taxCategory).toBe('TAXABLE'); // still the default — never inferred from the rate
      // not deleted here: the PO above references it (RESTRICT) — afterAll's blanket supplier
      // cleanup runs after POs/GRNs are removed.
    });
  });

  // ─── Supplier.isComposition ───────────────────────────────────────────────

  describe('Supplier.isComposition', () => {
    it('defaults to false when not specified', async () => {
      const s = await createSupplier({ name: 'G2g7a Regular', type: 'OTHER' }, A.company.id);
      expect(s.isComposition).toBe(false);
      await prisma.supplier.delete({ where: { id: s.id } });
    });

    it('can be set true at creation', async () => {
      const s = await createSupplier({ name: 'G2g7a Composition', type: 'OTHER', isComposition: true }, A.company.id);
      expect(s.isComposition).toBe(true);
      await prisma.supplier.delete({ where: { id: s.id } });
    });
  });

  // ─── Procurement lifecycle regression: this phase changes nothing about the existing flow ──

  describe('regression: existing procurement lifecycle is unaffected', () => {
    it('PO -> GRN -> tag still produces the same cost/weight/GST results as before this phase', async () => {
      const { tag, grnItemId } = await intake(A.branch.id, 16000);
      expect(Number(tag.costPrice)).toBe(16000);
      const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
      expect(Number(g.taxableValue)).toBe(16000);
    });
  });
});
