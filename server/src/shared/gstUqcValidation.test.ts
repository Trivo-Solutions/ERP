import { describe, it, expect } from 'vitest';
import { validateUqc } from './gstUqcValidation';

describe('gstUqcValidation', () => {
  it('validates canonical GST UQC codes as VALID', () => {
    const resGms = validateUqc('GMS');
    expect(resGms.valid).toBe(true);
    expect(resGms.status).toBe('VALID');
    expect(resGms.canonicalCode).toBe('GMS');
    expect(resGms.issue).toBeNull();

    const resPcs = validateUqc('PCS');
    expect(resPcs.valid).toBe(true);
    expect(resPcs.status).toBe('VALID');
    expect(resPcs.canonicalCode).toBe('PCS');

    const resNos = validateUqc('NOS');
    expect(resNos.valid).toBe(true);
    expect(resNos.status).toBe('VALID');
  });

  it('validates lower/mixed case codes as NORMALIZED', () => {
    const resLower = validateUqc('gms');
    expect(resLower.valid).toBe(true);
    expect(resLower.status).toBe('NORMALIZED');
    expect(resLower.canonicalCode).toBe('GMS');
    expect(resLower.issue?.code).toBe('UQC_NORMALIZED');

    const resMixed = validateUqc('  Pcs  ');
    expect(resMixed.valid).toBe(true);
    expect(resMixed.status).toBe('NORMALIZED');
    expect(resMixed.canonicalCode).toBe('PCS');
  });

  it('detects missing UQC inputs', () => {
    expect(validateUqc(undefined).status).toBe('MISSING');
    expect(validateUqc(null).status).toBe('MISSING');
    expect(validateUqc('').status).toBe('MISSING');
    expect(validateUqc('   ').status).toBe('MISSING');
    expect(validateUqc(null).valid).toBe(false);
  });

  it('flags non-string inputs as INVALID', () => {
    const res = validateUqc(12345);
    expect(res.valid).toBe(false);
    expect(res.status).toBe('INVALID');
    expect(res.issue?.code).toBe('INVALID_UQC_TYPE');
  });

  it('detects common informal units as UNSUPPORTED and suggests standard code', () => {
    const resGrams = validateUqc('GRAMS');
    expect(resGrams.valid).toBe(false);
    expect(resGrams.status).toBe('UNSUPPORTED');
    expect(resGrams.canonicalCode).toBe('GMS');
    expect(resGrams.issue?.code).toBe('UNSUPPORTED_UQC');
    expect(resGrams.issue?.message).toContain('GMS');

    const resPieces = validateUqc('PIECES');
    expect(resPieces.valid).toBe(false);
    expect(resPieces.status).toBe('UNSUPPORTED');
    expect(resPieces.canonicalCode).toBe('PCS');

    const resKg = validateUqc('KG');
    expect(resKg.valid).toBe(false);
    expect(resKg.status).toBe('UNSUPPORTED');
    expect(resKg.canonicalCode).toBe('KGS');
  });

  it('rejects completely unrecognized UQC codes as INVALID', () => {
    const res = validateUqc('XYZ123');
    expect(res.valid).toBe(false);
    expect(res.status).toBe('INVALID');
    expect(res.canonicalCode).toBeNull();
    expect(res.issue?.code).toBe('INVALID_UQC');
  });
});
