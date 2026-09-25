import { AppError } from '../middleware/error';

// JSON has no Date type: every date arrives as an ISO string and must become a real Date before it reaches the
// service (which calls Date methods on it, e.g. getFullYear() for the document number). A missing/garbage date is
// a 400 — never a 500, and never an "Invalid Date" that silently poisons a document number.
export function parseDate(v: unknown, label: string, fallbackNow = false): Date {
  if (v === undefined || v === null || v === '') {
    if (fallbackNow) return new Date();
    throw new AppError(`${label} is required`, 400);
  }
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) throw new AppError(`${label} is not a valid date`, 400);
  return d;
}

// Optional date: absent stays undefined, a present-but-garbage value is still a 400.
export function parseOptionalDate(v: unknown, label: string): Date | undefined {
  return v === undefined || v === null || v === '' ? undefined : parseDate(v, label);
}
