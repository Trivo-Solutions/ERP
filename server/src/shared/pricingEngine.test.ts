import { describe, it, expect } from 'vitest';
import { computeRowsPricing, computeMakingAmount } from './pricingEngine';
import { priceMaterialBreakdown } from './materialBreakdown';
// The client's mirror of the same formula. If either side changes alone, the parity test below fails.
// (the client sits outside this package's tsc rootDir, so this one file is excluded from `tsc -p tsconfig.json`; vitest runs it)
import { computeEstimateTotals, computeLineAmount, computeMakingAmount as clientMaking } from '../../../client/src/utils/estimateCalc';

// The reference piece used across the pricing audit: 10 g metal @ 6000, 1 ct ruby @ 1500, MC 100/g, VA 10%.
const ring = [
  { materialType: 'METAL', weight: 10, rate: 6000 },
  { materialType: 'STONE', weight: 1, rate: 1500 },
];

describe('pricing engine (shared/pricingEngine.ts)', () => {
  it('prices the reference ring: metal 60000 + ruby 1500 + MC 1000 + VA 6000 = 68500 (VA is a % of metal value)', () => {
    const t = computeRowsPricing(ring, 100, 10);
    expect(t.metalAmount).toBe(60000);
    expect(t.mcAmount).toBe(1000);
    expect(t.vaAmount).toBe(6000);
    expect(t.otherMaterials).toBe(1500);
    expect(t.total).toBe(68500);
  });

  it('VA never touches stones or the making charge; MC and VA are zero without a METAL row', () => {
    expect(computeMakingAmount(0, 0, 100, 10)).toBe(0);
    expect(computeRowsPricing([{ materialType: 'STONE', weight: 2, rate: 1000 }], 100, 10).total).toBe(2000);
  });

  it('the sale-line breakdown (priceMaterialBreakdown) uses the same engine and rounds once, to 2 dp', () => {
    const bd = priceMaterialBreakdown({ rows: ring.map((r) => ({ ...r, code: 'X', name: 'X', unit: 'GM' })), mcRate: 100, vaPercent: 10 });
    expect(bd.total).toBe(68500);
    expect(bd.making).toBe(7000);
    expect(bd.otherMaterials).toBe(1500);
    expect(priceMaterialBreakdown({ rows: [{ materialType: 'METAL', code: 'M', name: 'M', unit: 'GM', weight: 3.333, rate: 6001.37 }], mcRate: 99.99, vaPercent: 7.5 }).total)
      .toBe(Math.round(computeRowsPricing([{ materialType: 'METAL', weight: 3.333, rate: 6001.37 }], 99.99, 7.5).total * 100) / 100);
  });

  it('parity: the client mirror (utils/estimateCalc) gives the same numbers as the server engine on a spread of inputs', () => {
    const cases: Array<{ rows: typeof ring; mc: number; va: number }> = [
      { rows: ring, mc: 100, va: 10 },
      { rows: [{ materialType: 'METAL', weight: 9.125, rate: 6543.21 }, { materialType: 'DIAMOND', weight: 0.37, rate: 81234.5 }, { materialType: 'METAL', weight: 1.5, rate: 6543.21 }], mc: 187.5, va: 12.75 },
      { rows: [{ materialType: 'STONE', weight: 4, rate: 250 }], mc: 500, va: 25 },
      { rows: [], mc: 100, va: 10 },
    ];
    for (const c of cases) {
      const server = computeRowsPricing(c.rows, c.mc, c.va);
      const client = computeEstimateTotals(
        c.rows.map((r: { materialType: string; weight: number; rate: number }) => ({ materialType: r.materialType, weight: r.weight, saleAmount: computeLineAmount(r.weight, r.rate) })),
        { saleMcRate: c.mc, saleVaPercent: c.va },
      );
      expect(client.totalSaleAmount).toBeCloseTo(server.total, 6);
      expect(client.makingSaleAmount).toBeCloseTo(server.making, 6);
      expect(clientMaking(server.metalWeight, server.metalAmount, c.mc, c.va)).toBeCloseTo(computeMakingAmount(server.metalWeight, server.metalAmount, c.mc, c.va), 6);
    }
  });
});
