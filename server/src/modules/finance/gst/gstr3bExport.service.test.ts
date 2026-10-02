import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { buildGstr3bGstnExport } from './gstr3bExport.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

// G2g-7g — end-to-end: buildGstr3bGstnExport composes the frozen G2g-7f report through the real
// outward/ITC/RCM pipeline (PO -> GRN -> tag -> retail sale, same fixture pattern as
// gstr3bReconciliation.service.test.ts) and proves the export DTO + validator reflect real data —
// not the frozen engines' own business rules (fully covered by their own suites).
describe('G2g-7g: buildGstr3bGstnExport (end-to-end against real composed data)', () => {
  const suffix = `g7gexp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let clientId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const invoiceIds: string[] = [];

  async function intake(invoiceNumber: string, invoiceDate: Date, price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: invoiceDate,
      items: [{ materialCode: 'G7G-EXP-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...lineExtra }],
    }, A.ctx, A.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: invoiceDate, invoiceNumber, invoiceDate, branchId: A.branch.id,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, A.ctx, A.user.id);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'ring', metalType: 'GOLD' }, A.ctx, A.user.id);
    tagIds.push(tag.id);
    return { grn, tag };
  }

  async function sellTag(tagId: string, price: number) {
    const invoice = await _createInvoice({
      branchId: A.branch.id, clientId, invoiceDate: new Date('2026-09-20T12:00:00.000Z'), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 8, netGoldWeight: 8, rateType: 'FIXED', goldRate: price, tagId }],
    }, A.ctx, A.user.id);
    invoiceIds.push(invoice.id);
    return invoice;
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view', 'invoice:create']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7GE${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7GEC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7GE-SUP-${suffix}`, name: 'Exp Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA4000A1Z5', legalName: 'G2g7g Exp Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-G7G-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.selfInvoice.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.rcmLiability.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupJournalEntries([...tagIds, ...invoiceIds]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: A.user.id } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  it('a period with fully-resolved book data (no RCM) produces a filing-ready export', async () => {
    const invoiceDate = new Date('2026-09-05');
    const { tag } = await intake('G7G/INV/001', invoiceDate, 100000);
    await sellTag(tag.id, 150000);

    const result = await buildGstr3bGstnExport(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);

    expect(result.export.table31.outwardTaxableOther.amounts!.taxableValue).toBeGreaterThanOrEqual(150000 / 1.03 - 1);
    expect(result.export.table4.table4A.allOtherItc.eligible.taxableValue).toBeGreaterThanOrEqual(100000);
    expect(result.export.table4.table4A.allOtherItc.unresolved).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.validation.isFilingReady).toBe(true);
    expect(result.validation.blockers).toEqual([]);
    expect(result.validation.informational.some((i) => i.code === 'STATUTORY_POSITION_NOT_DETERMINABLE')).toBe(true);
  });

  it('a period with an RCM-tagged intake (0% rate) produces unresolved RCM ITC — never silently promoted to eligible — and blocks filing readiness', async () => {
    const invoiceDate = new Date('2026-10-05');
    await intake('G7G/INV/002', invoiceDate, 20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });

    const result = await buildGstr3bGstnExport(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '102026' }, A.user.id);

    expect(result.export.table4.table4A.inwardReverseCharge.unresolved.taxableValue).toBeGreaterThanOrEqual(20000);
    expect(result.export.table4.table4A.inwardReverseCharge.eligible).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect(result.validation.isFilingReady).toBe(false);
    expect(result.validation.blockers.map((b) => b.code)).toContain('UNRESOLVED_RCM_ITC');
  });

  it('never exposes a field literally named finalTaxLiability', async () => {
    const result = await buildGstr3bGstnExport(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);
    expect(JSON.stringify(result.export)).not.toContain('finalTaxLiability');
  });

  it('records an audit entry distinguishing filing-ready vs. not-filing-ready exports', async () => {
    await buildGstr3bGstnExport(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);
    const entries = await prisma.auditLog.findMany({ where: { tableName: 'company_gst_registrations', recordId: registrationId, userId: A.user.id }, orderBy: { timestamp: 'desc' }, take: 1 });
    expect(['GSTR3B_GSTN_EXPORT', 'GSTR3B_GSTN_EXPORT_NOT_FILING_READY']).toContain(entries[0].action);
  });

  it('404s on a cross-company / nonexistent registration id (delegated to the frozen G2g-7f report)', async () => {
    await expect(buildGstr3bGstnExport(A.ctx, { gstRegistrationId: 'does-not-exist', taxPeriod: '092026' }, A.user.id)).rejects.toThrow();
  });
});
