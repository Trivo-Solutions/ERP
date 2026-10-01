import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedIfPresent } from '../../middleware/tenant';
import { tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { DEBIT_NOTE_BOUND_FIELDS, DEBIT_NOTE_ITEM_COLUMNS } from '../../shared/debitNoteBoundFields';

// G2e — CRUD for the Debit Note print template. Structurally mirrors CreditNoteTemplate (one Json
// `layout` column, branchId override or company default, whitelisted bound fields) — branchId is
// kept on the model for structural parity even though purchase has no per-branch GST identity
// (PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §10); resolveDebitNoteTemplate below deliberately
// takes no branchId parameter for that reason.
export interface DebitNoteLayout {
  sections: {
    header: { showLogo: boolean; title: string; showBranchAddress: boolean };
    seller: { fields: string[] };
    supplier: { fields: string[] };
    reference: { fields: string[] };
    items: { columns: string[] };
    totals: { fields: string[] };
    footer: { termsText?: string; showSignatory: boolean; showAcknowledgement: boolean; notesText?: string };
  };
}

function validateLayout(layout: unknown): DebitNoteLayout {
  if (!layout || typeof layout !== 'object' || !(layout as any).sections) {
    throw new AppError('Template layout must be an object with a "sections" key', 400);
  }
  const s = (layout as any).sections;
  const boundFieldArrays: unknown[][] = [s.seller?.fields, s.supplier?.fields, s.reference?.fields, s.totals?.fields].filter(Boolean);
  for (const arr of boundFieldArrays) {
    for (const f of arr) {
      if (!(DEBIT_NOTE_BOUND_FIELDS as readonly string[]).includes(f as string)) {
        throw new AppError(`Unknown debit note template bound field: ${f}`, 400);
      }
    }
  }
  for (const col of s.items?.columns ?? []) {
    if (!(DEBIT_NOTE_ITEM_COLUMNS as readonly string[]).includes(col)) {
      throw new AppError(`Unknown debit note template item column: ${col}`, 400);
    }
  }
  return layout as DebitNoteLayout;
}

// The safe built-in fallback layout for Debit Notes
export function buildDefaultDebitNoteLayout(): DebitNoteLayout {
  return {
    sections: {
      header: { showLogo: true, title: 'Debit Note', showBranchAddress: true },
      seller: { fields: ['seller.legalName', 'seller.tradeName', 'seller.gstin', 'seller.address', 'seller.city', 'seller.stateCode'] },
      supplier: { fields: ['supplier.name', 'supplier.gstin', 'supplier.pan', 'supplier.address', 'supplier.city', 'supplier.state'] },
      reference: { fields: ['debitNote.number', 'debitNote.date', 'debitNote.status', 'originalGrn.number', 'originalGrn.date', 'supplierInvoice.number', 'supplierInvoice.date', 'purchaseReturn.number', 'debitNote.reasonCode', 'debitNote.reasonNotes'] },
      items: { columns: ['srNo', 'description', 'hsnCode', 'grossWeight', 'netWeight', 'taxableValue', 'cgstAmount', 'sgstAmount', 'igstAmount', 'totalValue'] },
      totals: { fields: ['totals.taxableValue', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.totalTax', 'totals.grandTotal'] },
      footer: { showSignatory: true, showAcknowledgement: false, termsText: 'Debit Note issued for adjustment against Goods Receipt Note.' },
    },
  };
}

export async function listDebitNoteTemplates(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.debitNoteTemplate.findMany({
    where: { companyId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    include: { branch: { select: { id: true, name: true } } },
  }));
}

export async function getDebitNoteTemplateById(companyId: string, id: string) {
  const t = await tenantQuery(companyId, (tx) => tx.debitNoteTemplate.findUnique({ where: { id } }));
  if (!t || t.companyId !== companyId) throw new AppError('Debit note template not found', 404);
  return t;
}

export async function createDebitNoteTemplate(companyId: string, data: {
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
      await tx.debitNoteTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.debitNoteTemplate.create({
      data: {
        companyId, name: data.name, description: data.description ?? null,
        branchId: data.branchId ?? null, layout: layout as unknown as Prisma.InputJsonValue,
        isDefault: data.isDefault ?? false, isActive: data.isActive ?? true, createdById: userId,
      },
    });
  });
}

export async function updateDebitNoteTemplate(companyId: string, id: string, data: {
  name?: string; description?: string | null; branchId?: string | null; layout?: unknown; isDefault?: boolean; isActive?: boolean;
}) {
  const existing = await getDebitNoteTemplateById(companyId, id);
  if (data.branchId !== undefined) await assertOwnedIfPresent('branch', data.branchId, companyId, 'Branch');
  const layout = data.layout !== undefined ? validateLayout(data.layout) : undefined;
  const branchId = data.branchId !== undefined ? data.branchId : existing.branchId;
  const willBeDefault = data.isDefault !== undefined ? data.isDefault : existing.isDefault;

  return tenantTransaction(companyId, async (tx) => {
    if (willBeDefault && branchId) {
      throw new AppError('A branch-specific template cannot also be the company default', 400);
    }
    if (data.isDefault) {
      await tx.debitNoteTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.debitNoteTemplate.update({
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

export async function duplicateDebitNoteTemplate(companyId: string, id: string, userId: string) {
  const t = await getDebitNoteTemplateById(companyId, id);
  return tenantQuery(companyId, (tx) => tx.debitNoteTemplate.create({
    data: {
      companyId, name: `${t.name} (Copy)`, description: t.description, branchId: null,
      layout: t.layout as Prisma.InputJsonValue, isDefault: false, isActive: true, createdById: userId,
    },
  }));
}

// Print-time resolution: company default, else safe built-in fallback — no branch tier (§10 of the
// design doc: purchase has no per-branch GST identity), unlike resolveCreditNoteTemplate's 3-tier lookup.
export async function resolveDebitNoteTemplate(companyId: string): Promise<DebitNoteLayout> {
  const companyDefault = await tenantQuery(companyId, (tx) => tx.debitNoteTemplate.findFirst({
    where: { companyId, isDefault: true, isActive: true },
  }));
  if (companyDefault) return companyDefault.layout as unknown as DebitNoteLayout;

  return buildDefaultDebitNoteLayout();
}
