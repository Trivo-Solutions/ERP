import { createHash } from 'crypto';
import type { MaterialBreakdown } from '../../shared/materialBreakdown';
import type { OfferResolution } from './offerResolver';

// Offer management step 3 - pure logic (no Prisma). The "floor" of a piece is the rates its offer gave; selling any
// component BELOW that floor - zero tolerance - needs a manager's approval. An approval is tied to the exact figures
// through a hash, so it cannot be reused for a different (lower) rate, a different piece, or a different discount.

export interface OfferFloor {
  offerId: string;
  offerName: string;
  /** Offered making charge ₹/g and VA %, or null when the offer did not lower that component. */
  mcRate: number | null;
  vaPercent: number | null;
  /** Offered rate by the tag's material-row id; only rows the offer lowered appear. */
  rows: Record<string, number>;
}

/** The below-offer figures of one line, in a canonical shape (rows sorted) - what is hashed and shown to the manager. */
export interface RateSet {
  mcRate?: number;
  vaPercent?: number;
  /** `code` is only a label for the manager's screen - it is not part of the hash. */
  rows: { materialId: string; rate: number; code?: string }[];
}

export interface BelowOffer { requested: RateSet; offered: RateSet }

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function floorFromResolution(res: OfferResolution): OfferFloor | null {
  if (!res.offer) return null;
  return {
    offerId: res.offer.id, offerName: res.offer.name,
    mcRate: res.mc ? res.mc.offerRate : null,
    vaPercent: res.va ? res.va.offerRate : null,
    rows: Object.fromEntries(Object.entries(res.rows).map(([k, v]) => [k, v.offerRate])),
  };
}

/** The floor a line's stored snapshot recorded, or null when it predates the recording of offered rates. */
export function floorFromSnapshot(b: MaterialBreakdown): OfferFloor | null {
  const o = b.offer;
  if (!o) return null;
  const rows: Record<string, number> = {};
  for (const r of b.rows) if (r.materialId && r.offerRate !== undefined) rows[r.materialId] = r.offerRate;
  if (o.mcRate === undefined && o.vaPercent === undefined && Object.keys(rows).length === 0) return null;
  return { offerId: o.id, offerName: o.name, mcRate: o.mcRate ?? null, vaPercent: o.vaPercent ?? null, rows };
}

/** Which components of this line sit below the floor? null when none does. Compared at 4 dp, no tolerance. */
export function belowOffer(floor: OfferFloor, line: Pick<MaterialBreakdown, 'rows' | 'mcRate' | 'vaPercent'>): BelowOffer | null {
  const requested: RateSet = { rows: [] };
  const offered: RateSet = { rows: [] };
  if (floor.mcRate !== null && r4(line.mcRate) < r4(floor.mcRate)) { requested.mcRate = r4(line.mcRate); offered.mcRate = r4(floor.mcRate); }
  if (floor.vaPercent !== null && r4(line.vaPercent) < r4(floor.vaPercent)) { requested.vaPercent = r4(line.vaPercent); offered.vaPercent = r4(floor.vaPercent); }
  for (const row of line.rows) {
    const f = row.materialId ? floor.rows[row.materialId] : undefined;
    if (f !== undefined && r4(row.rate) < r4(f)) {
      requested.rows.push({ materialId: row.materialId!, rate: r4(row.rate), code: row.code });
      offered.rows.push({ materialId: row.materialId!, rate: r4(f), code: row.code });
    }
  }
  if (requested.mcRate === undefined && requested.vaPercent === undefined && requested.rows.length === 0) return null;
  const byId = (a: { materialId: string; rate: number }, b: { materialId: string; rate: number }) => a.materialId.localeCompare(b.materialId) || a.rate - b.rate;
  requested.rows.sort(byId);
  offered.rows.sort(byId);
  return { requested, offered };
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Identity of a line approval: this piece, exactly these below-offer rates. */
export const lineRateHash = (tagId: string, requested: RateSet) =>
  sha({ scope: 'LINE', tagId, mc: requested.mcRate ?? null, va: requested.vaPercent ?? null, rows: requested.rows.map((r) => ({ materialId: r.materialId, rate: r.rate })) });

/** Identity of a discount approval: exactly this extra discount amount (₹, 2 dp). */
export const discountRateHash = (amount: number) => sha({ scope: 'DISCOUNT', amount: Math.round(amount * 100) / 100 });

/** What a bill still has to have approved before it can be saved (the server's own computation, never the client's). */
export type ApprovalNeed =
  | { scope: 'LINE'; tagId: string; offerId: string; offerName: string; requested: RateSet; offered: RateSet; rateHash: string }
  | { scope: 'DISCOUNT'; amount: number; rateHash: string };

export function describeNeed(n: ApprovalNeed): string {
  if (n.scope === 'DISCOUNT') return `an extra discount of ₹${n.amount.toFixed(2)} on a bill carrying an offer`;
  const parts: string[] = [];
  if (n.requested.mcRate !== undefined) parts.push(`making charge ₹${n.requested.mcRate}/g (offer ₹${n.offered.mcRate}/g)`);
  if (n.requested.vaPercent !== undefined) parts.push(`VA ${n.requested.vaPercent}% (offer ${n.offered.vaPercent}%)`);
  if (n.requested.rows.length) parts.push(`${n.requested.rows.length} material rate(s) below the offered rate`);
  return `${parts.join(', ')} on a piece under offer "${n.offerName}"`;
}
