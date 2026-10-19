import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { AppError } from './error';
import { BranchAccess, tenantQuery } from '../shared/tenantContext';
import { isIssuedBeforePasswordChange } from '../modules/auth/auth.service';

export interface JwtPayload {
  userId: string;
  email: string;
  // Tenant claims (multi-tenant migration) — resolved once at login/refresh from the active
  // CompanyUser membership, never accepted from the client afterward. A pre-migration token
  // (issued before these claims existed) has none of these fields; authenticate() rejects it
  // rather than guessing a company, forcing a clean re-login instead of silently defaulting.
  companyId: string;
  companyUserId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  branchAccess: BranchAccess;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// While a temporary, administrator-issued password is outstanding the session may do exactly two things: read who it is
// and change the password. Enforced here (not just in the UI) so a direct API call gets nowhere either.
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = new Set(['POST /auth/change-password', 'GET /auth/me']);

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401);
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new AppError('Invalid or expired token', 401);
  }

  if (!payload.companyId || !payload.companyUserId) {
    throw new AppError('Token missing tenant context — please log in again', 401);
  }

  // Re-validate on every request (mirrors the pre-existing isActive re-check on User) — a
  // deactivated membership or user is rejected immediately, not just at next token refresh.
  // The lookup runs under the company the token CLAIMS, so row-level security applies: a token that
  // names one company but a membership of another finds nothing at all (and the explicit check below
  // would reject it anyway). Nothing here trusts the claim — it only chooses which company's rows to look in.
  const membership = await tenantQuery(payload.companyId, (_tx) => _tx.companyUser.findFirst({
    where: { id: payload.companyUserId, companyId: payload.companyId },
    include: { user: true, role: true, company: { select: { isActive: true } } },
  }));
  if (
    !membership || !membership.isActive || !membership.user.isActive || !membership.company.isActive ||
    membership.userId !== payload.userId || membership.companyId !== payload.companyId
  ) {
    throw new AppError('User not found or deactivated', 401);
  }
  // Signed out by a password change made after this token was issued.
  if (isIssuedBeforePasswordChange((payload as JwtPayload & { iat?: number }).iat, membership.user.passwordChangedAt)) {
    throw new AppError('Your password was changed — please sign in again', 401);
  }

  if (membership.user.mustChangePassword) {
    const route = `${req.method} ${req.originalUrl.split('?')[0].replace(/^\/api\/v\d+/, '').replace(/\/+$/, '')}`;
    if (!ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.has(route)) {
      throw new AppError('You must change your temporary password before continuing', 403, true, 'PASSWORD_CHANGE_REQUIRED');
    }
  }

  req.user = {
    userId: membership.userId,
    email: membership.user.email,
    companyId: membership.companyId,
    companyUserId: membership.id,
    roleId: membership.roleId,
    roleName: membership.role.name,
    permissions: membership.role.permissions,
    branchAccess: payload.branchAccess,
  };
  next();
}
// (An `optionalAuth` variant used to live here. It had no callers and, unlike authenticate(), it
// trusted the token's tenant claims without re-checking the CompanyUser membership — removed so
// nobody can reach for it by accident. Every authenticated route must go through authenticate().)
