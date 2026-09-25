import { prisma } from '../config/database';
import { tenantQuery } from './tenantContext';

// Resolves the PriceMaster rate-card row for a stone grade at a given weight (C4) — the most
// recently effective active row whose weight range (if any) contains the weight; an unbounded
// weightFrom/weightTo on a row matches any weight. Returns null if nothing matches.
// companyId required (Phase 3) — PriceMaster is each company's own pricing policy, not a shared
// market rate card (see the schema's own comment).
export async function resolvePriceMaster(companyId: string, stoneGradeId: string, weight: number) {
  const rows = await tenantQuery(companyId, (_tx) => _tx.priceMaster.findMany({
    where: { companyId, stoneGradeId, isActive: true },
    orderBy: { effectiveDate: 'desc' },
  }));
  const match = rows.find((r) =>
    (r.weightFrom === null || weight >= Number(r.weightFrom)) &&
    (r.weightTo === null || weight <= Number(r.weightTo))
  );
  if (!match) return null;
  const saleRate = Number(match.pricePerCarat);
  return { saleRate, saleAmount: saleRate * weight };
}
