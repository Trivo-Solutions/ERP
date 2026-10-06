import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { assertSubCategoryForCategory } from '../../shared/subCategory';
import { createAuditEntry } from '../../middleware/audit';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { isValidKarat } from '../../shared/karatMaster';
import { resolveMetalRate } from '../../shared/metalRate';
import { resolveSupplierStateCode, splitInputGst, round2, resolveBuyerRegistration } from '../../shared/inputGst';
import { resolvePriceMaster } from '../../shared/priceMaster';
import { allocateFromLot } from '../../shared/purchaseLot';
import { rateForTagMaterial } from '../../shared/vendorRates';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { bookRcmLiabilityIfApplicable } from '../finance/gst/gstr3bRcmBooking.service';
import { assertGstr3bPeriodMutable } from '../finance/gst/gstr3bFilingProtection';
import { generateTsplForTag, resolveAllBoundFields, TagTemplateLayout } from '../../shared/tsplGenerator';
import { nextSimpleCode, nextTagNumber, nextDocumentNumber } from '../../shared/numberSequence';
import { TenantContext, canAccessBranch, tenantTransaction, tenantBatch, tenantQuery } from '../../shared/tenantContext';
import {
  assertBranchAccessible, assertTransferBranchesAccessible, assertOwnedIfPresent, assertAllOwned, assertOwnedByCompany,
} from '../../middleware/tenant';

// ─── Manufacturer from a supplier ─────────────────────────────────────────────
// A tag's Manufacturer is a Client (type MANUFACTURER) while a PO is raised on a Supplier — two party
// tables that don't know each other. When the goods being tagged came from a PO, the supplier IS normally the
// manufacturer, so this gives the tag screen the matching Client to pre-select: found by GSTIN (else by name,
// ignoring case) among the company's existing manufacturers, and created once, from the supplier's own details,
// if there is none yet. Idempotent — asking twice returns the same Client.
export async function manufacturerForSupplier(ctx: TenantContext, supplierId: string) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');
  const s = await tenantQuery(ctx.companyId, (tx) => tx.supplier.findUniqueOrThrow({ where: { id: supplierId } }));
  const gst = s.gstNumber?.trim().toUpperCase() || undefined;

  return tenantTransaction(ctx.companyId, async (tx) => {
    const existing = await tx.client.findFirst({
      where: {
        companyId: ctx.companyId, type: 'MANUFACTURER', isActive: true,
        OR: [
          ...(gst ? [{ gstNumber: { equals: gst, mode: 'insensitive' as const } }] : []),
          { name: { equals: s.name.trim(), mode: 'insensitive' as const } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;
    const clientCode = await nextSimpleCode(ctx.companyId, 'CLIENT', 'CL', 5, tx);
    return tx.client.create({
      data: {
        companyId: ctx.companyId, clientCode, type: 'MANUFACTURER', name: s.name.trim(),
        gstNumber: gst, panNumber: s.panNumber, phone: s.phone, email: s.email, contactPerson: s.contactName,
        address: s.address, city: s.city, state: s.state, pincode: s.pincode,
      },
    });
  });
}

// ─── Branches ────────────────────────────────────────────────────────────────
// companyId is always the caller's own tenant context — never a request parameter (see
// middleware/tenant.ts's rejectClientTenantSelectors + resolveTenantContext).

export async function listBranches(companyId: string) {
  return tenantQuery(companyId, (_tx) => _tx.branch.findMany({
    where: { companyId, isActive: true },
    orderBy: { name: 'asc' },
  }));
}

export async function createBranch(companyId: string, data: {
  name: string; address?: string; city?: string; state?: string;
  phone?: string; email?: string; managerName?: string; isHeadOffice?: boolean;
}) {
  const branchCode = await nextSimpleCode(companyId, 'BRANCH', 'BR', 4);
  return tenantQuery(companyId, (_tx) => _tx.branch.create({ data: { ...data, companyId, branchCode } }));
}

// Layer 2: id ownership validated before the update runs.
export async function updateBranch(id: string, companyId: string, data: {
  name?: string; address?: string; city?: string; state?: string;
  phone?: string; email?: string; managerName?: string;
  isHeadOffice?: boolean; isActive?: boolean;
  // G1 Part B/K: which GST registration this branch invoices under — null clears it (falls back
  // to the company's primary registration at invoice time, see sales.service.ts:resolveSellerRegistration).
  gstRegistrationId?: string | null;
}) {
  const existing = await tenantQuery(companyId, (_tx) => _tx.branch.findUnique({ where: { id }, select: { companyId: true } }));
  if (!existing || existing.companyId !== companyId) throw new AppError('Branch not found', 404);
  await assertOwnedIfPresent('companyGstRegistration', data.gstRegistrationId, companyId, 'GST registration');
  return tenantQuery(companyId, (_tx) => _tx.branch.update({ where: { id }, data }));
}

// E2: inter-branch stock visibility, one screen for the whole network. Scoped to "stock" in the
// literal sense — where current inventory is actually sitting right now (IN_STOCK / out on memo /
// in transit) — not SOLD/RETIRED, which are closed history rather than something to visualize
// across branches.
const STOCK_STATUSES = ['IN_STOCK', 'ON_APPROVAL', 'TRANSFERRED'] as const;

export async function getBranchStockSummary(companyId: string) {
  const [branches, grouped] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.branch.findMany({ where: { companyId, isActive: true }, orderBy: { name: 'asc' } })),
    tenantQuery(companyId, (_tx) => _tx.jewelryTag.groupBy({
      by: ['branchId', 'status'],
      where: { companyId, status: { in: STOCK_STATUSES as unknown as string[] } },
      _count: { _all: true },
      _sum: { sellingPrice: true, costPrice: true, grossWeight: true },
    })),
  ]);

  return branches.map((b) => {
    const byStatus = (status: string) => grouped.find((g) => g.branchId === b.id && g.status === status);
    const inStock = byStatus('IN_STOCK');
    return {
      branchId: b.id, branchCode: b.branchCode, branchName: b.name,
      inStock: {
        count: inStock?._count._all ?? 0,
        sellingValue: Number(inStock?._sum.sellingPrice ?? 0),
        costValue: Number(inStock?._sum.costPrice ?? 0),
        grossWeight: Number(inStock?._sum.grossWeight ?? 0),
      },
      onApprovalCount: byStatus('ON_APPROVAL')?._count._all ?? 0,
      inTransitCount: byStatus('TRANSFERRED')?._count._all ?? 0,
    };
  });
}

// H2: stock on hand, sliced by branch AND category (E2's getBranchStockSummary above only slices
// by branch). Scoped strictly to IN_STOCK — unlike E2, this isn't a network-visibility screen, it's
// "what could I sell right now," so ON_APPROVAL/TRANSFERRED pieces (spoken for or in transit)
// don't belong in it.
export async function getStockOnHand(companyId: string, filters: { branchId?: string; categoryId?: string } = {}) {
  const [branches, categories, grouped] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.branch.findMany({ where: { companyId, isActive: true }, orderBy: { name: 'asc' } })),
    tenantQuery(companyId, (_tx) => _tx.productCategory.findMany({ where: { companyId }, orderBy: { name: 'asc' } })),
    tenantQuery(companyId, (_tx) => _tx.jewelryTag.groupBy({
      by: ['branchId', 'categoryId'],
      where: {
        companyId,
        status: 'IN_STOCK',
        ...(filters.branchId && { branchId: filters.branchId }),
        ...(filters.categoryId && { categoryId: filters.categoryId }),
      },
      _count: { _all: true },
      _sum: { sellingPrice: true, costPrice: true, grossWeight: true },
    })),
  ]);

  const branchById = new Map(branches.map((b) => [b.id, b]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const rows = grouped
    .filter((g) => branchById.has(g.branchId)) // an inactive branch's stock isn't dropped from
    .map((g) => ({                             // reality, just not relevant to this screen
      branchId: g.branchId, branchName: branchById.get(g.branchId)!.name,
      categoryId: g.categoryId, categoryName: g.categoryId ? categoryById.get(g.categoryId)?.name ?? 'Unknown' : 'Uncategorized',
      count: g._count._all,
      sellingValue: Number(g._sum.sellingPrice ?? 0),
      costValue: Number(g._sum.costPrice ?? 0),
      grossWeight: Number(g._sum.grossWeight ?? 0),
    }))
    .sort((a, b) => a.branchName.localeCompare(b.branchName) || a.categoryName.localeCompare(b.categoryName));

  return {
    rows,
    totals: {
      count: rows.reduce((s, r) => s + r.count, 0),
      sellingValue: rows.reduce((s, r) => s + r.sellingValue, 0),
      costValue: rows.reduce((s, r) => s + r.costValue, 0),
      grossWeight: rows.reduce((s, r) => s + r.grossWeight, 0),
    },
  };
}

// H3: dead stock / ageing — how long has IN_STOCK piece been sitting. Anchored on `updatedAt`
// (proxy for "time in current status"), not `createdAt`: a tag returned (D1) and put back
// IN_STOCK keeps its original createdAt, which would overstate its age after a resale attempt.
// updatedAt isn't perfectly exclusive to status changes either (any field edit bumps it), but tag
// rows are rarely touched after creation outside a status flip, so it's a reasonable proxy — same
// class of documented approximation as F3's dueDate-or-invoiceDate anchor.
export async function getDeadStock(companyId: string, asOfDate?: Date) {
  const cutoff = asOfDate ?? new Date();
  const tags = await tenantQuery(companyId, (_tx) => _tx.jewelryTag.findMany({
    where: { companyId, status: 'IN_STOCK' },
    select: {
      id: true, tagNumber: true, name: true, sellingPrice: true, costPrice: true, updatedAt: true,
      branch: { select: { name: true } },
      category: { select: { name: true } },
    },
  }));

  const rows = tags.map((t) => {
    const daysInStock = Math.floor((cutoff.getTime() - new Date(t.updatedAt).getTime()) / 86_400_000);
    return {
      id: t.id, tagNumber: t.tagNumber, name: t.name,
      branchName: t.branch.name, categoryName: t.category?.name ?? 'Uncategorized',
      sellingValue: Number(t.sellingPrice), costValue: Number(t.costPrice),
      daysInStock,
      bucket: daysInStock <= 90 ? '0-90' : daysInStock <= 180 ? '91-180' : daysInStock <= 365 ? '181-365' : '365+',
    };
  }).sort((a, b) => b.daysInStock - a.daysInStock);

  const bucketTotals = { '0-90': 0, '91-180': 0, '181-365': 0, '365+': 0 } as Record<string, number>;
  for (const r of rows) bucketTotals[r.bucket] += r.costValue;

  return {
    asOfDate: cutoff, rows, bucketTotals,
    totals: { count: rows.length, costValue: rows.reduce((s, r) => s + r.costValue, 0) },
  };
}

// Stock Book: one row per tag with every attribute a person might want to slice by. The client
// switches columns on/off and can group the rows into a summary, so this deliberately returns the
// flat detail rather than pre-aggregating.
//
// Branch scope is enforced HERE from the caller's own branch grants (same rule as listTags): a
// branch-restricted user only ever sees their assigned branches — asking for another branch's id
// simply matches nothing, and with no branch asked they get all of *their* branches, never the whole
// company. `branches` in the result is the picker list for the same reason (listBranches returns
// every branch in the company, which a restricted user must not be offered).
//
// Not a point-in-time ledger: the system keeps no stock movement history, so "as of a past date" can't
// be reconstructed. The date range filters on when the piece was TAGGED (createdAt); status is its
// status right now.
const STOCK_BOOK_LIMIT = 50_000;
export const STOCK_BOOK_STATUS_FILTERS = ['IN_STOCK', 'ON_APPROVAL', 'TRANSFERRED', 'SOLD', 'RETIRED', 'STOCK', 'ALL'] as const;

export async function getStockBook(ctx: TenantContext, filters: {
  branchId?: string; status?: string; categoryId?: string; dateFrom?: Date; dateTo?: Date;
} = {}) {
  const status = filters.status ?? 'IN_STOCK';
  if (!(STOCK_BOOK_STATUS_FILTERS as readonly string[]).includes(status)) throw new AppError('Invalid status filter', 400);

  const allBranches = await tenantQuery(ctx.companyId, (_tx) => _tx.branch.findMany({
    where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' },
    select: { id: true, branchCode: true, name: true },
  }));
  const branches = allBranches.filter((b) => canAccessBranch(ctx, b.id));

  const allowedBranchIds = filters.branchId
    ? (canAccessBranch(ctx, filters.branchId) ? [filters.branchId] : ['__none__'])
    : (ctx.branchAccess.allBranches ? undefined : ctx.branchAccess.branchIds);

  const statusWhere = status === 'ALL' ? undefined
    : status === 'STOCK' ? { in: STOCK_STATUSES as unknown as string[] }
    : status;

  const where: Prisma.JewelryTagWhereInput = {
    companyId: ctx.companyId,
    ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
    ...(statusWhere && { status: statusWhere }),
    ...(filters.categoryId && { categoryId: filters.categoryId }),
    ...((filters.dateFrom || filters.dateTo) && {
      createdAt: {
        ...(filters.dateFrom && { gte: filters.dateFrom }),
        ...(filters.dateTo && { lte: new Date(new Date(filters.dateTo).setHours(23, 59, 59, 999)) }),
      },
    }),
  };

  const tags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where,
    select: {
      id: true, tagNumber: true, name: true, status: true, makeType: true, metalType: true, metalKarat: true,
      huid: true, settingType: true, grossWeight: true, netWeight: true, stoneWeight: true,
      costPrice: true, sellingPrice: true, createdAt: true, updatedAt: true,
      branch: { select: { id: true, name: true, branchCode: true } },
      category: { select: { name: true } },
      subCategory: { select: { name: true } },
      collection: { select: { name: true } },
      stockType: { select: { name: true } },
      manufacturer: { select: { name: true } },
      materials: { select: { materialType: true, weight: true, pieces: true } },
    },
    orderBy: [{ tagNumber: 'asc' }],
    take: STOCK_BOOK_LIMIT + 1,
  }));
  const truncated = tags.length > STOCK_BOOK_LIMIT;
  if (truncated) tags.pop();

  const now = Date.now();
  const rows = tags.map((t) => {
    // Diamonds and coloured stones are the two stone columns a jeweller reads; anything else non-metal
    // (a plain "STONE" row, pearls…) counts with the coloured stones. Weights are already carats.
    let diaWt = 0; let csWt = 0; let stonePieces = 0;
    for (const m of t.materials) {
      if (m.materialType === 'METAL') continue;
      const w = Number(m.weight);
      if (m.materialType === 'DIAMOND') diaWt += w; else csWt += w;
      stonePieces += m.pieces ?? 0;
    }
    return {
      id: t.id, tagNumber: t.tagNumber, name: t.name, status: t.status,
      branchId: t.branch.id, branchName: t.branch.name, branchCode: t.branch.branchCode,
      category: t.category?.name ?? 'Uncategorized', subCategory: t.subCategory?.name ?? '',
      collection: t.collection?.name ?? '', stockType: t.stockType?.name ?? '',
      manufacturer: t.manufacturer?.name ?? '',
      makeType: t.makeType, metalType: t.metalType, metalKarat: t.metalKarat ?? '',
      huid: t.huid ?? '', settingType: t.settingType ?? '',
      qty: 1,
      grossWeight: Number(t.grossWeight), netWeight: Number(t.netWeight), stoneWeight: Number(t.stoneWeight),
      diaWt: Math.round(diaWt * 1000) / 1000, csWt: Math.round(csWt * 1000) / 1000, stonePieces,
      costPrice: Number(t.costPrice), sellingPrice: Number(t.sellingPrice),
      taggedOn: t.createdAt, updatedAt: t.updatedAt,
      // Days since the status last changed — same updatedAt proxy (and caveat) as getDeadStock.
      daysInStatus: Math.floor((now - new Date(t.updatedAt).getTime()) / 86_400_000),
    };
  });

  return { branches, rows, truncated, limit: STOCK_BOOK_LIMIT };
}

