import { describe, it, expect } from 'vitest';
import { quoteTotals, computeLineAmount } from '../utils/estimateCalc';

// PHF-style fixed-price piece whose Silver row would price at 12.5 g x 90 = 1125 (+ MC/VA) on the weight-based model.
const silverRows = (rate: number, weight = 12.5) => [{ materialType: 'METAL', weight, saleAmount: computeLineAmount(weight, rate) }];
const fixedTag = { pricingMode: 'FIXED_PRICE_PER_PIECE', sellingPrice: '750' };
const weightTag = { pricingMode: 'WEIGHT_BASED', sellingPrice: '750' };

describe('quoteTotals - fixed price per piece', () => {
  it('quotes the saved price, not weight x daily silver rate', () => {
    const t = quoteTotals(fixedTag, silverRows(90), { saleMcRate: 10, saleVaPercent: 5 });
    expect(t.totalSaleAmount).toBe(750);
    expect(t.makingSaleAmount).toBe(0);
  });
  it('does not move when sample weight changes', () => {
    expect(quoteTotals(fixedTag, silverRows(90, 3), {}).totalSaleAmount).toBe(750);
    expect(quoteTotals(fixedTag, silverRows(90, 40), {}).totalSaleAmount).toBe(750);
  });
  it('does not move when the daily metal rate changes', () => {
    expect(quoteTotals(fixedTag, silverRows(50), {}).totalSaleAmount).toBe(750);
    expect(quoteTotals(fixedTag, silverRows(500), {}).totalSaleAmount).toBe(750);
  });
  it('MC / VA never add to the fixed base price', () => {
    expect(quoteTotals(fixedTag, silverRows(90), { saleMcRate: 100, saleVaPercent: 50 }).totalSaleAmount).toBe(750);
  });
  it('works with a non-silver material and with no rows at all', () => {
    expect(quoteTotals(fixedTag, [{ materialType: 'STONE', weight: 2, saleAmount: 999 }], {}).totalSaleAmount).toBe(750);
    expect(quoteTotals(fixedTag, [], {}).totalSaleAmount).toBe(750);
  });
});

describe('quoteTotals - weight-based categories unchanged', () => {
  it('Silver weight-based: metal value + MC + VA', () => {
    // 12.5 x 90 = 1125; MC 10 x 12.5 = 125; VA 5% of 1125 = 56.25
    const t = quoteTotals(weightTag, silverRows(90), { saleMcRate: 10, saleVaPercent: 5 });
    expect(t.totalSaleAmount).toBeCloseTo(1306.25, 2);
    expect(t.makingSaleAmount).toBeCloseTo(181.25, 2);
  });
  it('a tag with no pricingMode (legacy) is weight-based', () => {
    expect(quoteTotals({}, silverRows(90), {}).totalSaleAmount).toBe(1125);
  });
});
