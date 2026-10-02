import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstr3bFilingSnapshot } from './gstr3bFilingSnapshot.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

// G2g-7g — createGstr3bFilingSnapshot against real data: GSTR3B return type, version allocation,
// supersede-on-recreate, BLOCKED vs DRAFT status, and the terminal-period (FILED/LOCKED) guard.
describe('G2g-7g: createGstr3bFilingSnapshot', () => {
  const suffix = `g7gsnp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
      items: [{ materialCode: 'G7G-SNP-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...lineExtra }],
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

  async function sellTag(tagId: string, price: number, invoiceDate: Date) {
    const invoice = await _createInvoice({
      branchId: A.branch.id, clientId, invoiceDate, invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 8, netGoldWeight: 8, rateType: 'FIXED', goldRate: price, tagId }],
    }, A.ctx, A.user.id);
    invoiceIds.push(invoice.id);
    return invoice;
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view', 'invoice:create']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7GS${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7GSC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7GS-SUP-${suffix}`, name: 'Snp Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA5000A1Z5', legalName: 'G2g7g Snp Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-G7GS-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { companyId: A.company.id } }));
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

  it('gstRegistrationId/taxPeriod are required', async () => {
    // @ts-expect-error — intentionally omitting required fields
    await expect(createGstr3bFilingSnapshot(A.ctx, { taxPeriod: '092026' }, A.user.id)).rejects.toThrow();
    await expect(createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '' }, A.user.id)).rejects.toThrow();
  });

  it('creates a DRAFT snapshot (version 1) under returnType GSTR3B for a fully-resolved period, and moves the period OPEN -> SNAPSHOT_CREATED', async () => {
    const invoiceDate = new Date('2026-09-05');
    const { tag } = await intake('G7G/SNP/001', invoiceDate, 100000);
    await sellTag(tag.id, 150000, new Date('2026-09-20T12:00:00.000Z'));

    const snapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);
    expect(snapshot.version).toBe(1);
    expect(snapshot.status).toBe('DRAFT');
    expect(snapshot.isFilingReady).toBe(true);
    expect(snapshot.serializerVersion).toBe('g2g-7g-1');

    const period = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.findUnique({ where: { id: snapshot.returnPeriodId } }));
    expect(period!.returnType).toBe('GSTR3B');
    expect(period!.status).toBe('SNAPSHOT_CREATED');
  });

  it('a second snapshot for the same period gets version 2 and supersedes the first', async () => {
    const snapshot2 = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);
    expect(snapshot2.version).toBe(2);

    const snapshots = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.findMany({ where: { returnPeriodId: snapshot2.returnPeriodId }, orderBy: { version: 'asc' } }));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].status).toBe('SUPERSEDED');
    expect(snapshots[1].status).toBe('DRAFT');
  });

  it('a period with unresolved RCM data produces a BLOCKED snapshot, never DRAFT', async () => {
    await intake('G7G/SNP/002', new Date('2026-10-05'), 20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
    const snapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '102026' }, A.user.id);
    expect(snapshot.status).toBe('BLOCKED');
    expect(snapshot.isFilingReady).toBe(false);
    expect(snapshot.blockers.some((b) => b.code === 'UNRESOLVED_RCM_ITC')).toBe(true);
  });

  it('refuses (409) to create a new snapshot once the return period is FILED/LOCKED, without persisting anything', async () => {
    const snapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '112026' }, A.user.id);
    await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: snapshot.returnPeriodId }, data: { status: 'FILED' } }));

    const before = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { returnPeriodId: snapshot.returnPeriodId } }));
    await expect(createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '112026' }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    const after = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { returnPeriodId: snapshot.returnPeriodId } }));
    expect(after).toBe(before);
  });

  it('records a GSTR3B_FILING_SNAPSHOT_CREATED audit entry', async () => {
    const snapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '122026' }, A.user.id);
    const entries = await prisma.auditLog.findMany({ where: { tableName: 'gst_filing_snapshots', recordId: snapshot.id } });
    expect(entries.some((e) => e.action === 'GSTR3B_FILING_SNAPSHOT_CREATED')).toBe(true);
  });
});
