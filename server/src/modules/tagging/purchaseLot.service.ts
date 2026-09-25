import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { round2 } from '../../shared/inputGst';
import { TenantContext, canAccessBranch, tenantQuery, tenantTransaction } from '../../shared/tenantContext';

// Purchase lots (bags) — see shared/purchaseLot.ts for how a piece is cut from one. This file is the
// read side (what is in a bag, what is left, category by category) and the one write that ends a lot's
// life: closing it.

type LotWithSource = {
  id: string; label: string; karat: string | null; pieces: number | null; status: string;
  grossWeight: unknown; netWeight: unknown; totalCost: unknown;
  closedAt: Date | null; closeNote: string | null; createdAt: Date;
  grnItem: {
    grn: { grnNumber: string; receivedDate: Date; invoiceNumber: string | null; branchId: string | null; branch: { name: string } | null };
    poItem: {
      po: { poNumber: string; supplier: { id: string; name: string } };
      categories: Array<{
        id: string; categoryId: string; karat: string; grossWeight: unknown; stoneWeight: unknown; netWeight: unknown; pieces: number | null;
        costRate: unknown; mcRate: unknown; vaPercent: unknown;
        category: { name: string };
      }>;
    };
  };
};
type TagFigures = { categoryId: string | null; metalKarat: string | null; grossWeight: unknown; netWeight: unknown; costPrice: unknown };

const SOURCE_INCLUDE = {
  grnItem: {
    select: {
      grn: { select: { grnNumber: true, receivedDate: true, invoiceNumber: true, branchId: true, branch: { select: { name: true } } } },
      poItem: {
        select: {
          po: { select: { poNumber: true, supplier: { select: { id: true, name: true } } } },
          categories: { include: { category: { select: { name: true } } }, orderBy: { category: { name: 'asc' as const } } },
        },
      },
    },
  },
} as const;

const TAG_FIGURES = { categoryId: true, metalKarat: true, grossWeight: true, netWeight: true, costPrice: true } as const;

// What has been tagged out of the lot, and what is left — for the whole bag and for each category row.
// Live from the tags, never a stored counter. `remaining*` going non-zero on a CLOSED lot is the variance
// the closer was told about: goods or money that were on the invoice but never became a tag.
function summarize(lot: LotWithSource, tags: TagFigures[]) {
  const sum = (xs: TagFigures[], k: 'grossWeight' | 'netWeight' | 'costPrice') => xs.reduce((s, t) => s + Number(t[k]), 0);
  const taggedGross = sum(tags, 'grossWeight'), taggedNet = sum(tags, 'netWeight'), allocatedCost = sum(tags, 'costPrice');

  const categories = lot.grnItem.poItem.categories.map((r) => {
    const mine = tags.filter((t) => t.categoryId === r.categoryId && t.metalKarat === r.karat);
    const tGross = sum(mine, 'grossWeight'), tNet = sum(mine, 'netWeight');
    return {
      categoryId: r.categoryId, categoryName: r.category.name, karat: r.karat,
      grossWeight: Number(r.grossWeight), stoneWeight: Number(r.stoneWeight), netWeight: Number(r.netWeight),
      pieces: r.pieces,                                   // null = the invoice gave no count for this category
      // the cost rates entered once on the PO, which New Tag pre-fills on each piece (null = none entered)
      costRate: r.costRate == null ? null : Number(r.costRate),
      mcRate: r.mcRate == null ? null : Number(r.mcRate),
      vaPercent: r.vaPercent == null ? null : Number(r.vaPercent),
      taggedPieces: mine.length, remainingPieces: r.pieces == null ? null : r.pieces - mine.length,
      taggedGross: tGross, remainingGross: Number(r.grossWeight) - tGross,
      taggedNet: tNet, remainingNet: Number(r.netWeight) - tNet,
    };
  });

  return {
    pieces: lot.pieces, taggedPieces: tags.length, remainingPieces: lot.pieces == null ? null : lot.pieces - tags.length,
    grossWeight: Number(lot.grossWeight), taggedGross, remainingGross: Number(lot.grossWeight) - taggedGross,
    netWeight: Number(lot.netWeight), taggedNet, remainingNet: Number(lot.netWeight) - taggedNet,
    // `allocatedCost` is what the tags carry (each piece's own cost); `costVariance` is the invoice amount less that —
    // positive when the pieces carry less than was billed. Only meaningful once the bag is fully tagged.
    totalCost: Number(lot.totalCost), allocatedCost: round2(allocatedCost), remainingCost: round2(Number(lot.totalCost) - allocatedCost),
    costVariance: round2(Number(lot.totalCost) - allocatedCost),
    categories,
  };
}

