/**
 * Financial year and date utilities for GST reports.
 * Follows the Indian April-March financial year cycle.
 */

export function gstFinancialYear(date: Date = new Date()): number {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0 = Jan, 1 = Feb, 2 = Mar, 3 = Apr, ...
  return month < 3 ? year - 1 : year;
}

export function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultGstFrom(date: Date = new Date()): string {
  return `${gstFinancialYear(date)}-04-01`;
}

export function defaultGstTo(date: Date = new Date()): string {
  return formatLocalDate(date);
}
