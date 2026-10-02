import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../../shared/constants';
import { createGstRegistration } from '../../company/company.service';
import { createPO, createGRN } from '../../procurement/procurement.service';
import { createTagFromGrnItem } from '../../tagging/tagging.service';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstr3bFilingSnapshot } from './gstr3bFilingSnapshot.service';
import { createGstr3bFilingAttempt, recordGstr3bFilingAttemptOutcome, listGstr3bFilingAttempts } from './gstr3bFilingAttempt.service';
import { cleanupJournalEntries } from '../../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

// G2g-7g — createGstr3bFilingAttempt / recordGstr3bFilingAttemptOutcome / listGstr3bFilingAttempts
// against real GSTR3B-typed GstReturnPeriod/GstFilingSnapshot rows.
describe('G2g-7g: GSTR-3B filing attempts', () => {
  const suffix = `g7gatt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let clientId: string;
  let readySnapshotId: string;
  let blockedSnapshotId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const invoiceIds: string[] = [];

  async function intake(invoiceNumber: string, invoiceDate: Date, price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: invoiceDate,
      items: [{ materialCode: 'G7G-ATT-RING', materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...lineExtra }],
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
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `G7GA${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `G7GAC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: A.company.id, supplierCode: `G7GA-SUP-${suffix}`, name: 'Att Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA6000A1Z5', legalName: 'G2g7g Att Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-G7GA-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;

    const { tag } = await intake('G7G/ATT/001', new Date('2026-09-05'), 100000);
    await sellTag(tag.id, 150000, new Date('2026-09-20T12:00:00.000Z'));
    const readySnapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '092026' }, A.user.id);
    readySnapshotId = readySnapshot.id;
    expect(readySnapshot.status).toBe('DRAFT');

    await intake('G7G/ATT/002', new Date('2026-10-05'), 20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
    const blockedSnapshot = await createGstr3bFilingSnapshot(A.ctx, { gstRegistrationId: registrationId, taxPeriod: '102026' }, A.user.id);
    blockedSnapshotId = blockedSnapshot.id;
    expect(blockedSnapshot.status).toBe('BLOCKED');
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

  it('refuses to attempt against a BLOCKED snapshot (409) — a not-filing-ready period can never be attempted', async () => {
    await expect(createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '102026', snapshotId: blockedSnapshotId, mode: 'MANUAL_EXPORT' }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an invalid mode', async () => {
    await expect(createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId: readySnapshotId, mode: 'CARRIER_PIGEON' }, A.user.id)).rejects.toThrow();
  });

  it('creates attempt #1 against the DRAFT snapshot, with the snapshot\'s own wireJsonHash as payloadHash', async () => {
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId: readySnapshotId, mode: 'MANUAL_EXPORT' }, A.user.id);
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe('ATTEMPTED');
    const snapshot = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.findUnique({ where: { id: readySnapshotId } }));
    expect(attempt.payloadHash).toBe(snapshot!.wireJsonHash);

    const list = await listGstr3bFilingAttempts(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026' });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(attempt.id);
  });

  it('a REJECTED outcome is terminal — re-recording any outcome on it is refused (409), attempt history is immutable', async () => {
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId: readySnapshotId, mode: 'MANUAL_EXPORT' }, A.user.id);
    const rejected = await recordGstr3bFilingAttemptOutcome(A.ctx, { attemptId: attempt.id, outcome: 'REJECTED', errorCode: 'E1', errorMessage: 'portal rejected' }, A.user.id);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.errorCode).toBe('E1');

    await expect(recordGstr3bFilingAttemptOutcome(A.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED' }, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an ACCEPTED outcome records filedAt and a verbatim external ARN, never a generated one', async () => {
    const attempt = await createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId: readySnapshotId, mode: 'MANUAL_UPLOAD' }, A.user.id);
    const accepted = await recordGstr3bFilingAttemptOutcome(A.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED', arn: 'AA240900000001A' }, A.user.id);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.arn).toBe('AA240900000001A');
    expect(accepted.filedAt).not.toBeNull();
  });

  it('attempt numbers increment per return period, never reset', async () => {
    const list = await listGstr3bFilingAttempts(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026' });
    const numbers = list.map((a) => a.attemptNumber);
    expect(new Set(numbers).size).toBe(numbers.length); // all unique
    expect(Math.max(...numbers)).toBe(numbers.length);
  });

  it('a registration with no return period for this FY/taxPeriod yet returns an empty list, not a 404', async () => {
    const list = await listGstr3bFilingAttempts(A.ctx, { gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '012020' });
    expect(list).toEqual([]);
  });

  it('a cross-company registration id is a 404', async () => {
    await expect(createGstr3bFilingAttempt(A.ctx, { gstRegistrationId: 'does-not-exist', financialYear: '2026-27', taxPeriod: '092026', snapshotId: readySnapshotId, mode: 'MANUAL_EXPORT' }, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
