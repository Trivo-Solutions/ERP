import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from './error';
import {
  runWithTenantContext, canAccessBranch, tenantQuery, TenantContext,
} from '../shared/tenantContext';

// ═══════════════════════════════════════════════════
// Layer 1 — application tenant context.
//
// req.user (set by authenticate(), middleware/auth.ts) already carries companyId/companyUserId/
// branchAccess once the JWT payload is extended (see auth.ts). This middleware does two things:
//   1. Rejects (400), never silently strips, any client-supplied companyId/tenantId/
//      organizationId — the security contract is "the client never chooses the tenant," and a
//      loud rejection is preferred over silent stripping so a bug or probe is visible, not
//      swallowed.
//   2. Publishes req.user's tenant fields into AsyncLocalStorage for the duration of the
//      request, so deep service/helper code (audit logging in particular) can reach it without
//      every function needing it threaded through as an explicit parameter. Service functions
//      that actually enforce tenant scoping still take it as an explicit parameter (see
//      tagging.service.ts/sales.service.ts) — ALS here is a convenience for cross-cutting
//      concerns, not the primary mechanism route handlers rely on for scoping decisions.
// ═══════════════════════════════════════════════════

const FORBIDDEN_TENANT_KEYS = ['companyId', 'tenantId', 'organizationId'];

