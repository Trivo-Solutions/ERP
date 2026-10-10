import { isEstimateExpired } from '../../shared/estimateExpiry';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { priceMaterialBreakdown } from '../../shared/materialBreakdown';
import { resolveOfferForTag, todayString } from './offer.service';
import {
  ApprovalNeed, BelowOffer, OfferFloor, belowOffer, describeNeed, discountRateHash, floorFromResolution, lineRateHash,
} from './offerApproval';

// Offer management step 3: a manager's approval for selling below an offer.
//
//   biller  --requestApproval-->  PENDING  --decideApproval (a DIFFERENT person, discount:approve)-->  APPROVED | REJECTED
//   APPROVED --settleApprovals (inside the bill's own transaction; count-checked)--> USED     (single use)
//
// What needs approval is decided by the SERVER from the bill itself (sales.service.ts priceInvoice builds the
// ApprovalNeed list); the client never says "this one is fine". An approval matches a need only by its rateHash - the
// exact piece and exact below-offer figures - so a lower rate, another piece or a bigger discount needs a fresh one.

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'USED'] as const;
const MAX_REASON = 500;

const APPROVAL_SELECT = {
  id: true, scope: true, status: true, tagId: true, offerId: true, requestedRates: true, offeredRates: true, reason: true,
  requestedAt: true, decidedAt: true, decisionNote: true, usedAt: true, usedInvoiceId: true,
  requestedById: true, decidedById: true,
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  tag: { select: { id: true, tagNumber: true, name: true } },
  estimateId: true,
  estimate: { select: { id: true, estimateNumber: true } },
  offer: { select: { id: true, name: true } },
} satisfies Prisma.DiscountApprovalSelect;

type ApprovalRow = Prisma.DiscountApprovalGetPayload<{ select: typeof APPROVAL_SELECT }>;

const shape = (a: ApprovalRow) => ({
  id: a.id, scope: a.scope, status: a.status, reason: a.reason,
  tag: a.tag, offer: a.offer, estimate: a.estimate,
  requestedRates: a.requestedRates, offeredRates: a.offeredRates,
  requestedBy: a.requestedBy, requestedAt: a.requestedAt,
  decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote,
  usedAt: a.usedAt, usedInvoiceId: a.usedInvoiceId,
});

const auditView = (a: { scope: string; status: string; tagId: string | null; rateHash?: string; requestedRates: unknown; offeredRates: unknown }) =>
  ({ scope: a.scope, status: a.status, tagId: a.tagId, requestedRates: a.requestedRates, offeredRates: a.offeredRates }) as Record<string, unknown>;

function cleanReason(raw: unknown, what = 'A reason'): string {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) throw new AppError(`${what} is required`, 400);
  if (t.length > MAX_REASON) throw new AppError(`${what} must be at most ${MAX_REASON} characters`, 400);
  return t;
}

// ─── request ─────────────────────────────────────────────────────────────────

export interface ApprovalRequestInput {
  scope: 'LINE' | 'DISCOUNT';
  reason: string;
  /** LINE: the piece, the rates the bill would charge for it, and the bill's date (the offer is picked by date). */
  tagId?: string;
  materialBreakdown?: unknown;
  invoiceDate?: string;
  /** DISCOUNT: the extra invoice-level discount, ₹. */
  discountAmount?: number;
}

/**
 * Asks for approval. The server recomputes what is below the offered rate from the submitted breakdown and the offer in
 * force on the bill's date - if nothing is below it there is nothing to approve (409), and what is stored is the
 * server's figure, not the client's claim. An identical open request by the same person is returned, not duplicated.
 */
