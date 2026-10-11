import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { AppError } from '../../middleware/error';
import type { JwtPayload } from '../../middleware/auth';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { assertCanGrant } from '../../shared/grantGuard';
import { createAuditEntry } from '../../middleware/audit';
import { newInvitationToken, parseInvitationToken, hashInvitationToken } from './invitationToken';
import { tenantQuery, tenantTransaction, runAsPlatform } from '../../shared/tenantContext';
import type { BranchAccess, TenantContext } from '../../shared/tenantContext';

// ═══════════════════════════════════════════════════════════════════════════
// Identity model (Phase 2 of company isolation):
//
//   User        = global LOGIN identity: email, password hash, display name. Nothing about the
//                 person's role in any company.
//   CompanyUser = the person's identity INSIDE one company: employee id, department, phone,
//                 username, role, branch access, last login there.
//
// A membership is only ever created by an EXPLICIT act — the seed, or an invitation the recipient
// accepts. Nothing attaches an existing User to a company because someone typed their email.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveBranchAccess(companyUserId: string, companyId: string, allBranches: boolean): Promise<BranchAccess> {
  if (allBranches) {
    const branches = await tenantQuery(companyId, (_tx) => _tx.branch.findMany({ where: { companyId, isActive: true }, select: { id: true } }));
    return { allBranches: true, branchIds: branches.map((b) => b.id) };
  }
  const grants = await tenantQuery(companyId, (_tx) => _tx.userBranchAccess.findMany({
    // companyId is pinned directly AND through the branch: a grant is only honoured if it belongs
    // to this company on both sides (the composite FKs already make anything else unstorable).
    where: { companyUserId, companyId, branch: { companyId } },
    select: { branchId: true },
  }));
  return { allBranches: false, branchIds: grants.map((g) => g.branchId) };
}

function issueTokens(membership: {
  id: string; userId: string; companyId: string; roleId: string; allBranches: boolean;
  role: { name: string; permissions: string[] };
  user: { email: string };
}, branchAccess: BranchAccess, issuedAt?: number) {
  const payload: JwtPayload = {
    userId: membership.userId,
    email: membership.user.email,
    companyId: membership.companyId,
    companyUserId: membership.id,
    roleId: membership.roleId,
    roleName: membership.role.name,
    permissions: membership.role.permissions,
    branchAccess,
  };
  // issuedAt (seconds) is only passed right after a password change — see changePassword.
  const iat = issuedAt === undefined ? {} : { iat: issuedAt };
  const accessToken = jwt.sign({ ...payload, ...iat }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
  const refreshToken = jwt.sign(
    { userId: membership.userId, companyUserId: membership.id, companyId: membership.companyId, ...iat },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any }
  );
  return { accessToken, refreshToken, payload };
}

// A bcrypt hash to compare against when no membership matched, so "no such member" and "wrong
// password" cost the same time — otherwise response timing would reveal which identifiers are
// members of a company. Computed once, lazily.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  return (dummyHash ??= bcrypt.hash('trivo-timing-equaliser', 12));
}

// Company Code + Username/Email + Password. The company code SELECTS which company to sign in to;
// it grants nothing by itself — the caller must also be an active member of THAT company and know
// the password. Company is resolved FIRST, and everything downstream (which CompanyUser, which
// role, which branches) is looked up inside that company's membership scope, never globally — so a
// login for Company A can never resolve to a Company B membership, even for a person who belongs to
// both. From here on the company comes ONLY from the signed token (a client-supplied companyId is
// rejected outright by rejectClientTenantSelectors). `identifier` may be an email (looked up on the
// global User, then required to have a membership in the resolved company) or a company-scoped
// username (looked up directly on CompanyUser).
export async function login(companyCode: string, identifier: string, password: string) {
  const company = await prisma.company.findUnique({ where: { code: companyCode.toUpperCase() } });

  const isEmail = identifier.includes('@');
  const membership = company && company.isActive
    ? await tenantQuery(company.id, (tx) => isEmail
        ? tx.companyUser.findFirst({
            where: { companyId: company.id, user: { email: identifier.toLowerCase() } },
            include: { user: true, role: true },
          })
        : tx.companyUser.findUnique({
            where: { companyId_username: { companyId: company.id, username: identifier } },
            include: { user: true, role: true },
          }))
    : null;

  const usable = !!membership && membership.isActive && membership.user.isActive;
  // Always spend one bcrypt comparison, whether or not a usable membership was found.
  const valid = await bcrypt.compare(password, usable ? membership!.user.password : await getDummyHash());
  if (!usable || !valid || !company) throw new AppError('Invalid credentials', 401);

  const now = new Date();
  await tenantQuery(company.id, (tx) => tx.companyUser.update({ where: { id: membership!.id }, data: { lastLoginAt: now } }));
  await prisma.user.update({ where: { id: membership!.userId }, data: { lastLogin: now } }); // global identity: a platform table

  const branchAccess = await resolveBranchAccess(membership!.id, company.id, membership!.allBranches);
  const { accessToken, refreshToken } = issueTokens(membership!, branchAccess);

  return {
    accessToken,
    refreshToken,
    company: { id: company.id, code: company.code, name: company.name },
    user: {
      id: membership!.userId,
      email: membership!.user.email,
      name: membership!.user.name,
      role: membership!.role.name,
      permissions: membership!.role.permissions,
      companyUserId: membership!.id,
      branchAccess,
    },
  };
}

