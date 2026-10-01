import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { TAX_INVOICE_BOUND_FIELDS, TAX_INVOICE_ITEM_COLUMNS } from '../../shared/taxInvoiceBoundFields';

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

function validateLayout(layout: unknown): TaxInvoiceLayout {
  if (!layout || typeof layout !== 'object' || !(layout as any).sections) {
    throw new AppError('Template layout must be an object with a "sections" key', 400);
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
export async function resolveTaxInvoiceTemplate(companyId: string, branchId: string): Promise<TaxInvoiceLayout> {
  const branchTemplate = await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findFirst({
    where: { companyId, branchId, isActive: true },
  }));
  if (branchTemplate) return branchTemplate.layout as unknown as TaxInvoiceLayout;

  const companyDefault = await tenantQuery(companyId, (tx) => tx.taxInvoiceTemplate.findFirst({
    where: { companyId, isDefault: true, isActive: true },
  }));
  if (companyDefault) return companyDefault.layout as unknown as TaxInvoiceLayout;

  return buildDefaultLayout();
}
