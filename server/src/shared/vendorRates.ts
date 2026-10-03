import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';
import { assertAllOwned } from '../middleware/tenant';
import { tenantQuery } from './tenantContext';

// Vendor component pricing (stone / pearl / bead cost rates): vendor master -> PO agreed rate -> GRN snapshot -> tag.
//
//   VendorComponentRate   the supplier's standing rate. Only a DEFAULT for a new PO line (resolveVendorComponentRate).
//   PoItemComponent       the rate agreed on one PO line — authoritative for that purchase, never rewritten by a
//                         later vendor-rate edit (resolvePoComponents writes it from a default or the buyer's override).
//   GrnItemComponentRate  a copy of the PO line's rates taken at receipt; tagging reads this (rateForTagMaterial).
//
// A component is identified by its StoneType, optionally narrowed to a StoneGrade (the variant / quality), plus the
// unit it is priced in. Nothing is guessed between candidates: two rates that could both apply are reported as
// AMBIGUOUS and the caller refuses, rather than one being picked arbitrarily.

export interface ComponentKey { stoneTypeId: string; stoneGradeId: string | null; unit: string }

export type VendorRateResolution =
  | { status: 'NONE' }
  | { status: 'MATCH'; rate: { id: string; costRate: number } }
  | { status: 'AMBIGUOUS'; candidates: Array<{ id: string; costRate: number; effectiveDate: Date }> };

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/**
 * The supplier's active rate for exactly this stone + grade + unit, as of `asOf`. Of the active rows whose effective
 * date is on or before `asOf`, the latest date wins — that is how a rate is superseded. Two rows sharing that latest
 * date are ambiguous. A graded request prefers its own grade's rate, else the vendor's grade-less ("any quality")
 * rate; a grade-less request matches only grade-less rates. Never another grade's rate.
 */
export async function resolveVendorComponentRate(
  companyId: string, supplierId: string, key: ComponentKey, asOf: Date,
): Promise<VendorRateResolution> {
  const find = (stoneGradeId: string | null) => tenantQuery(companyId, (tx) => tx.vendorComponentRate.findMany({
    where: { companyId, supplierId, isActive: true, stoneTypeId: key.stoneTypeId, stoneGradeId, unit: key.unit, effectiveDate: { lte: asOf } },
    orderBy: { effectiveDate: 'desc' },
  }));
  let rows = await find(key.stoneGradeId);
  if (rows.length === 0 && key.stoneGradeId) rows = await find(null);
  if (rows.length === 0) return { status: 'NONE' };
  const latest = rows.filter((r) => r.effectiveDate.getTime() === rows[0].effectiveDate.getTime());
  if (latest.length > 1) {
    return { status: 'AMBIGUOUS', candidates: latest.map((r) => ({ id: r.id, costRate: Number(r.costRate), effectiveDate: r.effectiveDate })) };
  }
  return { status: 'MATCH', rate: { id: latest[0].id, costRate: Number(latest[0].costRate) } };
}

export interface PoComponentInput { stoneTypeId: string; stoneGradeId?: string | null; unit?: string; costRate?: number | string | null }
export interface ResolvedPoComponent extends ComponentKey { costRate: number; rateSource: 'VENDOR_MASTER' | 'MANUAL' }

/**
 * Validates a PO line's component list and settles each rate: the buyer's own rate if one was typed (an override —
 * the vendor master is never touched), else the supplier's standing rate. No rate anywhere, or an ambiguous
 * master, is a 400 — a component with no rate is of no use and a guessed one is worse.
 */
