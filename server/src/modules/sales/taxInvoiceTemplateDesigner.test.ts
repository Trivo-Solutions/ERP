import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import {
  createTaxInvoiceTemplate, updateTaxInvoiceTemplate, resolveTaxInvoiceTemplate, getTaxInvoiceTemplateById,
} from './taxInvoiceTemplate.service';
import { TAX_INVOICE_BOUND_FIELDS, TAX_INVOICE_TABLE_COLUMNS } from '../../shared/taxInvoiceBoundFields';
import { tenantQuery } from '../../shared/tenantContext';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// The free-form tax invoice template designer saves `layout.elements` (not the older checklist
// `sections`). Every bound field / column in it is whitelisted server-side at save time, exactly as
// the checklist format always was — a template can choose WHAT prints, never invent a value.

const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', xMm: 10, yMm: 10, fontSize: 9, ...extra });
const layoutOf = (elements: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  page: { widthMm: 210, heightMm: 297 }, elements, ...extra,
});
const itemsTable = (extra: Record<string, unknown> = {}) => ({
  id: 't1', type: 'table', tableKind: 'items', xMm: 5, yMm: 70, widthMm: 100, heightMm: 100,
  columns: [{ field: 'srNo', label: 'Sr', widthMm: 10 }, { field: 'description', label: 'Item', widthMm: 90 }], ...extra,
});

