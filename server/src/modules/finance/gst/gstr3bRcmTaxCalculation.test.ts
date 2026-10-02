import { describe, it, expect } from 'vitest';
import { calculateRcmTax } from './gstr3bRcmTaxCalculation';

describe('G2g-7d: calculateRcmTax (pure, reuses shared/inputGst.ts splitInputGst)', () => {
  it('splits intra-state (same state codes) into CGST + SGST halves', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: '24', companyStateCode: '24' });
    expect(result.cgst).toBe(90);
    expect(result.sgst).toBe(90);
    expect(result.igst).toBe(0);
    expect(result.totalTax).toBe(180);
    expect(result.posUnresolved).toBe(false);
  });

  it('routes inter-state (different state codes) entirely to IGST', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: '24', companyStateCode: '27' });
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
    expect(result.igst).toBe(180);
    expect(result.posUnresolved).toBe(false);
  });

  it('includes cess in totalTax but never in the CGST/SGST/IGST split', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: '24', companyStateCode: '24', cess: 25 });
    expect(result.cess).toBe(25);
    expect(result.totalTax).toBe(205);
  });

  it('defaults cess to 0 when omitted', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: '24', companyStateCode: '24' });
    expect(result.cess).toBe(0);
  });

  it('rounds to 2 decimal places on an odd taxable value', () => {
    // 333.33 * 0.18 = 59.9994 -> rounds to 60.00 before the CGST/SGST halves are taken.
    const result = calculateRcmTax({ taxableValue: 333.33, taxRate: 0.18, supplierStateCode: '24', companyStateCode: '24' });
    expect(result.cgst + result.sgst).toBe(60);
    expect(result.cgst).toBe(30);
    expect(result.sgst).toBe(30);
  });

  it('flags posUnresolved when the supplier state cannot be determined — still computes a fallback split (IGST)', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: null, companyStateCode: '24' });
    expect(result.posUnresolved).toBe(true);
    expect(result.igst).toBe(180);
  });

  it('flags posUnresolved when the company state cannot be determined', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0.18, supplierStateCode: '24', companyStateCode: null });
    expect(result.posUnresolved).toBe(true);
  });

  it('a zero rate produces zero tax', () => {
    const result = calculateRcmTax({ taxableValue: 1000, taxRate: 0, supplierStateCode: '24', companyStateCode: '24' });
    expect(result.totalTax).toBe(0);
    expect(result.cgst).toBe(0);
  });
});