// ─── Jewelry Tags ─────────────────────────────────────────────────────────────

export async function listTags(ctx: TenantContext, filters: {
  status?: string; branchId?: string; dateFrom?: Date; dateTo?: Date;
  page?: number; limit?: number;
}) {
  const { status, branchId, dateFrom, dateTo, page = 1, limit = 30 } = filters;

  // Branch scoping: companyId is always applied. If the caller asked for a specific branchId,
  // it must be one they're actually allowed to see (company ownership AND branch grant) —
  // requesting a same-company-but-unassigned branch, or another company's branch entirely, must
  // not widen or redirect the result; it must simply not match. If no branchId was requested,
  // the result is still capped to the caller's own allowed branch set (never "every branch in
  // the company" for a branch-restricted user) — this is where reads, not just writes, get
  // branch enforcement.
  const allowedBranchIds = branchId
    ? (canAccessBranch(ctx, branchId) ? [branchId] : ['__none__'])
    : (ctx.branchAccess.allBranches ? undefined : ctx.branchAccess.branchIds);

  const where: any = {
    companyId: ctx.companyId,
    ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
    ...(status && { status }),
    ...((dateFrom || dateTo) && {
      createdAt: {
        ...(dateFrom && { gte: dateFrom }),
        ...(dateTo && { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) }),
      },
    }),
  };
  const [tags, total] = await Promise.all([
    tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
      where,
      include: {
        branch: { select: { name: true, branchCode: true } },
        design: { select: { designCode: true, name: true } },
        jobCard: { select: { jobNumber: true } },
        category: { select: { name: true } },
        subCategory: { select: { name: true } },
        collection: { select: { name: true } },
        stockType: { select: { name: true } },
        manufacturer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    })),
    tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.count({ where })),
  ]);
  return { tags, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getTag(ctx: TenantContext, id: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({
    where: { id },
    include: {
      branch: true,
      size: { select: { id: true, code: true, name: true, isActive: true } },
      design: { select: { designCode: true, name: true } },
      jobCard: { select: { jobNumber: true, status: true } },
      createdBy: { select: { name: true } },
      // Needed so the edit form (NewTagPage.tsx reused for /tagging/tags/:id/edit) can
      // reconstruct the Materials tab's rows — createTag's own shape, read back.
      materials: true,
      memoItems: {
        include: { memo: { select: { memoNumber: true, status: true, sentDate: true } } },
        orderBy: { memo: { sentDate: 'desc' } },
      },
      transferItems: {
        include: {
          transfer: {
            select: { transferNumber: true, status: true, createdAt: true,
              fromBranch: { select: { name: true } }, toBranch: { select: { name: true } } },
          },
        },
      },
    },
  }));
  // Same "404, not 403" rule as assertOwnedByCompany — a wrong-company or unauthorized-branch
  // tag must look indistinguishable from a nonexistent one.
  if (!tag || tag.companyId !== ctx.companyId || !canAccessBranch(ctx, tag.branchId)) {
    throw new AppError('Tag not found', 404);
  }
  return tag;
}

