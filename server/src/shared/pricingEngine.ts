// The ONE sale/cost pricing formula on the server. Every place that prices a piece from material rows - the sale line's
// material breakdown (shared/materialBreakdown.ts), the estimate's saved totals (estimation.service.ts), the custom
// per-gram line (sales.service.ts priceInvoice) - calls these, so they cannot drift apart. The client mirrors them in
// client/src/utils/estimateCalc.ts; pricingEngine.parity.test.ts fails if the two ever disagree.
//
//   Material row amount = weight x rate                (plain, never rounded per row)
//   Making charge (MC)  = total METAL weight x MC rate (a flat Rs-per-gram labour rate)
//   Value addition (VA) = METAL amount x VA% / 100     (a % of the metal's own value - never of MC, never of stones)
//   Total               = all rows + MC + VA           (rounded once, by the caller, to 2 dp)

export interface PricingRow { materialType: string; weight: number; rate: number }

export function computeMakingAmount(metalWeight: number, metalValue: number, mcRate: number, vaPercent: number): number {
  return metalWeight * mcRate + (metalValue * vaPercent) / 100;
}

export function computeRowsPricing(rows: PricingRow[], mcRate: number, vaPercent: number) {
  const metal = rows.filter((r) => r.materialType === 'METAL');
  const metalWeight = metal.reduce((s, r) => s + r.weight, 0);
  const metalAmount = metal.reduce((s, r) => s + r.weight * r.rate, 0);
  const materialsAmount = rows.reduce((s, r) => s + r.weight * r.rate, 0);
  const mcAmount = metalWeight * mcRate;
  const vaAmount = (metalAmount * vaPercent) / 100;
  return {
    metalWeight, metalAmount, materialsAmount, mcAmount, vaAmount,
    making: mcAmount + vaAmount,
    otherMaterials: materialsAmount - metalAmount,
    total: materialsAmount + mcAmount + vaAmount,
  };
}
