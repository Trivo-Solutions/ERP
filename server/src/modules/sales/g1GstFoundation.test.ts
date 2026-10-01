import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice, amendInvoice } from './sales.service';
import { createGstRegistration, updateGstRegistration, listGstRegistrations } from '../company/company.service';
import { updateBranch } from '../tagging/tagging.service';
import {
  createTaxInvoiceTemplate, updateTaxInvoiceTemplate, getTaxInvoiceTemplateById,
  resolveTaxInvoiceTemplate, buildDefaultLayout,
} from './taxInvoiceTemplate.service';
import { gstFinancialYear } from '../../shared/numberSequence';
import { tenantQuery } from '../../shared/tenantContext';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';

// G1 Part C: pure function, no fixtures needed.
describe('gstFinancialYear (G1 Part C)', () => {
  it('a March date belongs to the FY that started the PREVIOUS calendar year', () => {
    expect(gstFinancialYear(new Date('2026-03-31T00:00:00Z'))).toBe(2025);
  });
  it('an April date belongs to the FY that starts THIS calendar year', () => {
    expect(gstFinancialYear(new Date('2026-04-01T00:00:00Z'))).toBe(2026);
  });
  it('December stays in the same FY as April of that year', () => {
    expect(gstFinancialYear(new Date('2026-12-31T00:00:00Z'))).toBe(2026);
  });
});

