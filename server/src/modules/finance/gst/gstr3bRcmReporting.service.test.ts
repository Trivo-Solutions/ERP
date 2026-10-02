import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { markRcmLiabilityPaid } from './gstr3bRcmBooking.service';
import { getGstr3bRcmReport } from './gstr3bRcmReporting.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

// G2g-7d — end-to-end: getGstr3bRcmReport against real RcmLiability rows produced by the booking
// hook (not just the pure aggregator's synthetic fixtures in gstr3bRcmAggregation.test.ts).
describe('G2g-7d: getGstr3bRcmReport (end-to-end against real RcmLiability rows)', () => {
  const suffix = `g7drpt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];

  async function intake(price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: new Date(),
      items: [{ materialCode: 'G7D-RPT-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...lineExtra }],
    }, A.ctx, A.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId: A.branch.id,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, A.ctx, A.user.id);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'ring', metalType: 'GOLD' }, A.ctx, A.user.id);
    tagIds.push(tag.id);
    return { grnItemId: grn.grnItems[0].id };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7DR${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7DRC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7DR-SUP-${suffix}`, name: 'Rpt Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA1000A1Z5', legalName: 'G2g7d Rpt Co', stateCode: '24' });
    registrationId = reg.id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.selfInvoice.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.rcmLiability.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: A.user.id } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  it('reports an ordinary (rcmCategory NONE) line as nothing — zero RCM liability/ITC', async () => {
    await intake(10000);
    const report = await getGstr3bRcmReport(A.company.id, registrationId, { from: new Date('2000-01-01'), to: new Date('2100-01-01') });
    expect(report.table3_1d.recognized.taxableValue).toBe(0);
  });

  it('reports an RCM_APPLICABLE, unpaid line as recognized liability + unresolved ITC', async () => {
    await intake(20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
    const report = await getGstr3bRcmReport(A.company.id, registrationId, { from: new Date('2000-01-01'), to: new Date('2100-01-01') });
    expect(report.table3_1d.recognized.taxableValue).toBeGreaterThanOrEqual(20000);
    expect(report.table4A3.eligible.taxableValue).toBe(0);
    expect(report.diagnostics.some((d) => d.code === 'RCM_PAYMENT_NOT_RECORDED')).toBe(true);
  });

  it('moves the amount into ELIGIBLE ITC once the liability is marked paid', async () => {
    const { grnItemId } = await intake(5000, { rcmCategory: 'LEGAL_SERVICES', taxRate: 0 });
    const liability = await tenantQuery(A.company.id, (tx) => tx.rcmLiability.findFirstOrThrow({ where: { companyId: A.company.id, grnItemId } }));
    await markRcmLiabilityPaid(A.ctx, liability.id, { paymentDate: new Date(), mode: 'CASH' }, A.user.id);

    const report = await getGstr3bRcmReport(A.company.id, registrationId, { from: new Date('2000-01-01'), to: new Date('2100-01-01') });
    expect(report.table4A3.eligible.taxableValue).toBeGreaterThanOrEqual(5000);
  });

  it('always reports the standing capability-gap diagnostics', async () => {
    const report = await getGstr3bRcmReport(A.company.id, registrationId, { from: new Date('2000-01-01'), to: new Date('2100-01-01') });
    const codes = report.diagnostics.map((d) => d.code);
    expect(codes).toContain('RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE');
    expect(codes).toContain('RCM_SECTION_17_5_NOT_DETERMINABLE');
    expect(codes).toContain('GSTR_2B_RCM_RECONCILIATION_UNAVAILABLE');
  });

  it('404s on a cross-company / nonexistent registration id', async () => {
    await expect(getGstr3bRcmReport(A.company.id, 'does-not-exist', { from: new Date('2000-01-01'), to: new Date('2100-01-01') })).rejects.toThrow();
  });
});