const shape = (lot: LotWithSource, tags: TagFigures[]) => ({
  id: lot.id, label: lot.label, karat: lot.karat, status: lot.status, createdAt: lot.createdAt,
  closedAt: lot.closedAt, closeNote: lot.closeNote,
  grnNumber: lot.grnItem.grn.grnNumber, receivedDate: lot.grnItem.grn.receivedDate, invoiceNumber: lot.grnItem.grn.invoiceNumber,
  branchId: lot.grnItem.grn.branchId, branchName: lot.grnItem.grn.branch?.name ?? null,
  poNumber: lot.grnItem.poItem.po.poNumber, supplier: lot.grnItem.poItem.po.supplier,
  ...summarize(lot, tags),
});

// A branch-restricted user only sees lots received at a branch they hold. (A GRN with no branch — raw
// material — never opens a lot, so this only ever narrows.)
const visibleTo = (ctx: TenantContext, lot: LotWithSource) =>
  !lot.grnItem.grn.branchId || canAccessBranch(ctx, lot.grnItem.grn.branchId);

export async function listPurchaseLots(ctx: TenantContext, filters: { status?: string } = {}) {
  const lots = await tenantQuery(ctx.companyId, (tx) => tx.purchaseLot.findMany({
    where: { companyId: ctx.companyId, ...(filters.status && { status: filters.status }) },
    include: { ...SOURCE_INCLUDE, tags: { select: TAG_FIGURES } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  }));
  return lots.filter((l) => visibleTo(ctx, l)).map((l) => shape(l, l.tags));
}

export async function getPurchaseLot(ctx: TenantContext, id: string) {
  const lot = await tenantQuery(ctx.companyId, (tx) => tx.purchaseLot.findFirst({
    where: { id, companyId: ctx.companyId },
    include: {
      ...SOURCE_INCLUDE,
      tags: {
        select: { ...TAG_FIGURES, id: true, tagNumber: true, name: true, status: true, stoneWeight: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  }));
  if (!lot || !visibleTo(ctx, lot)) throw new AppError('Purchase lot not found', 404);
  return { ...shape(lot, lot.tags), tags: lot.tags };
}

/**
 * Ends a lot: no more pieces can be cut from it. Closing is report-only — it never touches a tag or the
 * ledger. Whatever was on the invoice but never tagged (a piece short, a few hundredths of a gram, a
 * rupee of cost) is returned as the lot's `remaining*` figures and stays visible on the lot; what to do
 * about it is a person's decision, not an automatic write-off (same stance as a stock audit's findings).
 */
export async function closePurchaseLot(ctx: TenantContext, id: string, userId: string, note?: string) {
  await tenantTransaction(ctx.companyId, async (tx) => {
    // Same row lock a tagger takes, so a piece being tagged right now is either in the totals or refused.
    const locked = await tx.purchaseLot.updateMany({ where: { id, companyId: ctx.companyId }, data: { version: { increment: 1 } } });
    if (locked.count !== 1) throw new AppError('Purchase lot not found', 404);
    const flipped = await tx.purchaseLot.updateMany({
      where: { id, companyId: ctx.companyId, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date(), closeNote: note?.trim() || null },
    });
    if (flipped.count !== 1) throw new AppError('This lot is already closed', 409);
  });
  await createAuditEntry('purchase_lots', id, userId, 'UPDATE', undefined, undefined, ctx.companyId);
  return getPurchaseLot(ctx, id);
}
