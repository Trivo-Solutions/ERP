import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { importGstr2bStatement } from './gstr2bImport.service';
import { getGstr2bReconciliationReport } from './gstr2bReconciliation.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

describe('G2g-7e: getGstr2bReconciliationReport (end-to-end against real GRN/book data)', () => {
  const suffix = `g7ercn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];

  async function intake(invoiceNumber: string, invoiceDate: Date, price: number) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: invoiceDate,
      items: [{ materialCode: 'G7E-RCN-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price }],
    }, A.ctx, A.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: invoiceDate, invoiceNumber, invoiceDate, branchId: A.branch.id,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, A.ctx, A.user.id);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'ring', metalType: 'GOLD' }, A.ctx, A.user.id);
    tagIds.push(tag.id);
    return grn;
  }

  function twoBPayload(gstin: string, taxPeriod: string, supplierGstin: string, invoiceNumber: string, invoiceDate: Date, taxableValue: number) {
    const dd = String(invoiceDate.getUTCDate()).padStart(2, '0');
    const mm = String(invoiceDate.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = invoiceDate.getUTCFullYear();
    return {
      gstin, fp: taxPeriod,
      data: {
        gstin, rtnprd: taxPeriod,
        docdata: { b2b: [{ ctin: supplierGstin, trdnm: 'Rcn Supplier', inv: [{ inum: invoiceNumber, dt: `${dd}-${mm}-${yyyy}`, itms: [{ txval: taxableValue, iamt: Math.round(taxableValue * 0.03) }] }] }] },
      },
    };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7ER${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7ERC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7ER-SUP-${suffix}`, name: 'Rcn Supplier', type: 'OTHER', gstNumber: '27RCNSUP000R1Z1' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA2000A1Z5', legalName: 'G2g7e Rcn Co', stateCode: '24' });
    registrationId = reg.id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.gst2bDocument.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.deleteMany({ where: { companyId: A.company.id } }));
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

  it('reports every book document as BOOK_MISSING when no GSTR-2B statement has been imported yet', async () => {
    const invoiceDate = new Date('2026-04-05');
    await intake('RCN/NOSTMT', invoiceDate, 10000);
    const report = await getGstr2bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '042026' });
    expect(report.diagnostics.some((d) => d.code === 'NO_STATEMENT_IMPORTED')).toBe(true);
    expect(report.matches.some((m) => m.status === 'BOOK_MISSING' && m.documentNumber === 'RCN/NOSTMT')).toBe(true);
  });

  it('EXACT_MATCHes a book GRN against an imported statement for the same supplier/invoice/date/amount', async () => {
    const invoiceDate = new Date('2026-05-10');
    await intake('RCN/001', invoiceDate, 100000);
    await importGstr2bStatement(
      A.ctx,
      { gstRegistrationId: registrationId, rawPayload: twoBPayload('24AAAAA2000A1Z5', '052026', '27RCNSUP000R1Z1', 'RCN/001', invoiceDate, 100000), rawBytes: Buffer.from('x') },
      A.user.id,
    );

    const report = await getGstr2bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '052026' });
    const m = report.matches.find((x) => x.documentNumber === 'RCN/001');
    expect(m?.status).toBe('EXACT_MATCH');
    expect(report.diagnostics.some((d) => d.code === 'GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY')).toBe(true);
  });

  it('reports TWO_B_MISSING for a 2B document whose supplier never actually billed this company (per books)', async () => {
    const invoiceDate = new Date('2026-06-10');
    await importGstr2bStatement(
      A.ctx,
      { gstRegistrationId: registrationId, rawPayload: twoBPayload('24AAAAA2000A1Z5', '062026', '27RCNSUP000R1Z1', 'RCN/GHOST', invoiceDate, 50000), rawBytes: Buffer.from('y') },
      A.user.id,
    );
    const report = await getGstr2bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '062026' });
    expect(report.matches.some((m) => m.status === 'TWO_B_MISSING' && m.documentNumber === 'RCN/GHOST')).toBe(true);
  });

  it('404s on a cross-company / nonexistent registration id', async () => {
    await expect(getGstr2bReconciliationReport(A.company.id, { gstRegistrationId: 'does-not-exist', taxPeriod: '062026' })).rejects.toThrow();
  });

  it('400s when taxPeriod is missing', async () => {
    await expect(getGstr2bReconciliationReport(A.company.id, { gstRegistrationId: registrationId, taxPeriod: '' })).rejects.toThrow();
  });
});
