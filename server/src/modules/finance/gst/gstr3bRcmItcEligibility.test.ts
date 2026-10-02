import { describe, it, expect } from 'vitest';
import { classifyRcmItc } from './gstr3bRcmItcEligibility';

describe('G2g-7d: classifyRcmItc (pure, no Prisma)', () => {
  it('is UNRESOLVED (not eligible) while the liability is only LIABILITY_RECOGNIZED — not yet paid', () => {
    const result = classifyRcmItc('LIABILITY_RECOGNIZED');
    expect(result).toEqual({ status: 'UNRESOLVED', diagnosticCode: 'RCM_PAYMENT_NOT_RECORDED', reason: expect.stringContaining('Rule 86(2)') });
  });

  it('is ELIGIBLE once the liability is TAX_PAID — never before', () => {
    const result = classifyRcmItc('TAX_PAID');
    expect(result).toEqual({ status: 'ELIGIBLE', diagnosticCode: null, reason: null });
  });

  it('merely recognizing a liability never makes ITC available on its own', () => {
    // Guards against a future regression that collapses "liability created" and "ITC usable"
    // into the same moment (brief §16).
    expect(classifyRcmItc('LIABILITY_RECOGNIZED').status).not.toBe('ELIGIBLE');
  });
});
