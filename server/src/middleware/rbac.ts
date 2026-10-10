import { Request, Response, NextFunction } from 'express';
import { AppError } from './error';

export function requirePermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError('Authentication required', 401);

    const hasAll = permissions.every((p) => hasPermission(req.user!.permissions, p));

    if (!hasAll) {
      throw new AppError(
        `Access denied. Required: ${permissions.join(', ')}`,
        403
      );
    }
    next();
  };
}

/** Passes when the caller holds AT LEAST ONE of `permissions` (used when a route gained a more specific permission but must keep honouring the older one). */
export function requireAnyPermission(...permissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!permissions.some((p) => hasPermission(req.user!.permissions, p))) {
      throw new AppError(`Access denied. Required one of: ${permissions.join(', ')}`, 403);
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!roles.includes(req.user.roleName)) {
      throw new AppError(`Access denied. Role required: ${roles.join(' or ')}`, 403);
    }
    next();
  };
}

// J4 cleanup: the legacy `PERMISSIONS` const object (and its derived `Permission` type) that used to
// live here had zero usages anywhere in the repo — every requirePermission(...) call site already
// used raw string literals, and this object was stale relative to the live catalog (missing
// client:*/payment:*/return:*/invoice:void/invoice:edit, and listing a non-existent 'design:delete').
// The single source of truth for valid permission strings is shared/permissionCatalog.ts.

/** Returns true if `userPermissions` satisfies `permission`, using the same exact/resource-wildcard/'*' algorithm as requirePermission. */
export function hasPermission(userPermissions: string[], permission: string): boolean {
  const perms = new Set(userPermissions);
  return perms.has(permission) || perms.has('*') || perms.has(`${permission.split(':')[0]}:*`);
}
