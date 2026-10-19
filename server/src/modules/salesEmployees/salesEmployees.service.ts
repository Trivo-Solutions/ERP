import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { createAuditEntry } from '../../middleware/audit';
import { assertCanGrant } from '../../shared/grantGuard';
import { tenantQuery, tenantTransaction, runAsPlatform, TenantContext } from '../../shared/tenantContext';

// ═══════════════════════════════════════════════════════════════════════════
// Sales employees (Management > Sales Employees).
//
// No new employee table: a sales employee IS a CompanyUser (the person inside one company) on top of a global User
// (the login identity) - exactly what SalesInvoice.salesPersonId / TagEstimate.salesPersonId already reference. This
// module only adds a way to create one DIRECTLY (no invitation link) and to manage them.
//
// Provisioning: the User gets a random, server-generated TEMPORARY password, flagged mustChangePassword. It is returned
// once to the administrator, never stored in plaintext, never logged or audited, and authenticate() lets that session do
// nothing but change its password. The administrator can never read a password - only issue a new temporary one.
// ═══════════════════════════════════════════════════════════════════════════

const TEMP_PASSWORD_LENGTH = 16;
// No look-alike characters (0/O, 1/l/I) - the password is read out or written down once.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return out;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : (v?.trim() ? v.trim() : null));

// What a company may see about an employee - never the password hash, never User.lastLogin (platform-only).
const EMPLOYEE_SELECT = {
  id: true, employeeId: true, phone: true, designation: true, allBranches: true, isActive: true, lastLoginAt: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true, isActive: true, mustChangePassword: true } },
  role: { select: { id: true, name: true, displayName: true } },
  branchAccess: { select: { branchId: true, branch: { select: { id: true, name: true } } } },
} satisfies Prisma.CompanyUserSelect;

type EmployeeRow = Prisma.CompanyUserGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

function present(r: EmployeeRow) {
  return {
    id: r.id, userId: r.user.id, employeeId: r.employeeId, name: r.user.name, email: r.user.email, phone: r.phone,
    designation: r.designation, isActive: r.isActive, role: r.role, allBranches: r.allBranches,
    branches: r.branchAccess.map((b) => ({ id: b.branch.id, name: b.branch.name })),
    // Account status: ACTIVE (signed in at least once and not awaiting a first change), PASSWORD_CHANGE_PENDING
    // (a temporary password is outstanding) or DISABLED.
    accountStatus: !r.isActive || !r.user.isActive ? 'DISABLED' : r.user.mustChangePassword ? 'PASSWORD_CHANGE_PENDING' : 'ACTIVE',
    lastLoginAt: r.lastLoginAt, createdAt: r.createdAt,
  };
}

async function conflictFor(err: unknown, companyId: string, employeeId?: string | null, excludeId?: string) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  // Same rule as auth.service: never parse meta.target (RLS tables omit it) - ask inside THIS company only.
  if (employeeId) {
    const taken = await tenantQuery(companyId, (tx) => tx.companyUser.count({
      where: { companyId, employeeId, ...(excludeId && { id: { not: excludeId } }) },
    }));
    if (taken > 0) return new AppError('Employee code is already in use in this company', 409);
  }
  return new AppError('This employee could not be saved because of a duplicate', 409);
}

// A branch may be granted only if it is this company's own and still active. Checked before anything is written.
async function assertBranches(ctx: TenantContext, branchIds: string[]) {
  for (const id of branchIds) await assertOwnedByCompany('branch', id, ctx.companyId, 'Branch');
  if (branchIds.length === 0) return;
  const active = await tenantQuery(ctx.companyId, (tx) => tx.branch.count({ where: { companyId: ctx.companyId, id: { in: branchIds }, isActive: true } }));
  if (active !== branchIds.length) throw new AppError('A selected branch is inactive', 400);
}

// Branch scope. A caller restricted to some branches (branchAccess.allBranches === false, same rule as listTags / getStockBook)
// may only give access to those branches - never "all branches" - and may only manage an employee whose whole reach lies
// inside their own. Company-wide callers are unaffected. (Role escalation below is the same idea for permissions.)
function assertBranchGrantInScope(ctx: TenantContext, allBranches: boolean, branchIds: string[]) {
  if (ctx.branchAccess.allBranches) return;
  const mine = new Set(ctx.branchAccess.branchIds);
  if (allBranches || branchIds.some((id) => !mine.has(id))) {
    throw new AppError('You can only give access to branches you have access to yourself', 403);
  }
}
function assertTargetInScope(ctx: TenantContext, target: { allBranches: boolean; branchAccess: Array<{ branchId: string }> }) {
  if (ctx.branchAccess.allBranches) return;
  const mine = new Set(ctx.branchAccess.branchIds);
  if (target.allBranches || target.branchAccess.length === 0 || target.branchAccess.some((b) => !mine.has(b.branchId))) {
    throw new AppError('This employee has access outside your branches, so you cannot change them', 403);
  }
}

