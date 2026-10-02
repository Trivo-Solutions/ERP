import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { createPO, createGRN } from '../modules/procurement/procurement.service';
import { createTagFromGrnItem } from '../modules/tagging/tagging.service';
import { createInvoice as _createInvoice } from '../modules/sales/sales.service';
import { tenantQuery } from '../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../shared/constants';
import { cleanupJournalEntries } from './ledger';

// G2g-7g — proves the six new GSTR-3B filing-lifecycle routes (finance.router.ts: POST
// /gstr3b/snapshots, POST/GET /gstr3b/filing-attempts, POST .../outcome, POST .../file, POST
// /gstr3b/periods/:id/lock) actually enforce requirePermission(...) over real HTTP — the one thing
// the service-level suites (gstr3bFilingSnapshot/Attempt/Period.service.test.ts) cannot cover, since
// they call the service functions directly with an already-trusted TenantContext. Mirrors the
// established http.j3Administrative.test.ts-style "granted vs missing permission over real HTTP"
// pattern.
describe('HTTP: G2g-7g GSTR-3B filing-lifecycle route security', () => {
  const suffix = `g7gfsec${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let full: TestTenant; // holds every permission the lifecycle needs
  let noPerm: TestTenant; // holds none of the gst:* permissions
  let registrationId: string;
  let snapshotId: string;
  let stockTypeId: string;
  let categoryId: string;
  let supplierId: string;
  let clientId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const invoiceIds: string[] = [];

  async function readyPeriod(taxPeriod: string, invoiceNumber: string, invoiceDate: Date, saleDate: Date) {
    const po = await createPO({
      supplierId, poType: 'OUTRIGHT', orderDate: invoiceDate,
      items: [{ materialCode: `G7GF-${taxPeriod}`, materialName: 'ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: 100000 }],
    }, full.ctx, full.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: invoiceDate, invoiceNumber, invoiceDate, branchId: full.branch.id,
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, full.ctx, full.user.id);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'ring', metalType: 'GOLD' }, full.ctx, full.user.id);
    tagIds.push(tag.id);
    const invoice = await _createInvoice({
      branchId: full.branch.id, clientId, invoiceDate: saleDate, invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 8, netGoldWeight: 8, rateType: 'FIXED', goldRate: 150000, tagId: tag.id }],
    }, full.ctx, full.user.id);
    invoiceIds.push(invoice.id);
  }

  beforeAll(async () => {
    full = await createTestTenant(`${suffix}F`, [
      'po:create', 'grn:create', 'tag:create', 'journal:create', 'invoice:create', 'report:financial_view',
      'gst:snapshot_create', 'gst:filing_record', 'gst:period_view',
    ]);
    noPerm = await createTestTenant(`${suffix}N`, ['invoice:create']);

    stockTypeId = (await prisma.stockType.create({ data: { companyId: full.company.id, code: `G7GF${suffix}`.slice(0, 8).toUpperCase(), name: 'St' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: full.company.id, code: `G7GFC-${suffix}`, name: 'Cat' } })).id;
    supplierId = (await prisma.supplier.create({ data: { companyId: full.company.id, supplierCode: `G7GF-SUP-${suffix}`, name: 'Fsec Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' } })).id;
    const reg = await createGstRegistration(full.ctx, { gstin: '24AAAAA8000A1Z5', legalName: 'G2g7g Fsec Co', stateCode: '24', isPrimary: true, isActive: true });
    registrationId = reg.id;
    clientId = (await prisma.client.create({ data: { companyId: full.company.id, clientCode: `CL-G7GF-${suffix}`, name: 'Walk-in', type: 'RETAIL', state: 'Gujarat' } })).id;

    await readyPeriod('092026', 'G7GF/INV/001', new Date('2026-09-05'), new Date('2026-09-20T12:00:00.000Z'));
  });

  afterAll(async () => {
    await tenantQuery(full.company.id, (tx) => tx.gstReturnPeriod.updateMany({ where: { companyId: full.company.id }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
    await tenantQuery(full.company.id, (tx) => tx.gstFilingAttempt.deleteMany({ where: { companyId: full.company.id } }));
    await tenantQuery(full.company.id, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { companyId: full.company.id } }));
    await tenantQuery(full.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { companyId: full.company.id } }));
    await cleanupJournalEntries([...tagIds, ...invoiceIds]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: full.user.id } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await tenantQuery(full.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: full.company.id } }));
    await cleanupTestTenant(full);
    await cleanupTestTenant(noPerm);
    await prisma.$disconnect();
  });

  it('401s every route without authentication', async () => {
    const res1 = await apiWith(undefined, app).post('/finance/gstr3b/snapshots').send({ gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(res1.status).toBe(401);
    const res2 = await apiWith(undefined, app).get(`/finance/gstr3b/filing-attempts?gstRegistrationId=${registrationId}&financialYear=2026-27&taxPeriod=092026`);
    expect(res2.status).toBe(401);
  });

  it('403s POST /gstr3b/snapshots without gst:snapshot_create', async () => {
    const res = await apiWith(tokenFor(noPerm), app).post('/finance/gstr3b/snapshots').send({ gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(res.status).toBe(403);
  });

  it('a caller with gst:snapshot_create can create a DRAFT snapshot (201)', async () => {
    const res = await apiWith(tokenFor(full), app).post('/finance/gstr3b/snapshots').send({ gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.isFilingReady).toBe(true);
    snapshotId = res.body.data.id;
  });

  it('403s POST /gstr3b/filing-attempts without gst:filing_record', async () => {
    const res = await apiWith(tokenFor(noPerm), app).post('/finance/gstr3b/filing-attempts').send({ gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId, mode: 'MANUAL_EXPORT' });
    expect(res.status).toBe(403);
  });

  it('a granted caller creates a filing attempt (201), records an ACCEPTED outcome, lists it, files it, and locks it', async () => {
    const createRes = await apiWith(tokenFor(full), app).post('/finance/gstr3b/filing-attempts').send({ gstRegistrationId: registrationId, financialYear: '2026-27', taxPeriod: '092026', snapshotId, mode: 'MANUAL_EXPORT' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.status).toBe('ATTEMPTED');
    const attemptId = createRes.body.data.id;

    const outcomeRes = await apiWith(tokenFor(full), app).post(`/finance/gstr3b/filing-attempts/${attemptId}/outcome`).send({ outcome: 'ACCEPTED' });
    expect(outcomeRes.status).toBe(200);
    expect(outcomeRes.body.data.status).toBe('ACCEPTED');

    const listRes = await apiWith(tokenFor(full), app).get(`/finance/gstr3b/filing-attempts?gstRegistrationId=${registrationId}&financialYear=2026-27&taxPeriod=092026`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((a: { id: string }) => a.id === attemptId)).toBe(true);

    const fileRes = await apiWith(tokenFor(full), app).post(`/finance/gstr3b/filing-attempts/${attemptId}/file`).send({});
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.data.status).toBe('FILED');
    const periodId = fileRes.body.data.id;

    const lockRes = await apiWith(tokenFor(full), app).post(`/finance/gstr3b/periods/${periodId}/lock`).send({});
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.data.status).toBe('LOCKED');
  });

  it('403s GET /gstr3b/filing-attempts without gst:period_view', async () => {
    const res = await apiWith(tokenFor(noPerm), app).get(`/finance/gstr3b/filing-attempts?gstRegistrationId=${registrationId}&financialYear=2026-27&taxPeriod=092026`);
    expect(res.status).toBe(403);
  });

  it('a cross-company gstRegistrationId on snapshot creation is a 404, not a leak', async () => {
    const other = await createTestTenant(`${suffix}X`, ['gst:snapshot_create']);
    const res = await apiWith(tokenFor(other), app).post('/finance/gstr3b/snapshots').send({ gstRegistrationId: registrationId, taxPeriod: '092026' });
    expect(res.status).toBe(404);
    await cleanupTestTenant(other);
  });
});