/**
 * Lifecycle protection: a SOLD tag is on a customer's invoice, and a RETIRED tag has left stock for good
 * (a purchase return flips its tag to RETIRED, as does a manual retire) — their details must not change
 * and a fresh label must not be printed for a piece that is no longer ours. Enforced here, not just in the UI.
 */
export const LOCKED_TAG_STATUSES = ['SOLD', 'RETIRED', 'RETAGGED'] as const;
export function assertTagEditable(status: string, action: 'edited' | 'reprinted') {
  if ((LOCKED_TAG_STATUSES as readonly string[]).includes(status)) {
    const why = status === 'SOLD' ? 'sold' : status === 'RETAGGED' ? 'retagged (replaced by a new tag)' : 'retired / purchase-returned';
    throw new AppError(`This tag is ${why} and can no longer be ${action}`, 409);
  }
}

function assertValidPieceCount(n: unknown) {
  if (n === undefined || n === null) return;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new AppError('No. of Pcs must be a whole number of at least 1', 400);
  }
}

// A Size must be this company's, active, and — when the size is tied to a category — match the tag's.
// A category-less size applies to every category. Never required: no size is always allowed.
async function assertSizeForCategory(ctx: TenantContext, sizeId: string | null | undefined, categoryId: string | null | undefined) {
  if (!sizeId) return;
  await assertOwnedByCompany('size', sizeId, ctx.companyId, 'Size');
  const size = await tenantQuery(ctx.companyId, (_tx) => _tx.size.findFirst({ where: { id: sizeId, companyId: ctx.companyId } }));
  if (!size || !size.isActive) throw new AppError('Size is inactive or not found', 400);
  if (size.categoryId && size.categoryId !== categoryId) {
    throw new AppError("This size does not apply to the tag's category", 400);
  }
}

async function withLotComponentRates<T extends { materialType: string; stoneGradeId?: string; materialCodeId?: string; weight: number; unit?: string; costRate?: number; costAmount?: number }>(
  companyId: string, purchaseLotId: string, rows: T[],
): Promise<T[]> {
  // null (an empty form field) counts as "not entered", same as undefined; costAmount keeps its strict check
  if (typeof purchaseLotId !== 'string' || !rows.some((m) => m.materialType !== 'METAL' && (m.stoneGradeId || m.materialCodeId) && m.costRate == null && m.costAmount === undefined)) return rows;
  const lot = await tenantQuery(companyId, (_tx) => _tx.purchaseLot.findFirst({ where: { id: purchaseLotId, companyId }, select: { grnItemId: true } }));
  if (!lot) return rows; // an unknown lot is rejected, with a 404, by allocateFromLot inside the transaction
  return Promise.all(rows.map(async (m) => {
    if (m.materialType === 'METAL' || !(m.stoneGradeId || m.materialCodeId) || m.costRate != null || m.costAmount !== undefined) return m;
    const rate = await rateForTagMaterial(companyId, lot.grnItemId, { stoneGradeId: m.stoneGradeId, materialCodeId: m.materialCodeId, unit: m.unit ?? 'CT' });
    if (rate === null) return m;
    return { ...m, costRate: rate, costAmount: Math.round((Number(m.weight) * rate + Number.EPSILON) * 100) / 100 };
  }));
}

