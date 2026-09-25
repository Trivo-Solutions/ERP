import { prisma } from '../config/database';
import { tenantQuery } from './tenantContext';

// Resolves the daily rate to use for a given karat as of a given date — the latest
// MetalRate row with date <= the given date (handles gaps: weekends, days nobody
// updated the rate). Returns null if no rate has ever been entered for that karat/
// currency on or before that date; callers decide the fallback.
// companyId required (Phase 3) — MetalRate is each company's own quoted rate, not a shared
// market feed (see the schema's own comment on why).
export async function resolveMetalRate(companyId: string, karat: string, date: Date, currency = 'INR') {
  return tenantQuery(companyId, (_tx) => _tx.metalRate.findFirst({
    where: { companyId, karat, currency, date: { lte: date } },
    orderBy: { date: 'desc' },
  }));
}
