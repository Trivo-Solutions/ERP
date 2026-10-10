import { startOfBusinessDay, endOfBusinessDay } from './businessDay';

// An estimate is a quote for one DAY: the metal rate it froze is only good until the business day ends. After that it can no
// longer be sent to billing or billed - the estimator makes a new one at the then-current rate. The day is the INDIA day
// (Asia/Kolkata - see businessDay.ts), independent of the server's own timezone; "expired" is worked out from when the
// estimate was made, never stored.
export const startOfLocalDay = startOfBusinessDay;
export const endOfLocalDay = endOfBusinessDay;
export function isEstimateExpired(createdAt: Date | string, now: Date = new Date()): boolean {
  return new Date(createdAt).getTime() < startOfBusinessDay(now).getTime();
}