export async function createTag(ctx: TenantContext, data: {
  branchId: string; name: string; makeType?: string;
  metalType: string; metalKarat?: string;
  grossWeight: number; netWeight: number; stoneWeight?: number;
  huid?: string; settingType?: string; costPrice?: number; sellingPrice?: number;
  // The making-charge rate/VA% actually decided for this piece (auto-suggested from the
  // MakingCharge master client-side, but overridable there) — persisted so anything that reflects
  // this piece's price later (Estimation, direct-invoice pricing) can use the real decided value
  // instead of re-deriving from a master that may have since changed.
  saleMcRate?: number; saleVaPercent?: number;
  // The Cost-side counterpart — what was actually paid in labour/wastage, folded into costPrice
  // the same way saleMcRate/saleVaPercent fold into sellingPrice. Persisted (not just used
  // transiently to compute costPrice) so editing a tag later can show back what was really paid,
  // instead of resetting to blank and silently dropping this portion out of costPrice on save.
  costMcRate?: number; costVaPercent?: number;
  jobCardId?: string; designId?: string; notes?: string;
  // Both required (not just optional FKs) — the tag number itself is built from their codes
  // (see shared/numberSequence.ts's nextTagNumber), so there's no sensible way to number a tag
  // without them.
  stockTypeId: string; categoryId: string; subCategoryId?: string; collectionId?: string;
  sizeId?: string; noOfPcs?: number; // Size master row (optional) / pieces this tag covers
  manufacturerId?: string; // vendor the piece was sourced from — a Client, type MANUFACTURER
  // Cut this piece out of a bought-in lot (bag): checked against the bag's category rows and caps (see
  // shared/purchaseLot.ts). The piece's cost is whatever the Materials / MC & VA tabs build (pre-filled from the
  // PO's rates); with none entered at all it falls back to the bag's split by net weight.
  purchaseLotId?: string;
  materials?: Array<{
    code: string; materialType: string; materialCodeId?: string;
    stoneGradeId?: string; /* non-METAL row only — resolves saleRate/saleAmount from the
      PriceMaster rate card by weight when saleAmount is omitted (C4) */
    size?: string; pieces?: number; weight: number; unit?: string;
    costRate?: number; costAmount?: number; saleRate?: number; saleAmount?: number;
  }>;
}, userId: string) {
  // Layer 2: branchId is legitimate business input (a tag must belong to somewhere), but it is
  // never trusted as-is — it must both belong to the caller's own company AND be a branch the
  // caller is actually granted (company ownership alone is not enough for a branch-restricted
  // user). PostgreSQL FK checks would NOT catch a forged branchId here (referential-integrity
  // checks bypass RLS) — this explicit check is the real defense, not RLS.
  await assertBranchAccessible(data.branchId, ctx);

  if (data.metalKarat && !(await isValidKarat(ctx.companyId, data.metalKarat))) {
    throw new AppError(`Unknown karat/purity code: ${data.metalKarat}`, 400);
  }
  if (!data.stockTypeId) throw new AppError('Stock Type is required', 400);
  if (!data.categoryId) throw new AppError('Category is required', 400);

  // Layer 2: every master id a tag can carry is company-owned — a Company-B category, stock type,
  // sub-category, collection, material code or stone grade must 404, never attach to this tag.
  // (stockType/category are re-fetched below, scoped to the company, because their codes build
  // the tag number.)
  await assertSubCategoryForCategory(ctx.companyId, data.categoryId, data.subCategoryId, true);
  await assertOwnedIfPresent('collection', data.collectionId, ctx.companyId, 'Collection');
  await assertSizeForCategory(ctx, data.sizeId, data.categoryId);
  assertValidPieceCount(data.noOfPcs);
  await assertOwnedIfPresent('client', data.manufacturerId, ctx.companyId, 'Manufacturer');
  // Layer 2: jobCardId/designId are plain (non-composite) FKs left over from the manufacturing
  // era — unlike every other optional id above, nothing previously checked these, so a forged
  // Company-B id would have passed straight through (Postgres FK checks bypass RLS).
  await assertOwnedIfPresent('jobCard', data.jobCardId, ctx.companyId, 'Job card');
  await assertOwnedIfPresent('design', data.designId, ctx.companyId, 'Design');
  await assertAllOwned('materialCode', (data.materials ?? []).map((m) => m.materialCodeId), ctx.companyId, 'Material code');
  await assertAllOwned('stoneGrade', (data.materials ?? []).map((m) => m.stoneGradeId), ctx.companyId, 'Stone grade');
  // (presence was enforced above; this also rejects a non-string id — an object would otherwise reach Prisma as a filter)
  await assertOwnedIfPresent('stockType', data.stockTypeId, ctx.companyId, 'Stock Type');
  await assertOwnedIfPresent('productCategory', data.categoryId, ctx.companyId, 'Category');
  const [stockType, category] = await Promise.all([
    tenantQuery(ctx.companyId, (_tx) => _tx.stockType.findFirst({ where: { id: data.stockTypeId, companyId: ctx.companyId } })),
    tenantQuery(ctx.companyId, (_tx) => _tx.productCategory.findFirst({ where: { id: data.categoryId, companyId: ctx.companyId } })),
  ]);
  if (!stockType) throw new AppError('Stock Type not found', 404);
  if (!category) throw new AppError('Category not found', 404);

  // C4: a stone row (materialType !== 'METAL') with a stoneGradeId but no explicit saleAmount
  // gets one resolved from the PriceMaster rate card, by weight — before the cost/sale totals
  // below, so a resolved amount actually rolls into the tag's sellingPrice like a hand-entered
  // one would.
  const priced = await Promise.all((data.materials ?? []).map(async (m) => {
    if (m.materialType === 'METAL' || !m.stoneGradeId || m.saleAmount !== undefined) return m;
    const resolved = await resolvePriceMaster(ctx.companyId, m.stoneGradeId, Number(m.weight));
    return resolved ? { ...m, saleRate: resolved.saleRate, saleAmount: resolved.saleAmount } : m;
  }));

  // A piece cut from a lot: a stone/pearl/bead row with no cost entered takes the rate the PO agreed for that
  // component, via the GRN snapshot (shared/vendorRates.ts) — so it is not typed again on every tag. A row that
  // already has a cost rate or amount is never touched, and a row with no matching snapshot rate is left as it was.
  const materials = data.purchaseLotId ? await withLotComponentRates(ctx.companyId, data.purchaseLotId, priced) : priced;

  // Auto-compute grossWeight / netWeight from materials if provided and not explicitly set
  const metalWeight = materials
    .filter((m) => m.materialType === 'METAL')
    .reduce((s, m) => s + Number(m.weight), 0);
  const stoneWeightFromMats = materials
    .filter((m) => m.materialType !== 'METAL')
    .reduce((s, m) => s + Number(m.weight), 0);
  const grossWeight = data.grossWeight || metalWeight || 0;
  const netWeight   = data.netWeight   || metalWeight || 0;
  const stoneWeight = data.stoneWeight ?? stoneWeightFromMats;

  // Auto-compute costPrice / sellingPrice from materials if not given
  const totalCost = materials.reduce((s, m) => s + Number(m.costAmount ?? 0), 0);
  const totalSale = materials.reduce((s, m) => s + Number(m.saleAmount ?? 0), 0);
  const costPrice    = data.costPrice    ?? totalCost;
  const sellingPrice = data.sellingPrice ?? totalSale;

  const tag = await tenantTransaction(ctx.companyId, async (tx) => {
    // Lot first: it locks the lot and fails fast (closed / over-tagged / wrong karat) before a tag number is burned.
    const fromLot = data.purchaseLotId
      ? await allocateFromLot(tx, ctx.companyId, data.purchaseLotId, { grossWeight, netWeight, metalKarat: data.metalKarat, categoryId: data.categoryId })
      : null;
    const tagNumber = await nextTagNumber(ctx.companyId, stockType.code, category.code, tx);

    const created = await tx.jewelryTag.create({
      data: {
        companyId:    ctx.companyId,
        tagNumber,
        branchId:     data.branchId,
        name:         data.name,
        makeType:     data.makeType ?? 'GOLD',
        metalType:    data.metalType,
        metalKarat:   fromLot ? fromLot.metalKarat : data.metalKarat,
        purchaseLotId: fromLot ? data.purchaseLotId : undefined,
        grossWeight,
        netWeight,
        stoneWeight,
        huid:         data.huid,
        settingType:  data.settingType,
        costPrice:    fromLot && !(costPrice > 0) ? fromLot.suggestedCost : costPrice,
        sellingPrice,
        saleMcRate:    data.saleMcRate,
        saleVaPercent: data.saleVaPercent,
        costMcRate:    data.costMcRate,
        costVaPercent: data.costVaPercent,
        jobCardId:    data.jobCardId,
        designId:     data.designId,
        notes:        data.notes,
        stockTypeId:  data.stockTypeId,
        categoryId:   data.categoryId,
        subCategoryId: data.subCategoryId,
        collectionId: data.collectionId,
        sizeId:       data.sizeId || undefined,
        noOfPcs:      data.noOfPcs ?? undefined,
        manufacturerId: data.manufacturerId,
        createdById:  userId,
      },
      include: { branch: { select: { name: true } }, category: true, subCategory: true, stockType: true },
    });

    if (materials.length > 0) {
      await tx.jewelryTagMaterial.createMany({
        data: materials.map((m) => ({
          companyId:      ctx.companyId,
          tagId:          created.id,
          materialCodeId: m.materialCodeId ?? null,
          stoneGradeId:   m.stoneGradeId ?? null,
          code:           m.code,
          materialType:   m.materialType,
          size:           m.size ?? null,
          pieces:         m.pieces ?? null,
          weight:         m.weight,
          unit:           m.unit ?? (m.materialType === 'METAL' ? 'GM' : 'CT'),
          costRate:       m.costRate ?? null,
          costAmount:     m.costAmount ?? null,
          saleRate:       m.saleRate ?? null,
          saleAmount:     m.saleAmount ?? null,
        })),
      });
    }

    return created;
  });

  await createAuditEntry('jewelry_tags', tag.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return tag;
}

/**
 * Corrects a tag's own descriptive/physical/pricing details after the fact (wrong weight typed
 * in, HUID added later, category picked wrong, etc.) — NOT a stock movement. Deliberately doesn't
 * touch `tagNumber` (already printed/handed out — CLAUDE.md: never re-number) or `status` (that's
 * exclusively the sell/transfer/retire services' job, each its own guarded flip). Every field is
 * optional and only applied when the caller actually sends it, so a narrow fix (e.g. just `huid`)
 * can't clobber anything else. `materials`, when sent, replaces the whole breakdown wholesale —
 * same shape createTag writes, and the same weight/price auto-derivation from it — mirroring how
 * the edit form (NewTagPage.tsx, reused for /tagging/tags/:id/edit) always resends every row it
 * loaded, not a partial diff.
 *
 * costMcRate/costVaPercent are real columns (added alongside saleMcRate/saleVaPercent), so unlike
 * an earlier version of this function, resending the same material rows unchanged reproduces the
 * exact same costPrice — nothing about Cost Price round-tripping is lossy anymore.
 */
export async function updateTag(id: string, data: {
  name?: string; branchId?: string; makeType?: string;
  metalType?: string; metalKarat?: string;
  grossWeight?: number; netWeight?: number; stoneWeight?: number;
  huid?: string; settingType?: string; costPrice?: number; sellingPrice?: number;
  saleMcRate?: number; saleVaPercent?: number;
  costMcRate?: number; costVaPercent?: number;
  notes?: string;
  stockTypeId?: string; categoryId?: string; subCategoryId?: string; collectionId?: string;
  sizeId?: string | null; noOfPcs?: number | null; // null clears
  manufacturerId?: string;
  materials?: Array<{
    code: string; materialType: string; materialCodeId?: string;
    stoneGradeId?: string;
    size?: string; pieces?: number; weight: number; unit?: string;
    costRate?: number; costAmount?: number; saleRate?: number; saleAmount?: number;
  }>;
}, ctx: TenantContext, userId: string) {
  // Layer 2: the tag being edited, and any new branch it's being moved to, must both belong to
  // the caller's own company — and the new branch must be one they're actually granted, same as
  // createTag(). A wrong-company tag id is indistinguishable from a nonexistent one.
  const existing = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id } }));
  if (!existing || existing.companyId !== ctx.companyId || !canAccessBranch(ctx, existing.branchId)) {
    throw new AppError('Tag not found', 404);
  }
  assertTagEditable(existing.status, 'edited');
  if (data.branchId !== undefined) await assertBranchAccessible(data.branchId, ctx);

  if (data.metalKarat && !(await isValidKarat(ctx.companyId, data.metalKarat))) {
    throw new AppError(`Unknown karat/purity code: ${data.metalKarat}`, 400);
  }
  // Layer 2: same company-ownership rule as createTag — every master id on a tag edit is checked.
  await assertOwnedIfPresent('stockType', data.stockTypeId, ctx.companyId, 'Stock Type');
  await assertOwnedIfPresent('productCategory', data.categoryId, ctx.companyId, 'Category');
  // The (category, sub-category) pair the tag will have AFTER this edit must be a real link. A kept
  // sub-category is only re-checked when the category changes under it, and is never re-checked for
  // 'active' — deactivating the master later must not block editing tags that already carry it.
  {
    const effCategory = data.categoryId ?? existing.categoryId;
    const effSub = data.subCategoryId !== undefined ? data.subCategoryId : existing.subCategoryId;
    if (effSub && (data.subCategoryId !== undefined || data.categoryId !== undefined)) {
      await assertSubCategoryForCategory(ctx.companyId, effCategory, effSub, data.subCategoryId !== undefined && data.subCategoryId !== existing.subCategoryId);
    }
  }
  await assertOwnedIfPresent('collection', data.collectionId, ctx.companyId, 'Collection');
  // A size must fit the category the tag will have AFTER this edit (the new one if it is changing too).
  if (data.sizeId || data.categoryId) {
    await assertSizeForCategory(ctx, data.sizeId ?? existing.sizeId, data.categoryId ?? existing.categoryId);
  }
  if (data.noOfPcs !== undefined && data.noOfPcs !== null) assertValidPieceCount(data.noOfPcs);
  await assertOwnedIfPresent('client', data.manufacturerId, ctx.companyId, 'Manufacturer');
  await assertAllOwned('materialCode', (data.materials ?? []).map((m) => m.materialCodeId), ctx.companyId, 'Material code');
  await assertAllOwned('stoneGrade', (data.materials ?? []).map((m) => m.stoneGradeId), ctx.companyId, 'Stone grade');

  // Same C4 stone-price resolution as createTag — only runs when materials are actually being
  // replaced (a materials-less PATCH, e.g. a bare HUID fix, must never touch pricing).
  const materials = data.materials
    ? await Promise.all(data.materials.map(async (m) => {
        if (m.materialType === 'METAL' || !m.stoneGradeId || m.saleAmount !== undefined) return m;
        const resolved = await resolvePriceMaster(ctx.companyId, m.stoneGradeId, Number(m.weight));
        return resolved ? { ...m, saleRate: resolved.saleRate, saleAmount: resolved.saleAmount } : m;
      }))
    : undefined;

  let grossWeight = data.grossWeight;
  let netWeight = data.netWeight;
  let stoneWeight = data.stoneWeight;
  let costPrice = data.costPrice;
  let sellingPrice = data.sellingPrice;

  if (materials) {
    const metalWeight = materials.filter((m) => m.materialType === 'METAL').reduce((s, m) => s + Number(m.weight), 0);
    const stoneWeightFromMats = materials.filter((m) => m.materialType !== 'METAL').reduce((s, m) => s + Number(m.weight), 0);
    grossWeight = data.grossWeight || metalWeight || 0;
    netWeight   = data.netWeight   || metalWeight || 0;
    stoneWeight = data.stoneWeight ?? stoneWeightFromMats;

    const totalCost = materials.reduce((s, m) => s + Number(m.costAmount ?? 0), 0);
    const totalSale = materials.reduce((s, m) => s + Number(m.saleAmount ?? 0), 0);
    costPrice    = data.costPrice    ?? totalCost;
    sellingPrice = data.sellingPrice ?? totalSale;
  }
  const tag = await tenantTransaction(ctx.companyId, async (tx) => {
    const updated = await tx.jewelryTag.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.makeType !== undefined && { makeType: data.makeType }),
        ...(data.metalType !== undefined && { metalType: data.metalType }),
        ...(data.metalKarat !== undefined && { metalKarat: data.metalKarat }),
        ...(grossWeight !== undefined && { grossWeight }),
        ...(netWeight !== undefined && { netWeight }),
        ...(stoneWeight !== undefined && { stoneWeight }),
        ...(data.huid !== undefined && { huid: data.huid }),
        ...(data.settingType !== undefined && { settingType: data.settingType }),
        ...(costPrice !== undefined && { costPrice }),
        ...(sellingPrice !== undefined && { sellingPrice }),
        ...(data.saleMcRate !== undefined && { saleMcRate: data.saleMcRate }),
        ...(data.saleVaPercent !== undefined && { saleVaPercent: data.saleVaPercent }),
        ...(data.costMcRate !== undefined && { costMcRate: data.costMcRate }),
        ...(data.costVaPercent !== undefined && { costVaPercent: data.costVaPercent }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.stockTypeId !== undefined && { stockTypeId: data.stockTypeId }),
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.subCategoryId !== undefined && { subCategoryId: data.subCategoryId }),
        ...(data.collectionId !== undefined && { collectionId: data.collectionId }),
        ...(data.sizeId !== undefined && { sizeId: data.sizeId || null }),
        ...(data.noOfPcs !== undefined && { noOfPcs: data.noOfPcs }),
        ...(data.manufacturerId !== undefined && { manufacturerId: data.manufacturerId }),
      },
      include: { branch: { select: { name: true } }, category: true, subCategory: true, stockType: true },
    });

    // Replaced wholesale, same as createTag's own write — the edit form always resends the full
    // set of rows it loaded, never a partial diff.
    if (materials) {
      await tx.jewelryTagMaterial.deleteMany({ where: { tagId: id } });
      if (materials.length > 0) {
        await tx.jewelryTagMaterial.createMany({
          data: materials.map((m) => ({
            companyId:      ctx.companyId,
            tagId:          id,
            materialCodeId: m.materialCodeId ?? null,
            stoneGradeId:   m.stoneGradeId ?? null,
            code:           m.code,
            materialType:   m.materialType,
            size:           m.size ?? null,
            pieces:         m.pieces ?? null,
            weight:         m.weight,
            unit:           m.unit ?? (m.materialType === 'METAL' ? 'GM' : 'CT'),
            costRate:       m.costRate ?? null,
            costAmount:     m.costAmount ?? null,
            saleRate:       m.saleRate ?? null,
            saleAmount:     m.saleAmount ?? null,
          })),
        });
      }
    }

    return updated;
  });

  await createAuditEntry('jewelry_tags', tag.id, userId, 'UPDATE', undefined, undefined, ctx.companyId);
  return tag;
}

