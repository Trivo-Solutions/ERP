// Shared rate/amount + making-charge math, used by both NewTagPage.tsx's Materials/MC & VA tabs
// (creating a tag) and EstimationPage.tsx (quoting an existing tag) — kept as one place so the two
// screens can never drift into computing a customer's price differently.

export interface MakingChargeMasterRow {
  materialCodeId?: string | null;
  karat?: string | null;
  categoryId?: string | null;
  makeType?: string | null;
  makingCharge: number | string;
  saleWastagePercent: number | string;
}

// One material line's Amount = Weight × Rate, plain. The making-charge/VA markup is applied once
// at the tag/estimate level against the metal totals (see computeMakingAmount), not per row.
export function computeLineAmount(weight: number, rate: number): number {
  return Number(weight || 0) * Number(rate || 0);
}

// Most-specific-match-wins lookup by karat + category + makeType — mirrors sales.service.ts's
// findMakingCharge (server) exactly: a master row only matches when every field IT has pinned
// (non-null) agrees with the tag/estimate; among matches, the row pinning the most dimensions wins.
export function findMakingCharge<T extends MakingChargeMasterRow>(
  makingCharges: T[],
  karat: string | undefined,
  categoryId: string | undefined,
  makeType: string | undefined,
): T | null {
  const eligible = makingCharges.filter((m) =>
    (m.karat == null || m.karat === karat) &&
    (m.categoryId == null || m.categoryId === categoryId) &&
    (m.makeType == null || m.makeType === makeType)
  );
  if (eligible.length === 0) return null;
  const specificity = (m: T) => (m.karat != null ? 1 : 0) + (m.categoryId != null ? 1 : 0) + (m.makeType != null ? 1 : 0);
  const bestScore = Math.max(...eligible.map(specificity));
  return eligible.find((m) => specificity(m) === bestScore) ?? null;
}

// Making Charge is a flat ₹/gram labour rate → Amount = metal weight × rate. Value Addition/
// wastage is a % of the metal's own value → Amount = metal value × VA%/100. Applied once against
// metal totals, never per material line (a stone row never enters this calc).
export function computeMakingAmount(metalWeight: number, metalValueAmount: number, mcRate: number, vaPercent: number): number {
  return Number(metalWeight || 0) * Number(mcRate || 0) + (Number(metalValueAmount || 0) * Number(vaPercent || 0)) / 100;
}

export interface EstimateLineLike {
  materialType: string;
  weight: number | string;
  costAmount?: number | string;
  saleAmount?: number | string;
}

// Rolls a materials list + MC/VA rates into the four totals every estimate/tag ultimately needs:
// materials-only cost/sale, and grand cost/sale (materials + making charge).
export function computeEstimateTotals(
  items: EstimateLineLike[],
  mcVa: { costMcRate?: number; costVaPercent?: number; saleMcRate?: number; saleVaPercent?: number },
) {
  const metalWeight = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + Number(i.weight || 0), 0);
  const metalCostAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + Number(i.costAmount || 0), 0);
  const metalSaleAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + Number(i.saleAmount || 0), 0);

  const materialsCostAmt = items.reduce((s, i) => s + Number(i.costAmount || 0), 0);
  const materialsSaleAmt = items.reduce((s, i) => s + Number(i.saleAmount || 0), 0);

  const makingCostAmount = computeMakingAmount(metalWeight, metalCostAmt, mcVa.costMcRate ?? 0, mcVa.costVaPercent ?? 0);
  const makingSaleAmount = computeMakingAmount(metalWeight, metalSaleAmt, mcVa.saleMcRate ?? 0, mcVa.saleVaPercent ?? 0);

  return {
    metalWeight, materialsCostAmt, materialsSaleAmt, makingCostAmount, makingSaleAmount,
    totalCostAmount: materialsCostAmt + makingCostAmount,
    totalSaleAmount: materialsSaleAmt + makingSaleAmount,
  };
}

export const FIXED_PRICE_PER_PIECE = 'FIXED_PRICE_PER_PIECE';
export const isFixedPriceTag = (tag: { pricingMode?: string | null } | null | undefined): boolean => tag?.pricingMode === FIXED_PRICE_PER_PIECE;

// What the Estimation screen shows as the quote for a tag. A fixed-price-per-piece tag is quoted at its own saved GST-exclusive
// sellingPrice and nothing else: its material rows (kept only for weights / inventory), the day's metal rate, MC and VA never
// enter. Mirrors estimation.service.ts: createTagEstimate's `fixed` branch (the server is authoritative; this is the preview).
export function quoteTotals(
  tag: { pricingMode?: string | null; sellingPrice?: number | string | null },
  items: EstimateLineLike[],
  mcVa: { saleMcRate?: number; saleVaPercent?: number },
  fixedAmount?: number | string | null, // the estimator's amount for this quote; defaults to the tag's saved price
) {
  if (isFixedPriceTag(tag)) {
    const price = Math.round(Number(fixedAmount ?? tag.sellingPrice ?? 0) * 100) / 100;
    return { metalWeight: 0, materialsSaleAmt: price, makingSaleAmount: 0, totalSaleAmount: price };
  }
  const t = computeEstimateTotals(items, mcVa);
  return { metalWeight: t.metalWeight, materialsSaleAmt: t.materialsSaleAmt, makingSaleAmount: t.makingSaleAmount, totalSaleAmount: t.totalSaleAmount };
}
