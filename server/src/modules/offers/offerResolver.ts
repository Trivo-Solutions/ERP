// Pure offer resolution — no Prisma, no I/O. Given a piece's SALE rates and the offers on file, decide which
// rates an offer lowers on a given day.
//
// Layering (the price pipeline this slots into):
//   tagged sale rate -> (future) bulk temporary price change for the date -> OFFER -> final rate
// The caller passes in the BASE rate (today: the tagged rate; later: the bulk-changed rate), so this file never
// needs to change when the bulk feature arrives.
//
// Rules, as agreed:
//  * NO STACKING. For a piece, exactly ONE offer wins: highest priority, then newest. Within it, each
//    component (MC / VA / each stone row / metal) takes its single most specific matching rule.
//  * An offer only ever LOWERS a rate. PERCENT_OFF always does; FIXED_RATE applies only when the fixed rate is
//    below the base rate (a stone tagged 700 under an 800 fixed offer stays 700).
//  * An offer that changes nothing for this piece is not a candidate, so it can never shadow a lower-priority
//    offer that would have applied.

export type OfferComponent = 'MAKING_CHARGE' | 'VA' | 'STONE' | 'METAL';
export type OfferMode = 'PERCENT_OFF' | 'FIXED_RATE';

export const OFFER_COMPONENTS: readonly OfferComponent[] = ['MAKING_CHARGE', 'VA', 'STONE', 'METAL'];
export const OFFER_MODES: readonly OfferMode[] = ['PERCENT_OFF', 'FIXED_RATE'];

export interface OfferRuleLike {
  id: string;
  component: string;
  mode: string;
  value: number;
  stoneTypeId?: string | null;
  categoryId?: string | null;
  karat?: string | null;
}

export interface OfferLike {
  id: string;
  name: string;
  priority: number;
  createdAt: Date;
  /** Inclusive calendar dates, 'YYYY-MM-DD'. */
  effectiveFrom: string;
  effectiveTo: string | null;
  branchId?: string | null;
  isActive: boolean;
  rules: OfferRuleLike[];
}

export interface PieceRateRow {
  /** Opaque caller key (e.g. the material row id) echoed back in the result. */
  key: string;
  materialType: string;
  stoneTypeId?: string | null;
  rate: number;
}

export interface PieceRates {
  categoryId?: string | null;
  karat?: string | null;
  branchId?: string | null;
  /** Base MC (₹/g) and VA (%) for the piece. */
  mcRate: number;
  vaPercent: number;
  rows: PieceRateRow[];
}

export interface RateAdjustment {
  baseRate: number;
  offerRate: number;
  ruleId: string;
  mode: OfferMode;
  value: number;
}

export interface OfferResolution {
  offer: { id: string; name: string } | null;
  mc: RateAdjustment | null;
  va: RateAdjustment | null;
  /** Keyed by PieceRateRow.key; only rows an offer actually lowers appear. */
  rows: Record<string, RateAdjustment>;
}

const NONE: OfferResolution = { offer: null, mc: null, va: null, rows: {} };

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Is `asOf` ('YYYY-MM-DD') inside the offer's inclusive window? */
export function offerCoversDate(o: Pick<OfferLike, 'effectiveFrom' | 'effectiveTo'>, asOf: string): boolean {
  return o.effectiveFrom <= asOf && (o.effectiveTo == null || asOf <= o.effectiveTo);
}

/** The rate a rule would give, or null when it would not LOWER the base. */
function applyRule(rule: OfferRuleLike, base: number): RateAdjustment | null {
  if (!(base > 0)) return null;
  const value = Number(rule.value);
  let offerRate: number;
  if (rule.mode === 'PERCENT_OFF') offerRate = round4(base * (1 - value / 100));
  else if (rule.mode === 'FIXED_RATE') offerRate = round4(value);
  else return null;
  if (!(offerRate < base)) return null;
  return { baseRate: base, offerRate, ruleId: rule.id, mode: rule.mode as OfferMode, value };
}

const specificity = (r: OfferRuleLike) => (r.stoneTypeId ? 1 : 0) + (r.categoryId ? 1 : 0) + (r.karat ? 1 : 0);

/** Most specific matching rule's adjustment; ties go to the bigger reduction. */
function bestAdjustment(rules: OfferRuleLike[], base: number): RateAdjustment | null {
  let best: { adj: RateAdjustment; spec: number } | null = null;
  for (const r of rules) {
    const adj = applyRule(r, base);
    if (!adj) continue;
    const spec = specificity(r);
    if (!best || spec > best.spec || (spec === best.spec && adj.offerRate < best.adj.offerRate)) best = { adj, spec };
  }
  return best?.adj ?? null;
}

function resolveWithin(offer: OfferLike, piece: PieceRates): OfferResolution {
  // Narrowing dimensions the piece must satisfy (a rule that pins a category/karat only matches that one).
  const scoped = offer.rules.filter((r) =>
    (!r.categoryId || r.categoryId === piece.categoryId) && (!r.karat || r.karat === piece.karat));
  const of = (c: OfferComponent) => scoped.filter((r) => r.component === c);

  const rows: Record<string, RateAdjustment> = {};
  for (const row of piece.rows) {
    const adj = row.materialType === 'METAL'
      ? bestAdjustment(of('METAL'), row.rate)
      : bestAdjustment(of('STONE').filter((r) => !r.stoneTypeId || r.stoneTypeId === row.stoneTypeId), row.rate);
    if (adj) rows[row.key] = adj;
  }
  return {
    offer: { id: offer.id, name: offer.name },
    mc: bestAdjustment(of('MAKING_CHARGE'), piece.mcRate),
    va: bestAdjustment(of('VA'), piece.vaPercent),
    rows,
  };
}

const changesSomething = (r: OfferResolution) => !!r.mc || !!r.va || Object.keys(r.rows).length > 0;

/** Picks the single winning offer for this piece on `asOf` and returns what it lowers (or NONE). */
export function resolveOffer(offers: OfferLike[], piece: PieceRates, asOf: string): OfferResolution {
  const candidates = offers
    .filter((o) => o.isActive && offerCoversDate(o, asOf) && (!o.branchId || o.branchId === piece.branchId))
    .sort((a, b) => b.priority - a.priority || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const o of candidates) {
    const res = resolveWithin(o, piece);
    if (changesSomething(res)) return res;
  }
  return NONE;
}