// ─── Finished-goods intake (buy a finished piece, not raw material) ───────────

/**
 * Turns a FINISHED_GOODS GRN line into a sellable JewelryTag (status defaults to IN_STOCK).
 * One GRN item -> one tag; batch/multi-piece lines are a later enhancement.
 */
export async function createTagFromGrnItem(data: {
  grnItemId: string;
  branchId?: string;      // default: the branch the GRN was received at (GoodsReceiptNote.branchId)
  name: string;
  makeType?: string;
  metalType: string;
  metalKarat?: string;
  stoneWeight?: number;   // default 0; not derivable from PO/GRN data, caller must supply
  grossWeight?: number;   // default: GrnItem.acceptedWeight (the scale-verified whole-piece weight)
  huid?: string;
  settingType?: string;
  sellingPrice?: number;
  notes?: string;
  manufacturerId?: string; // a Client of type MANUFACTURER — the tag screen pre-selects the PO's supplier (manufacturerForSupplier)
  // Both required, same reasoning as createTag: the tag number is built from their codes.
  stockTypeId: string; categoryId: string; subCategoryId?: string; collectionId?: string;
}, ctx: TenantContext, userId: string) {
  if (data.metalKarat && !(await isValidKarat(ctx.companyId, data.metalKarat))) {
    throw new AppError(`Unknown karat/purity code: ${data.metalKarat}`, 400);
  }
  if (!data.stockTypeId) throw new AppError('Stock Type is required', 400);
  if (!data.categoryId) throw new AppError('Category is required', 400);

  // Layer 2: GrnItem is now company-scoped (Phase 2b) — a Company-B grnItemId must 404, not let
  // a tag be created against another company's GRN line.
  const grnItem = await tenantQuery(ctx.companyId, (_tx) => _tx.grnItem.findUnique({
    where: { id: data.grnItemId },
    include: { poItem: { include: { po: { include: { supplier: { select: { id: true, gstNumber: true, state: true } } } } } }, grn: true },
  }));
  if (!grnItem || grnItem.companyId !== ctx.companyId) throw new AppError('GRN item not found', 404);

  // Layer 2 branch check — same reasoning as createTag(). Falls back to the GRN's receiving branch.
  const branchId = data.branchId ?? grnItem.grn.branchId;
  if (!branchId) throw new AppError('Branch is required — this GRN has no receiving branch', 400);
  await assertBranchAccessible(branchId, ctx);
  if (grnItem.poItem.materialType !== FINISHED_GOODS_MATERIAL_TYPE) {
    throw new AppError(`GRN item is not a ${FINISHED_GOODS_MATERIAL_TYPE} line`, 400);
  }

  // Friendly pre-check for the common case. The authoritative guard against double-tagging
  // (including races between concurrent/retried calls) is the unique constraint on
  // JewelryTag.grnItemId, enforced by Postgres and caught as P2002 below.
  const existing = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { grnItemId: data.grnItemId } }));
  if (existing) throw new AppError(`GRN item already tagged as ${existing.tagNumber}`, 409);

  // Gross weight = the scale-verified weight of the whole piece (metal + stone) recorded at GRN
  // verification, unless the caller overrides it. Stone weight must be supplied explicitly — it
  // isn't derivable from PO/GRN data. Net weight (metal only) = gross - stone: for a stone-set
  // piece gross and net are never the same figure (mirrors the metal-weight convention createTag
  // already uses when building a tag from an explicit materials breakdown).
  const grossWeight = data.grossWeight ?? Number(grnItem.acceptedWeight);
  const stoneWeight = data.stoneWeight ?? 0;
  if (stoneWeight > grossWeight) {
    throw new AppError('Stone weight cannot exceed gross weight', 400);
  }
  const netWeight = grossWeight - stoneWeight;

  // v1 cost derivation: costPrice = the PO line's totalAmount only. PoItem has no separate
  // making-charge/wastage/other-charge fields for a finished-goods line, so there's nothing else
  // to fold in yet — if that's ever needed, extend PoItem rather than approximating here.
  const costPrice = Number(grnItem.poItem.totalAmount);

  // C2: when the caller doesn't hand-price the piece, suggest a sellingPrice from the metal
  // rate as of this GRN's receivedDate (the day the piece actually came in) for its karat —
  // not "today's" rate, which could be weeks off if this tag is created late. Still just a
  // suggestion: sellingPrice remains a plain editable column, never re-derived after intake.
  const effectiveKarat = data.metalKarat ?? grnItem.poItem.karat ?? undefined;
  let sellingPrice = data.sellingPrice;
  if (sellingPrice === undefined && effectiveKarat) {
    const rate = await resolveMetalRate(ctx.companyId, effectiveKarat, grnItem.grn.receivedDate);
    if (rate) sellingPrice = netWeight * Number(rate.ratePerGram);
  }
  sellingPrice = sellingPrice ?? 0;

  // Layer 2: master ids are company-owned — sub-category/collection are checked here, and the
  // stock type/category are fetched scoped to the company just below.
  await assertSubCategoryForCategory(ctx.companyId, data.categoryId, data.subCategoryId, true);
  await assertOwnedIfPresent('collection', data.collectionId, ctx.companyId, 'Collection');
  await assertOwnedIfPresent('client', data.manufacturerId, ctx.companyId, 'Manufacturer');
  const [stockType, category] = await Promise.all([
    tenantQuery(ctx.companyId, (_tx) => _tx.stockType.findFirst({ where: { id: data.stockTypeId, companyId: ctx.companyId } })),
    tenantQuery(ctx.companyId, (_tx) => _tx.productCategory.findFirst({ where: { id: data.categoryId, companyId: ctx.companyId } })),
  ]);
  if (!stockType) throw new AppError('Stock Type not found', 404);
  if (!category) throw new AppError('Category not found', 404);

  // Input GST on the supplier's bill (PoItem.taxRate, snapshotted at PO time): CGST+SGST if the
  // supplier is in the company's own state, else IGST. costPrice stays the bare taxable value —
  // recoverable GST is never part of stock cost.
  const supplierStateCode = await resolveSupplierStateCode(grnItem.poItem.po.supplier);

  let tag;
  try {
    tag = await tenantTransaction(ctx.companyId, async (tx) => {
      const tagNumber = await nextTagNumber(ctx.companyId, stockType.code, category.code, tx);
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } });
      const gst = splitInputGst(costPrice, Number(grnItem.poItem.taxRate), supplierStateCode, company.stateCode);
      // G2g-7a: which of the company's own GST registrations this inward supply is attributed
      // to — resolved from the GRN's own receiving branch (never the tag's own, possibly
      // overridden, branchId above), stamped alongside the tax amounts below.
      const buyerRegistrationId = await resolveBuyerRegistration(tx, ctx.companyId, grnItem.grn.branchId);
      // G2g-7g: this is the exact point this GRN line's input GST is booked (GrnItem.taxableValue/
      // inputCgst/Sgst/Igst below, read by gstr3bItcReporting.service.ts's loader by GRN
      // receivedDate) — reject before it is booked if that period is already FILED/LOCKED. Runs
      // before bookRcmLiabilityIfApplicable too, which is called later in this same transaction.
      await assertGstr3bPeriodMutable(tx, ctx.companyId, {
        documentType: 'GRN_ITEM', documentId: data.grnItemId,
        gstRegistrationId: buyerRegistrationId, documentDate: grnItem.grn.receivedDate, action: 'received',
      });

      const created = await tx.jewelryTag.create({
        data: {
          companyId: ctx.companyId,
          tagNumber,
          branchId,
          name: data.name,
          makeType: data.makeType ?? 'GOLD',
          metalType: data.metalType,
          metalKarat: effectiveKarat,
          grossWeight,
          netWeight,
          stoneWeight,
          huid: data.huid,
          settingType: data.settingType,
          costPrice,
          sellingPrice,
          grnItemId: data.grnItemId,
          notes: data.notes,
          stockTypeId: data.stockTypeId,
          categoryId: data.categoryId,
          subCategoryId: data.subCategoryId,
          collectionId: data.collectionId,
          manufacturerId: data.manufacturerId,
          createdById: userId,
        },
        include: { branch: { select: { name: true } } },
      });

      // F1: this is the buy-side of the buy->stock->sell loop (CLAUDE.md gap #1) — the piece's
      // costPrice enters the books here, as stock owed for, mirroring createInvoice's COGS/
      // Inventory entry on the sell side.
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: grnItem.grn.receivedDate, description: `Finished-goods intake ${grnItem.grn.grnNumber} — Tag ${tagNumber}`,
        referenceType: 'JewelryTag', referenceId: created.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: costPrice },
          { accountCode: LEDGER_ACCOUNT.INPUT_CGST, debit: gst.cgst },
          { accountCode: LEDGER_ACCOUNT.INPUT_SGST, debit: gst.sgst },
          { accountCode: LEDGER_ACCOUNT.INPUT_IGST, debit: gst.igst },
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, credit: round2(costPrice + gst.total) },
        ],
      });

      // Stamp the tax booked on the GRN line itself (what the purchase GST register reads and what
      // a purchase return reverses), and put the full bill — goods + GST — on the supplier's account.
      await tx.grnItem.update({
        where: { id: data.grnItemId },
        data: { taxableValue: costPrice, inputCgst: gst.cgst, inputSgst: gst.sgst, inputIgst: gst.igst, buyerRegistrationId },
      });
      await tx.supplier.update({
        where: { id: grnItem.poItem.po.supplierId },
        data: { currentDue: { increment: round2(costPrice + gst.total) } },
      });

      // G2g-7d: a no-op for the overwhelming majority of lines (PoItem.rcmCategory NONE) — only
      // creates an RcmLiability (+ journal, + self-invoice) when this line was explicitly flagged
      // with a notified reverse-charge category. See PHASE_G2G7D_AUDIT.md.
      await bookRcmLiabilityIfApplicable(tx, {
        ctx, userId,
        grn: { grnNumber: grnItem.grn.grnNumber, receivedDate: grnItem.grn.receivedDate },
        grnItemId: data.grnItemId,
        poItem: {
          rcmCategory: grnItem.poItem.rcmCategory, taxCategory: grnItem.poItem.taxCategory,
          hsnCodeId: grnItem.poItem.hsnCodeId, totalAmount: grnItem.poItem.totalAmount,
        },
        supplier: { id: grnItem.poItem.po.supplier.id, gstNumber: grnItem.poItem.po.supplier.gstNumber },
        supplierStateCode, companyStateCode: company.stateCode, buyerRegistrationId,
      });

      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('GRN item already tagged (concurrent request)', 409);
    }
    throw err;
  }

  await createAuditEntry('jewelry_tags', tag.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return tag;
}

