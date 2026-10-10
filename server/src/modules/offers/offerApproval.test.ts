import { describe, it, expect } from 'vitest';
import { OfferFloor, belowOffer, discountRateHash, floorFromResolution, floorFromSnapshot, lineRateHash } from './offerApproval';

const floor: OfferFloor = { offerId: 'o1', offerName: 'Festive', mcRate: 750, vaPercent: 9, rows: { ruby: 800 } };
const line = (o: { mc?: number; va?: number; ruby?: number; extraId?: string } = {}) => ({
  mcRate: o.mc ?? 750, vaPercent: o.va ?? 9,
  rows: [
    { code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', rate: 6000, materialId: 'gold' },
    { code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: o.ruby ?? 800, materialId: o.extraId ?? 'ruby' },
  ],
});

describe('belowOffer', () => {
  it('is null at the offered rates and above them - zero tolerance means one paisa below is caught', () => {
    expect(belowOffer(floor, line())).toBeNull();
    expect(belowOffer(floor, line({ mc: 1500, va: 18, ruby: 1500 }))).toBeNull();
    expect(belowOffer(floor, line({ ruby: 799.99 }))?.requested.rows).toEqual([{ materialId: 'ruby', rate: 799.99, code: 'RUBY' }]);
  });
  it('reports only the components that are below, with the offered figure beside each', () => {
    const b = belowOffer(floor, line({ mc: 600, ruby: 700 }))!;
    expect(b.requested).toMatchObject({ mcRate: 600, rows: [{ materialId: 'ruby', rate: 700 }] });
    expect(b.requested.vaPercent).toBeUndefined();
    expect(b.offered).toMatchObject({ mcRate: 750, rows: [{ materialId: 'ruby', rate: 800 }] });
  });
  it('a component the offer did not lower, or a row with no materialId, has no floor', () => {
    expect(belowOffer({ ...floor, mcRate: null, vaPercent: null }, line({ mc: 1, va: 1 }))).toBeNull();
    expect(belowOffer(floor, line({ ruby: 1, extraId: undefined as any }))?.requested.rows).toHaveLength(1);
    const noId = line({ ruby: 1 }); delete (noId.rows[1] as any).materialId;
    expect(belowOffer(floor, noId)).toBeNull();
  });
});

describe('hashes', () => {
  it('are tied to the piece and the exact figures, not to labels', () => {
    const a = belowOffer(floor, line({ ruby: 700 }))!.requested;
    const b = belowOffer(floor, line({ ruby: 700 }))!.requested;
    const labelled = { ...a, rows: a.rows.map((r) => ({ ...r, code: 'something else' })) };
    expect(lineRateHash('t1', a)).toBe(lineRateHash('t1', b));
    expect(lineRateHash('t1', a)).toBe(lineRateHash('t1', labelled));
    expect(lineRateHash('t2', a)).not.toBe(lineRateHash('t1', a));
    expect(lineRateHash('t1', belowOffer(floor, line({ ruby: 699 }))!.requested)).not.toBe(lineRateHash('t1', a));
  });
  it('a discount hash is the amount to the paisa', () => {
    expect(discountRateHash(500)).toBe(discountRateHash(500.001));
    expect(discountRateHash(500)).not.toBe(discountRateHash(500.5));
  });
});

describe('floors', () => {
  it('from a resolution: only lowered components', () => {
    const f = floorFromResolution({
      offer: { id: 'o', name: 'N' }, mc: { baseRate: 1500, offerRate: 750, ruleId: 'r', mode: 'PERCENT_OFF', value: 50 }, va: null,
      rows: { ruby: { baseRate: 1500, offerRate: 800, ruleId: 'r', mode: 'FIXED_RATE', value: 800 } },
    })!;
    expect(f).toEqual({ offerId: 'o', offerName: 'N', mcRate: 750, vaPercent: null, rows: { ruby: 800 } });
    expect(floorFromResolution({ offer: null, mc: null, va: null, rows: {} })).toBeNull();
  });
  it('from a stored snapshot; none when it predates offered rates', () => {
    const rows = [{ code: 'R', materialType: 'STONE', name: 'R', weight: 1, unit: 'CT', rate: 800, materialId: 'ruby', baseRate: 1500, offerRate: 800 }];
    expect(floorFromSnapshot({ rows, mcRate: 750, vaPercent: 9, offer: { id: 'o', name: 'N', baseMcRate: 1500, baseVaPercent: 18, mcRate: 750 } }))
      .toEqual({ offerId: 'o', offerName: 'N', mcRate: 750, vaPercent: null, rows: { ruby: 800 } });
    expect(floorFromSnapshot({ rows: [{ ...rows[0], offerRate: undefined }], mcRate: 1, vaPercent: 1, offer: { id: 'o', name: 'N', baseMcRate: 1, baseVaPercent: 1 } })).toBeNull();
    expect(floorFromSnapshot({ rows, mcRate: 1, vaPercent: 1 })).toBeNull();
  });
});