export async function resolvePoComponents(
  companyId: string, supplierId: string, orderDate: Date, lineName: string, inputs: PoComponentInput[] | undefined,
): Promise<ResolvedPoComponent[]> {
  if (inputs === undefined || inputs === null) return [];
  if (!Array.isArray(inputs)) throw new AppError(`${lineName}: components must be a list`, 400);
  if (inputs.length === 0) return [];

  for (const c of inputs) {
    if (!c || typeof c.stoneTypeId !== 'string' || !c.stoneTypeId) throw new AppError(`${lineName}: each component needs a stone/pearl/bead type`, 400);
  }
  await assertAllOwned('stoneType', inputs.map((c) => c.stoneTypeId), companyId, 'Stone type');
  await assertAllOwned('stoneGrade', inputs.map((c) => c.stoneGradeId ?? undefined), companyId, 'Stone grade');

  const types = await tenantQuery(companyId, (tx) => tx.stoneType.findMany({
    where: { companyId, id: { in: inputs.map((c) => c.stoneTypeId) } }, select: { id: true, name: true, unit: true },
  }));
  const gradeIds = inputs.map((c) => c.stoneGradeId).filter((g): g is string => !!g);
  const grades = gradeIds.length === 0 ? [] : await tenantQuery(companyId, (tx) => tx.stoneGrade.findMany({
    where: { companyId, id: { in: gradeIds } }, select: { id: true, stoneTypeId: true },
  }));

  const seen = new Set<string>();
  const out: ResolvedPoComponent[] = [];
  for (const c of inputs) {
    const type = types.find((t) => t.id === c.stoneTypeId)!;
    const at = `${lineName}, component ${type.name}`;
    const stoneGradeId = c.stoneGradeId || null;
    if (stoneGradeId && grades.find((g) => g.id === stoneGradeId)?.stoneTypeId !== c.stoneTypeId) {
      throw new AppError(`${at}: the chosen grade does not belong to this stone type`, 400);
    }
    const unit = (c.unit || type.unit).toUpperCase();
    const key: ComponentKey = { stoneTypeId: c.stoneTypeId, stoneGradeId, unit };
    const dup = `${key.stoneTypeId}:${key.stoneGradeId ?? ''}:${key.unit}`;
    if (seen.has(dup)) throw new AppError(`${at}: listed twice on this line — give one rate per component, grade and unit`, 400);
    seen.add(dup);

    const given = c.costRate !== undefined && c.costRate !== null && c.costRate !== '';
    if (given) {
      const n = Number(c.costRate);
      if (!Number.isFinite(n) || n < 0) throw new AppError(`${at}: the rate must be a number, 0 or more`, 400);
      out.push({ ...key, costRate: round4(n), rateSource: 'MANUAL' });
      continue;
    }
    const found = await resolveVendorComponentRate(companyId, supplierId, key, orderDate);
    if (found.status === 'MATCH') out.push({ ...key, costRate: round4(found.rate.costRate), rateSource: 'VENDOR_MASTER' });
    else if (found.status === 'AMBIGUOUS') {
      throw new AppError(`${at}: more than one vendor rate (${found.candidates.map((x) => x.costRate).join(', ')}) applies — enter the rate on the PO, or fix the vendor's rate list`, 400);
    } else throw new AppError(`${at}: the vendor has no rate for this component — enter the rate on the PO`, 400);
  }
  return out;
}

/** Copies the PO line's agreed component rates onto a GRN line — a snapshot, written once, never recomputed. */
export async function snapshotGrnComponentRates(
  tx: Prisma.TransactionClient, companyId: string, grnItemId: string, poItemId: string,
) {
  const comps = await tx.poItemComponent.findMany({ where: { companyId, poItemId } });
  if (comps.length === 0) return;
  await tx.grnItemComponentRate.createMany({
    data: comps.map((c) => ({
      companyId, grnItemId, stoneTypeId: c.stoneTypeId, stoneGradeId: c.stoneGradeId, unit: c.unit, costRate: c.costRate,
    })),
  });
}

/**
 * The cost rate the received goods carry for one tag material row, or null when none applies. Matches the row's grade
 * (and so its stone type) and unit against the GRN snapshot: an exact stone+grade rate first, else the stone's
 * grade-less ("any quality") rate. Two snapshot rows can't share a key (resolvePoComponents rejects duplicates), so
 * nothing is chosen between candidates; a unit that differs is simply not applied — there is no unit conversion.
 */
export async function rateForTagMaterial(
  companyId: string, grnItemId: string, row: { stoneGradeId?: string | null; unit: string },
): Promise<number | null> {
  if (!row.stoneGradeId) return null;
  const grade = await tenantQuery(companyId, (tx) => tx.stoneGrade.findFirst({
    where: { id: row.stoneGradeId!, companyId }, select: { stoneTypeId: true },
  }));
  if (!grade) return null;
  const snaps = await tenantQuery(companyId, (tx) => tx.grnItemComponentRate.findMany({
    where: { companyId, grnItemId, stoneTypeId: grade.stoneTypeId, unit: row.unit.toUpperCase() },
  }));
  const exact = snaps.filter((s) => s.stoneGradeId === row.stoneGradeId);
  const pool = exact.length > 0 ? exact : snaps.filter((s) => s.stoneGradeId === null);
  return pool.length === 1 ? Number(pool[0].costRate) : null;
}

export async function assertVendorRateOwned(id: string, companyId: string) {
  const row = await tenantQuery(companyId, (tx) => tx.vendorComponentRate.findFirst({ where: { id, companyId } }));
  if (!row) throw new AppError('Vendor rate not found', 404);
  return row;
}