describe('Tax Invoice Template designer layouts', () => {
  const suffix = `tid-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, ['taxInvoiceTemplate:create', 'taxInvoiceTemplate:edit']);
    tenantB = await createTestTenant(`${suffix}-b`, ['taxInvoiceTemplate:create']);
  });

  afterAll(async () => {
    for (const companyId of [tenant.company.id, tenantB.company.id]) {
      await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.deleteMany({ where: { companyId } }));
    }
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(tenantB);
    await prisma.$disconnect();
  });

  it('saves a designer layout and resolves it back for printing', async () => {
    const layout = layoutOf(
      [text('a', { boundField: 'seller.gstin' }), text('b', { literalText: 'Total {{totals.grandTotal}} — {{totals.grandTotalInWords}}' }), itemsTable(),
        { id: 'q', type: 'qrcode', xMm: 180, yMm: 10, widthMm: 22, heightMm: 22 }],
      { copies: ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER'] },
    );
    const t = await createTaxInvoiceTemplate(tenant.company.id, { name: 'Designer A', layout, isDefault: true }, tenant.user.id);
    expect((t.layout as any).elements).toHaveLength(4);
    const resolved = await resolveTaxInvoiceTemplate(tenant.company.id, tenant.branch.id);
    expect((resolved as any).elements).toHaveLength(4);
    expect((resolved as any).copies).toEqual(['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER']);
  });

  it('every whitelisted bound field and table column is accepted', async () => {
    const fieldEls = (TAX_INVOICE_BOUND_FIELDS as readonly string[]).map((f, i) => text(`f${i}`, { boundField: f }));
    const tables = Object.entries(TAX_INVOICE_TABLE_COLUMNS).map(([kind, cols], i) => ({
      id: `tb${i}`, type: 'table', tableKind: kind, xMm: 5, yMm: 5, widthMm: 100, heightMm: 30,
      columns: (cols as readonly string[]).map((c) => ({ field: c, label: c, widthMm: 10 })),
    }));
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'All fields', layout: layoutOf([...fieldEls, ...tables]),
    }, tenant.user.id)).resolves.toBeTruthy();
  });

  it('rejects a bound field outside the whitelist', async () => {
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad field', layout: layoutOf([text('a', { boundField: 'seller.bankAccountNumber' })]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template bound field/);
  });

  it('rejects an unknown {{placeholder}} inside literal text', async () => {
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad placeholder', layout: layoutOf([text('a', { literalText: 'GSTIN {{seller.gstin}} and {{company.secret}}' })]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template bound field: company.secret/);
  });

  it('rejects an unknown table column, an unknown table kind and an unknown element type', async () => {
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad column',
      layout: layoutOf([itemsTable({ columns: [{ field: 'costPrice', label: 'Cost', widthMm: 20 }] })]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template items column: costPrice/);
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad column for kind',
      layout: layoutOf([itemsTable({ tableKind: 'hsnSummary', columns: [{ field: 'srNo', label: 'Sr', widthMm: 10 }] })]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template hsnSummary column: srNo/);
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad kind', layout: layoutOf([itemsTable({ tableKind: 'ledger' })]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template table kind/);
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Bad type', layout: layoutOf([{ id: 'x', type: 'script', xMm: 0, yMm: 0 }]),
    }, tenant.user.id)).rejects.toThrow(/Unknown tax invoice template element type/);
  });

  it('rejects malformed geometry, duplicate ids, bad colours and a non-image data URL', async () => {
    const bad = (el: Record<string, unknown>, re: RegExp, name: string) =>
      expect(createTaxInvoiceTemplate(tenant.company.id, { name, layout: layoutOf([el]) }, tenant.user.id)).rejects.toThrow(re);
    await bad(text('a', { xMm: 'ten' }), /element x/, 'x');
    await bad(text('a', { widthMm: -5 }), /width/, 'w');
    await bad(text('a', { fontSize: 500 }), /font size/, 'fs');
    await bad(text('a', { color: 'red; background:url(x)' }), /colour/, 'color');
    await bad({ id: 'i', type: 'image', xMm: 0, yMm: 0, imageDataUrl: 'javascript:alert(1)' }, /embedded png/, 'img');
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'dup', layout: layoutOf([text('same'), text('same')]),
    }, tenant.user.id)).rejects.toThrow(/unique id/);
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'page', layout: { page: { widthMm: 5, heightMm: 297 }, elements: [] },
    }, tenant.user.id)).rejects.toThrow(/page width/);
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'copies', layout: layoutOf([], { copies: Array(9).fill('x') }),
    }, tenant.user.id)).rejects.toThrow(/copies/);
  });

  it('the older checklist (sections) layout is still accepted and untouched', async () => {
    const t = await createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Legacy',
      layout: { sections: { header: { title: 'Tax Invoice' }, seller: { fields: ['seller.gstin'] }, items: { columns: ['srNo', 'hsnCode'] } } },
    }, tenant.user.id);
    expect((t.layout as any).sections.header.title).toBe('Tax Invoice');
  });

  it('update validates the layout too, and persists a valid edit', async () => {
    const t = await createTaxInvoiceTemplate(tenant.company.id, { name: 'Editable', layout: layoutOf([text('a')]) }, tenant.user.id);
    await expect(updateTaxInvoiceTemplate(tenant.company.id, t.id, {
      layout: layoutOf([text('a', { boundField: 'nope.field' })]),
    })).rejects.toThrow(/Unknown tax invoice template bound field/);
    await updateTaxInvoiceTemplate(tenant.company.id, t.id, { layout: layoutOf([text('a', { boundField: 'invoice.number' })]) });
    const reloaded = await getTaxInvoiceTemplateById(tenant.company.id, t.id);
    expect((reloaded.layout as any).elements[0].boundField).toBe('invoice.number');
  });

  it('cross-company: another company\'s branch cannot be attached, and its template is not readable', async () => {
    await expect(createTaxInvoiceTemplate(tenant.company.id, {
      name: 'Forged branch', branchId: tenantB.branch.id, layout: layoutOf([text('a')]),
    }, tenant.user.id)).rejects.toMatchObject({ statusCode: 404 });

    const theirs = await createTaxInvoiceTemplate(tenantB.company.id, { name: 'B only', layout: layoutOf([text('a')]) }, tenantB.user.id);
    await expect(getTaxInvoiceTemplateById(tenant.company.id, theirs.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateTaxInvoiceTemplate(tenant.company.id, theirs.id, { name: 'hijacked' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
