// Most-specific-match-wins lookup over the MakingCharge master: a row matches when every field IT has pinned (non-null)
// agrees with the piece; a null field means "any". Among matches the row pinning the most dimensions wins, and the
// caller's own ordering (effectiveDate desc) breaks ties. The one server-side copy (client: utils/estimateCalc.findMakingCharge).
export interface MakingChargeRowLike { categoryId: string | null; karat: string | null; makeType: string | null }

export function pickMakingCharge<T extends MakingChargeRowLike>(
  rows: T[], categoryId: string | null | undefined, karat: string | null | undefined, makeType: string | null | undefined,
): T | undefined {
  const eligible = rows.filter((m) =>
    (m.categoryId == null || m.categoryId === categoryId) &&
    (m.karat == null || m.karat === karat) &&
    (m.makeType == null || m.makeType === makeType));
  if (eligible.length === 0) return undefined;
  const specificity = (m: T) => (m.categoryId != null ? 1 : 0) + (m.karat != null ? 1 : 0) + (m.makeType != null ? 1 : 0);
  const best = Math.max(...eligible.map(specificity));
  return eligible.find((m) => specificity(m) === best);
}