export async function retireTag(id: string, ctx: TenantContext, userId: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id } }));
  if (!tag || tag.companyId !== ctx.companyId || !canAccessBranch(ctx, tag.branchId)) {
    throw new AppError('Tag not found', 404);
  }
  if (!['IN_STOCK', 'RETURNED'].includes(tag.status)) {
    throw new AppError('Only IN_STOCK or RETURNED tags can be retired', 400);
  }
  return tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.update({ where: { id }, data: { status: 'RETIRED' } }));
}

// Stage 1's generateTsplForTag + a real tag/template, exposed for the Stage 2 print path. Read-
// only — printing a tag doesn't change its state, so this reuses tag:view rather than needing a
// new permission (see tagging.router.ts). TagTemplate is company-owned (Phase 2) — the default
// template fallback is scoped to THIS company's own default, never another company's.
export async function getTagPrintTspl(ctx: TenantContext, tagId: string, templateId?: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({
    where: { id: tagId },
    include: {
      branch: { select: { name: true, branchCode: true } },
      category: { select: { name: true, code: true } },
      subCategory: { select: { name: true, code: true } },
      collection: { select: { name: true, code: true } },
      stockType: { select: { name: true, code: true } },
      size: { select: { name: true, code: true } },
      manufacturer: { select: { name: true } },
      materials: { select: { materialType: true, weight: true, pieces: true } },
    },
  }));
  if (!tag || tag.companyId !== ctx.companyId || !canAccessBranch(ctx, tag.branchId)) {
    throw new AppError('Tag not found', 404);
  }
  assertTagEditable(tag.status, 'reprinted');

  const template = templateId
    ? await tenantQuery(ctx.companyId, (_tx) => _tx.tagTemplate.findUnique({ where: { id: templateId } }))
    : await tenantQuery(ctx.companyId, (_tx) => _tx.tagTemplate.findFirst({ where: { companyId: ctx.companyId, isDefault: true } }));
  if (!template || (templateId && template.companyId !== ctx.companyId)) {
    throw new AppError(templateId ? 'Tag template not found' : 'No default tag template configured', 404);
  }

  const tspl = generateTsplForTag(
    {
      widthMm: template.widthMm,
      heightMm: template.heightMm,
      gapMm: template.gapMm,
      layout: template.layout as unknown as TagTemplateLayout,
    },
    tag,
  );

  return { tspl, templateId: template.id, templateName: template.name };
}

// Designer preview: every bound field's resolved value for one tag. Read-only, tag:view, same
// company + branch checks as the print path; no template needed (the designer renders its own,
// possibly unsaved, layout with these values).
export async function getTagPreviewValues(ctx: TenantContext, tagId: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({
    where: { id: tagId },
    include: {
      branch: { select: { name: true, branchCode: true } },
      category: { select: { name: true, code: true } },
      subCategory: { select: { name: true, code: true } },
      collection: { select: { name: true, code: true } },
      stockType: { select: { name: true, code: true } },
      size: { select: { name: true, code: true } },
      manufacturer: { select: { name: true } },
      materials: { select: { materialType: true, weight: true, pieces: true } },
    },
  }));
  if (!tag || tag.companyId !== ctx.companyId || !canAccessBranch(ctx, tag.branchId)) {
    throw new AppError('Tag not found', 404);
  }
  return { values: resolveAllBoundFields(tag) };
}

// ─── Tag Templates (Stage 3: the visual designer) ─────────────────────────────

export async function listTagTemplates(companyId: string) {
  return tenantQuery(companyId, (_tx) => _tx.tagTemplate.findMany({
    where: { companyId },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  }));
}

export async function getTagTemplateById(companyId: string, id: string) {
  const template = await tenantQuery(companyId, (_tx) => _tx.tagTemplate.findUnique({ where: { id } }));
  if (!template || template.companyId !== companyId) throw new AppError('Tag template not found', 404);
  return template;
}

function validateLayout(layout: unknown): TagTemplateLayout {
  if (!layout || typeof layout !== 'object' || !Array.isArray((layout as any).elements)) {
    throw new AppError('Template layout must be an object with an "elements" array', 400);
  }
  return layout as TagTemplateLayout;
}

