import { describe, it, expect } from 'vitest';
import { GST_UQC_CODES, isValidGstUqc, normalizeGstUqc } from './gstUqc';

describe('gstUqc', () => {
  describe('isValidGstUqc', () => {
    it('accepts every code in the published catalog', () => {
      for (const code of GST_UQC_CODES) {
        expect(isValidGstUqc(code)).toBe(true);
      }
    });

    it('rejects a code not in the catalog', () => {
      expect(isValidGstUqc('KGM')).toBe(false); // not on the list (KGS is)
      expect(isValidGstUqc('GRAMS')).toBe(false);
      expect(isValidGstUqc('')).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isValidGstUqc(undefined)).toBe(false);
      expect(isValidGstUqc(null)).toBe(false);
      expect(isValidGstUqc(123)).toBe(false);
      expect(isValidGstUqc({})).toBe(false);
    });

    it('is strict on case — lower/mixed case is not accepted directly', () => {
      expect(isValidGstUqc('gms')).toBe(false);
      expect(isValidGstUqc('Gms')).toBe(false);
      expect(isValidGstUqc('GMS')).toBe(true);
    });
  });

  describe('normalizeGstUqc', () => {
    it('resolves an already-canonical code to itself', () => {
      expect(normalizeGstUqc('PCS')).toBe('PCS');
    });

    it('normalizes case and surrounding whitespace to the canonical code', () => {
      expect(normalizeGstUqc('gms')).toBe('GMS');
      expect(normalizeGstUqc('Pcs')).toBe('PCS');
      expect(normalizeGstUqc('  nos  ')).toBe('NOS');
    });

    it('returns null for an unrecognized code', () => {
      expect(normalizeGstUqc('GRAMS')).toBeNull();
      expect(normalizeGstUqc('kgm')).toBeNull();
    });

    it('returns null for non-string / empty input rather than throwing', () => {
      expect(normalizeGstUqc(undefined)).toBeNull();
      expect(normalizeGstUqc(null)).toBeNull();
      expect(normalizeGstUqc('')).toBeNull();
      expect(normalizeGstUqc(42)).toBeNull();
    });
  });

  describe('catalog shape', () => {
    it('has no duplicate codes', () => {
      expect(new Set(GST_UQC_CODES).size).toBe(GST_UQC_CODES.length);
    });

    it('every code is 3 characters, upper-case', () => {
      for (const code of GST_UQC_CODES) {
        expect(code).toMatch(/^[A-Z]{3}$/);
      }
    });

    it('includes LTR (LITRES) — the code the official e-waybill/GST UQC master carries that the initial catalog omitted', () => {
      expect(GST_UQC_CODES).toContain('LTR');
      expect(isValidGstUqc('LTR')).toBe(true);
    });

    it('includes the two codes this business actually needs today: GMS and PCS', () => {
      expect(GST_UQC_CODES).toContain('GMS');
      expect(GST_UQC_CODES).toContain('PCS');
    });
  });
});
