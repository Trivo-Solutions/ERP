import { Request, Response, NextFunction } from 'express';
import { AppError } from './error';

// ═══════════════════════════════════════════════════════════════════════════
// Operator-injection guard.
//
// JSON bodies and (qs-parsed) query strings can carry OBJECTS where a handler expects a string. Handed to Prisma
// as `where: { clientId: req.body.clientId }`, the object `{"not":""}` is not an id — it is a FILTER
// ("every row whose clientId is not empty"). Company scoping and RLS still confine such a query to the caller's own
// company, but it defeats "look up THIS record" semantics (the wrong row can be updated / a 500 is thrown).
//
// Rules, applied once at the edge to every /api request:
//   * body: any key named `<something>Id` (or exactly `id`) must be a string or null — never an object / array;
//           any key named `<something>Ids` must be an array of strings.
//   * query: values must be strings or arrays of strings — never nested objects (`?status[not]=x`).
// Anything else is a 400 before it reaches a handler. Legitimate clients (the SPA) already send flat strings.
// ═══════════════════════════════════════════════════════════════════════════

const ID_KEY = /(^id$|Id$)/;
const IDS_KEY = /Ids$/;
const MAX_DEPTH = 8;

function badBody(value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${path || 'body'} is nested too deeply`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const r = badBody(value[i], `${path}[${i}]`, depth + 1); if (r) return r; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (IDS_KEY.test(k)) {
        if (v !== null && v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return `${here} must be a list of ids`;
      } else if (ID_KEY.test(k)) {
        if (v !== null && v !== undefined && typeof v !== 'string') return `${here} must be an id string`;
      }
      const r = badBody(v, here, depth + 1); if (r) return r;
    }
  }
  return null;
}

export function inputGuard(req: Request, _res: Response, next: NextFunction) {
  for (const [k, v] of Object.entries(req.query ?? {})) {
    const ok = typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) throw new AppError(`Invalid query parameter: ${k}`, 400);
  }
  const bad = badBody(req.body, '', 0);
  if (bad) throw new AppError(`Invalid request: ${bad}`, 400);
  next();
}
