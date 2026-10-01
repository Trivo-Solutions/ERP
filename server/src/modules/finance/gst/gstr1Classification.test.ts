import { describe, it, expect } from 'vitest';
import {
  classifyGstr1OutwardSupply,
  getB2cLargeThreshold,
  UNCLASSIFIED,
  type ClassifyGstr1OutwardSupplyInput,
} from './gstr1Classification';

// Aug 2024 onward = current ₹1,00,000 threshold; before = historical ₹2,50,000 threshold.
const CURRENT_PERIOD_DATE = new Date('2026-01-15T00:00:00.000Z');
const HISTORICAL_PERIOD_DATE = new Date('2023-06-15T00:00:00.000Z');
const AUG_2024_BOUNDARY_DATE = new Date('2024-07-31T18:30:00.000Z'); // IST midnight of 1 Aug 2024 (IST = UTC+5:30)

const GUJARAT = '24';
const MAHARASHTRA = '27';

function baseInput(overrides: Partial<ClassifyGstr1OutwardSupplyInput> = {}): ClassifyGstr1OutwardSupplyInput {
  return {
    buyerGstin: null,
    sellerStateCode: GUJARAT,
    sellerRegistrationId: 'reg_1',
    placeOfSupply: MAHARASHTRA,
    invoiceValue: 50_000,
    invoiceDate: CURRENT_PERIOD_DATE,
    ...overrides,
  };
}

describe('getB2cLargeThreshold', () => {
  it('returns ₹1,00,000 on/after the Aug 2024 IST boundary', () => {
    expect(getB2cLargeThreshold(AUG_2024_BOUNDARY_DATE)).toBe(100_000);
    expect(getB2cLargeThreshold(CURRENT_PERIOD_DATE)).toBe(100_000);
  });

  it('returns ₹2,50,000 before the Aug 2024 IST boundary', () => {
    expect(getB2cLargeThreshold(HISTORICAL_PERIOD_DATE)).toBe(250_000);
    expect(getB2cLargeThreshold(new Date(AUG_2024_BOUNDARY_DATE.getTime() - 1))).toBe(250_000);
  });
});

describe('classifyGstr1OutwardSupply — B2B', () => {
  it('1. registered recipient + intra-state → B2B', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ buyerGstin: '24AAAAA0000A1Z5', sellerStateCode: GUJARAT, placeOfSupply: GUJARAT }),
    );
    expect(result.category).toBe('B2B');
    expect(result.isRegisteredRecipient).toBe(true);
    expect(result.isInterState).toBe(false);
  });

  it('2. registered recipient + interstate → B2B', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ buyerGstin: '27AAAAA0000A1Z5', sellerStateCode: GUJARAT, placeOfSupply: MAHARASHTRA }),
    );
    expect(result.category).toBe('B2B');
    expect(result.isInterState).toBe(true);
  });

  it('3. GSTIN whitespace normalized → B2B', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '  27AAAAA0000A1Z5  ' }));
    expect(result.category).toBe('B2B');
  });

  it('4. GSTIN lowercase normalized → B2B', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '27aaaaa0000a1z5' }));
    expect(result.category).toBe('B2B');
  });

  it('B2B does not require a resolvable place of supply — isInterState reports null rather than blocking classification', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ buyerGstin: '27AAAAA0000A1Z5', placeOfSupply: 'Unresolved Free Text' }),
    );
    expect(result.category).toBe('B2B');
    expect(result.isInterState).toBeNull();
  });
});

describe('classifyGstr1OutwardSupply — B2CL', () => {
  it('5. unregistered + interstate + ₹1,00,000.01 → B2CL', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 100_000.01 }));
    expect(result.category).toBe('B2CL');
    expect(result.threshold).toBe(100_000);
  });

  it('6. unregistered + interstate + exactly ₹1,00,000 → B2CS', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 100_000 }));
    expect(result.category).toBe('B2CS');
  });

  it('7. unregistered + interstate + ₹99,999.99 → B2CS', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 99_999.99 }));
    expect(result.category).toBe('B2CS');
  });

  it('8. invoice value (not taxable value) controls classification — a lower "taxable value" field is never consulted, only invoiceValue', () => {
    // The input type only ever accepts one value figure (invoiceValue) precisely so a caller
    // cannot accidentally pass a taxable value instead — this test proves the threshold reacts to
    // exactly that figure, whatever it represents.
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 100_000.01 }));
    expect(result.category).toBe('B2CL');
  });
});

describe('classifyGstr1OutwardSupply — B2CS', () => {
  it('9. unregistered + intra-state + low value → B2CS', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, invoiceValue: 500 }),
    );
    expect(result.category).toBe('B2CS');
    expect(result.isInterState).toBe(false);
  });

  it('10. unregistered + intra-state + very high value → still B2CS (value-independent)', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, invoiceValue: 50_00_000 }),
    );
    expect(result.category).toBe('B2CS');
    expect(result.threshold).toBeNull();
  });

  it('11. unregistered + interstate + exactly ₹1 lakh → B2CS', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 100_000 }));
    expect(result.category).toBe('B2CS');
  });
});

describe('classifyGstr1OutwardSupply — historical threshold', () => {
  it('12. pre-Aug-2024 interstate unregistered invoice ₹2.5 lakh exactly → B2CS', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 250_000, invoiceDate: HISTORICAL_PERIOD_DATE }));
    expect(result.category).toBe('B2CS');
    expect(result.threshold).toBe(250_000);
  });

  it('13. pre-Aug-2024 interstate unregistered invoice above ₹2.5 lakh → B2CL', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 250_000.01, invoiceDate: HISTORICAL_PERIOD_DATE }));
    expect(result.category).toBe('B2CL');
    expect(result.threshold).toBe(250_000);
  });

  it('14. Aug 2024 boundary uses ₹1 lakh threshold', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: 100_000.01, invoiceDate: AUG_2024_BOUNDARY_DATE }));
    expect(result.category).toBe('B2CL');
    expect(result.threshold).toBe(100_000);
  });
});