export async function createTagTemplate(companyId: string, data: {
  name: string; widthMm: number; heightMm: number; gapMm?: number;
  isDefault?: boolean; layout: unknown;
}, userId: string) {
  if (!data.name?.trim()) throw new AppError('Template name is required', 400);
  const layout = validateLayout(data.layout);

  return tenantTransaction(companyId, async (tx) => {
    // Only one default PER COMPANY at a time — the print path (getTagPrintTspl) falls back to
    // whichever row has isDefault:true WITHIN this company, so a second one would make that
    // fallback ambiguous within the same company (a different company's default is unaffected).
    if (data.isDefault) {
      await tx.tagTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.tagTemplate.create({
      data: {
        companyId,
        name: data.name,
        widthMm: data.widthMm,
        heightMm: data.heightMm,
        gapMm: data.gapMm ?? 2.0,
        isDefault: data.isDefault ?? false,
        layout: layout as unknown as Prisma.InputJsonValue,
        createdById: userId,
      },
    });
  });
}

export async function updateTagTemplate(companyId: string, id: string, data: {
  name?: string; widthMm?: number; heightMm?: number; gapMm?: number;
  isDefault?: boolean; layout?: unknown;
}) {
  await getTagTemplateById(companyId, id); // 404s cleanly if missing/wrong-company, before touching anything
  const layout = data.layout !== undefined ? validateLayout(data.layout) : undefined;

  return tenantTransaction(companyId, async (tx) => {
    if (data.isDefault) {
      await tx.tagTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    }
    return tx.tagTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.widthMm !== undefined && { widthMm: data.widthMm }),
        ...(data.heightMm !== undefined && { heightMm: data.heightMm }),
        ...(data.gapMm !== undefined && { gapMm: data.gapMm }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        ...(layout !== undefined && { layout: layout as unknown as Prisma.InputJsonValue }),
      },
    });
  });
}

// status omitted (or 'ALL') searches every status — the counter lookup screen (B4) needs to
// find a tag regardless of state (e.g. show "already SOLD") rather than silently missing it.
// Every existing caller (New Sale, Memo Out, Branch Transfers) explicitly passes 'IN_STOCK',
// so this default change doesn't alter their behavior.
export async function searchTags(ctx: TenantContext, query: string, branchId?: string, status?: string) {
  const allowedBranchIds = branchId
    ? (canAccessBranch(ctx, branchId) ? [branchId] : ['__none__'])
    : (ctx.branchAccess.allBranches ? undefined : ctx.branchAccess.branchIds);
  return tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where: {
      companyId: ctx.companyId,
      ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
      ...(status && status !== 'ALL' && { status }),
      OR: [
        { tagNumber: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
        { huid: { contains: query, mode: 'insensitive' } },
      ],
    },
    include: { branch: { select: { name: true } }, category: { select: { id: true, name: true } } },
    take: 20,
    orderBy: { tagNumber: 'asc' },
  }));
}

// ─── Branch Transfers ─────────────────────────────────────────────────────────

export async function listTransfers(ctx: TenantContext, filters: {
  status?: string; fromBranchId?: string; toBranchId?: string; incoming?: boolean; page?: number; limit?: number;
}) {
  const { status, fromBranchId, toBranchId, incoming, page = 1, limit = 20 } = filters;
  // `status` may be a comma list ("DISPATCHED,PARTIALLY_RECEIVED") — the receiving screen wants both.
  const statuses = status ? status.split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (fromBranchId) await assertBranchAccessible(fromBranchId, ctx);
  if (toBranchId) await assertBranchAccessible(toBranchId, ctx);
  const where = {
    companyId: ctx.companyId,
    ...(statuses.length === 1 && { status: statuses[0] }),
    ...(statuses.length > 1 && { status: { in: statuses } }),
    ...(fromBranchId && { fromBranchId }),
    ...(toBranchId && { toBranchId }),
    // A branch-restricted caller only sees transfers touching a branch they're granted — either
    // side counts, since a transfer they're not party to on either end isn't theirs to see.
    // `incoming` narrows that to the receiving side only: the branch-receives screen is for the
    // branch that has to take the pieces in, not the one that sent them.
    ...(!ctx.branchAccess.allBranches && (incoming
      ? { toBranchId: toBranchId ? toBranchId : { in: ctx.branchAccess.branchIds } }
      : {
        OR: [
          { fromBranchId: { in: ctx.branchAccess.branchIds } },
          { toBranchId: { in: ctx.branchAccess.branchIds } },
        ],
      })),
  };
  const [transfers, total] = await tenantBatch(ctx.companyId, (tx) => [
    tx.branchTransfer.findMany({
      where,
      include: {
        fromBranch: { select: { name: true, branchCode: true } },
        toBranch: { select: { name: true, branchCode: true } },
        requestedBy: { select: { name: true } },
        _count: { select: { items: true } },
        items: { select: { receivedAt: true } }, // how many pieces are already in (receivedAt set)
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    tx.branchTransfer.count({ where }),
  ]);
  return { transfers, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getTransfer(ctx: TenantContext, id: string) {
  const transfer = await tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.findUnique({
    where: { id },
    include: {
      fromBranch: true,
      toBranch: true,
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      items: {
        include: {
          tag: {
            select: { tagNumber: true, name: true, metalType: true, metalKarat: true,
              grossWeight: true, stoneWeight: true, netWeight: true, sellingPrice: true, status: true, huid: true,
              category: { select: { name: true } } },
          },
        },
      },
    },
  }));
  if (!transfer || transfer.companyId !== ctx.companyId) throw new AppError('Transfer not found', 404);
  if (!canAccessBranch(ctx, transfer.fromBranchId) && !canAccessBranch(ctx, transfer.toBranchId)) {
    throw new AppError('Transfer not found', 404);
  }
  return transfer;
}

export async function createTransfer(data: {
  fromBranchId: string; toBranchId: string; tagIds: string[]; notes?: string;
}, ctx: TenantContext, userId: string) {
  // Layer 2: BranchTransfer's own invariant — both ends must belong to this company AND be
  // branches the caller is actually granted. No FK, single-column constraint, or RLS policy can
  // express "both of these ids belong to the same company as each other"; this explicit check
  // is what does.
  await assertTransferBranchesAccessible(data.fromBranchId, data.toBranchId, ctx);
  if (!data.tagIds.length) throw new AppError('At least one tag is required', 400);

  const tags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where: { id: { in: data.tagIds }, companyId: ctx.companyId },
  }));

  const foundIds = new Set(tags.map((t) => t.id));
  const missing = data.tagIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);

  const invalid = tags.filter((t) => t.status !== 'IN_STOCK' || t.branchId !== data.fromBranchId);
  if (invalid.length) {
    throw new AppError(
      `Tags not available at source branch: ${invalid.map((t) => t.tagNumber).join(', ')}`, 400
    );
  }

  const transfer = await tenantTransaction(ctx.companyId, async (tx) => {
    // Guarded flip, reserved right away — not at approval. Otherwise the tags stay IN_STOCK and
    // fully sellable at a billing counter through the whole DRAFT/PENDING_APPROVAL window, and a
    // concurrent sale could race a later approval. Mirrors the count-checked pattern every other
    // stock mutator uses (createInvoice, receiveTransfer, ...): a tag sold between the pre-check
    // above and here fails loudly instead of being silently swept into a transfer.
    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: data.tagIds }, companyId: ctx.companyId, status: 'IN_STOCK' },
      data: { status: 'TRANSFERRED' },
    });
    if (flipped.count !== data.tagIds.length) {
      throw new AppError('Some tags are no longer available (sold or already reserved) — refresh and try again', 409);
    }
    const transferNumber = await nextDocumentNumber(ctx.companyId, 'BT', 'BT', tx);
    return tx.branchTransfer.create({
      data: {
        companyId: ctx.companyId,
        transferNumber,
        fromBranchId: data.fromBranchId,
        toBranchId: data.toBranchId,
        requestedById: userId,
        notes: data.notes,
        items: { createMany: { data: data.tagIds.map((tagId) => ({ tagId })) } },
      },
      include: { fromBranch: { select: { name: true } }, toBranch: { select: { name: true } }, items: true },
    });
  });
  await createAuditEntry('branch_transfers', transfer.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return transfer;
}

export async function submitTransfer(id: string, ctx: TenantContext, userId: string) {
  const t = await tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.findUnique({ where: { id } }));
  if (!t || t.companyId !== ctx.companyId) throw new AppError('Transfer not found', 404);
  // Same branch-access reasoning as approve/receive — a branch-restricted caller shouldn't be
  // able to advance a transfer they're not party to on either end, even though submitting
  // doesn't move any tags yet.
  await assertBranchAccessible(t.fromBranchId, ctx, 'Source branch');
  if (t.status !== 'DRAFT') throw new AppError('Only DRAFT transfers can be submitted', 400);
  return tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } }));
}

export async function approveTransfer(id: string, ctx: TenantContext, userId: string) {
  const t = await tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.findUnique({ where: { id } }));
  if (!t || t.companyId !== ctx.companyId) throw new AppError('Transfer not found', 404);
  await assertBranchAccessible(t.toBranchId, ctx, 'Destination branch'); // approving = the receiving side authorizing dispatch
  if (t.status !== 'PENDING_APPROVAL') throw new AppError('Only PENDING_APPROVAL transfers can be approved', 400);

  // Tags were already reserved (flipped IN_STOCK -> TRANSFERRED) at createTransfer, so approval
  // only advances the transfer's own status — there's no tag-side race left to guard here.
  return tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.update({
    where: { id },
    data: { status: 'DISPATCHED', approvedById: userId, approvedAt: new Date(), dispatchedAt: new Date() },
  }));
}

