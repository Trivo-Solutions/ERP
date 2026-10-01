import { IST_OFFSET_MS } from './compliance';

/**
 * Standard Indian Financial Year format regex: "YYYY-YY", e.g. "2024-25".
 * In Indian fiscal accounting, the financial year runs from 1 April of year YYYY
 * to 31 March of year YYYY+1.
 */
export const FINANCIAL_YEAR_REGEX = /^(\d{4})-(\d{2})$/;

/**
 * Validates whether a given string is a valid Indian financial year string (e.g. "2024-25").
 * Ensures the second part matches the subsequent calendar year modulo 100.
 */
export function isValidFinancialYear(fy: unknown): fy is string {
  if (typeof fy !== 'string') return false;
  const match = fy.trim().match(FINANCIAL_YEAR_REGEX);
  if (!match) return false;

  const startYear = parseInt(match[1], 10);
  const endYearShort = parseInt(match[2], 10);
  const expectedEndShort = (startYear + 1) % 100;

  return endYearShort === expectedEndShort;
}

/**
 * Formats a start year (e.g. 2024) into standard Indian FY format "2024-25".
 */
export function formatFinancialYear(startYear: number): string {
  const endYearShort = (startYear + 1) % 100;
  const endStr = endYearShort < 10 ? `0${endYearShort}` : `${endYearShort}`;
  return `${startYear}-${endStr}`;
}

/**
 * Parses an Indian FY string into startYear and endYear numbers.
 * E.g. "2024-25" -> { startYear: 2024, endYear: 2025 }
 */
export function parseFinancialYear(fy: string): { startYear: number; endYear: number } {
  if (!isValidFinancialYear(fy)) {
    throw new Error(`Invalid Indian financial year format: "${fy}". Expected "YYYY-YY" (e.g. "2024-25").`);
  }
  const startYear = parseInt(fy.substring(0, 4), 10);
  return { startYear, endYear: startYear + 1 };
}

/**
 * Returns the preceding Indian financial year.
 * E.g. "2024-25" -> "2023-24", "2000-01" -> "1999-00"
 */
export function getPrecedingFinancialYear(fy: string): string {
  const { startYear } = parseFinancialYear(fy);
  return formatFinancialYear(startYear - 1);
}

/**
 * Returns the succeeding Indian financial year.
 * E.g. "2024-25" -> "2025-26"
 */
export function getSucceedingFinancialYear(fy: string): string {
  const { startYear } = parseFinancialYear(fy);
  return formatFinancialYear(startYear + 1);
}

/**
 * Determines the Indian financial year string for a given date, anchored in IST (Asia/Kolkata +5:30).
 * Indian FY starts 1 April (month index 3) and ends 31 March (month index 2).
 */
export function getFinancialYearForDate(date: Date = new Date()): string {
  const istShifted = new Date(date.getTime() + IST_OFFSET_MS);
  const istYear = istShifted.getUTCFullYear();
  const istMonth = istShifted.getUTCMonth(); // 0 = Jan, 2 = Mar, 3 = Apr, 11 = Dec
  const fyStartYear = istMonth >= 3 ? istYear : istYear - 1;
  return formatFinancialYear(fyStartYear);
}

/**
 * Resolves the start and end Date boundaries (in UTC) for a given Indian financial year,
 * strictly covering 1 April 00:00:00.000 IST to 31 March 23:59:59.999 IST.
 */
export function getFinancialYearDateBounds(fy: string): { start: Date; end: Date } {
  const { startYear, endYear } = parseFinancialYear(fy);
  // April 1 00:00:00.000 IST is March 31 18:30:00.000 UTC
  const startMs = Date.UTC(startYear, 3, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  // March 31 23:59:59.999 IST is March 31 18:29:59.999 UTC
  const endMs = Date.UTC(endYear, 2, 31, 23, 59, 59, 999) - IST_OFFSET_MS;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
  };
}

/**
 * Tolerant normalizer for financial year input.
 * Accepts:
 * - "2024-25" -> "2024-25"
 * - "2024-2025" -> "2024-25"
 * - 2024 (number) -> "2024-25"
 * - "2024" (string of 4 digits) -> "2024-25"
 * - Date object -> current FY for date
 */
export function normalizeFinancialYear(input: unknown): string | null {
  if (!input) return null;
  if (input instanceof Date) {
    return getFinancialYearForDate(input);
  }
  if (typeof input === 'number' && Number.isInteger(input) && input >= 1900 && input <= 2100) {
    return formatFinancialYear(input);
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (isValidFinancialYear(trimmed)) {
      return trimmed;
    }
    // Check 4-digit year like "2024"
    if (/^\d{4}$/.test(trimmed)) {
      const year = parseInt(trimmed, 10);
      if (year >= 1900 && year <= 2100) {
        return formatFinancialYear(year);
      }
    }
    // Check full year range like "2024-2025"
    const fullMatch = String(trimmed).match(/^(\d{4})-(\d{4})$/);
    if (fullMatch) {
      const start = parseInt(fullMatch[1], 10);
      const end = parseInt(fullMatch[2], 10);
      if (end === start + 1) {
        return formatFinancialYear(start);
      }
    }
  }
  return null;
}

/**
 * Returns the current Indian financial year string for today's date in IST.
 */
export function getCurrentFinancialYear(): string {
  return getFinancialYearForDate(new Date());
}
