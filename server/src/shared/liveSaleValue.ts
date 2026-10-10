import { Prisma } from '@prisma/client';
import { tenantQuery } from './tenantContext';
import { resolveLiveMetalRate } from './metalRate';
import { computeRowsPricing } from './pricingEngine';

// What a piece would sell for TODAY: its metal at the day's rate for its karat (the one live element), and everything else
// from the tag's own stored sale columns (MC rate, VA %, stone sale rates), through the one pricing engine. Stock-side reports
// show this next to the cost price. The tag's stored `sellingPrice` is only the figure from the day it was tagged and is NOT
// used here. A piece that cannot be priced (a sale rate missing on the tag, or no metal rate on file for its karat) has no
// live value - it is reported as unpriced, never as 0.
export interface LiveValueTag {
  metalKarat: string | null;
  netWeight: unknown;
  saleMcRate: unknown;
  saleVaPercent: unknown;
  materials: Array<{ materialType: string; weight: unknown; saleRate: unknown }>;
}

export const LIVE_VALUE_TAG_SELECT = {
  metalKarat: true, netWeight: true, saleMcRate: true, saleVaPercent: true,
  materials: { select: { materialType: true, weight: true, saleRate: true } },
} as const;

/** Today's metal rate for each distinct karat (one lookup per karat, not per piece). A karat with no rate is simply absent. */
export async function loadLiveRates(companyId: string, karats: Iterable<string | null | undefined>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const k of new Set([...karats].filter((x): x is string => !!x))) {
    const live = await resolveLiveMetalRate(companyId, k);
    if (live) out.set(k, live.ratePerGram);
  }
  return out;
}

export function liveSaleValue(tag: LiveValueTag, rateByKarat: Map<string, number>): number | null {
  if (tag.saleMcRate == null || tag.saleVaPercent == null) return null;
  const metalRate = tag.metalKarat ? rateByKarat.get(tag.metalKarat) : undefined;
  const rows: Array<{ materialType: string; weight: number; rate: number }> = [];
  if (tag.materials.length === 0) {
    if (metalRate === undefined) return null;
    rows.push({ materialType: 'METAL', weight: Number(tag.netWeight), rate: metalRate }); // a bought-in piece with no material rows
  } else {
    for (const m of tag.materials) {
      if (m.materialType === 'METAL') {
        if (metalRate === undefined) return null;
        rows.push({ materialType: 'METAL', weight: Number(m.weight), rate: metalRate });
      } else {
        if (m.saleRate == null) return null;
        rows.push({ materialType: m.materialType, weight: Number(m.weight), rate: Number(m.saleRate) });
      }
    }
  }
  return Math.round(computeRowsPricing(rows, Number(tag.saleMcRate), Number(tag.saleVaPercent)).total * 100) / 100;
}

/**
 * Live sale value of every piece matching `where`, summed by `keyOf`. Returns per-key { value, unpriced } so a report can show the
 * live total and say how many pieces could not be priced. Company scope comes from the caller's `where` (companyId is required there).
 */
export async function liveValueByKey<K extends string>(
  companyId: string, where: Prisma.JewelryTagWhereInput, keyOf: (t: { branchId: string; categoryId: string | null }) => K,
): Promise<Map<K, { value: number; unpriced: number }>> {
  const tags = await tenantQuery(companyId, (_tx) => _tx.jewelryTag.findMany({
    where: { ...where, companyId }, select: { branchId: true, categoryId: true, ...LIVE_VALUE_TAG_SELECT },
  }));
  const rates = await loadLiveRates(companyId, tags.map((t) => t.metalKarat));
  const out = new Map<K, { value: number; unpriced: number }>();
  for (const t of tags) {
    const k = keyOf(t);
    const cur = out.get(k) ?? { value: 0, unpriced: 0 };
    const v = liveSaleValue(t, rates);
    if (v === null) cur.unpriced += 1; else cur.value += v;
    out.set(k, cur);
  }
  return out;
}
