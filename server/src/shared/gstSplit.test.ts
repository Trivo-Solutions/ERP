import { describe, it, expect } from 'vitest';
import { splitGst } from './gstSplit';

describe('splitGst', () => {
  describe('same-state (CGST + SGST)', () => {
    it('splits a normal GST rate evenly', () => {
      expect(splitGst(300, true)).toEqual({ cgst: 150, sgst: 150, igst: 0 });
    });

    it('splits a fractional taxable amount evenly, including the float remainder', () => {
      expect(splitGst(100.75, true)).toEqual({ cgst: 50.375, sgst: 50.375, igst: 0 });
    });

    it('produces zero tax for a zero-GST (fully-discounted) sale', () => {
      expect(splitGst(0, true)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    });
  });

  describe('inter-state (IGST)', () => {
    it('assigns the whole amount to IGST at a normal GST rate', () => {
      expect(splitGst(300, false)).toEqual({ cgst: 0, sgst: 0, igst: 300 });
    });

    it('assigns a fractional taxable amount to IGST without splitting it', () => {
      expect(splitGst(100.75, false)).toEqual({ cgst: 0, sgst: 0, igst: 100.75 });
    });

    it('produces zero tax for a zero-GST (fully-discounted) sale', () => {
      expect(splitGst(0, false)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    });
  });

  describe('rounding / precision (no rounding is performed by the helper itself)', () => {
    it('preserves an odd-paisa taxable amount as a raw half rather than rounding it', () => {
      // 1 / 2 = 0.5 exactly, but 0.03 / 2 hits a binary-float remainder — the helper must not
      // round it away, since callers (sales.service.ts) round only where they always did.
      const result = splitGst(0.03, true);
      expect(result.cgst).toBeCloseTo(0.015, 10);
      expect(result.sgst).toBeCloseTo(0.015, 10);
      expect(result.igst).toBe(0);
    });

    it('is a pure function: repeated calls with the same input return the same output', () => {
      expect(splitGst(1234.56, true)).toEqual(splitGst(1234.56, true));
      expect(splitGst(1234.56, false)).toEqual(splitGst(1234.56, false));
    });
  });
});
