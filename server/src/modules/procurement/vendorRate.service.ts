import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany, assertOwnedIfPresent } from '../../middleware/tenant';
import { TenantContext, tenantQuery } from '../../shared/tenantContext';
import { assertVendorRateOwned, resolveVendorComponentRate } from '../../shared/vendorRates';

// A supplier's standing cost rates for stone / pearl / bead components. They only ever DEFAULT a new PO line (see
// shared/vendorRates.ts): editing or deactivating one here never changes an existing PO or GRN.

const INCLUDE = {
  supplier: { select: { id: true, name: true } },
  stoneType: { select: { id: true, name: true, unit: true } },
  stoneGrade: { select: { id: true, shape: true, color: true, clarity: true, cut: true, quality: true } },
} as const;

function parseRate(v: unknown): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) throw new AppError('Cost rate must be a number, 0 or more', 400);
  return n;
}

export async function listVendorRates(ctx: TenantContext, q: { supplierId?: string; activeOnly?: boolean }) {
  if (q.supplierId !== undefined) await assertOwnedByCompany('supplier', q.supplierId, ctx.companyId, 'Supplier');
  return tenantQuery(ctx.companyId, (tx) => tx.vendorComponentRate.findMany({
    where: { companyId: ctx.companyId, ...(q.supplierId ? { supplierId: q.supplierId } : {}), ...(q.activeOnly ? { isActive: true } : {}) },
    include: INCLUDE,
    orderBy: [{ supplier: { name: 'asc' } }, { effectiveDate: 'desc' }],
  }));
}

/**
 * What a new PO line would default to for this vendor + component + grade + unit as of `asOf` — the same resolver the
 * PO create uses, exposed read-only so the PO screen shows the backend's answer instead of re-deriving it.
 */
export async function previewVendorRate(ctx: TenantContext, q: { supplierId: string; stoneTypeId: string; stoneGradeId?: string; unit?: string; asOf?: Date }) {
  await assertOwnedByCompany('supplier', q.supplierId, ctx.companyId, 'Supplier');
  await assertOwnedByCompany('stoneType', q.stoneTypeId, ctx.companyId, 'Stone type');
  await assertOwnedIfPresent('stoneGrade', q.stoneGradeId || undefined, ctx.companyId, 'Stone grade');
  const type = await tenantQuery(ctx.companyId, (tx) => tx.stoneType.findFirstOrThrow({ where: { id: q.stoneTypeId, companyId: ctx.companyId }, select: { unit: true } }));
  const stoneGradeId = q.stoneGradeId || null;
  if (stoneGradeId) {
    const g = await tenantQuery(ctx.companyId, (tx) => tx.stoneGrade.findFirst({ where: { id: stoneGradeId, companyId: ctx.companyId }, select: { stoneTypeId: true } }));
    if (g?.stoneTypeId !== q.stoneTypeId) throw new AppError('The chosen grade does not belong to this stone type', 400);
  }
  const unit = (q.unit || type.unit).toUpperCase();
  const found = await resolveVendorComponentRate(ctx.companyId, q.supplierId, { stoneTypeId: q.stoneTypeId, stoneGradeId, unit }, q.asOf ?? new Date());
  return { unit, ...found };
}

export async function createVendorRate(ctx: TenantContext, userId: string, data: {
  supplierId: string; stoneTypeId: string; stoneGradeId?: string | null; unit?: string;
  costRate: number | string; effectiveDate?: Date; notes?: string;
}) {
  await assertOwnedByCompany('supplier', data.supplierId, ctx.companyId, 'Supplier');
  await assertOwnedByCompany('stoneType', data.stoneTypeId, ctx.companyId, 'Stone type');
  await assertOwnedIfPresent('stoneGrade', data.stoneGradeId || undefined, ctx.companyId, 'Stone grade');
  const type = await tenantQuery(ctx.companyId, (tx) => tx.stoneType.findFirstOrThrow({ where: { id: data.stoneTypeId, companyId: ctx.companyId }, select: { unit: true } }));
  const stoneGradeId = data.stoneGradeId || null;
  if (stoneGradeId) {
    const g = await tenantQuery(ctx.companyId, (tx) => tx.stoneGrade.findFirst({ where: { id: stoneGradeId, companyId: ctx.companyId }, select: { stoneTypeId: true } }));
    if (g?.stoneTypeId !== data.stoneTypeId) throw new AppError('The chosen grade does not belong to this stone type', 400);
  }
  const unit = (data.unit || type.unit).toUpperCase();
  const effectiveDate = data.effectiveDate ?? new Date();

  // Two active rates for the same component on the same day could not be told apart — refuse at the source.
  const clash = await tenantQuery(ctx.companyId, (tx) => tx.vendorComponentRate.count({
    where: { companyId: ctx.companyId, supplierId: data.supplierId, stoneTypeId: data.stoneTypeId, stoneGradeId, unit, isActive: true, effectiveDate },
  }));
  if (clash > 0) throw new AppError('This vendor already has an active rate for this component with the same effective date — change that one, or use a later date', 409);

  const row = await tenantQuery(ctx.companyId, (tx) => tx.vendorComponentRate.create({
    data: {
      companyId: ctx.companyId, supplierId: data.supplierId, stoneTypeId: data.stoneTypeId, stoneGradeId, unit,
      costRate: parseRate(data.costRate), effectiveDate, notes: data.notes,
    },
    include: INCLUDE,
  }));
  await createAuditEntry('vendor_component_rates', row.id, userId, 'CREATE', undefined, { costRate: Number(row.costRate), unit }, ctx.companyId);
  return row;
}

/** Only the rate, notes and active flag change; what a rate is FOR (vendor / stone / grade / unit) is fixed — add a new one instead. */
export async function updateVendorRate(ctx: TenantContext, userId: string, id: string, data: { costRate?: number | string; notes?: string; isActive?: boolean }) {
  const before = await assertVendorRateOwned(id, ctx.companyId);
  const patch: { costRate?: number; notes?: string; isActive?: boolean } = {};
  if (data.costRate !== undefined) patch.costRate = parseRate(data.costRate);
  if (data.notes !== undefined) patch.notes = String(data.notes);
  if (data.isActive !== undefined) patch.isActive = Boolean(data.isActive);
  const row = await tenantQuery(ctx.companyId, (tx) => tx.vendorComponentRate.update({ where: { id: before.id }, data: patch, include: INCLUDE }));
  await createAuditEntry('vendor_component_rates', id, userId, 'EDIT',
    { costRate: Number(before.costRate), isActive: before.isActive }, { costRate: Number(row.costRate), isActive: row.isActive }, ctx.companyId);
  return row;
}
