import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { tenantQuery } from './tenantContext';

// Gold is quoted once a day as a 24K Gold rate and a 24K Old Gold rate; every other active GOLD karat is
// DERIVED from those two on the server: base x that karat's KaratMaster purity / 99.9 (the master is the source
// of truth - e.g. 22K = 0.9160, never 22/24). The derived value is stored in MetalRate like any other
// rate, so every consumer (resolveMetalRate, /rates/latest, ...) keeps reading the same rows, and a later
// rate change never reprices a past document (they snapshot the rate they used).
export const GOLD_BASE_KARAT = '24K';

// Silver is quoted the same way: one Silver 999 rate and one Old Silver 999 rate per day, stored as the ordinary MetalRate
// row of the '999' KaratMaster purity (rate = normal, ogRatePerGram = old). Every other Silver purity (925, a tested 87.3%...)
// is calculated from it.
export const SILVER_BASE_KARAT = '999';

// The market quotes both metals against 999 purity. A derived rate is therefore base x purity / 99.9 - NOT purity / 100:
// 22K gold = 24K rate x 0.916 / 0.999. The divisor is this constant, never the base row's own KaratMaster purity (24K is
// stored as 0.9999). Used by the rate sheet and by Material Purchase valuation so they cannot disagree.
export const BENCHMARK_PURITY = new Prisma.Decimal('0.999');

// Same 2-decimal half-up rounding the rest of the money code uses, done in Decimal so there is no
// float drift (stored column is Decimal(12,4)). `purity` is a fraction (0.925).
export function deriveKaratRate(base: Prisma.Decimal.Value, purity: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(base).mul(purity).div(BENCHMARK_PURITY).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

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
