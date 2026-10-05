import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import {
  TAX_INVOICE_BOUND_FIELDS, TAX_INVOICE_ITEM_COLUMNS, TAX_INVOICE_TABLE_COLUMNS, TAX_INVOICE_ELEMENT_TYPES,
} from '../../shared/taxInvoiceBoundFields';

// G1 Part F/L — CRUD for the Tax Invoice print template. Structurally mirrors
// EstimateTemplate/TagTemplate (one Json `layout` column, no separate element table, "only one
// isDefault per company" invariant enforced in a transaction) — see PHASE_G0 audit's research on
// which existing template system this follows and why. UNLIKE those two, every `boundField`/
// `column` value in a saved layout is validated HERE, at save time, against the server-side
// whitelist in taxInvoiceBoundFields.ts (belt-and-suspenders: resolveTaxInvoiceBoundField also
// throws again at render/print time — a layout can never reach the browser or a save with an
// out-of-whitelist reference, unlike EstimateTemplate's client-side-only enforcement).
//
// branchId is optional on the row: null = company-wide/default candidate, set = this one branch's
// override. resolveTaxInvoiceTemplate() below is the print-time resolution: explicit branch
// override, else the company's isDefault row, else a safe built-in fallback — same
// explicit-override-else-default shape as TagTemplate's own print-time resolution.

export interface TaxInvoiceLayout {
  sections: {
    header: { showLogo: boolean; title: string; showBranchAddress: boolean };
    seller: { fields: string[] };
    buyer: { fields: string[] };
    invoiceMeta: { fields: string[] };
    items: { columns: string[] };
    totals: { fields: string[] };
    payment: { fields: string[]; showBankDetails: boolean; bankDetailsText?: string };
    eInvoice: { enabled: boolean };
    footer: { termsText?: string; showSignatory: boolean; showAcknowledgement: boolean; notesText?: string };
  };
}

// Free-form designer layout (the same canvas idea as EstimateTemplate/TagTemplate): every element is
// positioned in mm and may bind to a whitelisted field. A layout is EITHER this shape (has `elements`)
// OR the older checklist shape above (has `sections`) — both stay valid, and both print.
export interface TaxInvoiceDesignerLayout {
  page: { widthMm: number; heightMm: number };
  copies?: string[];
  elements: Record<string, unknown>[];
}

const KNOWN_FIELDS = new Set<string>(TAX_INVOICE_BOUND_FIELDS as readonly string[]);
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const MAX_ELEMENTS = 400;
const MAX_IMAGE_DATA_URL = 1_200_000; // chars — an ~800 KB image, base64-encoded

function assertKnownField(f: unknown, what: string) {
  if (typeof f !== 'string' || !KNOWN_FIELDS.has(f)) {
    throw new AppError(`Unknown tax invoice template ${what}: ${String(f)}`, 400);
  }
}
function assertFinite(v: unknown, what: string, min: number, max: number) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new AppError(`Tax invoice template ${what} must be a number between ${min} and ${max}`, 400);
  }
}

