import { AppError } from '../middleware/error';
import { computeRowsPricing } from './pricingEngine';

// A sale line's material breakdown: the per-bill copy of a tag's (or estimate's) material rows plus the making-charge /
// value-addition rates actually charged. It is the bill's own record — editing it never touches the JewelryTag, its
// materials or its costPrice. The server recomputes the line price from it with the SAME formula the client's
// utils/estimateCalc uses (Amount = Weight x Rate; MC = metal weight x MC rate; VA = metal value x VA%), so the stored
// price can never disagree with the stored rows.

export const BREAKDOWN_MATERIAL_TYPES = ['METAL', 'STONE', 'DIAMOND', 'FINDING', 'OTHER'];
const MAX_ROWS = 50;

export interface MaterialBreakdownRow {
  code: string; materialType: string; name: string; weight: number; unit: string; rate: number;
  /** The tag's own material row this came from (lets an applied offer find the row's tagged rate). Informational. */
  materialId?: string;
  /** The tagged rate before an offer lowered it. Set ONLY by the server (attachOfferSnapshot), never taken from a client. */
  baseRate?: number;
  /** The rate the applied offer gave this row (the floor below which selling needs a manager's approval). Server-set only. */
  offerRate?: number;
}
export interface MaterialBreakdownOffer {
  id: string; name: string; baseMcRate: number; baseVaPercent: number;
  /** The offered MC / VA the offer gave (absent when it did not lower that component). Server-set only. */
  mcRate?: number; vaPercent?: number;
}
export interface MaterialBreakdown { rows: MaterialBreakdownRow[]; mcRate: number; vaPercent: number; offer?: MaterialBreakdownOffer }

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown, label: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new AppError(`${label} must be a number of 0 or more`, 400);
  return n;
}

export function priceMaterialBreakdown(input: unknown) {
  const b = input as Partial<MaterialBreakdown> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.rows)) throw new AppError('materialBreakdown must have a rows list', 400);
  if (b.rows.length > MAX_ROWS) throw new AppError(`materialBreakdown can have at most ${MAX_ROWS} rows`, 400);

  const rows: MaterialBreakdownRow[] = b.rows.map((r, idx) => {
    if (!r || typeof r !== 'object') throw new AppError(`Material row ${idx + 1} is invalid`, 400);
    if (!BREAKDOWN_MATERIAL_TYPES.includes(r.materialType)) throw new AppError(`Material row ${idx + 1}: unknown type ${String(r.materialType)}`, 400);
    return {
      code: String(r.code ?? '').slice(0, 60), materialType: r.materialType, name: String(r.name ?? '').slice(0, 120),
      weight: num(r.weight, `Material row ${idx + 1} weight`), unit: String(r.unit ?? 'GM').slice(0, 10),
      rate: num(r.rate, `Material row ${idx + 1} rate`),
      ...(typeof r.materialId === 'string' && r.materialId ? { materialId: r.materialId.slice(0, 40) } : {}),
    };
  });
  const mcRate = num(b.mcRate ?? 0, 'Making charge rate');
  const vaPercent = num(b.vaPercent ?? 0, 'VA %');
  if (vaPercent > 100) throw new AppError('VA % cannot be more than 100', 400);

  const t = computeRowsPricing(rows, mcRate, vaPercent);

  return {
    // The client may ASK for an offer (offerApplied); what is stored is only what the server then attaches.
    wantsOffer: (b as { offerApplied?: unknown }).offerApplied === true,
    normalized: { rows, mcRate, vaPercent } as MaterialBreakdown,
    metalWeight: t.metalWeight,
    making: round2(t.making),
    otherMaterials: round2(t.otherMaterials),
    total: round2(t.total),
  };
}

/**
 * Stamps the offer that was applied to a line onto its stored breakdown: which offer, and the tagged MC/VA and per-row
 * rates it lowered (looked up by the row's materialId). Everything comes from the server's own resolution or from the
 * line's previously stored snapshot - a client-supplied `offer` / `baseRate` never survives priceMaterialBreakdown.
 */
export function attachOfferSnapshot(
  b: MaterialBreakdown,
  snap: {
    offer: { id: string; name: string }; baseMcRate: number; baseVaPercent: number; baseRateByMaterialId: Map<string, number>;
    /** The rates the offer gave (step 3's approval floor); a component the offer did not lower is simply absent. */
    offerMcRate?: number; offerVaPercent?: number; offerRateByMaterialId?: Map<string, number>;
  },
): MaterialBreakdown {
  return {
    ...b,
    rows: b.rows.map((r) => {
      const base = r.materialId ? snap.baseRateByMaterialId.get(r.materialId) : undefined;
      const offered = r.materialId ? snap.offerRateByMaterialId?.get(r.materialId) : undefined;
      return base === undefined ? r : { ...r, baseRate: base, ...(offered !== undefined && { offerRate: offered }) };
    }),
    offer: {
      id: snap.offer.id, name: snap.offer.name, baseMcRate: snap.baseMcRate, baseVaPercent: snap.baseVaPercent,
      ...(snap.offerMcRate !== undefined && { mcRate: snap.offerMcRate }),
      ...(snap.offerVaPercent !== undefined && { vaPercent: snap.offerVaPercent }),
    },
  };
}