// The role being handed out must be this company's and held in full by the caller (no escalation); the TARGET's current
// role is held to the same bar, so a manager cannot edit, disable or re-password someone more privileged than themselves.
async function assertCanAssign(ctx: TenantContext, roleId: string) {
  await assertOwnedByCompany('role', roleId, ctx.companyId, 'Role');
  const role = await tenantQuery(ctx.companyId, (tx) => tx.role.findFirstOrThrow({ where: { id: roleId, companyId: ctx.companyId }, select: { permissions: true } }));
  assertCanGrant(ctx.permissions, role.permissions);
}

async function loadEmployee(ctx: TenantContext, id: string) {
  const row = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findFirst({
    where: { id, companyId: ctx.companyId, isSalesEmployee: true },
    select: { ...EMPLOYEE_SELECT, role: { select: { id: true, name: true, displayName: true, permissions: true } } },
  }));
  if (!row) throw new AppError('Sales employee not found', 404);
  return row;
}

export async function listSalesEmployees(ctx: TenantContext, q: { search?: string; status?: 'active' | 'inactive' | 'all' } = {}) {
  const search = q.search?.trim();
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: {
      companyId: ctx.companyId, isSalesEmployee: true,
      // A branch-restricted caller sees employees who work at their branches (or company-wide); never one confined elsewhere.
      ...(q.status === 'active' && { isActive: true }),
      ...(q.status === 'inactive' && { isActive: false }),
      // Two independent OR groups, so they are ANDed (one object key would let the second overwrite the first).
      AND: [
        ...(!ctx.branchAccess.allBranches
          ? [{ OR: [{ allBranches: true }, { branchAccess: { some: { branchId: { in: ctx.branchAccess.branchIds } } } }] }]
          : []),
        ...(search ? [{ OR: [
          { employeeId: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
          { designation: { contains: search, mode: 'insensitive' as const } },
          { user: { name: { contains: search, mode: 'insensitive' as const } } },
          { user: { email: { contains: search, mode: 'insensitive' as const } } },
        ] }] : []),
      ],
    },
    select: EMPLOYEE_SELECT, orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  }));
  return rows.map(present);
}

export interface CreateSalesEmployeeInput {
  name: string; email: string; employeeId?: string | null; phone?: string | null; designation?: string | null;
  roleId: string; allBranches?: boolean; branchIds?: string[];
}

export async function createSalesEmployee(ctx: TenantContext, data: CreateSalesEmployeeInput) {
  const email = data.email.trim().toLowerCase();
  const allBranches = data.allBranches ?? false;
  const branchIds = allBranches ? [] : [...new Set(data.branchIds ?? [])];
  const employeeId = blankToNull(data.employeeId) ?? null;

  await assertCanAssign(ctx, data.roleId);
  await assertBranches(ctx, branchIds);
  assertBranchGrantInScope(ctx, allBranches, branchIds);

  // A login that already exists ANYWHERE on the platform is never attached silently (CLAUDE.md section 11, phase 2): that
  // person must be invited and prove ownership with their own password. The answer is the same whether the email is
  // taken in this company or another, so it cannot be used to discover who has an account elsewhere.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError('This email cannot be used to create a new employee. If the person already has a TRIVO login, invite them from Users instead.', 409);
  }
  if (employeeId) {
    const clash = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.count({ where: { companyId: ctx.companyId, employeeId } }));
    if (clash > 0) throw new AppError('Employee code is already in use in this company', 409);
  }

  const temporaryPassword = generateTemporaryPassword();
  const hash = await bcrypt.hash(temporaryPassword, 12);

  let created: { id: string };
  try {
    // One transaction: the login, the membership and the branch grants exist together or not at all.
    created = await tenantTransaction(ctx.companyId, async (tx) => {
      const user = await tx.user.create({ data: { email, name: data.name.trim(), password: hash, mustChangePassword: true } });
      const membership = await tx.companyUser.create({
        data: {
          companyId: ctx.companyId, userId: user.id, roleId: data.roleId, allBranches, isSalesEmployee: true,
          employeeId, phone: blankToNull(data.phone) ?? null, designation: blankToNull(data.designation) ?? null,
        },
      });
      if (branchIds.length > 0) {
        await tx.userBranchAccess.createMany({ data: branchIds.map((branchId) => ({ companyId: ctx.companyId, companyUserId: membership.id, branchId })) });
      }
      return membership;
    });
  } catch (err) {
    // The transaction has rolled back: no orphan login, membership or grant. A concurrent create of the same email loses on
    // the global unique constraint; a clash on the employee code is reported as that. Anything else is not ours to hide.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const codeClash = employeeId ? await conflictFor(err, ctx.companyId, employeeId) : null;
      if (codeClash && codeClash.message.startsWith('Employee code')) throw codeClash;
      throw new AppError('This email cannot be used to create a new employee. If the person already has a TRIVO login, invite them from Users instead.', 409);
    }
    throw err;
  }

  // Never the password: only who/what/where.
  await createAuditEntry('company_users', created.id, ctx.userId, 'CREATE', undefined,
    { kind: 'SALES_EMPLOYEE', email, employeeId, roleId: data.roleId, allBranches, branchIds, designation: blankToNull(data.designation) ?? null }, ctx.companyId);

  const employee = present((await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findFirstOrThrow({ where: { id: created.id, companyId: ctx.companyId }, select: EMPLOYEE_SELECT }))));
  // Returned exactly once; there is no endpoint that can return it again.
  return { employee, temporaryPassword };
}

