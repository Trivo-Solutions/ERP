import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error';
import { round2 } from './inputGst';

// Purchase lots (bags): finished pieces bought on one supplier invoice line and tagged one at a time.
// The lot's whole cost is booked to the ledger when the GRN is received (createGRN); tagging a piece
// out of it only decides what share of that cost the piece carries.

// A piece's scale weight never matches the supplier's invoice to the milligram, so tags may total up to
// this much over the lot's invoice weight before the lot is considered over-tagged. Same 0.5% the GRN
// uses to decide whether a delivery's weight is verified.
export const LOT_WEIGHT_TOLERANCE = 0.005;

/**
 * What one piece costs out of a lot: its share of what is still un-allocated, pro-rata by net (metal)
 * weight — cost follows the gold, not the count. Because each share is taken from the *remaining* cost over
 * the *remaining* net weight, the shares add up to the lot total exactly (paise included), and the final
 * piece takes whatever is left, so nothing is lost to rounding.
 */
export function allocateLotCost(input: {
  remainingCost: number; remainingNet: number; pieceNet: number; isLastPiece: boolean;
}): number {
  const { remainingCost, remainingNet, pieceNet, isLastPiece } = input;
  if (isLastPiece) return round2(remainingCost);
  if (!(remainingNet > 0)) {
    throw new AppError('This lot has no net weight left to allocate cost against — close it, or correct the lot weights', 400);
  }
  // Never hand out more than what is left, even when a piece's scale weight runs a little over.
  return round2(Math.min(remainingCost, (remainingCost * pieceNet) / remainingNet));
}

/**
 * Validates one more piece against its lot and returns the cost it would carry by default. Must run inside the same
 * transaction that creates the tag: it takes the lot's row lock first (a no-op version bump — the second
 * of two concurrent taggers waits here until the first commits, then sees its tag in the totals), so two
 * pieces can never be handed the same share of the remainder.
 *
 * Two levels, because that is how the bill is written. The BAG has one cost and one net weight, and a piece's
 * cost is its share of what is left of it (allocateLotCost). The bag's CATEGORY rows (rings 22K, necklaces
 * 22K, ...) are what may be tagged: a piece must be in a category the bag holds, and cannot take a row past
 * its invoice weight (+0.5% scale tolerance) or its piece count, when it states one. A lot opened before
 * category rows existed has none, and is checked on its bag-level totals alone.
 *
 * Totals are read live from the lot's tags rather than kept as counters, so a later weight correction on
 * a tag can never leave a stale figure behind. Returned/retired pieces still count — the goods were
 * received and the cost allocated; a purchase return reverses it on the ledger, not in the lot.
 */
