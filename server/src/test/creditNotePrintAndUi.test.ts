import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createStandaloneCreditNote } from '../modules/sales/creditNote.service';
import {
  createCreditNoteTemplate, updateCreditNoteTemplate, getCreditNoteTemplateById,
  resolveCreditNoteTemplate, buildDefaultCreditNoteLayout, listCreditNoteTemplates,
} from '../modules/sales/creditNoteTemplate.service';
import {
  CREDIT_NOTE_BOUND_FIELDS, resolveCreditNoteBoundField, CreditNotePrintModel,
} from '../shared/creditNoteBoundFields';
import { tenantQuery } from '../shared/tenantContext';

// G2d — Credit Note Templates & Printing UI verification
describe('G2d: Credit Note Templates & Printing UI', () => {
  const suffix = `g2d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let tenantB: TestTenant;
  let clientId: string;
  const invoiceIds: string[] = [];
  const creditNoteIds: { companyId: string; id: string }[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create', 'return:create',
      'creditNote:view', 'creditNote:create', 'creditNote:cancel',
      'creditNoteTemplate:view', 'creditNoteTemplate:create', 'creditNoteTemplate:edit',
    ]);
    tenantB = await createTestTenant(`${suffix}-b`, [
      'creditNote:view', 'creditNoteTemplate:view',
    ]);

    const client = await prisma.client.create({
      data: {
        companyId: tenant.company.id,
        clientCode: `CL-${suffix}`,
        name: 'G2d Test Customer',
        type: 'RETAIL',
        phone: '+91 99999 88888',
        address: '100 Heritage Jewel Lane',
        city: 'Surat',
        state: 'Gujarat',
      },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    for (const cn of creditNoteIds) {
      await tenantQuery(cn.companyId, (tx) => tx.creditNote.deleteMany({ where: { id: cn.id, companyId: cn.companyId } }));
    }
    await tenantQuery(tenant.company.id, (tx) => tx.creditNoteTemplate.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenantB.company.id, (tx) => tx.creditNoteTemplate.deleteMany({ where: { companyId: tenantB.company.id } }));
    await cleanupJournalEntries(invoiceIds);
    await prisma.repairCase.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.salesReturnItem.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { companyId: tenant.company.id } } } }); // returned-jewellery register rows reference the return lines
    await prisma.salesReturn.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(tenantB);
    await prisma.$disconnect();
  });

  async function makeInvoice() {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-${suffix}-${invoiceIds.length}`,
        companyId: tenant.company.id,
        branchId: tenant.branch.id,
        name: 'Ring',
        metalType: 'GOLD',
        metalKarat: '22K',
        grossWeight: 10,
        netWeight: 10,
        stoneWeight: 0,
        costPrice: 8000,
        sellingPrice: 10000,
        createdById: tenant.user.id,
      },
    });

    const api = apiWith(tokenFor(tenant), app);
    const res = await api.post('/sales/invoices', {
      clientId,
      branchId: tenant.branch.id,
      invoiceDate: new Date().toISOString(),
      invoiceType: 'RETAIL',
      items: [{
        productCode: 'MISC',
        description: 'Gold Ornament',
        quantity: 1,
        grossWeight: 10,
        netGoldWeight: 10,
        rateType: 'FIXED',
        goldRate: 10000,
        tagId: tag.id,
      }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.data.id);
    return res.body.data;
  }

  describe('Bound fields & Layout definition', () => {
    it('CREDIT_NOTE_BOUND_FIELDS contains statutory header, seller, buyer, reference, and totals', () => {
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('creditNote.number');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('creditNote.date');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('creditNote.status');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('originalInvoice.number');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('salesReturn.number');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('totals.taxableValue');
      expect(CREDIT_NOTE_BOUND_FIELDS).toContain('totals.grandTotal');
    });

    it('resolveCreditNoteBoundField formats values properly and throws on unknown fields', () => {
      const model: CreditNotePrintModel = {
        seller: { legalName: 'Shree Jewellers', tradeName: null, gstin: '24AAAAA0000A1Z5', stateCode: '24', address: 'Bazaar', city: 'Surat', district: null, pincode: '395001', country: 'India' },
        buyer: { name: 'Customer A', gstin: null, pan: null, address: 'Address', city: 'Surat', state: 'Gujarat', stateCode: '24', pincode: '395002', phone: '9999999999', email: null },
        creditNote: { number: 'CN-2026-0001', date: '2026-04-15T00:00:00Z', financialYear: 2026, status: 'ISSUED', placeOfSupply: '24', reasonCode: 'POST_SALE_DISCOUNT', reasonNotes: 'Discount' },
        originalInvoice: { number: 'INV-2026-0001', date: '2026-04-10T00:00:00Z' },
        totals: { taxableValue: 10000, cgst: 150, sgst: 150, igst: 0, totalTax: 300, grandTotal: 10300 },
      };

      expect(resolveCreditNoteBoundField(model, 'creditNote.number')).toBe('CN-2026-0001');
      expect(resolveCreditNoteBoundField(model, 'totals.grandTotal')).toContain('10,300.00');
      expect(() => resolveCreditNoteBoundField(model, 'unregistered.field')).toThrow(/Unknown credit note template bound field/);
    });
  });

  describe('Credit Note Template CRUD & Resolution', () => {
    it('a company with no saved template resolves to safe built-in fallback', async () => {
      const resolved = await resolveCreditNoteTemplate(tenantB.company.id, null);
      expect(resolved).toEqual(buildDefaultCreditNoteLayout());
    });

    it('rejects a template layout with an unknown bound field', async () => {
      const layout = buildDefaultCreditNoteLayout();
      (layout.sections.seller.fields as string[]) = ['seller.legalName', 'seller.invalidUnknownField'];
      await expect(createCreditNoteTemplate(tenant.company.id, {
        name: 'Bad Layout Template', layout,
      }, tenant.user.id)).rejects.toThrow(/Unknown credit note template bound field/);
    });

    it('creates company default and resolves it', async () => {
      const layout = buildDefaultCreditNoteLayout();
      layout.sections.header.title = 'Company Custom Credit Note';
      const created = await createCreditNoteTemplate(tenant.company.id, {
        name: 'Custom Default',
        layout,
        isDefault: true,
      }, tenant.user.id);
      expect(created.id).toBeTruthy();

      const resolved = await resolveCreditNoteTemplate(tenant.company.id, tenant.branch.id);
      expect((resolved as any).sections.header.title).toBe('Company Custom Credit Note');
    });

    it('branch-specific template overrides company default for that branch only', async () => {
      const secondBranch = await addBranch(tenant.company.id, `${suffix}-b2`);
      const branchLayout = buildDefaultCreditNoteLayout();
      branchLayout.sections.header.title = 'Branch 2 Specific Credit Note';

      await createCreditNoteTemplate(tenant.company.id, {
        name: 'Branch 2 Template',
        branchId: secondBranch.id,
        layout: branchLayout,
      }, tenant.user.id);

      const resolvedBranch = await resolveCreditNoteTemplate(tenant.company.id, secondBranch.id);
      expect((resolvedBranch as any).sections.header.title).toBe('Branch 2 Specific Credit Note');

      const resolvedMain = await resolveCreditNoteTemplate(tenant.company.id, tenant.branch.id);
      expect((resolvedMain as any).sections.header.title).toBe('Company Custom Credit Note');
    });

    it('a branch-scoped template cannot be marked company default', async () => {
      await expect(createCreditNoteTemplate(tenant.company.id, {
        name: 'Illegal Branch Default',
        branchId: tenant.branch.id,
        layout: buildDefaultCreditNoteLayout(),
        isDefault: true,
      }, tenant.user.id)).rejects.toThrow(/cannot also be the company default/);
    });
  });

  describe('Credit Note API and presentation guarantees (G2d Step 11)', () => {
    it('1. Active standalone Credit Note renders correctly and includes enriched print data', async () => {
      const inv = await makeInvoice();
      const cn = await createStandaloneCreditNote(
        { invoiceId: inv.id, items: [{ description: 'Test Price Adjustment', taxableValue: 1000 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, tenant.user.id,
      );
      creditNoteIds.push({ companyId: tenant.company.id, id: cn.id });

      const api = apiWith(tokenFor(tenant), app);
      const res = await api.get(`/sales/credit-notes/${cn.id}`);
      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data.status).toBe('ISSUED');
      expect(data.creditNoteNumber).toBe(cn.creditNoteNumber);
      expect(data.client.phone).toBe('+91 99999 88888');
      expect(data.client.address).toBe('100 Heritage Jewel Lane');
      expect(data.originalInvoiceNumber).toBe(inv.invoiceNumber);
      expect(data.printTemplate).toBeDefined();
      expect(data.printTemplate.sections.header.title).toBeDefined();
    });

    it('2. Cancelled Credit Note renders as cancelled with cancellation metadata', async () => {
      const inv = await makeInvoice();
      const cn = await createStandaloneCreditNote(
        { invoiceId: inv.id, items: [{ description: 'Test Adjustment to Cancel', taxableValue: 500 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, tenant.user.id,
      );
      creditNoteIds.push({ companyId: tenant.company.id, id: cn.id });

      const api = apiWith(tokenFor(tenant), app);
      const cancelRes = await api.post(`/sales/credit-notes/${cn.id}/cancel`, { reason: 'Customer rejected adjustment' });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('CANCELLED');

      const getRes = await api.get(`/sales/credit-notes/${cn.id}`);
      expect(getRes.status).toBe(200);
      const data = getRes.body.data;
      expect(data.status).toBe('CANCELLED');
      expect(data.cancelReason).toBe('Customer rejected adjustment');
      expect(data.cancelledAt).toBeDefined();
    });

    it('3. Return-linked Credit Note displays its return reference and invoice link', async () => {
      const inv = await makeInvoice();
      const api = apiWith(tokenFor(tenant), app);

      // Create sales return with issueCreditNote: true (Path A)
      const retRes = await api.post('/sales/returns', {
        invoiceId: inv.id,
        items: [{ invoiceItemId: inv.items[0].id }],
        reason: 'Customer return',
        issueCreditNote: true,
      });
      expect(retRes.status).toBe(201);
      const returnNumber = retRes.body.data.returnNumber;

      // Find the created credit note
      const listRes = await api.get(`/sales/credit-notes?invoiceId=${inv.id}`);
      expect(listRes.status).toBe(200);
      const returnCn = listRes.body.data.find((n: any) => n.salesReturnId === retRes.body.data.id);
      expect(returnCn).toBeDefined();
      creditNoteIds.push({ companyId: tenant.company.id, id: returnCn.id });

      const detailRes = await api.get(`/sales/credit-notes/${returnCn.id}`);
      expect(detailRes.status).toBe(200);
      const detail = detailRes.body.data;
      expect(detail.salesReturnId).toBe(retRes.body.data.id);
      expect(detail.salesReturn.returnNumber).toBe(returnNumber);
      expect(detail.originalInvoiceNumber).toBe(inv.invoiceNumber);
    });

    it('4. Amounts shown match persisted backend values exactly without divergence', async () => {
      const inv = await makeInvoice();
      const cn = await createStandaloneCreditNote(
        { invoiceId: inv.id, items: [{ description: 'Specific Tax Test', taxableValue: 2000 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, tenant.user.id,
      );
      creditNoteIds.push({ companyId: tenant.company.id, id: cn.id });

      const api = apiWith(tokenFor(tenant), app);
      const res = await api.get(`/sales/credit-notes/${cn.id}`);
      const data = res.body.data;

      expect(Number(data.taxableAmount)).toBe(2000);
      expect(Number(data.cgst)).toBe(30); // 3% split (1.5% CGST = 30)
      expect(Number(data.sgst)).toBe(30); // 1.5% SGST = 30
      expect(Number(data.igst)).toBe(0);
      expect(Number(data.totalTax)).toBe(60);
      expect(Number(data.totalAmount)).toBe(2060);
    });

    it('5. Viewing/printing Credit Note never mutates customer balance', async () => {
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const balanceBefore = Number(clientBefore.currentBalance);

      const api = apiWith(tokenFor(tenant), app);
      await api.get('/sales/credit-notes');
      await api.get('/sales/credit-note-templates');

      const clientAfter = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfter.currentBalance)).toBe(balanceBefore);
    });

    it('6. Credit Note Templates endpoints respect permissions', async () => {
      const apiGranted = apiWith(tokenFor(tenant), app);
      const listOk = await apiGranted.get('/sales/credit-note-templates');
      expect(listOk.status).toBe(200);

      // tenantB has only creditNote:view and creditNoteTemplate:view — no creditNoteTemplate:create
      const apiB = apiWith(tokenFor(tenantB), app);
      const deniedCreate = await apiB.post('/sales/credit-note-templates', {
        name: 'Unauthorized Template', layout: buildDefaultCreditNoteLayout(),
      });
      expect(deniedCreate.status).toBe(403);
    });
  });
});