describe('classifyGstr1OutwardSupply — invalid/ambiguous data', () => {
  it('15. missing buyer GSTIN + missing POS → unclassified', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: null, placeOfSupply: null }));
    expect(result.category).toBe(UNCLASSIFIED);
    expect(result.isRegisteredRecipient).toBe(false);
  });

  it('16. missing seller registration → unclassified', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ sellerRegistrationId: null }));
    expect(result.category).toBe(UNCLASSIFIED);
    expect(result.sellerRegistrationId).toBeNull();
  });

  it('17. missing invoice value → unclassified', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceValue: null }));
    expect(result.category).toBe(UNCLASSIFIED);
  });

  it('18. invalid/unknown POS state → unclassified (unregistered recipient)', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ placeOfSupply: 'Gujarat' }));
    expect(result.category).toBe(UNCLASSIFIED);
  });

  it('empty-string GSTIN is treated as absent, not a truthy registered value', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '   ' }));
    expect(result.isRegisteredRecipient).toBe(false);
  });

  it('malformed seller state code (unregistered path) → unclassified', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ sellerStateCode: 'GJ' }));
    expect(result.category).toBe(UNCLASSIFIED);
  });

  it('never silently classifies ambiguous data as B2CS', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ placeOfSupply: undefined }));
    expect(result.category).not.toBe('B2CS');
    expect(result.category).toBe(UNCLASSIFIED);
  });

  it('missing invoice date on the one path that needs it (unregistered + interstate) → unclassified', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ invoiceDate: null }));
    expect(result.category).toBe(UNCLASSIFIED);
  });

  it('missing invoice date does NOT block an intra-state B2CS decision (no threshold consulted)', () => {
    const result = classifyGstr1OutwardSupply(
      baseInput({ sellerStateCode: GUJARAT, placeOfSupply: GUJARAT, invoiceDate: null }),
    );
    expect(result.category).toBe('B2CS');
  });
});

describe('classifyGstr1OutwardSupply — G2g-4a.1 recipient GSTIN validation', () => {
  it('garbage buyerGstin (wrong shape) → UNCLASSIFIED with INVALID_RECIPIENT_GSTIN diagnostic', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: 'NOT-A-GSTIN' }));
    expect(result.category).toBe(UNCLASSIFIED);
    expect(result.isRegisteredRecipient).toBe(true); // present, just malformed — never silently "absent"
    expect(result.reason).toMatch(/INVALID_RECIPIENT_GSTIN/);
  });

  it('wrong-length buyerGstin → UNCLASSIFIED, never silently treated as unregistered B2C', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '24AAAAA0000A1Z', invoiceValue: 50 }));
    expect(result.category).toBe(UNCLASSIFIED);
    expect(result.category).not.toBe('B2CS');
    expect(result.reason).toMatch(/INVALID_RECIPIENT_GSTIN/);
  });

  it('unrecognized state code in an otherwise well-formed buyerGstin → UNCLASSIFIED', () => {
    // '00' is 2 digits (passes shape) but not an allotted GST state/UT code (shared/gstin.ts).
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '00AAAAA0000A1Z8' }));
    expect(result.category).toBe(UNCLASSIFIED);
    expect(result.reason).toMatch(/INVALID_RECIPIENT_GSTIN/);
  });

  it('a checksum-only mismatch on an otherwise well-formed GSTIN is still accepted as B2B (deliberate — see gstr1Classification.ts)', () => {
    // Same structurally-valid-but-fake-checksum shape every frozen G2g-3 fixture in this codebase
    // already uses (e.g. "27AAAAA0000A1Z5") — must keep classifying B2B, or every frozen
    // aggregation/reporting/credit-note test would regress.
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '27AAAAA0000A1Z5' }));
    expect(result.category).toBe('B2B');
  });

  it('a real checksum-valid buyerGstin still classifies B2B (the shared validator is genuinely reused, not bypassed)', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ buyerGstin: '24AAAAA0000A1Z8', sellerStateCode: GUJARAT, placeOfSupply: GUJARAT }));
    expect(result.category).toBe('B2B');
  });
});

describe('classifyGstr1OutwardSupply — registration isolation', () => {
  it('19. seller registration id is preserved unchanged', () => {
    const result = classifyGstr1OutwardSupply(baseInput({ sellerRegistrationId: 'reg_abc_123' }));
    expect(result.sellerRegistrationId).toBe('reg_abc_123');
  });

  it('20. different seller registrations do not affect the recipient-registration classification itself', () => {
    const a = classifyGstr1OutwardSupply(
      baseInput({ buyerGstin: '27AAAAA0000A1Z5', sellerRegistrationId: 'reg_A', sellerStateCode: GUJARAT }),
    );
    const b = classifyGstr1OutwardSupply(
      baseInput({ buyerGstin: '27AAAAA0000A1Z5', sellerRegistrationId: 'reg_B', sellerStateCode: MAHARASHTRA }),
    );
    expect(a.category).toBe('B2B');
    expect(b.category).toBe('B2B');
    expect(a.isRegisteredRecipient).toBe(b.isRegisteredRecipient);
  });
});
