import { describe, it, expect } from 'vitest';
import { classifyInwardTaxLine } from './gstr3bItcEligibility';
import type { Gstr3bItcLineFacts } from './gstr3bItc.types';

// G2g-7c — pure classifier tests. No Prisma, no DB — see the module's own header for the five
// foundational conditions checked, in priority order.

const REG = 'reg-123';

const baseFacts = (): Gstr3bItcLineFacts => ({
  buyerRegistrationId: REG,
  supplierGstin: '24AAAAA0000A1Z8', // valid checksum per shared/gstin.ts's algorithm
  supplierIsComposition: false,
  taxCategory: 'TAXABLE',
});

describe('G2g-7c: classifyInwardTaxLine (pure, no Prisma)', () => {
  it('classifies a fully-determined domestic taxable purchase as ELIGIBLE', () => {
    const result = classifyInwardTaxLine(baseFacts(), REG);
    expect(result).toEqual({ scope: 'IN_SCOPE', status: 'ELIGIBLE', diagnosticCode: null, reason: null });
  });

  describe('registration scope', () => {
    it('excludes (not unresolved) a line explicitly attributed to a DIFFERENT registration', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), buyerRegistrationId: 'other-reg' }, REG);
      expect(result.scope).toBe('EXCLUDED_OTHER_REGISTRATION');
    });

    it('classifies a line with no buyerRegistrationId as UNRESOLVED, never defaulted to the requested registration', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), buyerRegistrationId: null }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'UNRESOLVED', diagnosticCode: 'BUYER_REGISTRATION_UNASSIGNED' });
    });

    it('treats an empty-string buyerRegistrationId the same as null', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), buyerRegistrationId: '   ' }, REG);
      expect(result.diagnosticCode).toBe('BUYER_REGISTRATION_UNASSIGNED');
    });
  });

  describe('supplier composition scheme', () => {
    it('classifies a composition-scheme supplier as INELIGIBLE — a reliable, established exclusion', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), supplierIsComposition: true }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'INELIGIBLE', diagnosticCode: 'SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE' });
    });

    it('composition check takes priority over a missing/malformed GSTIN (both facts may be true at once)', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), supplierIsComposition: true, supplierGstin: null }, REG);
      expect(result.diagnosticCode).toBe('SUPPLIER_COMPOSITION_SCHEME_INELIGIBLE');
    });
  });

  describe('supplier GSTIN', () => {
    it('classifies a missing supplier GSTIN as UNRESOLVED', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), supplierGstin: null }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'UNRESOLVED', diagnosticCode: 'SUPPLIER_GSTIN_UNAVAILABLE' });
    });

    it('classifies a structurally malformed supplier GSTIN as UNRESOLVED (not just a 15-char length check)', () => {
      // Right length, wrong checksum.
      const result = classifyInwardTaxLine({ ...baseFacts(), supplierGstin: '24AAAAA0000A1Z9' }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'UNRESOLVED', diagnosticCode: 'SUPPLIER_GSTIN_UNAVAILABLE' });
    });

    it('classifies an unrecognized GST state-code prefix as UNRESOLVED', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), supplierGstin: '00AAAAA0000A1Z5' }, REG);
      expect(result.status).toBe('UNRESOLVED');
    });
  });

  describe('tax category', () => {
    it('classifies a null (pre-G2g-7a) taxCategory as UNRESOLVED', () => {
      const result = classifyInwardTaxLine({ ...baseFacts(), taxCategory: null }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'UNRESOLVED', diagnosticCode: 'TAX_CATEGORY_UNAVAILABLE' });
    });

    it.each(['EXEMPT', 'NIL_RATED', 'NON_GST', 'ZERO_RATED'])('classifies taxCategory=%s as INELIGIBLE', (cat) => {
      const result = classifyInwardTaxLine({ ...baseFacts(), taxCategory: cat }, REG);
      expect(result).toMatchObject({ scope: 'IN_SCOPE', status: 'INELIGIBLE', diagnosticCode: 'TAX_CATEGORY_NON_TAXABLE' });
    });

    it('does NOT infer a non-taxable category from a zero tax rate — only reads the explicit taxCategory field', () => {
      // facts carries no concept of "rate" at all; a TAXABLE category stays ELIGIBLE regardless of
      // what amount this line happens to book (a 0%-rated bill from an unregistered supplier is a
      // different statutory fact from an EXEMPT/NIL/NON_GST/ZERO_RATED supply — see the module header).
      const result = classifyInwardTaxLine({ ...baseFacts(), taxCategory: 'TAXABLE' }, REG);
      expect(result.status).toBe('ELIGIBLE');
    });
  });

  describe('priority ordering (first applicable check wins)', () => {
    it('registration mismatch is checked before anything else', () => {
      const result = classifyInwardTaxLine(
        { buyerRegistrationId: 'other-reg', supplierGstin: null, supplierIsComposition: true, taxCategory: 'EXEMPT' },
        REG,
      );
      expect(result.scope).toBe('EXCLUDED_OTHER_REGISTRATION');
    });

    it('missing registration is checked before composition/GSTIN/tax-category', () => {
      const result = classifyInwardTaxLine(
        { buyerRegistrationId: null, supplierGstin: null, supplierIsComposition: true, taxCategory: 'EXEMPT' },
        REG,
      );
      expect(result.diagnosticCode).toBe('BUYER_REGISTRATION_UNASSIGNED');
    });

    it('GSTIN validity is checked before tax category', () => {
      const result = classifyInwardTaxLine(
        { ...baseFacts(), supplierGstin: null, taxCategory: 'EXEMPT' },
        REG,
      );
      expect(result.diagnosticCode).toBe('SUPPLIER_GSTIN_UNAVAILABLE');
    });
  });
});