export async function requestApproval(ctx: TenantContext, input: ApprovalRequestInput, userId: string) {
  const reason = cleanReason(input.reason);
  if (input.scope !== 'LINE' && input.scope !== 'DISCOUNT') throw new AppError('scope must be LINE or DISCOUNT', 400);

  let data: { tagId: string | null; offerId: string | null; requestedRates: Prisma.InputJsonValue; offeredRates: Prisma.InputJsonValue; rateHash: string };
  if (input.scope === 'LINE') {
    if (typeof input.tagId !== 'string' || !input.tagId) throw new AppError('tagId is required', 400);
    await assertOwnedByCompany('jewelryTag', input.tagId, ctx.companyId, 'Tag');
    const bd = priceMaterialBreakdown(input.materialBreakdown);
    const asOf = typeof input.invoiceDate === 'string' && input.invoiceDate ? input.invoiceDate.slice(0, 10) : todayString();
    const r = await resolveOfferForTag(ctx, input.tagId, asOf);
    const floor = floorFromResolution(r.resolution);
    if (!floor) throw new AppError('No offer applies to this piece, so there is nothing to approve', 409);
    const below = belowOffer(floor, bd.normalized);
    if (!below) throw new AppError('These rates are not below the offered rate - no approval is needed', 409);
    data = {
      tagId: input.tagId, offerId: floor.offerId,
      requestedRates: below.requested as unknown as Prisma.InputJsonValue, offeredRates: below.offered as unknown as Prisma.InputJsonValue,
      rateHash: lineRateHash(input.tagId, below.requested),
    };
  } else {
    const amount = Number(input.discountAmount);
    if (!Number.isFinite(amount) || !(amount > 0)) throw new AppError('discountAmount must be more than 0', 400);
    const amt = Math.round(amount * 100) / 100;
    data = {
      tagId: null, offerId: null, requestedRates: { discountAmount: amt }, offeredRates: { discountAmount: 0 }, rateHash: discountRateHash(amt),
    };
  }

  const existing = await tenantQuery(ctx.companyId, (tx) => tx.discountApproval.findFirst({
    where: { companyId: ctx.companyId, requestedById: userId, rateHash: data.rateHash, status: { in: ['PENDING', 'APPROVED'] } },
    select: APPROVAL_SELECT,
  }));
  if (existing) return shape(existing);

  const created = await tenantQuery(ctx.companyId, (tx) => tx.discountApproval.create({
    data: { companyId: ctx.companyId, scope: input.scope, reason, requestedById: userId, ...data },
    select: APPROVAL_SELECT,
  }));
  await createAuditEntry('discount_approvals', created.id, userId, 'CREATE', undefined, auditView({ ...created, ...data }), ctx.companyId);
  return shape(created);
}

// ─── decide / cancel ─────────────────────────────────────────────────────────

async function load(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('discountApproval', id, ctx.companyId, 'Approval request');
  const row = await tenantQuery(ctx.companyId, (tx) => tx.discountApproval.findUnique({ where: { id }, select: APPROVAL_SELECT }));
  if (!row) throw new AppError('Approval request not found', 404);
  return row;
}

/** The approver decides a PENDING request. Never their own: the person who asked cannot be the person who approves. */
export async function decideApproval(ctx: TenantContext, id: string, approverId: string, decision: 'APPROVE' | 'REJECT', note?: unknown) {
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new AppError('decision must be APPROVE or REJECT', 400);
  const decisionNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, MAX_REASON) : null;
  if (decision === 'REJECT' && !decisionNote) throw new AppError('Say why the request is being rejected', 400);

  const before = await load(ctx, id);
  if (before.requestedById === approverId) throw new AppError('You cannot decide your own approval request - another approver must', 403);
  const next = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  // An estimate is a quote for one day: a request for one made on an earlier day can be rejected but not approved - the
  // estimator makes a new estimate at today's rate.
  if (decision === 'APPROVE' && before.estimateId) {
    const est = await tenantQuery(ctx.companyId, (tx) => tx.tagEstimate.findUnique({ where: { id: before.estimateId! }, select: { createdAt: true, estimateNumber: true } }));
    if (est && isEstimateExpired(est.createdAt)) throw new AppError(`Estimate ${est.estimateNumber} was made on an earlier day and has expired - reject this request and make a new estimate`, 409);
  }
  // Count-checked: two approvers racing, or a request cancelled a moment ago, cannot both win. When the request came from an
  // estimate sent for approval, the estimate moves in the same transaction: approved -> released to billing, rejected -> back to OPEN.
  const done = await tenantTransaction(ctx.companyId, async (tx) => {
    const r = await tx.discountApproval.updateMany({
      where: { id, companyId: ctx.companyId, status: 'PENDING', requestedById: { not: approverId } },
      data: { status: next, decidedById: approverId, decidedAt: new Date(), decisionNote },
    });
    if (r.count === 1 && before.estimateId) {
      await tx.tagEstimate.updateMany({
        where: { id: before.estimateId, companyId: ctx.companyId, status: 'AWAITING_APPROVAL' },
        data: decision === 'APPROVE' ? { status: 'SENT', sentToBillingAt: new Date(), sentById: before.requestedById } : { status: 'OPEN' },
      });
    }
    return r;
  });
  if (done.count !== 1) throw new AppError(`This request is no longer pending (${(await load(ctx, id)).status})`, 409);
  const after = await load(ctx, id);
  await createAuditEntry('discount_approvals', id, approverId, decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
    auditView(before), { ...auditView(after), decisionNote }, ctx.companyId);
  return shape(after);
}

