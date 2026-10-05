import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { TenantContext, canAccessBranch, tenantQuery } from '../../shared/tenantContext';

// Barcode history. The rows are written by the tag_history_capture database trigger (see migration
// 20261004120000_tag_history) — this file only READS them: filters, branch scope, and turning the raw ids
// in each snapshot (branch, category, manufacturer, user...) into names a person can read.

export const TAG_HISTORY_EVENTS = ['CREATED', 'BASELINE', 'STATUS_CHANGE', 'BRANCH_CHANGE', 'EDITED', 'DELETED'] as const;
export const TAG_HISTORY_LIMIT = 5000;

// snapshot columns whose id is resolved to a name
const NAME_LOOKUPS = ['branchId', 'categoryId', 'subCategoryId', 'collectionId', 'stockTypeId', 'manufacturerId', 'sizeId'] as const;
type LookupKey = typeof NAME_LOOKUPS[number];
const isLookupKey = (k: string): k is LookupKey => (NAME_LOOKUPS as readonly string[]).includes(k);

export async function getTagHistory(ctx: TenantContext, filters: {
  tagNumber?: string; tagId?: string; branchId?: string; event?: string; userId?: string; status?: string;
  dateFrom?: Date; dateTo?: Date; limit?: number;
} = {}) {
  if (filters.event && !(TAG_HISTORY_EVENTS as readonly string[]).includes(filters.event)) {
    throw new AppError('Invalid event filter', 400);
  }

  const branchOptions = (await tenantQuery(ctx.companyId, (tx) => tx.branch.findMany({
    where: { companyId: ctx.companyId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true },
  }))).filter((b) => canAccessBranch(ctx, b.id));

  // Branch scope is enforced here, from the caller's own grants — a restricted user only ever sees history
  // recorded against their branch(es), same rule as the Stock Book.
  if (filters.branchId && !canAccessBranch(ctx, filters.branchId)) {
    return { rows: [], truncated: false, limit: TAG_HISTORY_LIMIT, branches: branchOptions, users: [] };
  }
  const allowedBranchIds = filters.branchId ? [filters.branchId]
    : (ctx.branchAccess.allBranches ? undefined : ctx.branchAccess.branchIds);

  const where: Prisma.TagHistoryWhereInput = {
    companyId: ctx.companyId,
    ...(allowedBranchIds && { branchId: { in: allowedBranchIds } }),
    ...(filters.tagId && { tagId: filters.tagId }),
    ...(filters.tagNumber && { tagNumber: { contains: filters.tagNumber, mode: 'insensitive' } }),
    ...(filters.event && { event: filters.event }),
    ...(filters.status && { status: filters.status }),
    ...(filters.userId && { actorUserId: filters.userId }),
    ...((filters.dateFrom || filters.dateTo) && {
      createdAt: {
        ...(filters.dateFrom && { gte: filters.dateFrom }),
        ...(filters.dateTo && { lte: new Date(new Date(filters.dateTo).setHours(23, 59, 59, 999)) }),
      },
    }),
  };
  const take = Math.min(Math.max(filters.limit ?? TAG_HISTORY_LIMIT, 1), TAG_HISTORY_LIMIT);

  const history = await tenantQuery(ctx.companyId, (tx) => tx.tagHistory.findMany({
    where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1,
  }));
  const truncated = history.length > take;
  const page = truncated ? history.slice(0, take) : history;

  // Collect every id that needs a name, then resolve each kind in one company-scoped query.
  const ids: Record<LookupKey | 'userId', Set<string>> = {
    branchId: new Set(), categoryId: new Set(), subCategoryId: new Set(), collectionId: new Set(),
    stockTypeId: new Set(), manufacturerId: new Set(), sizeId: new Set(), userId: new Set(),
  };
  const addId = (k: LookupKey | 'userId', v: unknown) => { if (typeof v === 'string' && v) ids[k].add(v); };
  type Change = { from: unknown; to: unknown };
  for (const h of page) {
    addId('userId', h.actorUserId);
    const snap = h.snapshot as Record<string, unknown>;
    addId('userId', snap.createdById);
    for (const k of NAME_LOOKUPS) addId(k, snap[k]);
    for (const [k, c] of Object.entries((h.changes ?? {}) as Record<string, Change>)) {
      if (isLookupKey(k)) { addId(k, c.from); addId(k, c.to); }
    }
  }
  const idList = (s: Set<string>) => [...s];
  const named = { select: { id: true, name: true } } as const;
  const [branches, categories, subCategories, collections, stockTypes, clients, sizes, members] = await Promise.all([
    tenantQuery(ctx.companyId, (tx) => tx.branch.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.branchId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.productCategory.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.categoryId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.subCategory.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.subCategoryId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.collection.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.collectionId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.stockType.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.stockTypeId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.client.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.manufacturerId) } }, ...named })),
    tenantQuery(ctx.companyId, (tx) => tx.size.findMany({ where: { companyId: ctx.companyId, id: { in: idList(ids.sizeId) } }, ...named })),
    // Only members of THIS company are ever named — a user id from anywhere else resolves to nothing.
    tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
      where: { companyId: ctx.companyId, userId: { in: idList(ids.userId) } }, select: { userId: true, user: { select: { name: true } } },
    })),
  ]);
  const toMap = (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [r.id, r.name]));
  const byKey: Record<LookupKey, Map<string, string>> = {
    branchId: toMap(branches), categoryId: toMap(categories), subCategoryId: toMap(subCategories),
    collectionId: toMap(collections), stockTypeId: toMap(stockTypes), manufacturerId: toMap(clients), sizeId: toMap(sizes),
  };
  const userName = new Map(members.map((m) => [m.userId, m.user.name]));
  const nameOf = (k: string, v: unknown): unknown =>
    typeof v === 'string' && isLookupKey(k) ? (byKey[k].get(v) ?? v) : v;

  const rows = page.map((h) => {
    const snap = h.snapshot as Record<string, unknown>;
    const changes = Object.fromEntries(Object.entries((h.changes ?? {}) as Record<string, Change>)
      .map(([k, c]) => [k, { from: nameOf(k, c.from), to: nameOf(k, c.to) }]));
    // Every snapshot field, with each id also shown as a name (the raw id stays under its own key).
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snap)) {
      data[k] = v;
      if (isLookupKey(k)) data[k.replace(/Id$/, 'Name')] = v ? nameOf(k, v) : null;
    }
    data.createdByName = typeof snap.createdById === 'string' ? (userName.get(snap.createdById) ?? null) : null;
    return {
      id: h.id, tagId: h.tagId, tagNumber: h.tagNumber, event: h.event, status: h.status,
      changedAt: h.createdAt, actorUserId: h.actorUserId,
      actorName: h.actorUserId ? (userName.get(h.actorUserId) ?? null) : null,
      branchName: h.branchId ? (byKey.branchId.get(h.branchId) ?? null) : null,
      changedFields: h.changedFields, changes, data,
    };
  });

  // Who can be filtered on: everyone in this company who has ever changed a tag.
  const actors = await tenantQuery(ctx.companyId, (tx) => tx.tagHistory.findMany({
    where: { companyId: ctx.companyId, actorUserId: { not: null } }, distinct: ['actorUserId'], select: { actorUserId: true },
  }));
  const actorMembers = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: { companyId: ctx.companyId, userId: { in: actors.map((a) => a.actorUserId as string) } },
    select: { userId: true, user: { select: { name: true } } },
  }));

  return {
    rows, truncated, limit: TAG_HISTORY_LIMIT, branches: branchOptions,
    users: actorMembers.map((m) => ({ id: m.userId, name: m.user.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
