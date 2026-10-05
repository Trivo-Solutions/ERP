import { AppError } from '../middleware/error';

// A sale line's material breakdown: the per-bill copy of a tag's (or estimate's) material rows plus the making-charge /
// value-addition rates actually charged. It is the bill's own record — editing it never touches the JewelryTag, its
// materials or its costPrice. The server recomputes the line price from it with the SAME formula the client's
// utils/estimateCalc uses (Amount = Weight x Rate; MC = metal weight x MC rate; VA = metal value x VA%), so the stored
// price can never disagree with the stored rows.

export const BREAKDOWN_MATERIAL_TYPES = ['METAL', 'STONE', 'DIAMOND', 'FINDING', 'OTHER'];
const MAX_ROWS = 50;

export interface MaterialBreakdownRow {
  code: string; materialType: string; name: string; weight: number; unit: string; rate: number;
}
export interface MaterialBreakdown { rows: MaterialBreakdownRow[]; mcRate: number; vaPercent: number }

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
    };
  });
  const mcRate = num(b.mcRate ?? 0, 'Making charge rate');
  const vaPercent = num(b.vaPercent ?? 0, 'VA %');
  if (vaPercent > 100) throw new AppError('VA % cannot be more than 100', 400);

  const metal = rows.filter((r) => r.materialType === 'METAL');
  const metalWeight = metal.reduce((s, r) => s + r.weight, 0);
  const metalAmount = metal.reduce((s, r) => s + r.weight * r.rate, 0);
  const materialsAmount = rows.reduce((s, r) => s + r.weight * r.rate, 0);
  const making = metalWeight * mcRate + (metalAmount * vaPercent) / 100;

  return {
    normalized: { rows, mcRate, vaPercent } as MaterialBreakdown,
    metalWeight,
    making: round2(making),
    otherMaterials: round2(materialsAmount - metalAmount),
    total: round2(materialsAmount + making),
  };
}