function validateDesignerLayout(layout: any): TaxInvoiceDesignerLayout {
  const page = layout.page;
  if (!page || typeof page !== 'object') throw new AppError('Template layout needs a "page" with widthMm and heightMm', 400);
  assertFinite(page.widthMm, 'page width (mm)', 40, 700);
  assertFinite(page.heightMm, 'page height (mm)', 40, 1500);
  if (layout.copies !== undefined) {
    if (!Array.isArray(layout.copies) || layout.copies.length > 6 || layout.copies.some((c: unknown) => typeof c !== 'string' || c.length > 60)) {
      throw new AppError('Template copies must be up to 6 labels of at most 60 characters', 400);
    }
  }
  if (!Array.isArray(layout.elements)) throw new AppError('Template layout "elements" must be an array', 400);
  if (layout.elements.length > MAX_ELEMENTS) throw new AppError(`A template may have at most ${MAX_ELEMENTS} elements`, 400);

  const ids = new Set<string>();
  for (const el of layout.elements) {
    if (!el || typeof el !== 'object') throw new AppError('Every template element must be an object', 400);
    if (typeof el.id !== 'string' || !el.id || ids.has(el.id)) throw new AppError('Every template element needs a unique id', 400);
    ids.add(el.id);
    if (!(TAX_INVOICE_ELEMENT_TYPES as readonly string[]).includes(el.type)) {
      throw new AppError(`Unknown tax invoice template element type: ${String(el.type)}`, 400);
    }
    assertFinite(el.xMm, 'element x (mm)', -50, 2000);
    assertFinite(el.yMm, 'element y (mm)', -50, 3000);
    for (const dim of ['widthMm', 'heightMm'] as const) {
      if (el[dim] !== undefined) assertFinite(el[dim], `element ${dim === 'widthMm' ? 'width' : 'height'} (mm)`, 0, 3000);
    }
    if (el.fontSize !== undefined) assertFinite(el.fontSize, 'font size (pt)', 3, 120);
    for (const c of ['color', 'fillColor'] as const) {
      if (el[c] !== undefined && !(typeof el[c] === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(el[c]))) {
        throw new AppError(`Tax invoice template ${c} must be a #hex colour`, 400);
      }
    }
    if (el.type === 'text') {
      if (el.boundField !== undefined) assertKnownField(el.boundField, 'bound field');
      if (el.literalText !== undefined) {
        if (typeof el.literalText !== 'string' || el.literalText.length > 2000) throw new AppError('Template text must be a string of at most 2000 characters', 400);
        for (const m of el.literalText.matchAll(PLACEHOLDER)) assertKnownField(m[1], 'bound field');
      }
    }
    if (el.type === 'barcode' && el.boundField !== undefined) assertKnownField(el.boundField, 'bound field');
    if (el.type === 'image' && el.imageDataUrl !== undefined) {
      if (typeof el.imageDataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(el.imageDataUrl)) {
        throw new AppError('Template image must be an embedded png, jpeg, webp or svg image', 400);
      }
      if (el.imageDataUrl.length > MAX_IMAGE_DATA_URL) throw new AppError('Template image is too large (max about 800 KB)', 400);
    }
    if (el.type === 'table') {
      const allowed = (TAX_INVOICE_TABLE_COLUMNS as Record<string, readonly string[]>)[el.tableKind];
      if (!allowed) throw new AppError(`Unknown tax invoice template table kind: ${String(el.tableKind)}`, 400);
      if (!Array.isArray(el.columns) || el.columns.length === 0 || el.columns.length > 60) {
        throw new AppError('A template table needs between 1 and 60 columns', 400);
      }
      const seen = new Set<string>();
      for (const col of el.columns) {
        if (!col || typeof col.field !== 'string' || !allowed.includes(col.field)) {
          throw new AppError(`Unknown tax invoice template ${el.tableKind} column: ${String(col?.field)}`, 400);
        }
        if (seen.has(col.field)) throw new AppError(`Duplicate tax invoice template column: ${col.field}`, 400);
        seen.add(col.field);
        if (typeof col.label !== 'string' || col.label.length > 80) throw new AppError('A column label must be a string of at most 80 characters', 400);
        assertFinite(col.widthMm, 'column width (mm)', 2, 700);
        if (col.align !== undefined && !['left', 'center', 'right'].includes(col.align)) throw new AppError('A column align must be left, center or right', 400);
      }
    }
  }
  return layout as TaxInvoiceDesignerLayout;
}

function validateLayout(layout: unknown): TaxInvoiceLayout | TaxInvoiceDesignerLayout {
  if (layout && typeof layout === 'object' && Array.isArray((layout as any).elements)) {
    return validateDesignerLayout(layout);
  }
  if (!layout || typeof layout !== 'object' || !(layout as any).sections) {
    throw new AppError('Template layout must be an object with a "sections" key (checklist format) or an "elements" list (designer format)', 400);
  }
  const s = (layout as any).sections;
  const boundFieldArrays: unknown[][] = [s.seller?.fields, s.buyer?.fields, s.invoiceMeta?.fields, s.totals?.fields, s.payment?.fields].filter(Boolean);
  for (const arr of boundFieldArrays) {
    for (const f of arr) {
      if (!(TAX_INVOICE_BOUND_FIELDS as readonly string[]).includes(f as string)) {
        throw new AppError(`Unknown tax invoice template bound field: ${f}`, 400);
      }
    }
  }
  for (const col of s.items?.columns ?? []) {
    if (!(TAX_INVOICE_ITEM_COLUMNS as readonly string[]).includes(col)) {
      throw new AppError(`Unknown tax invoice template item column: ${col}`, 400);
    }
  }
  return layout as TaxInvoiceLayout;
}

