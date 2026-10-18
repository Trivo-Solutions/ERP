import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany, assertOwnedIfPresent, assertAllOwned } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';
import { resolveLiveMetalRate } from '../../shared/metalRate';
import { isFixedPrice } from '../../shared/fixedPrice';
import { businessDayString } from '../../shared/businessDay';
import {
  OFFER_COMPONENTS, OFFER_MODES, OfferLike, OfferResolution, PieceRates, resolveOffer,
} from './offerResolver';

// Offer management (step 1): CRUD for dated sale-rate offers, plus resolution for one tag on a date.
// An offer never writes to JewelryTag / JewelryTagMaterial — it is a read-time overlay (see offerResolver.ts).

export interface OfferRuleInput {
  component: string;
  mode: string;
  value: number | string;
  stoneTypeId?: string | null;
  categoryId?: string | null;
  karat?: string | null;
}

export interface OfferInput {
  name: string;
  description?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  priority?: number;
  branchId?: string | null;
  isActive?: boolean;
  rules: OfferRuleInput[];
}

// ─── dates ───────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as 'YYYY-MM-DD' - the India business day (Asia/Kolkata), whatever timezone the server runs in. */
export function todayString(now = new Date()): string {
  return businessDayString(now);
}

function parseDay(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00.000Z`).getTime())) {
    throw new AppError(`${what} must be a date in YYYY-MM-DD form`, 400);
  }
  if (new Date(`${raw}T00:00:00.000Z`).toISOString().slice(0, 10) !== raw) throw new AppError(`${what} is not a real date`, 400);
  return raw;
}

const dayToDb = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dbToDay = (d: Date) => d.toISOString().slice(0, 10);

// ─── validation ──────────────────────────────────────────────────────────────

const optId = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new AppError(`${what} must be an id`, 400);
  return v;
};

async function cleanInput(ctx: TenantContext, input: OfferInput) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new AppError('Offer name is required', 400);
  const effectiveFrom = parseDay(input.effectiveFrom, 'Effective from');
  const effectiveTo = input.effectiveTo ? parseDay(input.effectiveTo, 'Effective to') : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new AppError('Effective to cannot be before effective from', 400);

  const priority = input.priority === undefined ? 0 : Number(input.priority);
  if (!Number.isInteger(priority) || Math.abs(priority) > 1000) throw new AppError('Priority must be a whole number', 400);

  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new AppError('An offer needs at least one rule', 400);
  if (input.rules.length > 200) throw new AppError('An offer can hold at most 200 rules', 400);

  const rules = input.rules.map((r, i) => {
    const at = `Rule ${i + 1}`;
    if (!OFFER_COMPONENTS.includes(r.component as never)) throw new AppError(`${at}: component must be one of ${OFFER_COMPONENTS.join(', ')}`, 400);
    if (!OFFER_MODES.includes(r.mode as never)) throw new AppError(`${at}: mode must be one of ${OFFER_MODES.join(', ')}`, 400);
    const value = Number(r.value);
    if (r.value === '' || r.value === null || r.value === undefined || !Number.isFinite(value) || value < 0) {
      throw new AppError(`${at}: value must be a number, 0 or more`, 400);
    }
    if (r.mode === 'PERCENT_OFF' && value > 100) throw new AppError(`${at}: a percentage off cannot exceed 100`, 400);
    const stoneTypeId = optId(r.stoneTypeId, `${at}: stone type`);
    if (stoneTypeId && r.component !== 'STONE') throw new AppError(`${at}: a stone type only applies to a STONE rule`, 400);
    const karat = typeof r.karat === 'string' && r.karat.trim() ? r.karat.trim() : null;
    return { component: r.component, mode: r.mode, value, stoneTypeId, categoryId: optId(r.categoryId, `${at}: category`), karat };
  });

  // Every request-supplied foreign id must belong to the caller's company (a plain-FK forge would otherwise pass).
  const branchId = optId(input.branchId, 'Branch');
  await assertOwnedIfPresent('branch', branchId, ctx.companyId, 'Branch');
  await assertAllOwned('stoneType', rules.map((r) => r.stoneTypeId), ctx.companyId, 'Stone type');
  await assertAllOwned('productCategory', rules.map((r) => r.categoryId), ctx.companyId, 'Category');
  const karats = [...new Set(rules.map((r) => r.karat).filter((k): k is string => !!k))];
  if (karats.length) {
    const found = await tenantQuery(ctx.companyId, (tx) => tx.karatMaster.findMany({
      where: { companyId: ctx.companyId, code: { in: karats } }, select: { code: true },
    }));
    const missing = karats.filter((k) => !found.some((f) => f.code === k));
    if (missing.length) throw new AppError(`Unknown karat: ${missing.join(', ')}`, 400);
  }

  return {
    name,
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null,
    effectiveFrom, effectiveTo, priority, branchId,
    isActive: input.isActive === undefined ? true : !!input.isActive,
    rules,
  };
}

// ─── shape ───────────────────────────────────────────────────────────────────

const OFFER_INCLUDE = {
  rules: {
    orderBy: { createdAt: 'asc' as const },
    include: { stoneType: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } },
  },
  branch: { select: { id: true, name: true } },
} satisfies Prisma.OfferInclude;

type OfferRow = Prisma.OfferGetPayload<{ include: typeof OFFER_INCLUDE }>;

export type OfferStatus = 'INACTIVE' | 'UPCOMING' | 'ACTIVE' | 'EXPIRED';

export function offerStatus(o: { isActive: boolean; effectiveFrom: string; effectiveTo: string | null }, today: string): OfferStatus {
  if (!o.isActive) return 'INACTIVE';
  if (today < o.effectiveFrom) return 'UPCOMING';
  if (o.effectiveTo && today > o.effectiveTo) return 'EXPIRED';
  return 'ACTIVE';
}

function shape(o: OfferRow, today: string) {
  const effectiveFrom = dbToDay(o.effectiveFrom);
  const effectiveTo = o.effectiveTo ? dbToDay(o.effectiveTo) : null;
  return {
    id: o.id, name: o.name, description: o.description, priority: o.priority,
    effectiveFrom, effectiveTo, isActive: o.isActive,
    status: offerStatus({ isActive: o.isActive, effectiveFrom, effectiveTo }, today),
    branchId: o.branchId, branch: o.branch,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
    rules: o.rules.map((r) => ({
      id: r.id, component: r.component, mode: r.mode, value: Number(r.value),
      stoneTypeId: r.stoneTypeId, stoneType: r.stoneType, categoryId: r.categoryId, category: r.category, karat: r.karat,
    })),
  };
}

const auditView = (o: ReturnType<typeof shape>) => ({
  name: o.name, effectiveFrom: o.effectiveFrom, effectiveTo: o.effectiveTo, priority: o.priority,
  branchId: o.branchId, isActive: o.isActive,
  rules: o.rules.map((r) => ({ component: r.component, mode: r.mode, value: r.value, stoneTypeId: r.stoneTypeId, categoryId: r.categoryId, karat: r.karat })),
}) as Record<string, unknown>;

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listOffers(ctx: TenantContext, filter: { status?: string } = {}) {
  const today = todayString();
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.offer.findMany({
    where: { companyId: ctx.companyId },
    include: OFFER_INCLUDE,
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  }));
  const all = rows.map((r) => shape(r, today));
  return filter.status && filter.status !== 'ALL' ? all.filter((o) => o.status === filter.status) : all;
}

export async function getOffer(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('offer', id, ctx.companyId, 'Offer');
  const row = await tenantQuery(ctx.companyId, (tx) => tx.offer.findUnique({ where: { id }, include: OFFER_INCLUDE }));
  if (!row) throw new AppError('Offer not found', 404);
  return shape(row, todayString());
}

export async function createOffer(ctx: TenantContext, input: OfferInput, userId: string) {
  const d = await cleanInput(ctx, input);
  const id = await tenantTransaction(ctx.companyId, async (tx) => {
    const offer = await tx.offer.create({
      data: {
        companyId: ctx.companyId, name: d.name, description: d.description,
        effectiveFrom: dayToDb(d.effectiveFrom), effectiveTo: d.effectiveTo ? dayToDb(d.effectiveTo) : null,
        priority: d.priority, branchId: d.branchId, isActive: d.isActive, createdById: userId,
      },
    });
    await tx.offerRule.createMany({ data: d.rules.map((r) => ({ ...r, companyId: ctx.companyId, offerId: offer.id })) });
    return offer.id;
  });
  const created = await getOffer(ctx, id);
  await createAuditEntry('offers', id, userId, 'CREATE', undefined, auditView(created), ctx.companyId);
  return created;
}

/** Replaces the offer's header and its whole rule list in one transaction (the page edits an offer as a unit). */
export async function updateOffer(ctx: TenantContext, id: string, input: OfferInput, userId: string) {
  const before = await getOffer(ctx, id);
  const d = await cleanInput(ctx, input);
  await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.offer.update({
      where: { id },
      data: {
        name: d.name, description: d.description,
        effectiveFrom: dayToDb(d.effectiveFrom), effectiveTo: d.effectiveTo ? dayToDb(d.effectiveTo) : null,
        priority: d.priority, branchId: d.branchId, isActive: d.isActive,
      },
    });
    await tx.offerRule.deleteMany({ where: { offerId: id, companyId: ctx.companyId } });
    await tx.offerRule.createMany({ data: d.rules.map((r) => ({ ...r, companyId: ctx.companyId, offerId: id })) });
  });
  const after = await getOffer(ctx, id);
  await createAuditEntry('offers', id, userId, 'EDIT', auditView(before), auditView(after), ctx.companyId);
  return after;
}

export async function setOfferActive(ctx: TenantContext, id: string, isActive: boolean, userId: string) {
  const before = await getOffer(ctx, id);
  if (before.isActive === isActive) throw new AppError(`Offer is already ${isActive ? 'active' : 'inactive'}`, 409);
  await tenantQuery(ctx.companyId, (tx) => tx.offer.update({ where: { id }, data: { isActive } }));
  const after = await getOffer(ctx, id);
  await createAuditEntry('offers', id, userId, isActive ? 'REACTIVATE' : 'DEACTIVATE', { isActive: before.isActive }, { isActive }, ctx.companyId);
  return after;
}

/**
 * Permanent removal of an offer and its rules. Only for an offer nothing refers to — once estimates/invoices
 * snapshot an offer (step 2) the FK refuses and the caller is told to deactivate instead. Never cascades.
 */
export async function deleteOffer(ctx: TenantContext, id: string, userId: string) {
  const before = await getOffer(ctx, id);
  try {
    await tenantTransaction(ctx.companyId, async (tx) => {
      await tx.offerRule.deleteMany({ where: { offerId: id, companyId: ctx.companyId } });
      await tx.offer.delete({ where: { id } });
    });
  } catch (err) {
    if (isBlockedByForeignKey(err)) throw new AppError('This offer has been used and cannot be deleted. Deactivate it instead.', 409);
    throw err;
  }
  await createAuditEntry('offers', id, userId, 'DELETE', auditView(before), undefined, ctx.companyId);
}

// ─── resolution ──────────────────────────────────────────────────────────────

/**
 * BASE sale rates for a piece on a date. Today this is simply what the tag was tagged with. When the bulk
 * temporary-price-change feature exists, THIS is the one place that learns about it (return the bulk rate for the
 * date, else the tagged rate) — offers and billing stay as they are.
 */
async function baseRatesForTag(ctx: TenantContext, tagId: string, asOf: string, opts: { requireMetalRate: boolean }) {
  const tag = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findUnique({
    where: { id: tagId },
    select: {
      id: true, companyId: true, categoryId: true, metalKarat: true, branchId: true, saleMcRate: true, saleVaPercent: true,
      materials: { select: { id: true, materialType: true, saleRate: true, stoneGrade: { select: { stoneTypeId: true } } } },
    },
  }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);
  // Gold is the one live element of a sale price: a METAL row is priced at the day's metal rate for the piece's karat, not
  // at whatever it was tagged with. (MC, VA and stone rates stay the tag's own columns.)
  const needsMetal = tag.materials.some((m) => m.materialType === 'METAL');
  const live = needsMetal && tag.metalKarat ? await resolveLiveMetalRate(ctx.companyId, tag.metalKarat, asOf) : null;
  // Only an offer that has a METAL rule can use the metal rate. Without one (the usual case) billing a fully priced tag must not
  // depend on a metal rate being on file, so the base metal row then just carries the tag's stored figure, which nothing reads.
  if (needsMetal && !live && opts.requireMetalRate) throw new AppError(`No metal rate has been entered for ${tag.metalKarat ?? 'this piece'} - enter it under Metal Rates first`, 409);
  const piece: PieceRates = {
    categoryId: tag.categoryId, karat: tag.metalKarat, branchId: tag.branchId,
    mcRate: Number(tag.saleMcRate ?? 0), vaPercent: Number(tag.saleVaPercent ?? 0),
    rows: tag.materials.map((m) => ({
      key: m.id, materialType: m.materialType, stoneTypeId: m.stoneGrade?.stoneTypeId ?? null,
      rate: m.materialType === 'METAL' && live ? live.ratePerGram : Number(m.saleRate ?? 0),
    })),
  };
  return piece;
}

async function loadOffersForResolution(ctx: TenantContext, asOf: string): Promise<OfferLike[]> {
  const day = dayToDb(asOf);
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.offer.findMany({
    where: { companyId: ctx.companyId, isActive: true, effectiveFrom: { lte: day }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }] },
    include: { rules: true },
  }));
  return rows.map((o) => ({
    id: o.id, name: o.name, priority: o.priority, createdAt: o.createdAt,
    effectiveFrom: dbToDay(o.effectiveFrom), effectiveTo: o.effectiveTo ? dbToDay(o.effectiveTo) : null,
    branchId: o.branchId, isActive: o.isActive,
    rules: o.rules.map((r) => ({ id: r.id, component: r.component, mode: r.mode, value: Number(r.value), stoneTypeId: r.stoneTypeId, categoryId: r.categoryId, karat: r.karat })),
  }));
}

/** What an offer does to one tag's sale rates on `asOf` (default today). Read-only; sale rates only, never cost. */
export async function resolveOfferForTag(
  ctx: TenantContext, tagId: string, asOf?: string,
): Promise<{ asOf: string; base: PieceRates; resolution: OfferResolution }> {
  const day = asOf ? parseDay(asOf, 'Date') : todayString();
  // A fixed-price-per-piece tag has no weight-based component rates for an offer to lower - no offer ever applies to it.
  const mode = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findFirst({ where: { id: tagId, companyId: ctx.companyId }, select: { pricingMode: true } }));
  const offers = isFixedPrice(mode) ? [] : await loadOffersForResolution(ctx, day);
  const base = await baseRatesForTag(ctx, tagId, day, { requireMetalRate: offers.some((o) => o.rules.some((r) => r.component === 'METAL')) });
  return { asOf: day, base, resolution: resolveOffer(offers, base, day) };
}