export async function refreshTokens(refreshToken: string) {
  let payload: { userId: string; companyUserId: string; companyId?: string; iat?: number };
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as typeof payload;
  } catch {
    throw new AppError('Invalid refresh token', 401);
  }
  // A refresh token issued before it carried its company cannot be looked up under row-level security
  // (there is no company to bind the query to) — refuse it; the user simply signs in again.
  if (!payload.companyId) throw new AppError('Invalid refresh token', 401);

  const membership = await tenantQuery(payload.companyId, (tx) => tx.companyUser.findFirst({
    where: { id: payload.companyUserId, companyId: payload.companyId },
    include: { user: true, role: true, company: { select: { isActive: true } } },
  }));
  if (!membership || membership.userId !== payload.userId || !membership.isActive || !membership.user.isActive || !membership.company.isActive) {
    throw new AppError('Invalid refresh token', 401);
  }
  if (isIssuedBeforePasswordChange(payload.iat, membership.user.passwordChangedAt)) throw new AppError('Invalid refresh token', 401);

  const branchAccess = await resolveBranchAccess(membership.id, membership.companyId, membership.allBranches);
  const { accessToken } = issueTokens(membership, branchAccess);
  return { accessToken };
}

// The password belongs to the GLOBAL login identity, so a person who is a member of several
// companies has one password for all of them. (Per-company passwords would be a different model.)
// A token (access or refresh) issued at or before the second of the user's last password change is dead. passwordChangedAt
// is stored truncated to the second; the caller's replacement tokens are minted one second later, so they outlive the cut-off.
export function isIssuedBeforePasswordChange(iat: number | undefined, passwordChangedAt: Date | null | undefined): boolean {
  if (!passwordChangedAt) return false;
  return (iat ?? 0) <= Math.floor(passwordChangedAt.getTime() / 1000);
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

// Policy for a password the person chooses for themselves. Deliberately simple and explainable (length is what matters);
// refuses the obvious: reuse of the current one, or the account's own e-mail/name.
export function assertAcceptablePassword(next: unknown, ctx: { current: string; email: string; name: string }): asserts next is string {
  if (typeof next !== 'string') throw new AppError('A new password is required', 400);
  if (next.length < MIN_PASSWORD_LENGTH) throw new AppError(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  if (next.length > MAX_PASSWORD_LENGTH) throw new AppError(`The new password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  if (next === ctx.current) throw new AppError('The new password must be different from the current one', 400);
  const lower = next.toLowerCase();
  if (lower.includes(ctx.email.toLowerCase()) || (ctx.name.trim().length >= 4 && lower.includes(ctx.name.trim().toLowerCase()))) {
    throw new AppError('The new password must not contain your e-mail or name', 400);
  }
  if (new Set(next).size < 5) throw new AppError('The new password is too repetitive', 400);
}

// The password belongs to the GLOBAL login identity, so a person who is a member of several
// companies has one password for all of them. (Per-company passwords would be a different model.)
// On success every previously issued token (this and any other device, any company) is revoked, and the CALLER gets
// fresh tokens for the company they are signed in to, so their own session carries on.
export async function changePassword(actor: { userId: string; companyId: string; companyUserId: string }, current: unknown, next: unknown) {
  if (typeof current !== 'string' || current.length === 0) throw new AppError('The current password is required', 400);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  const valid = await bcrypt.compare(current, user.password);
  if (!valid) throw new AppError('Current password incorrect', 400);
  assertAcceptablePassword(next, { current, email: user.email, name: user.name });
  const hashed = await bcrypt.hash(next, 12);
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await prisma.user.update({ where: { id: actor.userId }, data: { password: hashed, passwordChangedAt: changedAt } });

  const membership = await tenantQuery(actor.companyId, (tx) => tx.companyUser.findFirstOrThrow({
    where: { id: actor.companyUserId, companyId: actor.companyId },
    include: { user: true, role: true },
  }));
  await createAuditEntry('users', actor.userId, actor.userId, 'PASSWORD_CHANGE', undefined, { changed: true }, actor.companyId);
  const branchAccess = await resolveBranchAccess(membership.id, membership.companyId, membership.allBranches);
  const { accessToken, refreshToken } = issueTokens(membership, branchAccess, Math.floor(changedAt.getTime() / 1000) + 1);
  return { accessToken, refreshToken };
}

// ─── Memberships (a person inside ONE company) ────────────────────────────────

// Exactly what a company may see about a member: the company's OWN facts (employee id, department,
// phone, username, role, branch flag, last login here) plus the identity basics (email, name).
// Never the password hash, never User.lastLogin (which would reveal activity in other companies).
const MEMBER_SELECT = {
  id: true, username: true, employeeId: true, department: true, phone: true,
  allBranches: true, isActive: true, isDefault: true, createdAt: true, lastLoginAt: true,
  user: { select: { id: true, email: true, name: true } },
  role: { select: { id: true, name: true, displayName: true } },
} satisfies Prisma.CompanyUserSelect;

// Company-scoped — only this company's memberships, never a global User scan.
export async function listCompanyUsers(companyId: string) {
  return tenantQuery(companyId, (tx) =>
    tx.companyUser.findMany({ where: { companyId }, select: MEMBER_SELECT, orderBy: { createdAt: 'desc' } })
  );
}

export async function getMyMembership(companyId: string, companyUserId: string) {
  return tenantQuery(companyId, (tx) =>
    tx.companyUser.findFirst({ where: { id: companyUserId, companyId }, select: MEMBER_SELECT })
  );
}

// Maps a unique-constraint violation on a membership/invitation to a message that only ever talks
// about THIS company. (employeeId and username are unique per company, so a collision can only be
// with someone in the caller's own company — there is nothing about any other company to reveal.)
async function membershipConflict(
  err: unknown,
  ctx: { companyId: string; employeeId?: string | null; username?: string | null; excludeId?: string },
): Promise<AppError | null> {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  // Do NOT parse the error for the conflicting field: on a table protected by row-level security Postgres
  // deliberately omits the key details from a unique-violation (so an error can never leak row values), and
  // Prisma then reports target: null. Instead ask, inside THIS company only, which value is taken.
  const taken = async (where: Prisma.CompanyUserWhereInput) =>
    (await tenantQuery(ctx.companyId, (tx) => tx.companyUser.count({
      where: { companyId: ctx.companyId, ...(ctx.excludeId && { id: { not: ctx.excludeId } }), ...where },
    }))) > 0;
  if (ctx.employeeId && (await taken({ employeeId: ctx.employeeId }))) return new AppError('Employee ID is already in use in this company', 409);
  if (ctx.username && (await taken({ username: ctx.username }))) return new AppError('Username is already in use in this company', 409);
  return new AppError('This person is already a member of this company', 409);
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : (v?.trim() ? v.trim() : null));

export async function updateCompanyUser(
  ctx: TenantContext,
  companyUserId: string,
  data: {
    employeeId?: string | null; department?: string | null; phone?: string | null; username?: string | null;
    roleId?: string; allBranches?: boolean; isActive?: boolean;
  },
) {
  // Layer 2: the membership being edited, and any role it is moved to, must be this company's own.
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'User');
  if (data.roleId) {
    await assertOwnedByCompany('role', data.roleId, ctx.companyId, 'Role');
    await assertCanAssignRole(ctx, data.roleId);
  }
  if (data.isActive === false && companyUserId === ctx.companyUserId) {
    throw new AppError('You cannot deactivate your own account', 400);
  }

  try {
    return await tenantQuery(ctx.companyId, (tx) =>
      tx.companyUser.update({
        where: { id: companyUserId },
        data: {
          ...(data.employeeId !== undefined && { employeeId: blankToNull(data.employeeId) }),
          ...(data.department !== undefined && { department: blankToNull(data.department) }),
          ...(data.phone !== undefined && { phone: blankToNull(data.phone) }),
          ...(data.username !== undefined && { username: blankToNull(data.username) }),
          ...(data.roleId !== undefined && { roleId: data.roleId }),
          ...(data.allBranches !== undefined && { allBranches: data.allBranches }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
        select: MEMBER_SELECT,
      })
    );
  } catch (err) {
    throw (await membershipConflict(err, {
      companyId: ctx.companyId, excludeId: companyUserId,
      employeeId: data.employeeId === undefined ? undefined : blankToNull(data.employeeId),
      username: data.username === undefined ? undefined : blankToNull(data.username),
    })) ?? err;
  }
}

// Admin password reset. The password lives on the GLOBAL User, so resetting it would also lock out /
// take over that person's logins in any OTHER company — a company admin must never be able to do
// that. Refused unless this company is the person's only membership (checked platform-side, since
// RLS hides other companies' rows from a tenant query). There is no email provider, so the admin
// types the new password and hands it over.
export async function resetMemberPassword(ctx: TenantContext, companyUserId: string, newPassword: string) {
  await assertOwnedByCompany('companyUser', companyUserId, ctx.companyId, 'User');
  if (companyUserId === ctx.companyUserId) {
    throw new AppError('Use Change Password to change your own password', 400);
  }
  const member = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyUser.findFirstOrThrow({ where: { id: companyUserId, companyId: ctx.companyId }, select: { userId: true } }));
  const memberships = await runAsPlatform((p) => p.companyUser.count({ where: { userId: member.userId } }));
  if (memberships > 1) {
    throw new AppError('This person also belongs to another company and has one shared password — they must change it themselves', 409);
  }
  const hashed = await bcrypt.hash(newPassword, 12);
  await runAsPlatform((p) => p.user.update({ where: { id: member.userId }, data: { password: hashed, passwordChangedAt: new Date(Math.floor(Date.now() / 1000) * 1000) } }));
  await createAuditEntry('company_users', companyUserId, ctx.userId, 'PASSWORD_RESET', undefined, { reset: true }, ctx.companyId);
}

// A role may only be handed to someone by a person who holds every permission it carries (see shared/grantGuard.ts).
async function assertCanAssignRole(ctx: TenantContext, roleId: string) {
  const role = await tenantQuery(ctx.companyId, (tx) => tx.role.findFirstOrThrow({ where: { id: roleId, companyId: ctx.companyId }, select: { permissions: true } }));
  assertCanGrant(ctx.permissions, role.permissions);
}

// ─── Invitations ──────────────────────────────────────────────────────────────
//
// Company A admin  ->  invite (email, role, branches, employee details)  ->  PENDING invitation
//   ->  recipient accepts with the one-time token  ->  existing global User linked OR a new User
//   created  ->  CompanyUser (+ branch grants) created.
//
// There is no email provider wired yet, so createInvitation returns the raw token ONCE for the admin
// to hand over (an email sender can deliver the same token later without changing anything else).
// Only the token's SHA-256 is stored.

const INVITATION_TTL_DAYS = 7;
const INVALID_INVITATION = 'Invalid or expired invitation';

export async function createInvitation(
  ctx: TenantContext,
  data: {
    email: string; roleId: string; allBranches?: boolean; branchIds?: string[];
    username?: string; employeeId?: string; department?: string; phone?: string;
  },
) {
  const email = data.email.trim().toLowerCase();
  const allBranches = data.allBranches ?? false;
  const branchIds = allBranches ? [] : [...new Set(data.branchIds ?? [])];

  // Layer 2: role and every branch named must be this company's own.
  await assertOwnedByCompany('role', data.roleId, ctx.companyId, 'Role');
  await assertCanAssignRole(ctx, data.roleId);
  for (const branchId of branchIds) await assertOwnedByCompany('branch', branchId, ctx.companyId, 'Branch');

  const employeeId = blankToNull(data.employeeId) ?? null;
  const username = blankToNull(data.username) ?? null;

  // Only THIS company's own data is consulted below. The global User table is deliberately never
  // looked at here, so the response is identical whether or not the email already has a login
  // somewhere on the platform — an admin cannot probe who is registered elsewhere.
  const existingMember = await tenantQuery(ctx.companyId, (_tx) => _tx.companyUser.findFirst({
    where: { companyId: ctx.companyId, user: { email } }, select: { id: true },
  }));
  if (existingMember) throw new AppError('This email already belongs to a member of your company', 409);
  if (employeeId) {
    const clash = await tenantQuery(ctx.companyId, (_tx) => _tx.companyUser.findFirst({ where: { companyId: ctx.companyId, employeeId }, select: { id: true } }));
    if (clash) throw new AppError('Employee ID is already in use in this company', 409);
  }
  if (username) {
    const clash = await tenantQuery(ctx.companyId, (_tx) => _tx.companyUser.findFirst({ where: { companyId: ctx.companyId, username }, select: { id: true } }));
    if (clash) throw new AppError('Username is already in use in this company', 409);
  }

  const { token, tokenHash } = newInvitationToken(ctx.companyId);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const invitation = await tenantTransaction(ctx.companyId, async (tx) => {
    // One live invitation per (company, email): a re-invite supersedes the earlier one.
    await tx.companyInvitation.updateMany({
      where: { companyId: ctx.companyId, email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    return tx.companyInvitation.create({
      data: {
        companyId: ctx.companyId, email, roleId: data.roleId, allBranches, branchIds,
        username, employeeId, department: blankToNull(data.department) ?? null, phone: blankToNull(data.phone) ?? null,
        tokenHash, expiresAt, invitedById: ctx.userId,
      },
    });
  });

  await createAuditEntry('company_invitations', invitation.id, ctx.userId, 'CREATE', undefined, { email, roleId: data.roleId }, ctx.companyId);

  // `token` is returned exactly once and is not retrievable afterwards.
  return {
    id: invitation.id, email, roleId: invitation.roleId, allBranches, branchIds,
    status: invitation.status, expiresAt: invitation.expiresAt, token,
  };
}

const INVITATION_SELECT = {
  id: true, email: true, roleId: true, allBranches: true, branchIds: true, username: true,
  employeeId: true, department: true, phone: true, status: true, expiresAt: true, createdAt: true, acceptedAt: true,
  role: { select: { id: true, name: true, displayName: true } },
} satisfies Prisma.CompanyInvitationSelect;

export async function listInvitations(companyId: string) {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.companyInvitation.findMany({ where: { companyId }, select: INVITATION_SELECT, orderBy: { createdAt: 'desc' } })
  );
  const now = Date.now();
  return rows.map((r) => ({ ...r, status: r.status === 'PENDING' && r.expiresAt.getTime() <= now ? 'EXPIRED' : r.status }));
}

export async function revokeInvitation(ctx: TenantContext, invitationId: string) {
  await assertOwnedByCompany('companyInvitation', invitationId, ctx.companyId, 'Invitation');
  const result = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyInvitation.updateMany({
      where: { id: invitationId, companyId: ctx.companyId, status: 'PENDING' },
      data: { status: 'REVOKED' },
    })
  );
  if (result.count !== 1) throw new AppError('Only a pending invitation can be revoked', 409);
  await createAuditEntry('company_invitations', invitationId, ctx.userId, 'REVOKE', undefined, undefined, ctx.companyId);
}

/**
 * PUBLIC (unauthenticated) — the recipient accepts with the one-time token.
 *
 * The caller always supplies a name and a password, whether or not they already have a login:
 *   - no login exists for the invited email  -> a new global User is created with them;
 *   - a login already exists                 -> the supplied password must match THAT login (proof
 *     the person owns it; `name` is ignored — the global name is not overwritten), and the existing
 *     User is linked to this company.
 * Every failure — unknown/expired/revoked/used token, wrong password for an existing login, inactive
 * user, a role/branch that has since disappeared — returns the SAME generic error, so this endpoint
 * never reveals whether an email already has an account. Both branches cost one bcrypt operation,
 * so timing doesn't either.
 *
 * Note: this is the one lookup made without a company context (the token is all the caller has). It
 * is a deliberate, narrow platform-level read of a single row by an unguessable token hash.
 */
export async function acceptInvitation(data: { token: string; name: string; password: string }) {
  const invalid = () => new AppError(INVALID_INVITATION, 400);

  // The token carries the company it belongs to (see invitationToken.ts), so the lookup runs under
  // THAT company's row-level security. A token naming the wrong company simply finds nothing.
  const claimed = parseInvitationToken(data.token);
  const invitation = claimed
    ? await tenantQuery(claimed.companyId, (tx) => tx.companyInvitation.findUnique({
        where: { tokenHash: hashInvitationToken(data.token) },
        include: { company: true },
      }))
    : null;
  if (!invitation || invitation.companyId !== claimed!.companyId || invitation.status !== 'PENDING' || invitation.expiresAt.getTime() <= Date.now() || !invitation.company.isActive) {
    // Same amount of hashing work as the real paths, so a bad token isn't distinguishable by time.
    await getDummyHash().then((h) => bcrypt.compare(data.password, h));
    throw invalid();
  }

  const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
  let newPasswordHash: string | undefined;
  if (existing) {
    if (!existing.isActive || !(await bcrypt.compare(data.password, existing.password))) throw invalid();
  } else {
    newPasswordHash = await bcrypt.hash(data.password, 12);
  }

  const companyId = invitation.companyId;
  let result: { companyUserId: string; userId: string; email: string; name: string };
  try {
    result = await tenantTransaction(companyId, async (tx) => {
      // Single-use, race-safe: only one concurrent accept can flip PENDING -> ACCEPTED.
      const flipped = await tx.companyInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (flipped.count !== 1) throw invalid();

      // Re-validate what the invitation staged — the company may have changed since it was issued.
      const role = await tx.role.findFirst({ where: { id: invitation.roleId, companyId } });
      if (!role) throw invalid();
      if (!invitation.allBranches && invitation.branchIds.length > 0) {
        const branches = await tx.branch.count({ where: { id: { in: invitation.branchIds }, companyId, isActive: true } });
        if (branches !== invitation.branchIds.length) throw invalid();
      }

      const user = existing ?? await tx.user.create({
        data: { email: invitation.email, name: data.name.trim(), password: newPasswordHash! },
      });

      const alreadyMember = await tx.companyUser.findUnique({ where: { companyId_userId: { companyId, userId: user.id } } });
      if (alreadyMember) throw new AppError('This person is already a member of this company', 409);

      const membership = await tx.companyUser.create({
        data: {
          companyId, userId: user.id, roleId: invitation.roleId, allBranches: invitation.allBranches,
          username: invitation.username, employeeId: invitation.employeeId,
          department: invitation.department, phone: invitation.phone,
        },
      });
      if (!invitation.allBranches && invitation.branchIds.length > 0) {
        await tx.userBranchAccess.createMany({
          data: invitation.branchIds.map((branchId) => ({ companyId, companyUserId: membership.id, branchId })),
        });
      }
      await tx.companyInvitation.update({ where: { id: invitation.id }, data: { acceptedCompanyUserId: membership.id } });

      return { companyUserId: membership.id, userId: user.id, email: user.email, name: user.name };
    });
  } catch (err) {
    // A conflict here (employee id / username taken since the invitation was issued) concerns only
    // this company's own directory.
    const conflict = await membershipConflict(err, { companyId, employeeId: invitation.employeeId, username: invitation.username });
    if (conflict) {
      throw new AppError('This invitation can no longer be accepted because a detail in it now conflicts with another member of the company. Ask your administrator to send a new invitation.', 409);
    }
    throw err;
  }

  await createAuditEntry('company_users', result.companyUserId, result.userId, 'INVITATION_ACCEPTED', undefined, { invitationId: invitation.id }, companyId);

  // The invitee learns the company they joined (they were invited to it) but is NOT signed in —
  // they log in normally with company code + email + password.
  return {
    company: { code: invitation.company.code, name: invitation.company.name },
    user: { id: result.userId, email: result.email, name: result.name },
    companyUserId: result.companyUserId,
  };
}