export interface UpdateSalesEmployeeInput {
  name?: string; employeeId?: string | null; phone?: string | null; designation?: string | null; roleId?: string;
  allBranches?: boolean; branchIds?: string[]; isActive?: boolean;
}

export async function updateSalesEmployee(ctx: TenantContext, id: string, data: UpdateSalesEmployeeInput) {
  const before = await loadEmployee(ctx, id);
  assertCanGrant(ctx.permissions, before.role.permissions); // cannot touch someone more privileged than yourself
  assertTargetInScope(ctx, before); // ...nor someone whose reach is outside your own branches
  if (data.roleId && data.roleId !== before.role.id) await assertCanAssign(ctx, data.roleId);
  if (data.isActive === false && id === ctx.companyUserId) throw new AppError('You cannot deactivate your own account', 400);
  const branchIds = data.branchIds === undefined ? undefined : [...new Set(data.branchIds)];
  if (branchIds) await assertBranches(ctx, branchIds);
  if (branchIds !== undefined || data.allBranches !== undefined) {
    // The branch reach this edit would leave behind must also be inside the caller's own scope.
    assertBranchGrantInScope(ctx, data.allBranches ?? before.allBranches, branchIds ?? before.branchAccess.map((b) => b.branchId));
  }

  const employeeId = data.employeeId === undefined ? undefined : blankToNull(data.employeeId);
  try {
    await tenantTransaction(ctx.companyId, async (tx) => {
      if (data.name !== undefined) {
        // The name lives on the GLOBAL login. Only change it when this company is the person's only one - otherwise a
        // company administrator would be renaming that person in every other company too.
        const memberships = await runAsPlatform((p) => p.companyUser.count({ where: { userId: before.user.id } }));
        if (memberships > 1) throw new AppError('This person also belongs to another company - their name can only be changed by them', 409);
        await tx.user.update({ where: { id: before.user.id }, data: { name: data.name.trim() } });
      }
      await tx.companyUser.update({
        where: { id },
        data: {
          ...(employeeId !== undefined && { employeeId }),
          ...(data.phone !== undefined && { phone: blankToNull(data.phone) }),
          ...(data.designation !== undefined && { designation: blankToNull(data.designation) }),
          ...(data.roleId !== undefined && { roleId: data.roleId }),
          ...(data.allBranches !== undefined && { allBranches: data.allBranches }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });
      // The branch list is replaced as a whole inside the same transaction as everything else above.
      if (branchIds !== undefined || data.allBranches === true) {
        await tx.userBranchAccess.deleteMany({ where: { companyId: ctx.companyId, companyUserId: id } });
        if (data.allBranches !== true && branchIds && branchIds.length > 0) {
          await tx.userBranchAccess.createMany({ data: branchIds.map((branchId) => ({ companyId: ctx.companyId, companyUserId: id, branchId })) });
        }
      }
    });
  } catch (err) {
    throw (await conflictFor(err, ctx.companyId, employeeId ?? undefined, id)) ?? err;
  }

  const after = await loadEmployee(ctx, id);
  const action = data.isActive === undefined || data.isActive === before.isActive ? 'EDIT' : data.isActive ? 'REACTIVATE' : 'DEACTIVATE';
  const snap = (e: typeof before) => ({
    name: e.user.name, employeeId: e.employeeId, phone: e.phone, designation: e.designation, roleId: e.role.id,
    allBranches: e.allBranches, branchIds: e.branchAccess.map((b) => b.branchId).sort(), isActive: e.isActive,
  });
  await createAuditEntry('company_users', id, ctx.userId, action, snap(before), snap(after), ctx.companyId);
  const { permissions: _drop, ...role } = after.role;
  return present({ ...after, role });
}

// Issues a NEW temporary password (the old one is not retrievable and is replaced). The person is signed out everywhere and
// must choose their own password at next sign-in. Refused for yourself and for a person who also belongs to another
// company - their one global password is theirs alone to change.
export async function issueTemporaryPassword(ctx: TenantContext, id: string) {
  const target = await loadEmployee(ctx, id);
  assertCanGrant(ctx.permissions, target.role.permissions);
  assertTargetInScope(ctx, target);
  if (id === ctx.companyUserId) throw new AppError('Use Change Password to change your own password', 400);
  const memberships = await runAsPlatform((p) => p.companyUser.count({ where: { userId: target.user.id } }));
  if (memberships > 1) throw new AppError('This person also belongs to another company and has one shared password - they must change it themselves', 409);

  const temporaryPassword = generateTemporaryPassword();
  const hash = await bcrypt.hash(temporaryPassword, 12);
  await runAsPlatform((p) => p.user.update({
    where: { id: target.user.id },
    data: { password: hash, mustChangePassword: true, passwordChangedAt: new Date(Math.floor(Date.now() / 1000) * 1000) },
  }));
  await createAuditEntry('company_users', id, ctx.userId, 'PASSWORD_RESET', undefined, { temporary: true }, ctx.companyId);
  return { temporaryPassword };
}

// ─── Existing company members ────────────────────────────────────────────────
// Marking only flips CompanyUser.isSalesEmployee on a membership that already exists in THIS company - it never creates a
// User or a CompanyUser, so a person can never end up with two accounts. Unmarking likewise leaves the login, role and
// branch access exactly as they were.

export async function listMarkableMembers(ctx: TenantContext) {
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findMany({
    where: { companyId: ctx.companyId, isSalesEmployee: false, isActive: true, user: { isActive: true } },
    select: {
      id: true, employeeId: true, allBranches: true, branchAccess: { select: { branchId: true } },
      user: { select: { name: true, email: true } }, role: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  }));
  // A branch-restricted caller is only offered members they could actually take charge of.
  const inScope = (r: (typeof rows)[number]) => { try { assertTargetInScope(ctx, r); return true; } catch { return false; } };
  return rows.filter(inScope).map((r) => ({ id: r.id, name: r.user.name, email: r.user.email, employeeId: r.employeeId, role: r.role.displayName }));
}

export async function markExistingMemberAsSalesEmployee(ctx: TenantContext, companyUserId: string, designation?: string | null) {
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'Member');
  const target = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findFirstOrThrow({
    where: { id: companyUserId, companyId: ctx.companyId },
    select: { isSalesEmployee: true, isActive: true, designation: true, allBranches: true, branchAccess: { select: { branchId: true } }, role: { select: { permissions: true } } },
  }));
  // Same bar as editing: you cannot take charge of someone more privileged than yourself, or outside your branches.
  assertCanGrant(ctx.permissions, target.role.permissions);
  assertTargetInScope(ctx, target);
  const dn = blankToNull(designation);
  // Count-checked conditional write: two concurrent marks cannot both "win".
  const flipped = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.updateMany({
    where: { id: companyUserId, companyId: ctx.companyId, isSalesEmployee: false },
    data: { isSalesEmployee: true, ...(dn !== undefined && dn !== null && { designation: dn }) },
  }));
  if (flipped.count !== 1) throw new AppError('This member is already a sales employee', 409);
  await createAuditEntry('company_users', companyUserId, ctx.userId, 'SALES_EMPLOYEE_MARK',
    { isSalesEmployee: false }, { isSalesEmployee: true, designation: dn ?? target.designation }, ctx.companyId);
  return present(await tenantQuery(ctx.companyId, (tx) => tx.companyUser.findFirstOrThrow({ where: { id: companyUserId, companyId: ctx.companyId }, select: EMPLOYEE_SELECT })));
}

export async function unmarkSalesEmployee(ctx: TenantContext, companyUserId: string) {
  const before = await loadEmployee(ctx, companyUserId);
  assertCanGrant(ctx.permissions, before.role.permissions);
  assertTargetInScope(ctx, before);
  const flipped = await tenantQuery(ctx.companyId, (tx) => tx.companyUser.updateMany({
    where: { id: companyUserId, companyId: ctx.companyId, isSalesEmployee: true }, data: { isSalesEmployee: false },
  }));
  if (flipped.count !== 1) throw new AppError('Sales employee not found', 404);
  await createAuditEntry('company_users', companyUserId, ctx.userId, 'SALES_EMPLOYEE_UNMARK',
    { isSalesEmployee: true }, { isSalesEmployee: false }, ctx.companyId);
  return { id: companyUserId, isSalesEmployee: false };
}