/**
 * The receiving branch takes in the pieces it has verified — only those. `tagIds` are the verified
 * pieces (each must be an item of this transfer not already received); every other piece stays
 * TRANSFERRED, in transit, and the transfer is PARTIALLY_RECEIVED until the last one is taken in.
 * Omitting `tagIds` receives every piece still outstanding (the pre-verification behaviour).
 */
export async function receiveTransfer(id: string, ctx: TenantContext, userId: string, tagIds?: string[]) {
  const t = await tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.findUnique({ where: { id }, include: { items: true } }));
  if (!t || t.companyId !== ctx.companyId) throw new AppError('Transfer not found', 404);
  await assertBranchAccessible(t.toBranchId, ctx, 'Destination branch');
  if (t.status !== 'DISPATCHED' && t.status !== 'PARTIALLY_RECEIVED') {
    throw new AppError('Only DISPATCHED or PARTIALLY_RECEIVED transfers can be received', 400);
  }

  const outstanding = t.items.filter((i) => !i.receivedAt);
  const wanted = tagIds ? [...new Set(tagIds)] : outstanding.map((i) => i.tagId);
  if (wanted.length === 0) throw new AppError('Verify at least one item to receive', 400);
  const outstandingIds = new Set(outstanding.map((i) => i.tagId));
  const notPending = wanted.filter((tagId) => !outstandingIds.has(tagId));
  if (notPending.length) {
    throw new AppError('Some items are not awaiting receipt on this transfer (wrong transfer, or already received)', 400);
  }

  const now = new Date();
  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    // Guarded flip: only a piece still TRANSFERRED comes in, so nothing that has since moved is dragged back.
    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: wanted }, companyId: ctx.companyId, status: 'TRANSFERRED' },
      data: { status: 'IN_STOCK', branchId: t.toBranchId },
    });
    if (flipped.count !== wanted.length) {
      throw new AppError('Some items are no longer in transit and cannot be received', 409);
    }
    await tx.branchTransferItem.updateMany({
      where: { transferId: id, companyId: ctx.companyId, tagId: { in: wanted }, receivedAt: null },
      data: { receivedAt: now },
    });
    const complete = wanted.length === outstanding.length;
    return tx.branchTransfer.update({
      where: { id },
      data: complete ? { status: 'RECEIVED', receivedAt: now } : { status: 'PARTIALLY_RECEIVED' },
    });
  });
  await createAuditEntry('branch_transfers', id, userId, 'RECEIVE', undefined,
    { received: wanted.length, outstanding: outstanding.length - wanted.length }, ctx.companyId);
  return result;
}

export async function cancelTransfer(id: string, ctx: TenantContext, userId: string) {
  const t = await tenantQuery(ctx.companyId, (_tx) => _tx.branchTransfer.findUnique({ where: { id }, include: { items: true } }));
  if (!t || t.companyId !== ctx.companyId) throw new AppError('Transfer not found', 404);
  await assertBranchAccessible(t.fromBranchId, ctx, 'Source branch');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(t.status)) {
    throw new AppError('Only DRAFT or PENDING_APPROVAL transfers can be cancelled', 400);
  }
  return tenantTransaction(ctx.companyId, async (tx) => {
    // Give the reservation back. Safe as a blind updateMany: a DRAFT/PENDING_APPROVAL transfer's
    // tags can only be TRANSFERRED because createTransfer put them there — receiveTransfer (the
    // only other writer of this status) requires the transfer itself to be DISPATCHED or
    // PARTIALLY_RECEIVED first, which this one isn't.
    await tx.jewelryTag.updateMany({
      where: { id: { in: t.items.map((i) => i.tagId) }, companyId: ctx.companyId, status: 'TRANSFERRED' },
      data: { status: 'IN_STOCK' },
    });
    return tx.branchTransfer.update({ where: { id }, data: { status: 'CANCELLED' } });
  });
}

// ─── Stock Audits (E3) ──────────────────────────────────────────────────────
// A physical count for one branch — snapshot what the system expects, scan pieces to check them
// off, close it to see what's missing or unexpected. Report-only: nothing here ever mutates
// JewelryTag.status or branchId (confirmed with the user) — a finding is a fact for a person to
// act on later via the tools that already exist (retireTag, a branch transfer), not an automatic
// side effect of counting.

function auditSummary(items: Array<{ expected: boolean; found: boolean }>) {
  return {
    expectedCount: items.filter((i) => i.expected).length,
    foundCount: items.filter((i) => i.found).length,
    missingCount: items.filter((i) => i.expected && !i.found).length,
    unexpectedCount: items.filter((i) => !i.expected && i.found).length,
  };
}

export async function startStockAudit(branchId: string, ctx: TenantContext, userId: string, notes?: string) {
  await assertBranchAccessible(branchId, ctx);

  const openAudit = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.findFirst({ where: { companyId: ctx.companyId, branchId, status: 'IN_PROGRESS' } }));
  if (openAudit) {
    throw new AppError(`Branch already has an in-progress audit: ${openAudit.auditNumber}`, 409);
  }

  const expectedTags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where: { companyId: ctx.companyId, branchId, status: 'IN_STOCK' },
    select: { id: true },
  }));

  const audit = await tenantTransaction(ctx.companyId, async (tx) => {
    const auditNumber = await nextDocumentNumber(ctx.companyId, 'SA', 'SA', tx);
    const created = await tx.stockAudit.create({
      data: { companyId: ctx.companyId, auditNumber, branchId, startedById: userId, notes },
    });
    if (expectedTags.length > 0) {
      await tx.stockAuditItem.createMany({
        data: expectedTags.map((t) => ({ companyId: ctx.companyId, auditId: created.id, tagId: t.id, expected: true })),
      });
    }
    return created;
  });

  await createAuditEntry('stock_audits', audit.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return getStockAudit(ctx, audit.id);
}

// Idempotent: re-scanning an already-found tag is a no-op. A tag with no existing item row for
// this audit (not expected — system didn't think it was IN_STOCK here) gets a new row marking it
// found-but-unexpected, rather than being rejected as an error.
export async function scanAuditItem(auditId: string, tagId: string, ctx: TenantContext, userId: string) {
  const audit = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.findUnique({ where: { id: auditId } }));
  if (!audit || audit.companyId !== ctx.companyId) throw new AppError('Stock audit not found', 404);
  if (!canAccessBranch(ctx, audit.branchId)) throw new AppError('Stock audit not found', 404);
  if (audit.status !== 'IN_PROGRESS') {
    throw new AppError('Only an IN_PROGRESS audit can be scanned', 400);
  }

  // Layer 2: the scanned tag must belong to this company — a Company-B tagId (typo, forged, or
  // a mis-scanned barcode) must 404, not silently create a cross-company "unexpected find" row.
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id: tagId } }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);

  const existing = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAuditItem.findUnique({
    where: { auditId_tagId: { auditId, tagId } },
  }));

  let item;
  if (existing) {
    item = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAuditItem.update({
      where: { id: existing.id },
      data: { found: true, foundAt: existing.foundAt ?? new Date() },
    }));
  } else {
    item = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAuditItem.create({
      data: { companyId: ctx.companyId, auditId, tagId, expected: false, found: true, foundAt: new Date() },
    }));
  }
  await createAuditEntry('stock_audit_items', item.id, userId, existing ? 'UPDATE' : 'CREATE', undefined, undefined, ctx.companyId);

  return getStockAudit(ctx, auditId);
}

export async function completeStockAudit(id: string, ctx: TenantContext, userId: string) {
  const audit = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.findUnique({ where: { id } }));
  if (!audit || audit.companyId !== ctx.companyId) throw new AppError('Stock audit not found', 404);
  if (audit.status !== 'IN_PROGRESS') {
    throw new AppError('Only an IN_PROGRESS audit can be completed', 400);
  }
  await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } }));
  await createAuditEntry('stock_audits', id, userId, 'UPDATE', undefined, undefined, ctx.companyId);
  return getStockAudit(ctx, id);
}

export async function getStockAudit(ctx: TenantContext, id: string) {
  const audit = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.findUnique({
    where: { id },
    include: {
      branch: { select: { name: true, branchCode: true } },
      startedBy: { select: { name: true } },
      items: {
        include: { tag: { select: { tagNumber: true, name: true, status: true, branchId: true } } },
        orderBy: { tag: { tagNumber: 'asc' } },
      },
    },
  }));
  if (!audit || audit.companyId !== ctx.companyId) throw new AppError('Stock audit not found', 404);
  if (!canAccessBranch(ctx, audit.branchId)) throw new AppError('Stock audit not found', 404);
  return { ...audit, summary: auditSummary(audit.items) };
}

export async function listStockAudits(ctx: TenantContext, branchId?: string) {
  if (branchId) await assertBranchAccessible(branchId, ctx);
  const audits = await tenantQuery(ctx.companyId, (_tx) => _tx.stockAudit.findMany({
    where: {
      companyId: ctx.companyId,
      ...(branchId && { branchId }),
      ...(!branchId && !ctx.branchAccess.allBranches && { branchId: { in: ctx.branchAccess.branchIds } }),
    },
    include: {
      branch: { select: { name: true, branchCode: true } },
      startedBy: { select: { name: true } },
      items: { select: { expected: true, found: true } },
    },
    orderBy: { startedAt: 'desc' },
  }));
  return audits.map(({ items, ...audit }) => ({ ...audit, summary: auditSummary(items) }));
}
