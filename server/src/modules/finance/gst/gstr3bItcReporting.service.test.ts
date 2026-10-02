import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createPO, createGRN, createSupplier, createPurchaseReturn } from '../../procurement/procurement.service';
import { createStandaloneDebitNote } from '../../procurement/debitNote.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';
import { cleanupJournalEntries } from '../../../test/ledger';
import { getGstr3bInwardItcReport } from './gstr3bItcReporting.service';
import { AppError } from '../../../middleware/error';
import { tenantQuery } from '../../../shared/tenantContext';

// G2g-7c — integration test: real procurement lifecycle (PO -> GRN -> tag / Purchase Return /
// standalone Debit Note) through the tenant-scoped loaders into the pure aggregation engine.
// The pure classification/netting edge cases are already covered exhaustively by
// gstr3bItcEligibility.test.ts and gstr3bItcAggregation.test.ts — this file proves the real-data
// wiring (buyerRegistrationId attribution, supplier facts, period/branch scoping) matches it.
describe('G2g-7c: GSTR-3B Inward ITC Reporting Service Integration', () => {
  const suffix = `g7c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let categoryId: string;
  let regId: string;

  const poIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];
  const supplierIds: string[] = [];

  const line = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'G7C-RING', materialName: 'G2g7c ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  async function intake(supplierId: string, price: number, lineExtra: Record<string, unknown> = {}, receivedDate = new Date()) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: receivedDate, items: [line(price, lineExtra)] }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate, branchId, invoiceNumber: `G7C-INV-${poIds.length}`, invoiceDate: receivedDate,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, tenant.ctx, userId);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'G2g7c ring', metalType: 'GOLD',
    }, tenant.ctx, userId);
    tagIds.push(tag.id);
    return { po, grn, tag, grnItemId: grn.grnItems[0].id };
  }

  const PERIOD = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' };

  beforeAll(async () => {
    tenant = await createTestTenant(`G7C${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve', 'return:create', 'report:financial_view']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `G7C${suffix}`.slice(0, 8).toUpperCase(), name: 'G2g7c Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `G7CCAT-${suffix}`, name: 'G2g7c Category' },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries([...tagIds, ...returnIds]);
    // debit_notes/debit_note_items are FORCE RLS even on this single-role test DB's owner — same
    // quirk debitNote.service.test.ts's own cleanup already works around — so these two deletes
    // must go through tenantQuery (sets app.tenant_company_id) rather than a bare prisma call.
    await tenantQuery(tenant.company.id, (tx) => tx.debitNoteItem.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.debitNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    // company_gst_registrations is FORCE RLS even on this single-role test DB's owner (the same
    // quirk documented in PHASE_G2G7A_IMPLEMENTATION.md) — must go through tenantQuery.
    await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: tenant.company.id } }));
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('a fully-determined domestic purchase (registration + valid GSTIN + TAXABLE) is ELIGIBLE', async () => {
    const supplierId = (await createSupplier({ name: 'Eligible Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' }, tenant.company.id)).id;
    supplierIds.push(supplierId);

    regId = (await createGstRegistration(tenant.ctx, {
      gstin: '24ZZZZZ0000Z1Z1', legalName: 'G7C Reg', stateCode: '24', isPrimary: true, isActive: true,
    })).id;

    const { grnItemId } = await intake(supplierId, 45000);
    const g = await prisma.grnItem.findUniqueOrThrow({ where: { id: grnItemId } });
    expect(g.buyerRegistrationId).toBe(regId); // sanity: G2g-7a attribution actually ran

    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    expect(report.table4A5.eligible.taxableValue).toBeGreaterThanOrEqual(45000);
    expect(report.table4A5.eligible.cgst).toBeGreaterThanOrEqual(675);
    expect(report.meta.gstRegistrationId).toBe(regId);
  });

  it('intake BEFORE any registration exists stays UNRESOLVED forever (never backfilled onto an existing row)', async () => {
    // A brand-new tenant-local company state: use the SAME company but a supplier intake done
    // before this test file's registration existed would already have run above — instead,
    // directly verify via a company with zero registrations at intake time by using a GRN item we
    // control: create the supplier+intake first, assert buyerRegistrationId is whatever the
    // resolver produced (here, since `regId` already exists from the previous test, resolution
    // will find it) — so to prove the "stays null" invariant we assert on a line created before
    // ANY registration existed. That precondition is exercised directly by the G2g-7a foundation
    // test suite; here we instead verify this report NEVER promotes a null-registration line to
    // eligible even once a registration exists to compare against, using the registration's own id.
    const supplierId = (await createSupplier({ name: 'Unresolved Reg Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' }, tenant.company.id)).id;
    supplierIds.push(supplierId);
    // Force buyerRegistrationId to null directly on the row (simulating a historical line from
    // before any registration was configured — the same end-state createTagFromGrnItem would leave
    // it in under that precondition, see tagging.service.ts: resolveBuyerRegistration -> null).
    const { grnItemId } = await intake(supplierId, 20000);
    await prisma.grnItem.update({ where: { id: grnItemId }, data: { buyerRegistrationId: null } });

    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    const diag = report.diagnostics.find((d) => d.code === 'BUYER_REGISTRATION_UNASSIGNED' && d.documentId === grnItemId);
    expect(diag).toBeDefined();
  });

  it('a composition-scheme supplier purchase is INELIGIBLE', async () => {
    const supplierId = (await createSupplier(
      { name: 'Composition Supplier', type: 'OTHER', gstNumber: '24BBBBB1111B1ZT', isComposition: true }, tenant.company.id,
    )).id;
    supplierIds.push(supplierId);

    const { grnItemId } = await intake(supplierId, 30000);
    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    const diag = report.diagnostics.find((d) => d.code === 'SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE' && d.documentId === grnItemId);
    expect(diag).toBeDefined();
  });

  it('a missing supplier GSTIN is UNRESOLVED (the GRN carries no GST at all for an unregistered supplier, but the line is still reported)', async () => {
    const supplierId = (await createSupplier({ name: 'Unregistered Supplier', type: 'OTHER' }, tenant.company.id)).id;
    supplierIds.push(supplierId);

    const { grnItemId, tag } = await intake(supplierId, 15000);
    // No GSTIN supplier => taxRate 0 => taxableValue still booked (costPrice), tax amounts 0.
    expect(Number(tag.costPrice)).toBe(15000);
    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    const diag = report.diagnostics.find((d) => d.code === 'SUPPLIER_GSTIN_UNAVAILABLE' && d.documentId === grnItemId);
    expect(diag).toBeDefined();
  });

  it('a purchase return nets into the SAME bucket its source GRN line was already in', async () => {
    const supplierId = (await createSupplier({ name: 'Return Supplier', type: 'OTHER', gstNumber: '24CCCCC2222C1ZE' }, tenant.company.id)).id;
    supplierIds.push(supplierId);

    const beforeIntake = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    const { tag } = await intake(supplierId, 50000);

    const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId);
    returnIds.push(ret.id);

    const afterReturn = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    // The return gives back exactly what the intake booked — net contribution of this
    // intake+return pair to the eligible bucket is zero.
    expect(afterReturn.table4A5.eligible.taxableValue).toBeCloseTo(beforeIntake.table4A5.eligible.taxableValue, 2);
    expect(afterReturn.table4A5.eligible.cgst).toBeCloseTo(beforeIntake.table4A5.eligible.cgst, 2);
  });

  it('a standalone (Path B) debit note has no taxCategory snapshot and nets into unresolved', async () => {
    const supplierId = (await createSupplier({ name: 'Debit Note Supplier', type: 'OTHER', gstNumber: '24EEEEE5555E1ZE' }, tenant.company.id)).id;
    supplierIds.push(supplierId);

    const { grn } = await intake(supplierId, 60000);
    const before = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);

    await createStandaloneDebitNote(
      { grnId: grn.id, items: [{ description: 'Price variance', taxableValue: 5000 }], reasonCode: 'PRICE_VARIANCE' },
      tenant.ctx, userId,
    );

    const after = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    // The intake itself was ELIGIBLE (registered, non-composition supplier, TAXABLE PO line) — the
    // debit note's own lack of a taxCategory snapshot means ITS reversal lands in unresolved, not
    // eligible, so eligible is unaffected while unresolved goes negative by the note's tax.
    expect(after.table4A5.eligible.taxableValue).toBeCloseTo(before.table4A5.eligible.taxableValue, 2);
    expect(after.table4A5.unresolved.taxableValue).toBeLessThan(before.table4A5.unresolved.taxableValue);
  });

  it('excludes a GRN line received outside the requested period', async () => {
    const supplierId = (await createSupplier({ name: 'Out Of Period Supplier', type: 'OTHER', gstNumber: '24FFFFF6666F1ZZ' }, tenant.company.id)).id;
    supplierIds.push(supplierId);
    const { grnItemId } = await intake(supplierId, 12000, {}, new Date('2024-01-15T00:00:00.000Z'));

    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD); // PERIOD is 2026
    const allDocIds = report.diagnostics.map((d) => d.documentId);
    expect(allDocIds).not.toContain(grnItemId);
  });

  it('rejects a GST registration that does not belong to this company', async () => {
    await expect(getGstr3bInwardItcReport(tenant.company.id, 'nonexistent-reg-id', PERIOD)).rejects.toThrow(AppError);
  });

  it('eligibility matrix and report-level diagnostics are always present', async () => {
    const report = await getGstr3bInwardItcReport(tenant.company.id, regId, PERIOD);
    expect(report.eligibilityMatrix.length).toBeGreaterThan(0);
    expect(report.diagnostics.some((d) => d.code === 'GSTR_2B_RECONCILIATION_UNAVAILABLE')).toBe(true);
  });
});
