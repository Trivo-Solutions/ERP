import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstr3bFilingSnapshot } from './gstr3bFilingSnapshot.service';
import { createGstr3bFilingAttempt, recordGstr3bFilingAttemptOutcome } from './gstr3bFilingAttempt.service';
import { fileGstr3bReturnPeriod, lockGstr3bReturnPeriod } from './gstr3bFilingPeriod.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

// G2g-7g — fileGstr3bReturnPeriod / lockGstr3bReturnPeriod: the full snapshot -> attempt -> ACCEPTED
// -> FILED -> LOCKED lifecycle over real GSTR3B-typed rows. Proves the lifecycle machinery works end
// to end for the one scenario this codebase CAN resolve today (no automatic FILED state — a FILED
// boundary only ever follows an explicit ACCEPTED attempt, never snapshot/attempt creation alone).
describe('G2g-7g: GSTR-3B period file/lock lifecycle', () => {
  const suffix = `g7gper${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let clientId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const invoiceIds: string[] = [];

  async function intake(invoiceNumber: string, invoiceDate: Date, price: number) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: invoiceDate,
      items: [{ materialCode: 'G7G-PER-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price }],
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

  async function readyPeriod(taxPeriod: string, invoiceDate: Date, saleDate: Date) {
    const { tag } = await intake(`G7G/PER/${taxPeriod}`, invoiceDate, 100000);
    await sellTag(tag.id, 150000, saleDate);
    const snapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod }, A.user.id);
    expect(snapshot.status).toBe('DRAFT');
    return snapshot;
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view', 'invoice:create']);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7GP${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7GPC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7GP-SUP-${suffix}`, name: 'Per Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA7000A1Z5', legalName: 'G2g7g Per Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-G7GP-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.updateMany({ where: { companyId: A.company.id }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
    await tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { companyId: A.company.id } }));
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

  it('cannot establish FILED from an attempt that is not ACCEPTED', async () => {
    const snapshot = await readyPeriod('092026', new Date('2026-09-05'), new Date('2026-09-20T12:00:00.000Z'));
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId: snapshot.id, mode: 'MANUAL_EXPORT' }, A.user.id);
    await expect(fileGstr3bReturnPeriod(A.ctx, { attemptId: attempt.id }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('no automatic FILED state: creating a snapshot or an attempt alone never advances the period to FILED', async () => {
    const period = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.findFirst({ where: { companyId: A.company.id, gstRegistrationId: registrationId, returnType: 'GSTR3B', taxPeriod: '092026' } }));
    expect(period!.status).toBe('SNAPSHOT_CREATED'); // not FILED, despite a snapshot AND an attempt already existing from the prior test
  });

  it('the full lifecycle: ACCEPTED attempt -> file -> FILED -> lock -> LOCKED', async () => {
    const snapshot = await readyPeriod('102026', new Date('2026-10-05'), new Date('2026-10-20T12:00:00.000Z'));
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '102026', snapshotId: snapshot.id, mode: 'MANUAL_EXPORT' }, A.user.id);
    await recordGstr3bFilingAttemptOutcome(A.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED' }, A.user.id);

    const filed = await fileGstr3bReturnPeriod(A.ctx, { attemptId: attempt.id }, A.user.id);
    expect(filed.status).toBe('FILED');
    expect(filed.filedSnapshotId).toBe(snapshot.id);
    expect(filed.filedByAttemptId).toBe(attempt.id);
    expect(filed.filedAt).not.toBeNull();

    // Filing twice is refused.
    await expect(fileGstr3bReturnPeriod(A.ctx, { attemptId: attempt.id }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    // A new snapshot can no longer be created for a FILED period.
    await expect(createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '102026' }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });

    const locked = await lockGstr3bReturnPeriod(A.ctx, { periodId: filed.id }, A.user.id);
    expect(locked.status).toBe('LOCKED');
    expect(locked.lockedAt).not.toBeNull();

    // Locking twice, or locking a non-FILED period, are both refused.
    await expect(lockGstr3bReturnPeriod(A.ctx, { periodId: filed.id }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('cannot lock a period that has never been FILED', async () => {
    const snapshot = await readyPeriod('112026', new Date('2026-11-05'), new Date('2026-11-20T12:00:00.000Z'));
    await expect(lockGstr3bReturnPeriod(A.ctx, { periodId: snapshot.returnPeriodId }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records GSTR3B_PERIOD_FILED and GSTR3B_PERIOD_LOCKED audit entries (not the GSTR1-named ones)', async () => {
    const snapshot = await readyPeriod('122026', new Date('2026-12-05'), new Date('2026-12-20T12:00:00.000Z'));
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '122026', snapshotId: snapshot.id, mode: 'MANUAL_EXPORT' }, A.user.id);
    await recordGstr3bFilingAttemptOutcome(A.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED' }, A.user.id);
    const filed = await fileGstr3bReturnPeriod(A.ctx, { attemptId: attempt.id }, A.user.id);
    await lockGstr3bReturnPeriod(A.ctx, { periodId: filed.id }, A.user.id);

    const entries = await prisma.auditLog.findMany({ where: { tableName: 'gst_return_periods', recordId: filed.id } });
    expect(entries.some((e) => e.action === 'GSTR3B_PERIOD_FILED')).toBe(true);
    expect(entries.some((e) => e.action === 'GSTR3B_PERIOD_LOCKED')).toBe(true);
    expect(entries.some((e) => e.action === 'GSTR1_PERIOD_FILED')).toBe(false);
  });

  it('a cross-company attemptId/periodId is a 404', async () => {
    await expect(fileGstr3bReturnPeriod(A.ctx, { attemptId: 'does-not-exist' }, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(lockGstr3bReturnPeriod(A.ctx, { periodId: 'does-not-exist' }, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
