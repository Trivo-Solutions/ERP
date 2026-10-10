import { describe, it, expect } from 'vitest';
import { businessDayString, startOfBusinessDay, endOfBusinessDay, dayToDbDate } from './businessDay';
import { isEstimateExpired } from './estimateExpiry';

// The business day is the India day (UTC+05:30), whatever timezone the server process runs in.
describe('business day (Asia/Kolkata)', () => {
  it('rolls over at 18:30 UTC, not at UTC or server-local midnight', () => {
    expect(businessDayString(new Date('2026-10-14T18:29:59.999Z'))).toBe('2026-10-14'); // 23:59:59.999 IST
    expect(businessDayString(new Date('2026-10-14T18:30:00.000Z'))).toBe('2026-10-15'); // 00:00:00 IST
    expect(businessDayString(new Date('2026-10-14T00:10:00.000Z'))).toBe('2026-10-14'); // 05:40 IST
    expect(businessDayString(new Date('2026-12-31T20:00:00.000Z'))).toBe('2027-01-01'); // year boundary
  });

  it('start / end of the day are the exact IST instants', () => {
    const at = new Date('2026-10-14T10:00:00Z');
    expect(startOfBusinessDay(at).toISOString()).toBe('2026-10-13T18:30:00.000Z');
    expect(endOfBusinessDay(at).toISOString()).toBe('2026-10-14T18:29:59.999Z');
    expect(dayToDbDate('2026-10-14').toISOString()).toBe('2026-10-14T00:00:00.000Z');
  });

  it('an estimate made at 23:59 IST is good until the stroke of midnight IST and expired one millisecond later', () => {
    const made = new Date('2026-10-14T18:29:00.000Z'); // 23:59 IST on the 14th
    expect(isEstimateExpired(made, new Date('2026-10-14T18:29:59.999Z'))).toBe(false);
    expect(isEstimateExpired(made, new Date('2026-10-14T18:30:00.000Z'))).toBe(true);
    // made just after IST midnight, still valid at noon IST the same day, even though UTC is still "yesterday"
    expect(isEstimateExpired(new Date('2026-10-14T18:31:00.000Z'), new Date('2026-10-15T06:30:00.000Z'))).toBe(false);
  });
});