export function rejectClientTenantSelectors(req: Request, res: Response, next: NextFunction) {
  const offending = FORBIDDEN_TENANT_KEYS.filter((k) => {
    const inBody = req.body && typeof req.body === 'object' && req.body[k] !== undefined;
    const inQuery = req.query && (req.query as Record<string, unknown>)[k] !== undefined;
    const inHeader = req.headers[k.toLowerCase()] !== undefined;
    return inBody || inQuery || inHeader;
  });
  if (offending.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Request must not specify: ${offending.join(', ')} — tenant is determined by authentication, not client input`,
    });
  }
  next();
}

export function resolveTenantContext(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new AppError('Authentication required', 401);
  const ctx: TenantContext = {
    companyId: req.user.companyId,
    companyUserId: req.user.companyUserId,
    userId: req.user.userId,
    roleId: req.user.roleId,
    roleName: req.user.roleName,
    permissions: req.user.permissions,
    branchAccess: req.user.branchAccess,
  };
  req.tenant = ctx;
  runWithTenantContext(ctx, next);
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

// ─── Layer 2 — explicit relation-ownership validation ──────────────────────
//
// PostgreSQL foreign-key/referential-integrity checks do NOT consult RLS policies on the
// referenced table (verified Postgres behavior, not an assumption) — a row's mere existence is
// enough to satisfy a FOREIGN KEY constraint regardless of whether the checking role's RLS
// policy would let it SELECT that row. This means RLS (Layer 3) cannot be relied on to reject a
// forged relation id smuggled into a create/update payload (e.g. Company B's clientId on a
// Company A invoice). This helper is the actual defense: every service function that accepts a
// foreign-entity id from a request MUST call this before using that id in any read, write, or
// relation-connect. 404 (not 403) is returned for a wrong-company id, same as "doesn't exist" —
// a 403 would itself leak that the row exists somewhere.

type ScopedModel =
  | 'branch' | 'client' | 'jewelryTag' | 'salesInvoice' | 'role'
  | 'memoOut' | 'tagTemplate' | 'branchTransfer' | 'stockAudit'
  | 'account' | 'costCenter' | 'invoicePayment' | 'salesReturn' | 'oldGoldExchange'
  | 'purchaseOrder' | 'purchaseRequisition' | 'goodsReceiptNote' | 'purchaseReturn'
  | 'repairJob' | 'hallmarkingBatch'
  // Phase 3 — full rollout
  | 'design' | 'costEstimate' | 'supplier' | 'metalStock' | 'stoneLot' | 'consumable'
  | 'salesOrder' | 'jobCard' | 'artisan' | 'subcontractorInvoice'
  | 'hardwareDevice' | 'tagEstimate' | 'estimateTemplate' | 'priceMaster' | 'makingCharge'
  | 'processTolerance'
  // Phase 1 of full company isolation — the masters are company-owned now, so every master id a
  // request supplies (a tag's category, an invoice line's category, a making charge's material
  // code, ...) must be verified against the caller's company like any other foreign id.
  | 'designCategory' | 'karatMaster' | 'productCategory' | 'subCategory' | 'collection'
  | 'materialCode' | 'stockType' | 'stoneType' | 'stoneGrade'
  // Phase 2 — identity/membership
  | 'companyUser' | 'companyInvitation'
  // G1 — GST foundation
  | 'companyGstRegistration' | 'taxInvoiceTemplate'
  // G2c — Credit Note
  | 'creditNote'
  // G2e — Debit Note (procurement/purchase-side)
  | 'debitNote'
  // G2g-4b — Sales Debit Note (outward/sell-side — a wholly separate domain from 'debitNote' above)
  | 'salesDebitNote'
  // G8a — GST integration foundation
  | 'gstIntegrationConfig';

// Routed through tenantQuery (Form 1 — see tenantContext.ts) rather than a bare prisma call:
// this is a read against a tenant-scoped table, so it follows the same one standard pattern as
// everything else, and — importantly for RLS readiness — means this check keeps working
// correctly (rather than false-negative-rejecting a legitimate same-company id) the moment RLS
// is enforced against the live connection, since the session variable is already being set here
// exactly like every other tenant-scoped query.
export async function assertOwnedByCompany(
  model: ScopedModel,
  id: string,
  companyId: string,
  label: string
): Promise<void> {
  // A missing / non-string id is a bad request. It must never reach Prisma as-is: undefined is a 500
  // ("needs at least one of id…"), and a JSON object such as {"not":""} would be read as a FILTER, not an id.
  if (typeof id !== 'string' || !id) throw new AppError(`${label} is required`, 400);
  const row = await tenantQuery(companyId, (tx) =>
    (tx[model] as { findUnique: (args: unknown) => Prisma.PrismaPromise<{ companyId: string } | null> })
      .findUnique({ where: { id }, select: { companyId: true } })
  );
  if (!row || row.companyId !== companyId) {
    throw new AppError(`${label} not found`, 404);
  }
}

/**
 * Ownership check for an OPTIONAL foreign id — null/undefined/'' means "not supplied" and is
 * skipped; anything else must belong to the caller's company. Most master references (a tag's
 * sub-category or collection, a stone row's grade) are optional, so this saves every call site
 * from repeating the `if (id)` guard. Same 404-not-403 behavior as assertOwnedByCompany.
 */
export async function assertOwnedIfPresent(
  model: ScopedModel,
  id: string | null | undefined,
  companyId: string,
  label: string
): Promise<void> {
  if (!id) return;
  await assertOwnedByCompany(model, id, companyId, label);
}

/** Same, for a list of ids (deduplicated) — e.g. every material row's materialCodeId on a tag. */
export async function assertAllOwned(
  model: ScopedModel,
  ids: Array<string | null | undefined>,
  companyId: string,
  label: string
): Promise<void> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  await Promise.all(unique.map((id) => assertOwnedByCompany(model, id, companyId, label)));
}

/** Branch-access check — company ownership AND the caller's own branch grant, both required. */
export async function assertBranchAccessible(
  branchId: string,
  ctx: TenantContext,
  label = 'Branch'
): Promise<void> {
  await assertOwnedByCompany('branch', branchId, ctx.companyId, label);
  if (!canAccessBranch(ctx, branchId)) {
    throw new AppError(`${label} not found`, 404);
  }
}

/**
 * BranchTransfer's own invariant: both ends must belong to the caller's company AND be branches
 * the caller is actually granted — no FK, single-column constraint, or RLS policy can express
 * "both of these two ids belong to the same company as each other," so this is checked
 * explicitly, once, at the one place a transfer is created.
 */
export async function assertTransferBranchesAccessible(
  fromBranchId: string,
  toBranchId: string,
  ctx: TenantContext
): Promise<void> {
  if (fromBranchId === toBranchId) {
    throw new AppError('Source and destination branches must be different', 400);
  }
  await assertBranchAccessible(fromBranchId, ctx, 'Source branch');
  await assertBranchAccessible(toBranchId, ctx, 'Destination branch');
}
