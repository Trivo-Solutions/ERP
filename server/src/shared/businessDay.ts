// The business day is the INDIA day (Asia/Kolkata, UTC+05:30, no daylight saving) - explicitly, not whatever timezone the server
// machine happens to be in. A quote's "same day" expiry, "is today's metal rate entered?" and the offers' "today" all use this,
// so they behave identically on a UTC container, an IST VM or a developer laptop.
export const BUSINESS_TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The India calendar day of an instant, as 'YYYY-MM-DD'. */
export function businessDayString(at: Date = new Date()): string {
  return dayFmt.format(at); // en-CA => YYYY-MM-DD
}

/** The instant the given India day starts (00:00:00.000 IST). */
export function startOfBusinessDay(at: Date = new Date()): Date {
  return new Date(`${businessDayString(at)}T00:00:00.000${IST_OFFSET}`);
}

/** The last millisecond of the given India day (23:59:59.999 IST). */
export function endOfBusinessDay(at: Date = new Date()): Date {
  return new Date(`${businessDayString(at)}T23:59:59.999${IST_OFFSET}`);
}

/** A 'YYYY-MM-DD' day as the UTC-midnight Date a Postgres @db.Date column round-trips. */
export function dayToDbDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
