import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, TenantContext } from '../../shared/tenantContext';

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
