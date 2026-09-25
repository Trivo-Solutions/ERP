import { Request } from 'express';

// Express 4 types req.query values as string | string[] | ParsedQs | ParsedQs[].
// This helper safely extracts a single string value from a query param.
export function qs(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === 'string' ? v : undefined;
}

export function qsNum(req: Request, key: string, fallback?: number): number | undefined {
  const v = req.query[key];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
