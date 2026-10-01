import { IST_OFFSET_MS } from './compliance';

// G2g-2: GST report date filters (`from`/`to`) accept either a plain business-day string
// (`YYYY-MM-DD`, what a date picker sends) or a full ISO timestamp. `new Date('2026-09-30')`
// parses a date-only string as UTC midnight (05:30 IST) — comparing that against a `lte: to`
// filter silently drops most of the actual business day (e.g. anything after 5:30am IST). A
// date-only value is instead resolved as one full calendar day in the business timezone
// (Asia/Kolkata, fixed +5:30, no DST — same constant compliance.ts's istDayBounds uses for a
// payment's own timestamp); a full timestamp is trusted as-is, unchanged. Scoped to the GST
// report endpoints only — not a general-purpose date abstraction.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function istDayStartMs(v: string): number {
  const [y, m, d] = v.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS;
}

/** Beginning of the requested business day (IST) if `v` is date-only; otherwise `v` as given. */
export function parseIstRangeStart(v: string): Date {
  return DATE_ONLY_RE.test(v) ? new Date(istDayStartMs(v)) : new Date(v);
}

/** End of the requested business day (IST) if `v` is date-only; otherwise `v` as given. */
export function parseIstRangeEnd(v: string): Date {
  return DATE_ONLY_RE.test(v) ? new Date(istDayStartMs(v) + 24 * 60 * 60 * 1000 - 1) : new Date(v);
}

/**
 * The start date (`YYYY-04-01`) of the Indian financial year that `now` falls in, IST-anchored.
 * FY runs 1 April - 31 March: April-December -> the current calendar year's own April 1;
 * January-March -> the PREVIOUS calendar year's April 1. `now` is shifted into IST the same way
 * shared/compliance.ts's own `istDayBounds` does (fixed +5:30, no DST) before reading its
 * calendar month/year, so a server running in UTC (or any other timezone) still resolves the
 * correct IST calendar date rather than "today" in the server's own local time — a GSTR-1 `from`
 * default must never silently drift a day around the IST midnight boundary.
 */
export function getCurrentFinancialYearStart(now: Date = new Date()): string {
  const istShifted = new Date(now.getTime() + IST_OFFSET_MS);
  const istYear = istShifted.getUTCFullYear();
  const istMonth = istShifted.getUTCMonth(); // 0 = January, 3 = April
  const fyStartYear = istMonth >= 3 ? istYear : istYear - 1;
  return `${fyStartYear}-04-01`;
}
