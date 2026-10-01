import { describe, it, expect } from 'vitest';
import { parseIstRangeStart, parseIstRangeEnd, getCurrentFinancialYearStart } from './istDate';

// G2g-2: date-only (`YYYY-MM-DD`) GST report boundaries must resolve to a full IST business day,
// not UTC midnight (which would cut off most of the actual day — see istDate.ts's own comment).
describe('parseIstRangeStart / parseIstRangeEnd (G2g-2 date-only boundary hardening)', () => {
  it('parseIstRangeStart includes the very beginning of the requested IST business day', () => {
    // 2026-09-30 00:00 IST == 2026-09-29T18:30:00.000Z
    const start = parseIstRangeStart('2026-09-30');
    expect(start.toISOString()).toBe('2026-09-29T18:30:00.000Z');
  });

  it('parseIstRangeEnd includes a late-evening record for the requested IST business day', () => {
    // 2026-09-30 23:59:59.900 IST is late evening in India — must be <= the computed end.
    const lateEvening = new Date('2026-09-30T18:29:59.900Z'); // 23:59:59.900 IST
    const end = parseIstRangeEnd('2026-09-30');
    expect(lateEvening.getTime()).toBeLessThanOrEqual(end.getTime());
    // And the boundary itself is the last instant of that IST day: 2026-10-01T00:00:00.000Z - 1ms.
    expect(end.toISOString()).toBe('2026-09-30T18:29:59.999Z');
  });

  it('does not include the next IST day (adjacent-day exclusion)', () => {
    const end = parseIstRangeEnd('2026-09-30');
    const nextDayFirstMoment = new Date('2026-09-30T18:30:00.000Z'); // 2026-10-01 00:00:00.000 IST
    expect(nextDayFirstMoment.getTime()).toBeGreaterThan(end.getTime());
  });

  it('does not include the previous IST day (adjacent-day exclusion)', () => {
    const start = parseIstRangeStart('2026-09-30');
    const prevDayLastMoment = new Date('2026-09-29T18:29:59.999Z'); // 2026-09-29 23:59:59.999 IST
    expect(prevDayLastMoment.getTime()).toBeLessThan(start.getTime());
  });

  it('a full ISO timestamp (not date-only) is trusted as-is, not reinterpreted', () => {
    const iso = '2026-09-30T12:34:56.789Z';
    expect(parseIstRangeStart(iso).toISOString()).toBe(iso);
    expect(parseIstRangeEnd(iso).toISOString()).toBe(iso);
  });
});

// Phase A (GSTR-1 readiness) — the GSTR-1 finance-router endpoints previously defaulted `from` to
// `${new Date().getFullYear()}-04-01`, which is wrong for Jan-Mar (it points at a FY that hasn't
// started yet, e.g. "2027-04-01" while still filing for FY 2026-27). getCurrentFinancialYearStart
// fixes this: April-December -> this calendar year's own April 1; January-March -> last year's.
describe('getCurrentFinancialYearStart (Phase A FY default fix)', () => {
  it('April 1 -> that same calendar year\'s April 1 (FY just started)', () => {
    expect(getCurrentFinancialYearStart(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-04-01');
  });

  it('December 31 -> the current calendar year\'s April 1 (still inside that FY)', () => {
    expect(getCurrentFinancialYearStart(new Date('2026-12-31T23:59:59+05:30'))).toBe('2026-04-01');
  });

  it('January 1 -> the PREVIOUS calendar year\'s April 1', () => {
    expect(getCurrentFinancialYearStart(new Date('2027-01-01T00:00:00+05:30'))).toBe('2026-04-01');
  });

  it('March 31 -> still the previous calendar year\'s April 1 (FY about to roll over)', () => {
    expect(getCurrentFinancialYearStart(new Date('2027-03-31T23:59:59+05:30'))).toBe('2026-04-01');
  });

  it('April 1 of the next FY -> rolls over to the new calendar year\'s April 1', () => {
    expect(getCurrentFinancialYearStart(new Date('2027-04-01T00:00:00+05:30'))).toBe('2027-04-01');
  });

  it('is IST-anchored, not server-local/UTC — a UTC instant just after IST midnight already belongs to the new day', () => {
    // 2026-03-31T19:00:00Z = 2026-04-01T00:30:00 IST -> already April, FY has started.
    expect(getCurrentFinancialYearStart(new Date('2026-03-31T19:00:00.000Z'))).toBe('2026-04-01');
    // 2026-03-31T17:00:00Z = 2026-03-31T22:30:00 IST -> still March, FY has not started yet.
    expect(getCurrentFinancialYearStart(new Date('2026-03-31T17:00:00.000Z'))).toBe('2025-04-01');
  });
});