// The safe built-in fallback (Part H: "Do not make invoice generation fail merely because an
// administrator has not yet created a custom template") — a sensible, complete default layout,
// never persisted, returned as-is when a company has configured nothing at all.
export function buildDefaultLayout(): TaxInvoiceLayout {
  return {
    sections: {
      header: { showLogo: true, title: 'Tax Invoice', showBranchAddress: true },
      seller: { fields: ['seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.address', 'seller.city', 'seller.stateCode'] },
      buyer: { fields: ['buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state'] },
      invoiceMeta: { fields: ['invoice.number', 'invoice.date', 'invoice.type', 'invoice.placeOfSupply'] },
      items: { columns: ['srNo', 'hsnCode', 'description', 'quantity', 'netWeight', 'rate', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalPrice'] },
      totals: { fields: ['totals.subtotal', 'totals.discount', 'totals.otherCharges', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.roundOff', 'totals.grandTotal'] },
      payment: { fields: ['payment.paidAmount', 'payment.balanceDue'], showBankDetails: false },
      eInvoice: { enabled: true },
      footer: { showSignatory: true, showAcknowledgement: false },
    },
  };
}

export async function listTaxInvoiceTemplates(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findMany({
    where: { companyId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: { branch: { select: { id: true, name: true } } },
  }));
}

export async function getTaxInvoiceTemplateById(companyId: string, id: string) {
  const t = await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findUnique({ where: { id } }));
  if (!t || t.companyId !== companyId) throw new AppError('Tax invoice template not found', 404);
  return t;
}

export async function createTaxInvoiceTemplate(companyId: string, data: {
  name: string; description?: string; branchId?: string | null; layout: unknown; isDefault?: boolean; isActive?: boolean;
}, userId: string) {
  if (!data.name?.trim()) throw new AppError('Template name is required', 400);
  await assertOwnedIfPresent('branch', data.branchId, companyId, 'Branch');
  const layout = validateLayout(data.layout);

  return tenantTransaction(companyId, async (tx) => {
    // Only one isDefault per company, and it must be the company-wide one (a branch-scoped
    // template is an override, never THE default) — a branch template with isDefault:true would
    // be ambiguous with the actual company default, so it's simply not allowed.
    if (data.isDefault && data.branchId) {
      throw new AppError('A branch-specific template cannot also be the company default', 400);
    }
    if (data.isDefault) {
      await tx.taxInvoiceTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.taxInvoiceTemplate.create({
      data: {
        companyId, name: data.name, description: data.description ?? null,
        branchId: data.branchId ?? null, layout: layout as unknown as Prisma.InputJsonValue,
        isDefault: data.isDefault ?? false, isActive: data.isActive ?? true, createdById: userId,
      },
    });
  });
}

export async function updateTaxInvoiceTemplate(companyId: string, id: string, data: {
  name?: string; description?: string | null; branchId?: string | null; layout?: unknown; isDefault?: boolean; isActive?: boolean;
}) {
  const existing = await getTaxInvoiceTemplateById(companyId, id);
  if (data.branchId !== undefined) await assertOwnedIfPresent('branch', data.branchId, companyId, 'Branch');
  const layout = data.layout !== undefined ? validateLayout(data.layout) : undefined;
  const branchId = data.branchId !== undefined ? data.branchId : existing.branchId;
  const willBeDefault = data.isDefault !== undefined ? data.isDefault : existing.isDefault;

  return tenantTransaction(companyId, async (tx) => {
    if (willBeDefault && branchId) {
      throw new AppError('A branch-specific template cannot also be the company default', 400);
    }
    if (data.isDefault) {
      await tx.taxInvoiceTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.taxInvoiceTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(layout !== undefined && { layout: layout as unknown as Prisma.InputJsonValue }),
      },
    });
  });
}

export async function duplicateTaxInvoiceTemplate(companyId: string, id: string, userId: string) {
  const t = await getTaxInvoiceTemplateById(companyId, id);
  return tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.create({
    data: {
      companyId, name: `${t.name} (Copy)`, description: t.description, branchId: null,
      layout: t.layout as Prisma.InputJsonValue, isDefault: false, isActive: true, createdById: userId,
    },
  }));
}

// G1 Part H — print-time resolution: explicit branch override, else the company default, else the
// safe built-in fallback (never fails invoice generation merely for lacking a saved template).
export async function resolveTaxInvoiceTemplate(companyId: string, branchId: string): Promise<TaxInvoiceLayout | TaxInvoiceDesignerLayout> {
  const branchTemplate = await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findFirst({
    where: { companyId, branchId, isActive: true },
  }));
  if (branchTemplate) return branchTemplate.layout as unknown as TaxInvoiceLayout | TaxInvoiceDesignerLayout;

  const companyDefault = await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findFirst({
    where: { companyId, isDefault: true, isActive: true },
  }));
  if (companyDefault) return companyDefault.layout as unknown as TaxInvoiceLayout | TaxInvoiceDesignerLayout;

  return buildDefaultLayout();
}
