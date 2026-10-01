import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { CREDIT_NOTE_BOUND_FIELDS, CREDIT_NOTE_ITEM_COLUMNS } from '../../shared/creditNoteBoundFields';

// G2d — CRUD for the Credit Note print template. Structurally mirrors TaxInvoiceTemplate
// (one Json `layout` column, branchId override or company default, whitelisted bound fields).
export interface CreditNoteLayout {
  sections: {
    header: { showLogo: boolean; title: string; showBranchAddress: boolean };
    seller: { fields: string[] };
    buyer: { fields: string[] };
    reference: { fields: string[] };
    items: { columns: string[] };
    totals: { fields: string[] };
    eInvoice?: { enabled: boolean };
    footer: { termsText?: string; showSignatory: boolean; showAcknowledgement: boolean; notesText?: string };
  };
}

function validateLayout(layout: unknown): CreditNoteLayout {
  if (!layout || typeof layout !== 'object' || !(layout as any).sections) {
    throw new AppError('Template layout must be an object with a "sections" key', 400);
  }
  const s = (layout as any).sections;
  const boundFieldArrays: unknown[][] = [s.seller?.fields, s.buyer?.fields, s.reference?.fields, s.totals?.fields].filter(Boolean);
  for (const arr of boundFieldArrays) {
    for (const f of arr) {
      if (!(CREDIT_NOTE_BOUND_FIELDS as readonly string[]).includes(f as string)) {
        throw new AppError(`Unknown credit note template bound field: ${f}`, 400);
      }
    }
  }
  for (const col of s.items?.columns ?? []) {
    if (!(CREDIT_NOTE_ITEM_COLUMNS as readonly string[]).includes(col)) {
      throw new AppError(`Unknown credit note template item column: ${col}`, 400);
    }
  }
  return layout as CreditNoteLayout;
}

// The safe built-in fallback layout for Credit Notes
export function buildDefaultCreditNoteLayout(): CreditNoteLayout {
  return {
    sections: {
      header: { showLogo: true, title: 'Credit Note', showBranchAddress: true },
      seller: { fields: ['seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.address', 'seller.city', 'seller.stateCode'] },
      buyer: { fields: ['buyer.name', 'buyer.gstin', 'buyer.pan', 'buyer.address', 'buyer.city', 'buyer.state'] },
      reference: { fields: ['creditNote.number', 'creditNote.date', 'creditNote.status', 'originalInvoice.number', 'originalInvoice.date', 'salesReturn.number', 'creditNote.reasonCode', 'creditNote.reasonNotes'] },
      items: { columns: ['srNo', 'description', 'hsnCode', 'grossWeight', 'netWeight', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalValue'] },
      totals: { fields: ['totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal'] },
      eInvoice: { enabled: true },
      footer: { showSignatory: true, showAcknowledgement: false, termsText: 'Credit Note issued under Section 34 of the CGST Act, 2017.' },
    },
  };
}

export async function listCreditNoteTemplates(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.creditNoteTemplate.findMany({
    where: { companyId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: { branch: { select: { id: true, name: true } } },
  }));
}

export async function getCreditNoteTemplateById(companyId: string, id: string) {
  const t = await tenantQuery(companyId, (tx) => tx.creditNoteTemplate.findUnique({ where: { id } }));
  if (!t || t.companyId !== companyId) throw new AppError('Credit note template not found', 404);
  return t;
}

export async function createCreditNoteTemplate(companyId: string, data: {
  name: string; description?: string; branchId?: string | null; layout: unknown; isDefault?: boolean; isActive?: boolean;
}, userId: string) {
  if (!data.name?.trim()) throw new AppError('Template name is required', 400);
  await assertOwnedIfPresent('branch', data.branchId, companyId, 'Branch');
  const layout = validateLayout(data.layout);

  return tenantTransaction(companyId, async (tx) => {
    if (data.isDefault && data.branchId) {
      throw new AppError('A branch-specific template cannot also be the company default', 400);
    }
    if (data.isDefault) {
      await tx.creditNoteTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.creditNoteTemplate.create({
      data: {
        companyId, name: data.name, description: data.description ?? null,
        branchId: data.branchId ?? null, layout: layout as unknown as Prisma.InputJsonValue,
        isDefault: data.isDefault ?? false, isActive: data.isActive ?? true, createdById: userId,
      },
    });
  });
}

export async function updateCreditNoteTemplate(companyId: string, id: string, data: {
  name?: string; description?: string | null; branchId?: string | null; layout?: unknown; isDefault?: boolean; isActive?: boolean;
}) {
  const existing = await getCreditNoteTemplateById(companyId, id);
  if (data.branchId !== undefined) await assertOwnedIfPresent('branch', data.branchId, companyId, 'Branch');
  const layout = data.layout !== undefined ? validateLayout(data.layout) : undefined;
  const branchId = data.branchId !== undefined ? data.branchId : existing.branchId;
  const willBeDefault = data.isDefault !== undefined ? data.isDefault : existing.isDefault;

  return tenantTransaction(companyId, async (tx) => {
    if (willBeDefault && branchId) {
      throw new AppError('A branch-specific template cannot also be the company default', 400);
    }
    if (data.isDefault) {
      await tx.creditNoteTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.creditNoteTemplate.update({
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

export async function duplicateCreditNoteTemplate(companyId: string, id: string, userId: string) {
  const t = await getCreditNoteTemplateById(companyId, id);
  return tenantQuery(companyId, (tx) => tx.creditNoteTemplate.create({
    data: {
      companyId, name: `${t.name} (Copy)`, description: t.description, branchId: null,
      layout: t.layout as Prisma.InputJsonValue, isDefault: false, isActive: true, createdById: userId,
    },
  }));
}

// Print-time resolution: explicit branch override, else company default, else safe built-in fallback
export async function resolveCreditNoteTemplate(companyId: string, branchId?: string | null): Promise<CreditNoteLayout> {
  if (branchId) {
    const branchTemplate = await tenantQuery(companyId, (tx) => tx.creditNoteTemplate.findFirst({
      where: { companyId, branchId, isActive: true },
    }));
    if (branchTemplate) return branchTemplate.layout as unknown as CreditNoteLayout;
  }

  const companyDefault = await tenantQuery(companyId, (tx) => tx.creditNoteTemplate.findFirst({
    where: { companyId, isDefault: true, isActive: true },
  }));
  if (companyDefault) return companyDefault.layout as unknown as CreditNoteLayout;

  return buildDefaultCreditNoteLayout();
}
