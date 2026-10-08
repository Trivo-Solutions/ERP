import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, TenantContext } from '../../shared/tenantContext';
import { isValidPermissionList } from '../../shared/permissionCatalog';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';

// ─── Roles & permissions ───────────────────────────────────────────────────
// Role.permissions is still the same flat string[] it always was (see permissionCatalog.ts) — the
// Settings > Roles permission grid is a friendlier editor over that array, not a new model. Every
// requirePermission(...) check in every router keeps working unchanged.

export async function createRole(
  ctx: TenantContext,
  data: { name: string; displayName: string; permissions: string[] },
) {
  if (!isValidPermissionList(data.permissions)) {
    throw new AppError('One or more permissions are not recognised', 400);
  }
  try {
    const role = await tenantQuery(ctx.companyId, (tx) => tx.role.create({
      data: { companyId: ctx.companyId, name: data.name, displayName: data.displayName, permissions: data.permissions },
    }));
    await createAuditEntry('roles', role.id, ctx.userId, 'CREATE', undefined, { name: data.name, permissions: data.permissions }, ctx.companyId);
    return role;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('A role with this name already exists in your company', 409);
    }
    throw err;
  }
}

export async function updateRole(
  ctx: TenantContext,
  roleId: string,
  data: { displayName?: string; permissions?: string[] },
) {
  await assertOwnedByCompany('role', roleId, ctx.companyId, 'Role');

  const existing = await tenantQuery(ctx.companyId, (tx) => tx.role.findFirstOrThrow({ where: { id: roleId, companyId: ctx.companyId } }));
  // The '*' wildcard role is the platform's one guaranteed escape hatch into a company — refuse to
  // let it be narrowed by accident from this editor (a company still free to create its own
  // '*'-equivalent role on purpose, just not by editing this specific one).
  if (existing.name === 'SUPER_ADMIN' && data.permissions !== undefined) {
    throw new AppError('The Super Administrator role\'s permissions cannot be changed', 400);
  }
  if (data.permissions !== undefined && !isValidPermissionList(data.permissions)) {
    throw new AppError('One or more permissions are not recognised', 400);
  }

  try {
    const role = await tenantQuery(ctx.companyId, (tx) => tx.role.update({
      where: { id: roleId },
      data: {
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.permissions !== undefined && { permissions: data.permissions }),
      },
    }));
    await createAuditEntry('roles', roleId, ctx.userId, 'UPDATE', { permissions: existing.permissions }, { permissions: data.permissions }, ctx.companyId);
    return role;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('A role with this name already exists in your company', 409);
    }
    throw err;
  }
}

export async function deleteRole(ctx: TenantContext, roleId: string) {
  await assertOwnedByCompany('role', roleId, ctx.companyId, 'Role');
  const existing = await tenantQuery(ctx.companyId, (tx) => tx.role.findFirstOrThrow({ where: { id: roleId, companyId: ctx.companyId } }));
  if (existing.name === 'SUPER_ADMIN') {
    throw new AppError('The Super Administrator role cannot be deleted', 400);
  }
  try {
    await tenantQuery(ctx.companyId, (tx) => tx.role.delete({ where: { id: roleId } }));
  } catch (err) {
    // CompanyUser.roleId / CompanyInvitation.roleId have no onDelete override, so Postgres's
    // default NO ACTION already refuses this at the database level while anyone still holds the
    // role — this just turns that into a clear message instead of a raw FK-violation 500.
    if (isBlockedByForeignKey(err)) {
      throw new AppError('This role is still assigned to a member or a pending invitation — reassign them first', 409);
    }
    throw err;
  }
  await createAuditEntry('roles', roleId, ctx.userId, 'DELETE', { name: existing.name, displayName: existing.displayName }, undefined, ctx.companyId);
}

// Company-scoped key/value settings. Every read and write is pinned to the caller's own
// companyId (and runs through tenantQuery so the RLS session variable is set too) — one company's
// value for a key is invisible to, and independent of, every other company's.

export async function listConfigs(companyId: string) {
  return tenantQuery(companyId, (tx) =>
    tx.systemConfig.findMany({ where: { companyId }, orderBy: [{ category: 'asc' }, { key: 'asc' }] })
  );
}

export async function upsertConfig(companyId: string, key: string, value: string, category?: string) {
  // Photography settings are validated, merged and audited by their own endpoint; the generic key/value door must not bypass that.
  if (key.toLowerCase().startsWith('photography.')) throw new AppError('Photography settings are managed through /photography/settings', 400);
  return tenantQuery(companyId, (tx) =>
    tx.systemConfig.upsert({
      where: { companyId_key: { companyId, key } },
      create: { companyId, key, value, category: category ?? 'GENERAL' },
      update: { value },
    })
  );
}
