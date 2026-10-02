import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { importGstr2bStatement } from './gstr2bImport.service';
import { getGstr3bReconciliationReport } from './gstr3bReconciliation.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../../test/fixtures';

// G2g-7f — end-to-end: getGstr3bReconciliationReport composes real outward (G2g-7b), book ITC
// (G2g-7c), RCM (G2g-7d), and GSTR-2B (G2g-7e) data for one registration/period. Does not
// re-exercise any of those four engines' own business rules (fully covered by their own frozen test
// suites) — only that the composition wires them together correctly against real rows, and that
// registration/branch security and period validation are enforced at this new layer too.
describe('G2g-7f: getGstr3bReconciliationReport (end-to-end against real composed data)', () => {
  const suffix = `g7frpt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
      items: [{ materialCode: 'G7F-RPT-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...lineExtra }],
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

  function twoBPayload(gstin: string, taxPeriod: string, supplierGstin: string, invoiceNumber: string, invoiceDate: Date, taxableValue: number) {
    const dd = String(invoiceDate.getUTCDate()).padStart(2, '0');
    const mm = String(invoiceDate.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = invoiceDate.getUTCFullYear();
    return {
      gstin, fp: taxPeriod,
      data: {
        gstin, rtnprd: taxPeriod,
        docdata: { b2b: [{ ctin: supplierGstin, trdnm: 'Rpt Supplier', inv: [{ inum: invoiceNumber, dt: `${dd}-${mm}-${yyyy}`, itms: [{ txval: taxableValue, iamt: Math.round(taxableValue * 0.03) }] }] }] },
      },
    };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view', 'invoice:create']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7FR${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7FRC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7FR-SUP-${suffix}`, name: 'Rpt Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA3000A1Z5', legalName: 'G2g7f Rpt Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-G7F-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.gst2bDocument.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.deleteMany({ where: { companyId: A.company.id } }));
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

  it('composes outward + book ITC + RCM + GSTR-2B into one report for a period with real data in all four', async () => {
    const invoiceDate = new Date('2026-09-05');
    const { tag: eligibleTag } = await intake('G7F/INV/001', invoiceDate, 100000);
    await intake('G7F/INV/002', invoiceDate, 20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
    await sellTag(eligibleTag.id, 150000);
    await importGstr2bStatement(
      A.ctx,
      { gstRegistrationId: registrationId, rawPayload: twoBPayload('24AAAAA3000A1Z5', '092026', '24AAAAA0000A1Z8', 'G7F/INV/001', invoiceDate, 100000), rawBytes: Buffer.from('x') },
      A.user.id,
    );

    const report = await getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '092026' });

    // Outward (G2g-7b) — the sale is reflected.
    expect(report.outwardLiability.report.table31.table31a.taxableValue).toBeGreaterThanOrEqual(150000 / 1.03 - 1);
    // Book ITC (G2g-7c) — the ordinary intake is eligible.
    expect(report.inputTaxCredit.book.table4A5.eligible.taxableValue).toBeGreaterThanOrEqual(100000);
    // RCM (G2g-7d) — the RCM-flagged intake is recognized as a liability, unresolved ITC (unpaid).
    expect(report.reverseCharge.report.table3_1d.recognized.taxableValue).toBeGreaterThanOrEqual(20000);
    expect(report.reverseCharge.report.table4A3.unresolved.taxableValue).toBeGreaterThanOrEqual(20000);
    // GSTR-2B reconciliation (G2g-7e) — the imported statement matches the first GRN.
    expect(report.twoBReconciliation.statementAvailable).toBe(true);
    expect(report.twoBReconciliation.report.summary.exactMatch).toBeGreaterThanOrEqual(1);
    // Composed presentation — 4(A)(5)/4(A)(3) reused verbatim, 4(C) nets only the supported eligible buckets.
    expect(report.inputTaxCredit.presentation.table4A.allOtherItc.eligible).toEqual(report.inputTaxCredit.book.table4A5.eligible);
    expect(report.inputTaxCredit.presentation.table4C.netItcAvailable.taxableValue).toBeGreaterThanOrEqual(100000);
    // Matrix: at least one MATCHED_* bucket present from the imported statement.
    expect(report.twoBReconciliation.matrix.some((m) => m.category.startsWith('MATCHED'))).toBe(true);
  });

  it('filing status is NOT_STARTED — no GSTR-3B return period has ever been created by any service', async () => {
    const report = await getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(report.filingStatus.status).toBe('NOT_STARTED');
    expect(report.filingStatus.periodId).toBeNull();
    expect(report.diagnostics.some((d) => d.code === 'FILING_PERIOD_NOT_STARTED')).toBe(true);
  });

  it('never claims a statutory filing position — bookPosition and statutoryReportingPosition stay distinct', async () => {
    const report = await getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(report.summary.statutoryReportingPosition.status).toBe('NOT_DETERMINABLE');
    expect(typeof report.summary.bookPosition.estimatedNetPosition).toBe('number');
  });

  it('404s on a cross-company / nonexistent registration id', async () => {
    await expect(getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: 'does-not-exist', taxPeriod: '092026' })).rejects.toThrow();
  });

  it('400s without a taxPeriod', async () => {
    // @ts-expect-error — intentionally omitting a required field to prove the runtime guard
    await expect(getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: registrationId })).rejects.toThrow();
  });

  it('a report for an empty period reports zeroed sections, not a crash', async () => {
    const report = await getGstr3bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '012020' });
    expect(report.outwardLiability.report.table31.table31a.taxableValue).toBe(0);
    expect(report.inputTaxCredit.book.table4A5.eligible.taxableValue).toBe(0);
    expect(report.twoBReconciliation.statementAvailable).toBe(false);
  });
});
