import { describe, it, expect } from 'vitest';
import {
  isValidFinancialYear,
  formatFinancialYear,
  parseFinancialYear,
  getPrecedingFinancialYear,
  getSucceedingFinancialYear,
  getFinancialYearForDate,
  getFinancialYearDateBounds,
  normalizeFinancialYear,
} from './financialYear';

describe('financialYear', () => {
  describe('isValidFinancialYear', () => {
    it('accepts valid Indian FY strings', () => {
      expect(isValidFinancialYear('2023-24')).toBe(true);
      expect(isValidFinancialYear('2024-25')).toBe(true);
      expect(isValidFinancialYear('2025-26')).toBe(true);
      expect(isValidFinancialYear('1999-00')).toBe(true);
      expect(isValidFinancialYear('2099-00')).toBe(true);
    });

    it('rejects invalid or non-matching FY strings', () => {
      expect(isValidFinancialYear('2024-26')).toBe(false); // skipped year
      expect(isValidFinancialYear('2024-24')).toBe(false); // same year
      expect(isValidFinancialYear('2024-23')).toBe(false); // reversed
      expect(isValidFinancialYear('2024')).toBe(false);    // single year
      expect(isValidFinancialYear('2024-2025')).toBe(false); // 4-digit end
      expect(isValidFinancialYear('FY24-25')).toBe(false);
      expect(isValidFinancialYear('')).toBe(false);
      expect(isValidFinancialYear(null)).toBe(false);
      expect(isValidFinancialYear(undefined)).toBe(false);
      expect(isValidFinancialYear(2024)).toBe(false);
    });
  });

  describe('formatFinancialYear & parseFinancialYear', () => {
    it('formats year numbers correctly', () => {
      expect(formatFinancialYear(2024)).toBe('2024-25');
      expect(formatFinancialYear(2008)).toBe('2008-09');
      expect(formatFinancialYear(2009)).toBe('2009-10');
      expect(formatFinancialYear(1999)).toBe('1999-00');
    });

    it('parses valid FY strings into start and end years', () => {
      expect(parseFinancialYear('2024-25')).toEqual({ startYear: 2024, endYear: 2025 });
      expect(parseFinancialYear('1999-00')).toEqual({ startYear: 1999, endYear: 2000 });
    });

    it('throws on invalid FY string in parseFinancialYear', () => {
      expect(() => parseFinancialYear('invalid')).toThrow(/Invalid Indian financial year/);
    });
  });

  describe('getPrecedingFinancialYear & getSucceedingFinancialYear', () => {
    it('returns the correct preceding financial year', () => {
      expect(getPrecedingFinancialYear('2024-25')).toBe('2023-24');
      expect(getPrecedingFinancialYear('2023-24')).toBe('2022-23');
      expect(getPrecedingFinancialYear('2000-01')).toBe('1999-00');
      expect(getPrecedingFinancialYear('2001-02')).toBe('2000-01');
    });

    it('returns the correct succeeding financial year', () => {
      expect(getSucceedingFinancialYear('2023-24')).toBe('2024-25');
      expect(getSucceedingFinancialYear('2024-25')).toBe('2025-26');
      expect(getSucceedingFinancialYear('1999-00')).toBe('2000-01');
    });
  });

  describe('getFinancialYearForDate (Indian FY logic)', () => {
    it('resolves April to December to current calendar year start', () => {
      // 1 April 2024 IST
      expect(getFinancialYearForDate(new Date('2024-04-01T00:00:00+05:30'))).toBe('2024-25');
      // 15 August 2024 IST
      expect(getFinancialYearForDate(new Date('2024-08-15T12:00:00+05:30'))).toBe('2024-25');
      // 31 December 2024 IST
      expect(getFinancialYearForDate(new Date('2024-12-31T23:59:59+05:30'))).toBe('2024-25');
    });

    it('resolves January to March to preceding calendar year start', () => {
      // 1 January 2025 IST -> still FY 2024-25
      expect(getFinancialYearForDate(new Date('2025-01-01T00:00:00+05:30'))).toBe('2024-25');
      // 28 February 2025 IST -> still FY 2024-25
      expect(getFinancialYearForDate(new Date('2025-02-28T12:00:00+05:30'))).toBe('2024-25');
      // 31 March 2025 23:59:59 IST -> last moment of FY 2024-25
      expect(getFinancialYearForDate(new Date('2025-03-31T23:59:59+05:30'))).toBe('2024-25');
      // 1 April 2025 00:00:00 IST -> begins FY 2025-26
      expect(getFinancialYearForDate(new Date('2025-04-01T00:00:00+05:30'))).toBe('2025-26');
    });

    it('handles IST midnight boundary correctly across UTC', () => {
      // 31 March 2024 18:30:00 UTC = 1 April 2024 00:00:00 IST -> FY 2024-25
      expect(getFinancialYearForDate(new Date('2024-03-31T18:30:00.000Z'))).toBe('2024-25');
      // 31 March 2024 18:29:59 UTC = 31 March 2024 23:59:59 IST -> FY 2023-24
      expect(getFinancialYearForDate(new Date('2024-03-31T18:29:59.000Z'))).toBe('2023-24');
    });
  });

  describe('getFinancialYearDateBounds', () => {
    it('returns exact IST boundaries for FY 2024-25', () => {
      const bounds = getFinancialYearDateBounds('2024-25');
      // 1 April 2024 00:00:00 IST = 31 March 2024 18:30:00 UTC
      expect(bounds.start.toISOString()).toBe('2024-03-31T18:30:00.000Z');
      // 31 March 2025 23:59:59.999 IST = 31 March 2025 18:29:59.999 UTC
      expect(bounds.end.toISOString()).toBe('2025-03-31T18:29:59.999Z');
    });
  });

  describe('normalizeFinancialYear', () => {
    it('normalizes valid FY strings without changes', () => {
      expect(normalizeFinancialYear('2024-25')).toBe('2024-25');
      expect(normalizeFinancialYear('  2024-25  ')).toBe('2024-25');
    });

    it('normalizes 4-digit start year strings and numbers', () => {
      expect(normalizeFinancialYear('2024')).toBe('2024-25');
      expect(normalizeFinancialYear(2024)).toBe('2024-25');
    });

    it('normalizes full year range strings', () => {
      expect(normalizeFinancialYear('2024-2025')).toBe('2024-25');
    });

    it('normalizes Date objects', () => {
      expect(normalizeFinancialYear(new Date('2024-05-10T10:00:00Z'))).toBe('2024-25');
    });

    it('returns null for unparseable input', () => {
      expect(normalizeFinancialYear('2024-2026')).toBeNull();
      expect(normalizeFinancialYear('invalid')).toBeNull();
      expect(normalizeFinancialYear(null)).toBeNull();
      expect(normalizeFinancialYear(undefined)).toBeNull();
      expect(normalizeFinancialYear('')).toBeNull();
    });
  });
});