describe('G1 GST foundation (registration, branch link, snapshot, templates, IRN guard)', () => {
  const suffix = `g1-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let tenantB: TestTenant;
  let clientId: string;
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, ['invoice:create', 'invoice:edit']);
    tenantB = await createTestTenant(`${suffix}-b`, ['invoice:create']);
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'Original Name', type: 'RETAIL', gstNumber: '24AAAAA0000A1Z5', address: 'Original Address', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    // Clear the FK from branches before deleting registrations/templates, and delete both before
    // cleanupTestTenant removes the branch/company themselves (see this file's own note above).
    // company_gst_registrations/tax_invoice_templates are FORCE-RLS tables (unlike the older
    // tables fixtures.ts otherwise deletes with a bare `prisma` call in this single-role test DB)
    // — a bare deleteMany silently matches ZERO rows here (RLS hides them, no error), so cleanup
    // MUST go through tenantQuery (which sets app.tenant_company_id) or it leaves an invisible
    // row that still trips the branches_gstRegistrationId/tax_invoice_templates_branchId
    // composite FK the moment cleanupTestTenant tries to delete the branch underneath it.
    await prisma.branch.updateMany({ where: { companyId: tenant.company.id }, data: { gstRegistrationId: null } });
    await prisma.branch.updateMany({ where: { companyId: tenantB.company.id }, data: { gstRegistrationId: null } });
    for (const companyId of [tenant.company.id, tenantB.company.id]) {
      await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.deleteMany({ where: { companyId } }));
      await tenantQuery(companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId } }));
    }
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(tenantB);
    await prisma.$disconnect();
  });

  describe('CompanyGstRegistration CRUD (Part A/K)', () => {
    it('the first registration created for a company becomes primary automatically', async () => {
      const reg = await createGstRegistration(tenant.ctx, {
        gstin: '24ABCDE1234F1Z5', legalName: 'First Registration Pvt Ltd', stateCode: '24',
      });
      expect(reg.isPrimary).toBe(true);
    });

    it('creating a second isPrimary:true registration demotes the first', async () => {
      const second = await createGstRegistration(tenant.ctx, {
        gstin: '27ABCDE1234F1Z8', legalName: 'Second Registration Pvt Ltd', stateCode: '27', isPrimary: true,
      });
      expect(second.isPrimary).toBe(true);
      const all = await listGstRegistrations(tenant.company.id);
      const first = all.find((r) => r.gstin === '24ABCDE1234F1Z5')!;
      expect(first.isPrimary).toBe(false);
    });

    it('rejects a duplicate GSTIN for the same company', async () => {
      await expect(createGstRegistration(tenant.ctx, {
        gstin: '24ABCDE1234F1Z5', legalName: 'Duplicate', stateCode: '24',
      })).rejects.toThrow(/already has a registration/);
    });

    it('rejects a malformed GSTIN', async () => {
      await expect(createGstRegistration(tenant.ctx, {
        gstin: 'NOT-A-GSTIN', legalName: 'Bad GSTIN Co', stateCode: '24',
      })).rejects.toThrow(/standard format/);
    });

    it('refuses to deactivate the sole primary registration', async () => {
      const all = await listGstRegistrations(tenant.company.id);
      const primary = all.find((r) => r.isPrimary)!;
      await expect(updateGstRegistration(tenant.ctx, primary.id, { isActive: false }))
        .rejects.toThrow(/mark another one primary/);
    });

    it('a cross-company registration id 404s, never silently succeeds', async () => {
      const all = await listGstRegistrations(tenant.company.id);
      const someId = all[0].id;
      await expect(updateGstRegistration(tenantB.ctx, someId, { legalName: 'Hijacked' }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('Branch -> GST Registration link (Part B)', () => {
    it('assigns a same-company registration to a branch', async () => {
      const all = await listGstRegistrations(tenant.company.id);
      const second = all.find((r) => r.gstin === '27ABCDE1234F1Z8')!;
      const updated = await updateBranch(tenant.branch.id, tenant.company.id, { gstRegistrationId: second.id });
      expect(updated.gstRegistrationId).toBe(second.id);
    });

    it('rejects assigning another company\'s registration to a branch (404, never a silent cross-company link)', async () => {
      const all = await listGstRegistrations(tenant.company.id);
      await expect(updateBranch(tenantB.branch.id, tenantB.company.id, { gstRegistrationId: all[0].id }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('Seller/buyer snapshot on a real invoice (Part D/E)', () => {
    it('uses the BRANCH\'S linked registration\'s legalName/gstin as the seller — not Company.name/gstin', async () => {
      const tag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TSTTAG-${suffix}-1`, companyId: tenant.company.id, branchId: tenant.branch.id,
          name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
          costPrice: 40000, sellingPrice: 48000, createdById: tenant.user.id,
        },
      });
      tagIds.push(tag.id);

      const invoice = await createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', branchId: tenant.branch.id,
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 48000, tagId: tag.id }],
      }, tenant.ctx, tenant.user.id);
      invoiceIds.push(invoice.id);

      const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
      expect(tax.sellerLegalName).toBe('Second Registration Pvt Ltd');
      expect(tax.gstin).toBe('27ABCDE1234F1Z8');
      // Buyer snapshot captured from the Client as it stood at creation time.
      expect(tax.buyerGstin).toBe('24AAAAA0000A1Z5');
      expect(tax.buyerAddress).toBe('Original Address');
    });

    it('a later Client edit never changes an already-issued invoice\'s buyer snapshot', async () => {
      await prisma.client.update({ where: { id: clientId }, data: { gstNumber: '24ZZZZZ9999Z1Z9', address: 'Changed Address' } });
      const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoiceIds[0] } });
      expect(tax.buyerGstin).toBe('24AAAAA0000A1Z5'); // unchanged
      expect(tax.buyerAddress).toBe('Original Address'); // unchanged
    });

    it('per-line cgst+sgst+igst sums to the invoice-level TaxInvoice amounts', async () => {
      const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoiceIds[0] } });
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoiceIds[0] } });
      const sumCgst = items.reduce((s, i) => s + Number(i.cgstAmount), 0);
      const sumSgst = items.reduce((s, i) => s + Number(i.sgstAmount), 0);
      const sumIgst = items.reduce((s, i) => s + Number(i.igstAmount), 0);
      expect(sumCgst).toBeCloseTo(Number(tax.cgst), 2);
      expect(sumSgst).toBeCloseTo(Number(tax.sgst), 2);
      expect(sumIgst).toBeCloseTo(Number(tax.igst), 2);
    });
  });

  describe('amendInvoice refuses once an IRN exists (Part N)', () => {
    it('blocks amendment with a clear business error, not a silent rewrite', async () => {
      await prisma.taxInvoice.update({ where: { invoiceId: invoiceIds[0] }, data: { irn: 'IRN-G1-TEST-0001' } });
      await expect(amendInvoice(invoiceIds[0], {
        items: [{ productCode: 'MISC', description: 'Ring (edited)', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 48000 }],
      }, tenant.ctx, tenant.user.id)).rejects.toMatchObject({ statusCode: 409 });
      // Clear it again so this fixture's own afterAll cleanup (which doesn't expect a live IRN) proceeds normally.
      await prisma.taxInvoice.update({ where: { invoiceId: invoiceIds[0] }, data: { irn: null } });
    });
  });

  describe('Tax Invoice Template (Part F/G/H/L)', () => {
    it('a company with no saved template resolves to the safe built-in default', async () => {
      const resolved = await resolveTaxInvoiceTemplate(tenantB.company.id, tenantB.branch.id);
      expect(resolved).toEqual(buildDefaultLayout());
    });

    it('rejects a layout that references a bound field outside the whitelist', async () => {
      const layout = buildDefaultLayout();
      (layout.sections.seller.fields as string[]) = ['seller.legalName', 'seller.bankAccountNumber'];
      await expect(createTaxInvoiceTemplate(tenant.company.id, {
        name: 'Bad Template', layout,
      }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template bound field/);
    });

    it('company default is used when no branch-specific template exists', async () => {
      const companyLayout = buildDefaultLayout();
      companyLayout.sections.header.title = 'Company Default Invoice Title';
      await createTaxInvoiceTemplate(tenant.company.id, {
        name: 'Company Default', layout: companyLayout, isDefault: true,
      }, tenant.user.id);
      const resolved = await resolveTaxInvoiceTemplate(tenant.company.id, tenant.branch.id);
      expect((resolved as any).sections.header.title).toBe('Company Default Invoice Title');
    });

    it('a branch-specific template overrides the company default for that branch only', async () => {
      const second = await addBranch(tenant.company.id, `${suffix}-2`);
      const branchLayout = buildDefaultLayout();
      branchLayout.sections.header.title = 'Branch-Specific Invoice Title';
      await createTaxInvoiceTemplate(tenant.company.id, {
        name: 'Branch Override', branchId: second.id, layout: branchLayout,
      }, tenant.user.id);

      const resolvedForSecond = await resolveTaxInvoiceTemplate(tenant.company.id, second.id);
      expect((resolvedForSecond as any).sections.header.title).toBe('Branch-Specific Invoice Title');

      const resolvedForFirst = await resolveTaxInvoiceTemplate(tenant.company.id, tenant.branch.id);
      expect((resolvedForFirst as any).sections.header.title).toBe('Company Default Invoice Title');

      // Left for this suite's top-level afterAll to clean up (it removes every
      // taxInvoiceTemplate/branch for this tenant before cleanupTestTenant runs).
    });

    it('a branch-specific template cannot also be marked the company default', async () => {
      await expect(createTaxInvoiceTemplate(tenant.company.id, {
        name: 'Invalid', branchId: tenant.branch.id, layout: buildDefaultLayout(), isDefault: true,
      }, tenant.user.id)).rejects.toThrow(/cannot also be the company default/);
    });

    it('a cross-company template id 404s', async () => {
      const mine = await createTaxInvoiceTemplate(tenant.company.id, { name: 'Mine', layout: buildDefaultLayout() }, tenant.user.id);
      await expect(getTaxInvoiceTemplateById(tenantB.company.id, mine.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(updateTaxInvoiceTemplate(tenantB.company.id, mine.id, { name: 'Hijacked' })).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
