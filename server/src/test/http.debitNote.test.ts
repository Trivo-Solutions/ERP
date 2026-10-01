import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../shared/constants';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { tenantQuery } from '../shared/tenantContext';

// G2e — proves debitNote:view/create/cancel actually gate the new routes over real HTTP (the one
// thing debitNote.service.test.ts's service-level tests do NOT cover — they call the service
// functions directly with a full-permission ctx, bypassing requirePermission(...) entirely).
// Mirrors http.j3Administrative.test.ts's exact pattern: granted -> succeeds, missing -> 403.
describe('HTTP: Debit Note permission gating (G2e)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];
  const debitNoteIds: string[] = [];
  const supplierIds: string[] = [];

  afterAll(async () => {
    await cleanupJournalEntries([...tagIds, ...returnIds, ...debitNoteIds]);
    for (const t of cleanupTenants) {
      await tenantQuery(t.company.id, (tx) => tx.debitNote.deleteMany({ where: { companyId: t.company.id } }));
      // debit_note_templates isn't covered by cleanupTestTenant (same gap as creditNoteTemplate —
      // see creditNotePrintAndUi.test.ts's identical cleanup line) — remove what this file created.
      await tenantQuery(t.company.id, (tx) => tx.debitNoteTemplate.deleteMany({ where: { companyId: t.company.id } }));
    }
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    for (const t of cleanupTenants) {
      await prisma.auditLog.deleteMany({ where: { userId: t.user.id } });
      await cleanupTestTenant(t);
    }
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }

  // Real HTTP: PO -> GRN, over the actual router, so the fixture matches exactly what a live
  // caller would have created (not a hand-inserted Prisma row).
  async function makeGrn(t: TestTenant, api: ReturnType<typeof apiWith>, price: number) {
    const supplier = await prisma.supplier.create({
      data: { companyId: t.company.id, supplierCode: `HDN-SUP-${suffix}-${supplierIds.length}`, name: 'HTTP DN Supplier', type: 'OTHER' },
    });
    supplierIds.push(supplier.id);

    const poRes = await api.post('/procurement/orders', {
      supplierId: supplier.id, poType: 'OUTRIGHT', orderDate: new Date().toISOString(),
      items: [{ materialCode: 'RING-HDN', materialName: 'HTTP DN ring', materialType: FINISHED_GOODS_MATERIAL_TYPE, quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price }],
    });
    expect(poRes.status).toBe(201);
    poIds.push(poRes.body.data.id);

    const grnRes = await api.post('/procurement/grn', {
      poId: poRes.body.data.id, receivedDate: new Date().toISOString(), branchId: t.branch.id,
      items: [{ poItemId: poRes.body.data.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    });
    expect(grnRes.status).toBe(201);
    return grnRes.body.data;
  }

  it('debitNote:create — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('DNCG', ['po:create', 'grn:create', 'debitNote:create']);
    const grn1 = await makeGrn(granted.t, granted.api, 20000);
    const ok = await granted.api.post('/procurement/debit-notes', {
      grnId: grn1.id, items: [{ description: 'HTTP test', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE',
    });
    expect(ok.status).toBe(201);
    debitNoteIds.push(ok.body.data.id);

    const missing = await tenantWith('DNCM', ['po:create', 'grn:create']); // no debitNote:create
    const grn2 = await makeGrn(missing.t, missing.api, 20000);
    const denied = await missing.api.post('/procurement/debit-notes', {
      grnId: grn2.id, items: [{ description: 'HTTP test', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE',
    });
    expect(denied.status).toBe(403);
  });

  it('debitNote:view — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('DNVG', ['po:create', 'grn:create', 'debitNote:create', 'debitNote:view']);
    const grn = await makeGrn(granted.t, granted.api, 15000);
    const created = await granted.api.post('/procurement/debit-notes', {
      grnId: grn.id, items: [{ description: 'View test', taxableValue: 500 }], reasonCode: 'SHORT_SUPPLY',
    });
    expect(created.status).toBe(201);
    debitNoteIds.push(created.body.data.id);

    const list = await granted.api.get('/procurement/debit-notes');
    expect(list.status).toBe(200);
    const detail = await granted.api.get(`/procurement/debit-notes/${created.body.data.id}`);
    expect(detail.status).toBe(200);

    const missing = await tenantWith('DNVM', ['po:create', 'grn:create']); // no debitNote:view
    const deniedList = await missing.api.get('/procurement/debit-notes');
    expect(deniedList.status).toBe(403);
    const deniedDetail = await missing.api.get(`/procurement/debit-notes/${created.body.data.id}`);
    expect(deniedDetail.status).toBe(403);
  });

  it('debitNote:cancel — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('DNXG', ['po:create', 'grn:create', 'debitNote:create', 'debitNote:cancel']);
    const grn1 = await makeGrn(granted.t, granted.api, 12000);
    const dn1 = await granted.api.post('/procurement/debit-notes', {
      grnId: grn1.id, items: [{ description: 'Cancel test', taxableValue: 400 }], reasonCode: 'CORRECTION_IN_GRN',
    });
    expect(dn1.status).toBe(201);
    debitNoteIds.push(dn1.body.data.id);
    const ok = await granted.api.post(`/procurement/debit-notes/${dn1.body.data.id}/cancel`, { reason: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('CANCELLED');

    const missing = await tenantWith('DNXM', ['po:create', 'grn:create', 'debitNote:create']); // has create, not cancel
    const grn2 = await makeGrn(missing.t, missing.api, 12000);
    const dn2 = await missing.api.post('/procurement/debit-notes', {
      grnId: grn2.id, items: [{ description: 'Cancel test 2', taxableValue: 400 }], reasonCode: 'CORRECTION_IN_GRN',
    });
    expect(dn2.status).toBe(201);
    debitNoteIds.push(dn2.body.data.id);
    const denied = await missing.api.post(`/procurement/debit-notes/${dn2.body.data.id}/cancel`, { reason: 'test' });
    expect(denied.status).toBe(403);
  });

  it('the Path A route (issue a Debit Note against an existing Purchase Return) is gated by debitNote:create, not just po:approve', async () => {
    const granted = await tenantWith('DNAG', ['po:create', 'grn:create', 'tag:create', 'po:approve', 'debitNote:create']);
    const grn = await makeGrn(granted.t, granted.api, 9000);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `HDN-TAG-${suffix}`, companyId: granted.t.company.id, branchId: granted.t.branch.id,
        name: 'HTTP DN ring', metalType: 'GOLD', grossWeight: 8, netWeight: 8, stoneWeight: 0,
        costPrice: 9000, sellingPrice: 11000, grnItemId: grn.grnItems[0].id, status: 'IN_STOCK',
        createdById: granted.t.user.id,
      },
    });
    tagIds.push(tag.id);

    const ret = await granted.api.post('/procurement/returns', { items: [{ tagId: tag.id }] });
    expect(ret.status).toBe(201);
    returnIds.push(ret.body.data.id);

    const ok = await granted.api.post(`/procurement/returns/${ret.body.data.id}/debit-note`, {});
    expect(ok.status).toBe(201);
    debitNoteIds.push(ok.body.data.id);

    // po:approve alone (no debitNote:create) is not enough for the dedicated Path A route.
    const missing = await tenantWith('DNAM', ['po:create', 'grn:create', 'tag:create', 'po:approve']);
    const grn2 = await makeGrn(missing.t, missing.api, 9000);
    const tag2 = await prisma.jewelryTag.create({
      data: {
        tagNumber: `HDN-TAG2-${suffix}`, companyId: missing.t.company.id, branchId: missing.t.branch.id,
        name: 'HTTP DN ring', metalType: 'GOLD', grossWeight: 8, netWeight: 8, stoneWeight: 0,
        costPrice: 9000, sellingPrice: 11000, grnItemId: grn2.grnItems[0].id, status: 'IN_STOCK',
        createdById: missing.t.user.id,
      },
    });
    tagIds.push(tag2.id);
    const ret2 = await missing.api.post('/procurement/returns', { items: [{ tagId: tag2.id }] });
    expect(ret2.status).toBe(201);
    returnIds.push(ret2.body.data.id);
    const denied = await missing.api.post(`/procurement/returns/${ret2.body.data.id}/debit-note`, {});
    expect(denied.status).toBe(403);
  });

  it('debitNoteTemplate:view/create/edit — granted succeeds, missing is 403', async () => {
    const granted = await tenantWith('DTG', ['debitNoteTemplate:view', 'debitNoteTemplate:create', 'debitNoteTemplate:edit']);
    const list = await granted.api.get('/procurement/debit-note-templates');
    expect(list.status).toBe(200);
    const created = await granted.api.post('/procurement/debit-note-templates', {
      name: 'HTTP Test Template', layout: { sections: { header: { showLogo: true, title: 'Debit Note', showBranchAddress: true }, items: { columns: [] }, totals: { fields: [] }, footer: { showSignatory: true, showAcknowledgement: false } } },
    });
    expect(created.status).toBe(201);
    const updated = await granted.api.put(`/procurement/debit-note-templates/${created.body.data.id}`, { name: 'Renamed' });
    expect(updated.status).toBe(200);

    const missing = await tenantWith('DTM', []);
    const deniedList = await missing.api.get('/procurement/debit-note-templates');
    expect(deniedList.status).toBe(403);
    const deniedCreate = await missing.api.post('/procurement/debit-note-templates', { name: 'x', layout: { sections: {} } });
    expect(deniedCreate.status).toBe(403);
  });
});
