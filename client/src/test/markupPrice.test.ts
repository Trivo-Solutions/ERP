import { describe, it, expect } from 'vitest';
import { priceFromMarkup } from '../utils/markupPrice';

describe('priceFromMarkup', () => {
  it('cost 1000 at 20% -> 1200', () => expect(priceFromMarkup(1000, 20)).toBe(1200));
  it('accepts form strings', () => expect(priceFromMarkup('1000', '20')).toBe(1200));
  it('rounds to 2 dp', () => expect(priceFromMarkup(333.33, 12.4)).toBe(374.66));
  it('0% -> the cost itself', () => expect(priceFromMarkup(500, 0)).toBe(500));
  it('blank / invalid / non-positive cost leaves the price alone (null)', () => {
    expect(priceFromMarkup('', 20)).toBeNull();
    expect(priceFromMarkup(1000, '')).toBeNull();
    expect(priceFromMarkup('abc', 20)).toBeNull();
    expect(priceFromMarkup(0, 20)).toBeNull();
    expect(priceFromMarkup(-5, 20)).toBeNull();
    expect(priceFromMarkup(1000, -100)).toBeNull();
  });
});
