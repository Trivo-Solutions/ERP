import { describe, it, expect, vi } from 'vitest';
import {
  validateGstinCompliance,
  validateHsnCompliance,
  validateUqcCompliance,
  validateGstCompliance,
} from './gstCompliance';

describe('gstCompliance', () => {
  describe('validateGstinCompliance', () => {
    it('detects missing GSTIN as ERROR', () => {
      const res = validateGstinCompliance('');
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0].code).toBe('MISSING_GSTIN');
      expect(res.errors[0].field).toBe('gstin');
    });

    it('detects structurally invalid GSTIN as ERROR', () => {
      const res = validateGstinCompliance('INVALID_GSTIN_123');
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0].code).toBe('INVALID_GSTIN');
    });

    it('validates a correct GSTIN and outputs INFO', () => {
      // 24AAAAA0000A1Z8 is the codebase fixture with valid checksum
      const res = validateGstinCompliance('24AAAAA0000A1Z8');
      expect(res.errors).toHaveLength(0);
      expect(res.info.some((i) => i.code === 'VALID_GSTIN')).toBe(true);
      expect(res.info.some((i) => i.code === 'GSTIN_STATE_INFO')).toBe(true);
    });
  });

  describe('validateHsnCompliance', () => {
    it('detects missing HSN as ERROR', async () => {
      const res = await validateHsnCompliance({ code: '' });
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].code).toBe('MISSING_HSN_SAC');
      expect(res.errors[0].field).toBe('hsnCode');
    });

    it('detects non-numeric characters as ERROR', async () => {
      const res = await validateHsnCompliance({ code: '7113A' });
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].code).toBe('INVALID_HSN_CHARACTERS');
    });

    it('warns if code starts with 99 but codeType is HSN', async () => {
      const res = await validateHsnCompliance({ code: '998311', codeType: 'HSN' });
      expect(res.warnings.some((w) => w.code === 'CODE_TYPE_RECOMMEND_SAC')).toBe(true);
    });

    it('warns if odd length digit code is passed', async () => {
      const res = await validateHsnCompliance({ code: '711' });
      expect(res.warnings.some((w) => w.code === 'HSN_NONSTANDARD_DIGIT_LENGTH')).toBe(true);
    });

    it('validates seeded HSN 7113 against master as active match', async () => {
      const res = await validateHsnCompliance({ code: '7113', codeType: 'HSN' });
      expect(res.errors).toHaveLength(0);
      expect(res.info.some((i) => i.code === 'HSN_MASTER_MATCH')).toBe(true);
      expect(res.details?.existsInMaster).toBe(true);
      expect(res.details?.isActive).toBe(true);
    });

    it('warns when code length is 4 digits but AATO > 5 Cr (mandating 6 digits)', async () => {
      const res = await validateHsnCompliance({
        code: '7113',
        codeType: 'HSN',
        aato: 60_000_000, // 6 Cr
        aatoState: 'PRECEDING_FY_AATO_VERIFIED',
      });
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(true);
    });

    it('confirms compliant when code length is 6 digits and AATO > 5 Cr', async () => {
      const res = await validateHsnCompliance({
        code: '711319',
        codeType: 'HSN',
        aato: 60_000_000, // 6 Cr
        aatoState: 'PRECEDING_FY_AATO_VERIFIED',
      });
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
    });

    it('warns when code is < 4 digits for B2B supplies with AATO <= 5 Cr', async () => {
      const res = await validateHsnCompliance({
        code: '71',
        codeType: 'HSN',
        aato: 20_000_000, // 2 Cr
        aatoState: 'PRECEDING_FY_AATO_VERIFIED',
        supplyType: 'B2B',
      });
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(true);
    });

    it('does not emit HSN_MIN_4_DIGITS_B2B for B2C supplies with AATO <= 5 Cr', async () => {
      const res = await validateHsnCompliance({
        code: '71',
        codeType: 'HSN',
        aato: 20_000_000, // 2 Cr
        aatoState: 'PRECEDING_FY_AATO_VERIFIED',
        supplyType: 'B2C',
      });
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(false);
      expect(res.info.some((i) => i.code === 'HSN_B2C_OPTIONAL')).toBe(true);
    });

    it('warns that supply type is required when supplyType is omitted and code < 4 digits with AATO <= 5 Cr', async () => {
      const res = await validateHsnCompliance({
        code: '71',
        codeType: 'HSN',
        aato: 20_000_000, // 2 Cr
        aatoState: 'PRECEDING_FY_AATO_VERIFIED',
      });
      expect(res.warnings.some((w) => w.code === 'SUPPLY_TYPE_REQUIRED_FOR_HSN_RULE')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(false);
    });
  });

  describe('validateUqcCompliance', () => {
    it('returns warning for missing UQC', () => {
      const res = validateUqcCompliance(null);
      expect(res.warnings.some((w) => w.code === 'MISSING_UQC')).toBe(true);
    });

    it('returns info for valid standard UQC', () => {
      const res = validateUqcCompliance('GMS');
      expect(res.errors).toHaveLength(0);
      expect(res.info.some((i) => i.code === 'VALID_UQC')).toBe(true);
    });

    it('returns error for invalid UQC code', () => {
      const res = validateUqcCompliance('XYZ999');
      expect(res.errors.some((e) => e.code === 'INVALID_UQC')).toBe(true);
    });

    it('returns warning for informal unit (e.g. GRAMS) and suggests standard', () => {
      const res = validateUqcCompliance('GRAMS');
      expect(res.errors.some((e) => e.code === 'UNSUPPORTED_UQC')).toBe(true);
    });
  });

  describe('validateGstCompliance (Combined)', () => {
    it('evaluates completely clean request as valid with info and no errors', async () => {
      const res = await validateGstCompliance({
        gstin: '24AAAAA0000A1Z8',
        hsnCode: '7113',
        codeType: 'HSN',
        supplyType: 'B2B',
        uqc: 'GMS',
        precedingTurnover: 30_000_000, // 3 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.info.length).toBeGreaterThan(0);
      expect(res.metadata?.gstin?.valid).toBe(true);
      expect(res.metadata?.hsnSac?.code).toBe('7113');
      expect(res.metadata?.uqc?.canonicalCode).toBe('GMS');
      expect(res.metadata?.aatoThreshold?.exceeds5Cr).toBe(false);
    });

    it('evaluates request with multiple failures distinguishing errors, warnings, and info', async () => {
      const res = await validateGstCompliance({
        gstin: 'INVALID_GSTIN',
        hsnCode: '998311', // SAC code but labeled HSN
        codeType: 'HSN',
        uqc: 'INVALID_UQC',
        precedingTurnover: 80_000_000, // 8 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.valid).toBe(false);
      // Errors should contain invalid GSTIN and invalid UQC
      expect(res.errors.some((e) => e.field === 'gstin')).toBe(true);
      expect(res.errors.some((e) => e.field === 'uqc')).toBe(true);
      // Warnings should contain codeType recommendation
      expect(res.warnings.some((w) => w.code === 'CODE_TYPE_RECOMMEND_SAC')).toBe(true);
    });
  });

  describe('Phase D AATO & HSN Statutory Compliance Verification (Tests 1-10, 12)', () => {
    it('Test 1: exactly ₹5 crore + B2B → 4 digits', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113', // 4 digits
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 50_000_000, // Exactly 5 Cr (<= 5 Cr)
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_VERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('authoritative');
      expect(res.metadata?.aatoThreshold?.exceeds5Cr).toBe(false);
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(4);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(false);
    });

    it('Test 2: ₹5 crore + 1 → 6 digits', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113', // 4 digits (fails 6-digit requirement)
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 50_000_001, // 5 Cr + 1 (> 5 Cr)
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_VERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('authoritative');
      expect(res.metadata?.aatoThreshold?.exceeds5Cr).toBe(true);
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(6);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(true);

      // Meets 6 digits
      const res6 = await validateGstCompliance({
        hsnCode: '711319', // 6 digits
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 50_000_001,
        precedingVerificationStatus: 'VERIFIED',
      });
      expect(res6.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
      expect(res6.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
    });

    it('Test 3: <= ₹5 crore + B2C + short HSN → no B2B-specific HSN error', async () => {
      const res = await validateGstCompliance({
        hsnCode: '71', // 2 digits (short HSN)
        codeType: 'HSN',
        supplyType: 'B2C',
        precedingTurnover: 30_000_000, // 3 Cr <= 5 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      // Must NOT emit HSN_MIN_4_DIGITS_B2B error/warning for B2C supplies
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(false);
      expect(res.info.some((i) => i.code === 'HSN_B2C_OPTIONAL')).toBe(true);
    });

    it('Test 4: <= ₹5 crore + B2B + short HSN → 4-digit rule', async () => {
      const res = await validateGstCompliance({
        hsnCode: '71', // 2 digits (< 4 digits)
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 30_000_000, // 3 Cr <= 5 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(true);
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(4);
    });

    it('Test 5: > ₹5 crore + B2C → 6-digit rule', async () => {
      const res4 = await validateGstCompliance({
        hsnCode: '7113', // 4 digits
        codeType: 'HSN',
        supplyType: 'B2C',
        precedingTurnover: 70_000_000, // 7 Cr > 5 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      // 6-digit rule under Notification No. 78/2020 applies to both B2B and B2C when > 5 Cr
      expect(res4.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(true);
      expect(res4.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(6);

      const res6 = await validateGstCompliance({
        hsnCode: '711319', // 6 digits
        codeType: 'HSN',
        supplyType: 'B2C',
        precedingTurnover: 70_000_000,
        precedingVerificationStatus: 'VERIFIED',
      });
      expect(res6.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
      expect(res6.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
    });

    it('Test 6: preceding turnover + VERIFIED → authoritative', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113',
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 30_000_000,
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_VERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('authoritative');
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(4);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
    });

    it('Test 7: preceding turnover + UNVERIFIED → warning/unknown', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113',
        codeType: 'HSN',
        precedingTurnover: 70_000_000,
        precedingVerificationStatus: 'UNVERIFIED',
      });

      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_UNVERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('warning/unknown');
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBeNull();
      expect(res.warnings.some((w) => w.code === 'PRECEDING_FY_AATO_UNVERIFIED')).toBe(true);
      // Must not emit silent statutory pass or fail
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(false);
    });

    it('Test 8: preceding turnover + missing verification → warning/unknown', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113',
        codeType: 'HSN',
        precedingTurnover: 70_000_000,
        // precedingVerificationStatus omitted!
      });

      // Must NOT silently become VERIFIED
      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_UNVERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('warning/unknown');
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBeNull();
      expect(res.warnings.some((w) => w.code === 'PRECEDING_FY_AATO_UNVERIFIED')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(false);
    });

    it('Test 9: current FY > ₹5 crore must never become statutory threshold', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113', // 4 digits
        codeType: 'HSN',
        supplyType: 'B2B',
        precedingTurnover: 30_000_000, // 3 Cr (<= 5 Cr)
        precedingVerificationStatus: 'VERIFIED',
        currentTurnover: 90_000_000, // 9 Cr (> 5 Cr) in current FY!
      });

      // Preceding FY controls! 4 digits is compliant for <= 5 Cr; 9 Cr current FY does NOT force 6 digits!
      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_VERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('authoritative');
      expect(res.metadata?.aatoThreshold?.exceeds5Cr).toBe(false);
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBe(4);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(true);
      expect(res.info.some((i) => i.code === 'CURRENT_FY_AATO_INFORMATIONAL')).toBe(true);
    });

    it('Test 10: legacy aggregateTurnover without verification must not silently become VERIFIED', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113',
        codeType: 'HSN',
        aggregateTurnover: 80_000_000, // 8 Cr via legacy parameter without verification status
      });

      // Must NOT silently become PRECEDING_FY_AATO_VERIFIED
      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_UNVERIFIED');
      expect(res.metadata?.aatoThreshold?.status).toBe('warning/unknown');
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBeNull();
      expect(res.warnings.some((w) => w.code === 'PRECEDING_FY_AATO_UNVERIFIED')).toBe(true);
    });

    it('Test 12: no-preceding-FY behavior remains conservative', async () => {
      const res = await validateGstCompliance({
        hsnCode: '7113',
        codeType: 'HSN',
        precedingTurnover: null,
        currentTurnover: 80_000_000,
      });

      // Does not convert to 0 or assume first-year business
      expect(res.metadata?.aatoThreshold?.state).toBe('PRECEDING_FY_AATO_MISSING');
      expect(res.metadata?.aatoThreshold?.status).toBe('warning/unknown');
      expect(res.metadata?.aatoThreshold?.mandatedMinHsnDigits).toBeNull();
      expect(res.warnings.some((w) => w.code === 'PRECEDING_FY_AATO_MISSING')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_6_DIGITS_AATO_OVER_5CR')).toBe(false);
      expect(res.info.some((i) => i.code === 'AATO_HSN_DIGITS_COMPLIANT')).toBe(false);
    });

    it('Supply type omitted: does not silently assume B2B when code < 4 digits', async () => {
      const res = await validateGstCompliance({
        hsnCode: '71', // 2 digits
        codeType: 'HSN',
        precedingTurnover: 30_000_000,
        precedingVerificationStatus: 'VERIFIED',
        // supplyType omitted!
      });

      expect(res.warnings.some((w) => w.code === 'SUPPLY_TYPE_REQUIRED_FOR_HSN_RULE')).toBe(true);
      expect(res.warnings.some((w) => w.code === 'HSN_MIN_4_DIGITS_B2B')).toBe(false);
    });
  });
});
