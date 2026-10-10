import { describe, it, expect } from 'vitest';
import { resolveOffer, OfferLike, OfferRuleLike, PieceRates } from './offerResolver';

const rule = (o: Partial<OfferRuleLike> & Pick<OfferRuleLike, 'component' | 'mode' | 'value'>): OfferRuleLike => ({ id: `r${Math.random()}`, ...o });
const offer = (o: Partial<OfferLike> & { rules: OfferRuleLike[] }): OfferLike => ({
  id: `o${Math.random()}`, name: 'Offer', priority: 0, createdAt: new Date('2026-01-01'),
  effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', isActive: true, ...o,
});
// Ruby 1500/ct, CST 3000/ct, MC 1500/g, VA 18% — the example from the brief.
const piece: PieceRates = {
  categoryId: 'cat1', karat: '22K', branchId: 'b1', mcRate: 1500, vaPercent: 18,
  rows: [
    { key: 'gold', materialType: 'METAL', rate: 6000 },
    { key: 'ruby', materialType: 'STONE', stoneTypeId: 'ruby', rate: 1500 },
    { key: 'cst', materialType: 'STONE', stoneTypeId: 'cst', rate: 3000 },
  ],
};
const DAY = '2026-10-15';

describe('resolveOffer', () => {
  it('50% off MC and VA', () => {
    const r = resolveOffer([offer({ rules: [
      rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 }),
      rule({ component: 'VA', mode: 'PERCENT_OFF', value: 50 }),
    ] })], piece, DAY);
    expect(r.mc).toMatchObject({ baseRate: 1500, offerRate: 750 });
    expect(r.va).toMatchObject({ baseRate: 18, offerRate: 9 });
    expect(r.rows).toEqual({});
  });

  it('per stone type: percent on one, fixed rate on another; metal untouched', () => {
    const r = resolveOffer([offer({ rules: [
      rule({ component: 'STONE', mode: 'PERCENT_OFF', value: 50, stoneTypeId: 'ruby' }),
      rule({ component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: 'cst' }),
    ] })], piece, DAY);
    expect(r.rows.ruby.offerRate).toBe(750);
    expect(r.rows.cst.offerRate).toBe(800);
    expect(r.rows.gold).toBeUndefined();
  });

  it('a fixed rate never raises a price: stone at 700 under an 800 fixed offer is left alone', () => {
    const p: PieceRates = { ...piece, rows: [{ key: 'a', materialType: 'STONE', stoneTypeId: 'ruby', rate: 700 }] };
    const r = resolveOffer([offer({ rules: [rule({ component: 'STONE', mode: 'FIXED_RATE', value: 800 })] })], p, DAY);
    expect(r.offer).toBeNull();
    expect(r.rows).toEqual({});
  });

  it('a rule with no stone type covers every stone, but a specific rule beats it', () => {
    const r = resolveOffer([offer({ rules: [
      rule({ component: 'STONE', mode: 'PERCENT_OFF', value: 10 }),
      rule({ component: 'STONE', mode: 'PERCENT_OFF', value: 40, stoneTypeId: 'ruby' }),
    ] })], piece, DAY);
    expect(r.rows.ruby.offerRate).toBe(900);
    expect(r.rows.cst.offerRate).toBe(2700);
  });

  it('specificity beats size: a narrower smaller discount wins over a broader bigger one', () => {
    const r = resolveOffer([offer({ rules: [
      rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 60 }),
      rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 20, categoryId: 'cat1' }),
    ] })], piece, DAY);
    expect(r.mc?.offerRate).toBe(1200);
  });

  it('category and karat rules only match their own piece', () => {
    const other = offer({ rules: [
      rule({ component: 'VA', mode: 'PERCENT_OFF', value: 50, categoryId: 'catX' }),
      rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50, karat: '18K' }),
    ] });
    expect(resolveOffer([other], piece, DAY).offer).toBeNull();
    expect(resolveOffer([other], { ...piece, categoryId: 'catX', karat: '18K' }, DAY).mc?.offerRate).toBe(750);
  });

  it('inclusive date window, open-ended end, and inactive offers', () => {
    const rules = [rule({ component: 'VA', mode: 'PERCENT_OFF', value: 50 })];
    expect(resolveOffer([offer({ rules })], piece, '2026-10-01').va).not.toBeNull();
    expect(resolveOffer([offer({ rules })], piece, '2026-10-31').va).not.toBeNull();
    expect(resolveOffer([offer({ rules })], piece, '2026-09-30').offer).toBeNull();
    expect(resolveOffer([offer({ rules })], piece, '2026-11-01').offer).toBeNull();
    expect(resolveOffer([offer({ rules, effectiveTo: null })], piece, '2030-01-01').va).not.toBeNull();
    expect(resolveOffer([offer({ rules, isActive: false })], piece, DAY).offer).toBeNull();
  });

  it('branch-scoped offer only applies at that branch', () => {
    const rules = [rule({ component: 'VA', mode: 'PERCENT_OFF', value: 50 })];
    expect(resolveOffer([offer({ rules, branchId: 'b2' })], piece, DAY).offer).toBeNull();
    expect(resolveOffer([offer({ rules, branchId: 'b1' })], piece, DAY).va).not.toBeNull();
  });

  it('NO STACKING: only the highest-priority offer applies, nothing from the other', () => {
    const lowMc = offer({ id: 'low', priority: 1, rules: [rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 90 })] });
    const highVa = offer({ id: 'high', priority: 5, rules: [rule({ component: 'VA', mode: 'PERCENT_OFF', value: 10 })] });
    const r = resolveOffer([lowMc, highVa], piece, DAY);
    expect(r.offer?.id).toBe('high');
    expect(r.va?.offerRate).toBe(16.2);
    expect(r.mc).toBeNull();
  });

  it('equal priority: the newest offer wins', () => {
    const rules = [rule({ component: 'VA', mode: 'PERCENT_OFF', value: 10 })];
    const older = offer({ id: 'old', createdAt: new Date('2026-01-01'), rules });
    const newer = offer({ id: 'new', createdAt: new Date('2026-02-01'), rules });
    expect(resolveOffer([older, newer], piece, DAY).offer?.id).toBe('new');
  });

  it('a higher-priority offer that changes nothing does not shadow one that does', () => {
    const noop = offer({ id: 'noop', priority: 9, rules: [rule({ component: 'STONE', mode: 'FIXED_RATE', value: 9999 })] });
    const real = offer({ id: 'real', priority: 1, rules: [rule({ component: 'VA', mode: 'PERCENT_OFF', value: 50 })] });
    expect(resolveOffer([noop, real], piece, DAY).offer?.id).toBe('real');
  });

  it('metal rule lowers the gold row only; MC fixed rate is rupees per gram', () => {
    const r = resolveOffer([offer({ rules: [
      rule({ component: 'METAL', mode: 'PERCENT_OFF', value: 1 }),
      rule({ component: 'MAKING_CHARGE', mode: 'FIXED_RATE', value: 1000 }),
    ] })], piece, DAY);
    expect(r.rows.gold.offerRate).toBe(5940);
    expect(r.mc?.offerRate).toBe(1000);
    expect(r.rows.ruby).toBeUndefined();
  });

  it('a zero or missing base rate is never adjusted', () => {
    const r = resolveOffer([offer({ rules: [rule({ component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 })] })], { ...piece, mcRate: 0 }, DAY);
    expect(r.offer).toBeNull();
  });
});
