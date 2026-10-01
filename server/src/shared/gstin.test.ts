import { describe, it, expect } from 'vitest';
import { validateGstin, normalizeGstin } from './gstin';

// Fixture GSTINs below have their check digit (character 15) computed by the same published
// GSTIN checksum algorithm this module implements — see gstin.ts's file-level compliance
// disclaimer. '24AAAAA0000A1Z8' is the module's own reference example (also used, sans a real
// checksum, as company.service.ts's format-example message).
const VALID_GSTIN = '24AAAAA0000A1Z8';

describe('gstin: normalizeGstin', () => {
  it('trims and upper-cases', () => {
    expect(normalizeGstin('  24aaaaa0000a1z8  ')).toBe('24AAAAA0000A1Z8');
  });

  it('null/undefined/empty all normalize to empty string', () => {
    expect(normalizeGstin(null)).toBe('');
    expect(normalizeGstin(undefined)).toBe('');
    expect(normalizeGstin('')).toBe('');
  });
});

describe('gstin: validateGstin', () => {
  it('accepts a structurally + checksum-valid GSTIN', () => {
    const result = validateGstin(VALID_GSTIN);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.gstin).toBe(VALID_GSTIN);
    expect(result.stateCode).toBe('24');
    expect(result.pan).toBe('AAAAA0000A');
    expect(result.entityCode).toBe('1');
  });

  it('normalizes lowercase input before validating', () => {
    const result = validateGstin(VALID_GSTIN.toLowerCase());
    expect(result.valid).toBe(true);
    expect(result.gstin).toBe(VALID_GSTIN);
  });

  it('normalizes surrounding whitespace before validating', () => {
    const result = validateGstin(`  ${VALID_GSTIN}  `);
    expect(result.valid).toBe(true);
    expect(result.gstin).toBe(VALID_GSTIN);
  });

  it('rejects null/undefined/empty input', () => {
    for (const input of [null, undefined, '', '   ']) {
      const result = validateGstin(input);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects the wrong length', () => {
    const short = validateGstin(VALID_GSTIN.slice(0, 14));
    expect(short.valid).toBe(false);
    expect(short.errors[0]).toMatch(/15 characters/);

    const long = validateGstin(`${VALID_GSTIN}X`);
    expect(long.valid).toBe(false);
    expect(long.errors[0]).toMatch(/15 characters/);
  });

  it('rejects invalid characters', () => {
    const result = validateGstin('24AAAAA0000A1Z#'); // '#' is out of alphabet, still 15 chars
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /digits and upper-case letters/.test(e))).toBe(true);
  });

  it('rejects an unrecognized state code', () => {
    // '00' is 2 digits (passes shape) but not an allotted GST state/UT code.
    const candidate = `00${VALID_GSTIN.slice(2)}`;
    const result = validateGstin(candidate);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /state\/UT code/.test(e))).toBe(true);
  });

  it('rejects an invalid PAN structure', () => {
    // Digits where PAN expects letters (positions 3-7 must be letters).
    const candidate = `24123450000A1Z8`;
    const result = validateGstin(candidate);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /PAN segment/.test(e))).toBe(true);
  });

  it('rejects an invalid checksum', () => {
    // Flip the check digit to something that cannot also be correct.
    const wrongCheckDigit = VALID_GSTIN[14] === '8' ? '9' : '8';
    const candidate = `${VALID_GSTIN.slice(0, 14)}${wrongCheckDigit}`;
    const result = validateGstin(candidate);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Checksum/.test(e))).toBe(true);
  });

  it("rejects a missing literal 'Z' at character 14", () => {
    const candidate = `${VALID_GSTIN.slice(0, 13)}Y${VALID_GSTIN.slice(14)}`;
    const result = validateGstin(candidate);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Character 14/.test(e))).toBe(true);
  });

  it('rejects an out-of-range entity/registration code', () => {
    // Entity code (character 13) must be 1-9 or A-Z; '0' is out of range.
    const candidate = `24AAAAA0000A0Z8`;
    const result = validateGstin(candidate);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Entity\/registration code/.test(e))).toBe(true);
  });
});