/** The requester withdraws their own request (pending or approved-but-unused). */
export async function cancelApproval(ctx: TenantContext, id: string, userId: string) {
  const before = await load(ctx, id);
  if (before.requestedById !== userId) throw new AppError('Only the person who asked can cancel a request', 403);
  const done = await tenantTransaction(ctx.companyId, async (tx) => {
    const r = await tx.discountApproval.updateMany({
      where: { id, companyId: ctx.companyId, requestedById: userId, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
    if (r.count === 1 && before.estimateId) {
      // Withdrawn: an estimate still waiting goes back to OPEN; one already released to billing is pulled back too (not yet billed).
      await tx.tagEstimate.updateMany({
        where: { id: before.estimateId, companyId: ctx.companyId, status: { in: ['AWAITING_APPROVAL', 'SENT'] } },
        data: { status: 'OPEN' },
      });
    }
    return r;
  });
  if (done.count !== 1) throw new AppError(`This request can no longer be cancelled (${(await load(ctx, id)).status})`, 409);
  const after = await load(ctx, id);
  await createAuditEntry('discount_approvals', id, userId, 'CANCEL', auditView(before), auditView(after), ctx.companyId);
  return shape(after);
}

// ─── read ────────────────────────────────────────────────────────────────────

/** An approver sees every request of the company; anyone else sees only their own. */
export async function listApprovals(ctx: TenantContext, userId: string, canApprove: boolean, filter: { status?: string; mine?: boolean; estimateId?: string } = {}) {
  const status = filter.status && filter.status !== 'ALL' ? filter.status : undefined;
  if (status && !(APPROVAL_STATUSES as readonly string[]).includes(status)) throw new AppError('Unknown status', 400);
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.discountApproval.findMany({
    where: {
      companyId: ctx.companyId, ...(status && { status }),
      // Asking about one estimate (the biller loading it) is open to anyone who can bill; otherwise non-approvers see only their own.
      ...(filter.estimateId ? { estimateId: filter.estimateId } : (!canApprove || filter.mine) && { requestedById: userId }),
    },
    select: APPROVAL_SELECT, orderBy: { requestedAt: 'desc' }, take: 300,
  }));
  return rows.map(shape);
}

export async function getApproval(ctx: TenantContext, id: string, userId: string, canApprove: boolean) {
  const row = await load(ctx, id);
  if (!canApprove && row.requestedById !== userId) throw new AppError('Approval request not found', 404);
  return shape(row);
}

// ─── use (inside the bill's transaction) ─────────────────────────────────────

/**
 * Called by createInvoice / amendInvoice inside their own transaction, once the invoice row exists. Every need must be
 * met by (a) an approval this very invoice already consumed (an amend that leaves those rates alone), or (b) an APPROVED,
 * unused approval from `approvalIds` whose hash is exactly the need's. (b) is consumed with a count-checked update, so
 * two bills can never share one approval; if the bill later rolls back, so does the consumption. All unmet needs are
 * reported together (409, code DISCOUNT_APPROVAL_REQUIRED) so the biller can ask for them in one go.
 */
export async function settleApprovals(
  tx: Prisma.TransactionClient, ctx: TenantContext,
  args: { invoiceId: string; needs: ApprovalNeed[]; approvalIds?: unknown },
) {
  if (args.needs.length === 0) return;
  const ids = Array.isArray(args.approvalIds) ? args.approvalIds.filter((x): x is string => typeof x === 'string' && !!x) : [];

  const [carried, offered] = await Promise.all([
    tx.discountApproval.findMany({
      where: { companyId: ctx.companyId, usedInvoiceId: args.invoiceId, status: 'USED' }, select: { rateHash: true },
    }),
    ids.length
      ? tx.discountApproval.findMany({
          where: { companyId: ctx.companyId, id: { in: ids }, status: 'APPROVED' }, select: { id: true, rateHash: true },
        })
      : Promise.resolve([] as { id: string; rateHash: string }[]),
  ]);
  const carriedHashes = new Set(carried.map((c) => c.rateHash));
  const pool = [...offered];

  const missing: ApprovalNeed[] = [];
  for (const need of args.needs) {
    if (carriedHashes.has(need.rateHash)) continue;
    const at = pool.findIndex((p) => p.rateHash === need.rateHash);
    if (at < 0) { missing.push(need); continue; }
    const [hit] = pool.splice(at, 1);
    const used = await tx.discountApproval.updateMany({
      where: { id: hit.id, companyId: ctx.companyId, status: 'APPROVED', rateHash: need.rateHash },
      data: { status: 'USED', usedAt: new Date(), usedInvoiceId: args.invoiceId },
    });
    if (used.count !== 1) missing.push(need); // consumed by another bill a moment ago
  }
  if (missing.length > 0) {
    throw new AppError(
      `A store manager's approval is needed for ${missing.map(describeNeed).join('; ')}`,
      409, true, 'DISCOUNT_APPROVAL_REQUIRED', { needs: missing },
    );
  }
}

// ─── estimates sent for approval ─────────────────────────────────────────────

/** Is this estimate's pricing below the offer in force today? Returns the floor + what is below it, or null. */
export async function estimateBelowOffer(
  ctx: TenantContext, tagId: string,
  rates: { mcRate: number; vaPercent: number; rows: { materialId?: string | null; rate: number; code?: string }[] },
): Promise<{ floor: OfferFloor; below: BelowOffer } | null> {
  const r = await resolveOfferForTag(ctx, tagId);
  const floor = floorFromResolution(r.resolution);
  if (!floor) return null;
  const below = belowOffer(floor, {
    mcRate: rates.mcRate, vaPercent: rates.vaPercent,
    rows: rates.rows.map((x) => ({ code: x.code ?? '', materialType: '', name: '', weight: 0, unit: '', rate: x.rate, ...(x.materialId ? { materialId: x.materialId } : {}) })),
  });
  return below ? { floor, below } : null;
}

export const requireApprovalReason = (raw: unknown) => {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) {
    throw new AppError('This estimate is priced below the offer, so it has to go to a store manager for approval - say why', 409, true, 'APPROVAL_REASON_REQUIRED');
  }
  return cleanReason(t);
};

/** Inside the caller's transaction: opens the approval request that goes with an estimate sent for approval. */
export async function createEstimateApproval(
  tx: Prisma.TransactionClient, ctx: TenantContext,
  a: { estimateId: string; tagId: string; floor: OfferFloor; below: BelowOffer; reason: string; userId: string },
) {
  const rateHash = lineRateHash(a.tagId, a.below.requested);
  const row = await tx.discountApproval.create({
    data: {
      companyId: ctx.companyId, scope: 'LINE', reason: a.reason, requestedById: a.userId, tagId: a.tagId, offerId: a.floor.offerId,
      estimateId: a.estimateId, rateHash,
      requestedRates: a.below.requested as unknown as Prisma.InputJsonValue, offeredRates: a.below.offered as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: row.id, rateHash };
}

export const auditEstimateApprovalRequested = (ctx: TenantContext, userId: string, approvalId: string, below: BelowOffer, tagId: string, estimateId: string) =>
  createAuditEntry('discount_approvals', approvalId, userId, 'CREATE', undefined,
    { scope: 'LINE', status: 'PENDING', tagId, estimateId, requestedRates: below.requested, offeredRates: below.offered }, ctx.companyId);