export async function allocateFromLot(
  tx: Prisma.TransactionClient,
  companyId: string,
  lotId: string,
  piece: { grossWeight: number; netWeight: number; metalKarat?: string | null; categoryId?: string | null },
) {
  if (typeof lotId !== 'string' || !lotId) throw new AppError('Purchase lot is required', 400);

  const locked = await tx.purchaseLot.updateMany({ where: { id: lotId, companyId }, data: { version: { increment: 1 } } });
  if (locked.count !== 1) throw new AppError('Purchase lot not found', 404);
  const lot = await tx.purchaseLot.findFirstOrThrow({ where: { id: lotId, companyId } });

  if (!(piece.grossWeight > 0) || !(piece.netWeight > 0)) {
    throw new AppError('Gross and net weight are required to tag a piece out of a lot (its cost is split by net weight)', 400);
  }
  if (piece.netWeight > piece.grossWeight) throw new AppError('Net weight cannot exceed gross weight', 400);

  const rows = await tx.poItemCategory.findMany({
    where: { companyId, poItem: { grnItems: { some: { id: lot.grnItemId } } } },
    include: { category: { select: { name: true } } },
    orderBy: { category: { name: 'asc' } },
  });
  const tags = await tx.jewelryTag.findMany({
    where: { companyId, purchaseLotId: lotId },
    select: { categoryId: true, metalKarat: true, grossWeight: true, netWeight: true, costPrice: true },
  });
  const sum = (xs: typeof tags, k: 'grossWeight' | 'netWeight' | 'costPrice') => xs.reduce((s, t) => s + Number(t[k]), 0);
  const taggedPieces = tags.length, taggedGross = sum(tags, 'grossWeight'), taggedNet = sum(tags, 'netWeight');
  const allocatedCost = sum(tags, 'costPrice');

  if (lot.pieces != null && taggedPieces >= lot.pieces) {
    throw new AppError(`All ${lot.pieces} pieces of this lot are already tagged`, 409);
  }
  if (lot.status !== 'OPEN') throw new AppError(`Lot ${lot.label} is closed — no more pieces can be tagged from it`, 409);

  const over = (after: number, invoice: number) => after > Number(invoice) * (1 + LOT_WEIGHT_TOLERANCE);
  let karat: string | undefined = piece.metalKarat ?? undefined;

  if (rows.length === 0) {
    // Legacy lot: one karat and one total, no category rows.
    if (lot.karat && piece.metalKarat && lot.karat !== piece.metalKarat) {
      throw new AppError(`This lot is ${lot.karat}; the piece is ${piece.metalKarat}`, 400);
    }
    karat = karat ?? lot.karat ?? undefined;
  } else {
    const label = (r: (typeof rows)[number]) => `${r.category.name} ${r.karat}`;
    const holds = rows.map(label).join(', ');
    let candidates = rows.filter((r) => r.categoryId === piece.categoryId);
    if (candidates.length === 0) {
      throw new AppError(`This lot has no such category — it holds: ${holds}. Choose one of those as the piece's category`, 400);
    }
    if (candidates.length > 1) {
      candidates = piece.metalKarat ? candidates.filter((r) => r.karat === piece.metalKarat) : [];
      if (candidates.length !== 1) throw new AppError(`This lot holds this category in more than one karat (${holds}) — set the piece's karat`, 400);
    }
    const row = candidates[0];
    if (piece.metalKarat && piece.metalKarat !== row.karat) {
      throw new AppError(`${row.category.name} in this lot is ${row.karat}; the piece is ${piece.metalKarat}`, 400);
    }
    karat = row.karat;

    const mine = tags.filter((t) => t.categoryId === row.categoryId && t.metalKarat === row.karat);
    if (row.pieces != null && mine.length >= row.pieces) {
      throw new AppError(`All ${row.pieces} ${label(row)} pieces of this lot are already tagged`, 409);
    }
    const rowGross = sum(mine, 'grossWeight') + piece.grossWeight;
    const rowNet = sum(mine, 'netWeight') + piece.netWeight;
    if (over(rowGross, Number(row.grossWeight))) {
      throw new AppError(`Gross weight would exceed ${label(row)} in this lot: ${rowGross.toFixed(3)} g tagged against ${Number(row.grossWeight).toFixed(3)} g on the invoice`, 400);
    }
    if (over(rowNet, Number(row.netWeight))) {
      throw new AppError(`Net weight would exceed ${label(row)} in this lot: ${rowNet.toFixed(3)} g tagged against ${Number(row.netWeight).toFixed(3)} g on the invoice`, 400);
    }
  }

  // The bag as a whole can never be over-tagged either.
  if (over(taggedGross + piece.grossWeight, Number(lot.grossWeight))) {
    throw new AppError(
      `Gross weight would exceed the lot: ${(taggedGross + piece.grossWeight).toFixed(3)} g tagged against ${Number(lot.grossWeight).toFixed(3)} g on the invoice`, 400);
  }
  if (over(taggedNet + piece.netWeight, Number(lot.netWeight))) {
    throw new AppError(
      `Net weight would exceed the lot: ${(taggedNet + piece.netWeight).toFixed(3)} g tagged against ${Number(lot.netWeight).toFixed(3)} g on the invoice`, 400);
  }

  // The final piece takes whatever cost is left: the one that completes the piece count (when the invoice
  // gave one for every category), or brings the tagged net weight up to the bag's (within the scale tolerance).
  const isLastPiece = (lot.pieces != null && taggedPieces + 1 === lot.pieces)
    || taggedNet + piece.netWeight >= Number(lot.netWeight) * (1 - LOT_WEIGHT_TOLERANCE);
  const costPrice = allocateLotCost({
    remainingCost: round2(Number(lot.totalCost) - allocatedCost),
    remainingNet: Number(lot.netWeight) - taggedNet,
    pieceNet: piece.netWeight,
    isLastPiece,
  });
  // It closes the lot — nothing is left to tag, so it should not sit in the "open lots" picker. (A lot that
  // is never completed is closed by hand; what was left over then stays visible as its variance.)
  if (isLastPiece) {
    await tx.purchaseLot.update({ where: { id: lot.id }, data: { status: 'CLOSED', closedAt: new Date(), closeNote: 'All pieces tagged' } });
  }
  // `suggestedCost` is only what the piece would carry if nobody entered a cost of their own: tags built from
  // rates the PO carried (or edited on the tag) set their own cost, and the bag reports the difference from the
  // invoice as its variance. See createTag.
  return { suggestedCost: costPrice, metalKarat: karat, lot };
}
