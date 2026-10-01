import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, tenantTransaction, TenantContext } from '../../shared/tenantContext';

// Grants a CompanyUser explicit access to one branch. Both the membership and the branch are
// verified as belonging to the caller's own company BEFORE the grant is created (a wrong-company
// id is a 404, indistinguishable from a nonexistent one), and the grant is stamped with that
// company's id. Postgres FK checks do not consult RLS, so the application check is the primary
// defence — and the composite foreign keys on user_branch_access ((companyUserId, companyId) and
// (branchId, companyId)) are the backstop that makes a cross-company grant impossible to STORE even
// if this check were ever bypassed.
export async function grantBranchAccess(ctx: TenantContext, companyUserId: string, branchId: string) {
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'User');
  await assertOwnedByCompany('branch', branchId, ctx.companyId, 'Branch');
  try {
    const grant = await tenantQuery(ctx.companyId, (tx) =>
      tx.userBranchAccess.create({ data: { companyId: ctx.companyId, companyUserId, branchId } })
    );
    await createAuditEntry('user_branch_access', grant.id, ctx.userId, 'CREATE', undefined, { companyUserId, branchId }, ctx.companyId);
    return grant;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('This user already has access to that branch', 409);
    }
    throw err;
  }
}

export async function revokeBranchAccess(ctx: TenantContext, companyUserId: string, branchId: string) {
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'User');
  // companyId is part of the filter too, so a branchId from another company simply matches nothing.
  const result = await tenantQuery(ctx.companyId, (tx) =>
    tx.userBranchAccess.deleteMany({ where: { companyId: ctx.companyId, companyUserId, branchId } })
  );
  if (result.count > 0) {
    await createAuditEntry('user_branch_access', `${companyUserId}:${branchId}`, ctx.userId, 'DELETE', { companyUserId, branchId }, undefined, ctx.companyId);
  }
  return result;
}

// This company's active branches — the picker list for the invite/edit-member UI. Gated on
// user:manage (not tag:view/branch:manage like the other /branches listings elsewhere) so a
// user administrator doesn't need an unrelated permission just to grant branch access.
export async function listBranches(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.branch.findMany({
    where: { companyId, isActive: true },
    orderBy: { name: 'asc' },
  }));
}

// The specific branches a member currently holds (meaningless/empty while allBranches is true —
// resolveBranchAccess in auth.service.ts is what actually expands allBranches at login time).
export async function listBranchAccess(ctx: TenantContext, companyUserId: string) {
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'User');
  const grants = await tenantQuery(ctx.companyId, (tx) =>
    tx.userBranchAccess.findMany({ where: { companyId: ctx.companyId, companyUserId }, select: { branchId: true } })
  );
  return grants.map((g) => g.branchId);
}

// ═══════════════════════════════════════════════════
// G1 Part A/K — CompanyGstRegistration CRUD.
//
// Company.gstin/stateCode (the legacy, single-registration fields) are left untouched by all of
// this — they remain the migration-time source a company's first registration was backfilled
// from, and sales.service.ts:resolveSellerRegistration() still falls back to them for a company
// with zero rows here. This is purely additive.
// ═══════════════════════════════════════════════════

export async function listGstRegistrations(companyId: string) {
  return tenantQuery(companyId, (tx) => tx.companyGstRegistration.findMany({
    where: { companyId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  }));
}

type GstRegistrationInput = {
  gstin: string; legalName: string; tradeName?: string | null; stateCode: string;
  address?: string | null; city?: string | null; district?: string | null; pincode?: string | null;
  country?: string; isPrimary?: boolean; isActive?: boolean;
};

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

function assertValidGstin(gstin: string) {
  if (!GSTIN_FORMAT.test(gstin)) {
    throw new AppError('GSTIN must be 15 characters in the standard format (e.g. 24ABCDE1234F1Z5)', 400);
  }
}

// Exactly one row per company may be isPrimary — enforced here in a transaction (same
// uniqueness-invariant-in-a-transaction precedent as TagTemplate/EstimateTemplate's isDefault),
// not a DB constraint (a partial unique index would work too, but this matches the established
// codebase convention for this exact shape of "only one of these may be the special one").
export async function createGstRegistration(ctx: TenantContext, data: GstRegistrationInput) {
  assertValidGstin(data.gstin);
  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    const existingCount = await tx.companyGstRegistration.count({ where: { companyId: ctx.companyId } });
    const isPrimary = data.isPrimary ?? existingCount === 0; // the company's first registration is primary by default
    if (isPrimary) {
      await tx.companyGstRegistration.updateMany({ where: { companyId: ctx.companyId, isPrimary: true }, data: { isPrimary: false } });
    }
    try {
      return await tx.companyGstRegistration.create({
        data: { ...data, companyId: ctx.companyId, isPrimary, isActive: data.isActive ?? true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('This company already has a registration with that GSTIN', 409);
      }
      throw err;
    }
  });
  await createAuditEntry('company_gst_registrations', created.id, ctx.userId, 'CREATE', undefined, created, ctx.companyId);
  return created;
}

export async function updateGstRegistration(ctx: TenantContext, id: string, data: Partial<GstRegistrationInput>) {
  if (data.gstin) assertValidGstin(data.gstin);
  await assertOwnedByCompany('companyGstRegistration', id, ctx.companyId, 'GST registration');
  const updated = await tenantTransaction(ctx.companyId, async (tx) => {
    const before = await tx.companyGstRegistration.findUniqueOrThrow({ where: { id } });
    if (data.isPrimary === true && !before.isPrimary) {
      await tx.companyGstRegistration.updateMany({ where: { companyId: ctx.companyId, isPrimary: true }, data: { isPrimary: false } });
    }
    // A registration cannot be deactivated while it is the sole primary — a company must always
    // have exactly one resolvable seller identity for new invoices (Part B's "fail clearly"
    // requirement only bites when NOTHING resolves; this stops that state from being reachable
    // at all via the admin screen).
    if (data.isActive === false && before.isPrimary) {
      throw new AppError('Cannot deactivate the primary GST registration — mark another one primary first', 409);
    }
    try {
      return await tx.companyGstRegistration.update({ where: { id }, data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('This company already has a registration with that GSTIN', 409);
      }
      throw err;
    }
  });
  await createAuditEntry('company_gst_registrations', id, ctx.userId, 'EDIT', undefined, updated, ctx.companyId);
  return updated;
}
