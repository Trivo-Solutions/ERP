import { describe, it, expect } from 'vitest';
import { classifyRcmSupply, determineSelfInvoiceRequirement, determinePaymentVoucherRequirement } from './gstr3bRcmClassification';
import type { Gstr3bRcmLineFacts } from './gstr3bRcm.types';

// G2g-7d — pure classifier tests. No Prisma, no DB.

const REG = 'reg-123';

const baseFacts = (): Gstr3bRcmLineFacts => ({
  rcmCategory: 'GTA_FREIGHT',
  buyerRegistrationId: REG,
  taxCategory: 'TAXABLE',
});

describe('G2g-7d: classifyRcmSupply (pure, no Prisma)', () => {
  it('classifies a notified, fully-determined line as RCM_APPLICABLE', () => {
    const result = classifyRcmSupply(baseFacts(), REG);
    expect(result).toEqual({ scope: 'IN_SCOPE', status: 'RCM_APPLICABLE', diagnosticCode: null, reason: null });
  });

  describe('default/NONE category — the overwhelming common case', () => {
    it('classifies a null rcmCategory as RCM_NOT_APPLICABLE', () => {
      const result = classifyRcmSupply({ ...baseFacts(), rcmCategory: null }, REG);
      expect(result).toEqual({ scope: 'IN_SCOPE', status: 'RCM_NOT_APPLICABLE', diagnosticCode: null, reason: null });
    });

    it('classifies rcmCategory="NONE" as RCM_NOT_APPLICABLE', () => {
      const result = classifyRcmSupply({ ...baseFacts(), rcmCategory: 'NONE' }, REG);
      expect(result.status).toBe('RCM_NOT_APPLICABLE');
    });

    it('does NOT infer RCM from an unregistered supplier alone — §9(4) is suspended', () => {
      // No category set at all; buyerRegistrationId/taxCategory facts are irrelevant to this branch.
      const result = classifyRcmSupply({ rcmCategory: null, buyerRegistrationId: null, taxCategory: null }, REG);
      expect(result.status).toBe('RCM_NOT_APPLICABLE');
    });
  });

  describe('UNRESOLVED category', () => {
    it('classifies rcmCategory="UNRESOLVED" as RCM_UNRESOLVED, never guessed into a named category', () => {
      const result = classifyRcmSupply({ ...baseFacts(), rcmCategory: 'UNRESOLVED' }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'RCM_UNRESOLVED', diagnosticCode: 'RCM_CATEGORY_UNRESOLVED' });
    });

    it('UNRESOLVED-category check runs before registration/tax-category checks', () => {
      const result = classifyRcmSupply({ rcmCategory: 'UNRESOLVED', buyerRegistrationId: null, taxCategory: 'EXEMPT' }, REG);
      expect(result.diagnosticCode).toBe('RCM_CATEGORY_UNRESOLVED');
    });
  });

  describe('registration scope', () => {
    it('excludes (not unresolved) a line explicitly attributed to a DIFFERENT registration', () => {
      const result = classifyRcmSupply({ ...baseFacts(), buyerRegistrationId: 'other-reg' }, REG);
      expect(result.scope).toBe('EXCLUDED_OTHER_REGISTRATION');
    });

    it('classifies a notified line with no buyerRegistrationId as UNRESOLVED, never defaulted to the requested registration', () => {
      const result = classifyRcmSupply({ ...baseFacts(), buyerRegistrationId: null }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'RCM_UNRESOLVED', diagnosticCode: 'RCM_REGISTRATION_UNASSIGNED' });
    });

    it('treats an empty-string buyerRegistrationId the same as null', () => {
      const result = classifyRcmSupply({ ...baseFacts(), buyerRegistrationId: '   ' }, REG);
      expect(result.diagnosticCode).toBe('RCM_REGISTRATION_UNASSIGNED');
    });
  });

  describe('tax category consistency', () => {
    it.each(['EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'])('flags a notified category with taxCategory=%s as RCM_TAX_CATEGORY_CONFLICT', (cat) => {
      const result = classifyRcmSupply({ ...baseFacts(), taxCategory: cat }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'RCM_UNRESOLVED', diagnosticCode: 'RCM_TAX_CATEGORY_CONFLICT' });
    });

    it('a null taxCategory does not conflict (treated as unknown, not non-taxable)', () => {
      const result = classifyRcmSupply({ ...baseFacts(), taxCategory: null }, REG);
      expect(result.status).toBe('RCM_APPLICABLE');
    });
  });

  describe('priority ordering (first applicable check wins)', () => {
    it('registration mismatch is checked before tax-category conflict', () => {
      const result = classifyRcmSupply({ ...baseFacts(), buyerRegistrationId: 'other-reg', taxCategory: 'EXEMPT' }, REG);
      expect(result.scope).toBe('EXCLUDED_OTHER_REGISTRATION');
    });

    it('missing registration is checked before tax-category conflict', () => {
      const result = classifyRcmSupply({ ...baseFacts(), buyerRegistrationId: null, taxCategory: 'EXEMPT' }, REG);
      expect(result.diagnosticCode).toBe('RCM_REGISTRATION_UNASSIGNED');
    });
  });
});

describe('G2g-7d: determineSelfInvoiceRequirement', () => {
  it('is NOT_DETERMINED when classification itself is unresolved', () => {
    expect(determineSelfInvoiceRequirement('RCM_UNRESOLVED', null)).toBe('SELF_INVOICE_NOT_DETERMINED');
  });

  it('is NOT_REQUIRED when RCM does not apply, regardless of supplier GSTIN', () => {
    expect(determineSelfInvoiceRequirement('RCM_NOT_APPLICABLE', null)).toBe('SELF_INVOICE_NOT_REQUIRED');
  });

  it('is REQUIRED when RCM applies and the supplier has no GSTIN', () => {
    expect(determineSelfInvoiceRequirement('RCM_APPLICABLE', null)).toBe('SELF_INVOICE_REQUIRED');
  });

  it('is REQUIRED when RCM applies and the supplier GSTIN is structurally invalid', () => {
    expect(determineSelfInvoiceRequirement('RCM_APPLICABLE', '24AAAAA0000A1Z9')).toBe('SELF_INVOICE_REQUIRED');
  });

  it('is NOT_REQUIRED when RCM applies and the supplier GSTIN is valid — never RCM_APPLICABLE => REQUIRED unconditionally', () => {
    expect(determineSelfInvoiceRequirement('RCM_APPLICABLE', '24AAAAA0000A1Z8')).toBe('SELF_INVOICE_NOT_REQUIRED');
  });
});

describe('G2g-7d: determinePaymentVoucherRequirement', () => {
  it('is NOT_DETERMINED when classification itself is unresolved', () => {
    expect(determinePaymentVoucherRequirement('RCM_UNRESOLVED')).toBe('PAYMENT_VOUCHER_NOT_DETERMINED');
  });

  it('is NOT_REQUIRED when RCM does not apply', () => {
    expect(determinePaymentVoucherRequirement('RCM_NOT_APPLICABLE')).toBe('PAYMENT_VOUCHER_NOT_REQUIRED');
  });

  it('is REQUIRED when RCM applies, independent of supplier registration', () => {
    expect(determinePaymentVoucherRequirement('RCM_APPLICABLE')).toBe('PAYMENT_VOUCHER_REQUIRED');
  });
});
