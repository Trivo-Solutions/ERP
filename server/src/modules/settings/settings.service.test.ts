import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, REAL_ROLE_SPLIT, rlsClient } from '../../test/fixtures';
import { listConfigs, upsertConfig, createRole, updateRole, deleteRole } from './settings.service';

// SystemConfig used to be one global table (`key @unique`) shared by every company. These prove
// it is now genuinely per-company — at the service layer, at the unique constraint, and at the
// Postgres RLS policy (same forced-RLS-inside-a-rolled-back-transaction technique as
// rls.phase3.test.ts, since the dev role owns the tables and is otherwise exempt from RLS).

describe('SystemConfig is company-scoped', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;
  const KEY = `TEST_MARGIN_${suffix}`;

  beforeAll(async () => {
    companyA = await createTestTenant(`CFGA${suffix}`, []);
    companyB = await createTestTenant(`CFGB${suffix}`, []);
  });

  afterAll(async () => {
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  it('the same key holds an independent value in each company', async () => {
    await upsertConfig(companyA.company.id, KEY, '10', 'PRICING');
    await upsertConfig(companyB.company.id, KEY, '99', 'PRICING');

    const a = (await listConfigs(companyA.company.id)).find((c) => c.key === KEY);
    const b = (await listConfigs(companyB.company.id)).find((c) => c.key === KEY);
    expect(a?.value).toBe('10');
    expect(b?.value).toBe('99');
  });

  it('updating a key in Company A does not change Company B', async () => {
    await upsertConfig(companyA.company.id, KEY, '25');

    const a = (await listConfigs(companyA.company.id)).find((c) => c.key === KEY);
    const b = (await listConfigs(companyB.company.id)).find((c) => c.key === KEY);
    expect(a?.value).toBe('25');
    expect(b?.value).toBe('99');
  });

  it('a company never sees another company\'s rows in its list', async () => {
    const onlyA = await listConfigs(companyA.company.id);
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((c) => c.companyId === companyA.company.id)).toBe(true);
  });

  it('upserting the same key twice in one company updates, not duplicates', async () => {
    await upsertConfig(companyA.company.id, KEY, '30');
    const rows = (await listConfigs(companyA.company.id)).filter((c) => c.key === KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('30');
  });

  it('the database itself rejects a duplicate (companyId, key)', async () => {
    await expect(
      prisma.systemConfig.create({ data: { companyId: companyA.company.id, key: KEY, value: 'dup', category: 'GENERAL' } })
    ).rejects.toThrow();
  });

  it('RLS: a session scoped to Company A cannot SELECT Company B\'s config row', async () => {
    const ROLLBACK = new Error('__deliberate_rollback__');
    let seen: string[] = [];
    try {
      await rlsClient.$transaction(async (tx) => {
        if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "system_configs" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
        const rows: any[] = await tx.$queryRaw`SELECT "companyId" FROM system_configs WHERE key = ${KEY}`;
        seen = rows.map((r) => r.companyId);
        throw ROLLBACK; // proof-only, never persisted
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    expect(seen).toEqual([companyA.company.id]);
  });
});

// The Role editor (Settings > Roles): a friendlier grid over the same Role.permissions string[]
// that requirePermission(...) has always read — createRole/updateRole are the only new surface,
// permission enforcement itself is untouched.
describe('Role editor (createRole / updateRole)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;

  beforeAll(async () => {
    companyA = await createTestTenant(`ROLA${suffix}`, ['role:view', 'role:create', 'role:edit', 'role:delete', 'sales:view', 'invoice:create', 'tag:view', 'tag:create']);
    companyB = await createTestTenant(`ROLB${suffix}`, ['role:view', 'role:create', 'role:edit', 'role:delete', 'sales:view', 'invoice:create', 'tag:view', 'tag:create']);
  });

  afterAll(async () => {
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  it('creates a role scoped to the caller\'s own company with only catalog permissions', async () => {
    const role = await createRole(companyA.ctx, {
      name: `CASHIER_${suffix}`, displayName: 'Cashier', permissions: ['sales:view', 'invoice:create'],
    });
    expect(role.companyId).toBe(companyA.company.id);
    expect(role.permissions.sort()).toEqual(['invoice:create', 'sales:view']);
  });

  it('rejects a permission string that is not in the catalog', async () => {
    await expect(createRole(companyA.ctx, {
      name: `BOGUS_${suffix}`, displayName: 'Bogus', permissions: ['not:a:real:permission'],
    })).rejects.toThrow(/not recognised/);
  });

  it('updateRole refuses a roleId belonging to another company (404)', async () => {
    const roleB = await createRole(companyB.ctx, { name: `OTHERCO_${suffix}`, displayName: 'Other Co', permissions: [] });
    await expect(updateRole(companyA.ctx, roleB.id, { permissions: ['sales:view'] })).rejects.toMatchObject({ statusCode: 404 });
    const stillB = await prisma.role.findUniqueOrThrow({ where: { id: roleB.id } });
    expect(stillB.permissions).toEqual([]);
  });

  it('updateRole changes only the fields given, and only within the caller\'s own company', async () => {
    const role = await createRole(companyA.ctx, { name: `EDITABLE_${suffix}`, displayName: 'Editable', permissions: ['tag:view'] });
    const updated = await updateRole(companyA.ctx, role.id, { permissions: ['tag:view', 'tag:create'] });
    expect(updated.permissions.sort()).toEqual(['tag:create', 'tag:view']);
    expect(updated.displayName).toBe('Editable'); // untouched
  });

  it('the Super Administrator role\'s permissions cannot be edited from here', async () => {
    const superAdmin = await prisma.role.upsert({
      where: { companyId_name: { companyId: companyA.company.id, name: 'SUPER_ADMIN' } },
      create: { companyId: companyA.company.id, name: 'SUPER_ADMIN', displayName: 'Super Administrator', permissions: ['*'] },
      update: {},
    });
    await expect(updateRole(companyA.ctx, superAdmin.id, { permissions: ['sales:view'] })).rejects.toThrow(/Super Administrator/);
  });

  it('deleteRole refuses a roleId belonging to another company (404), and it still exists', async () => {
    const roleB = await createRole(companyB.ctx, { name: `KEEPME_${suffix}`, displayName: 'Keep Me', permissions: [] });
    await expect(deleteRole(companyA.ctx, roleB.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await prisma.role.findUnique({ where: { id: roleB.id } })).not.toBeNull();
  });

  it('the Super Administrator role cannot be deleted', async () => {
    const superAdmin = await prisma.role.findFirstOrThrow({ where: { companyId: companyA.company.id, name: 'SUPER_ADMIN' } });
    await expect(deleteRole(companyA.ctx, superAdmin.id)).rejects.toThrow(/Super Administrator/);
  });

  it('refuses to delete a role still held by a member', async () => {
    const role = await createRole(companyA.ctx, { name: `HELD_${suffix}`, displayName: 'Held', permissions: ['tag:view'] });
    await prisma.companyUser.update({ where: { id: companyA.companyUser.id }, data: { roleId: role.id } });
    await expect(deleteRole(companyA.ctx, role.id)).rejects.toThrow(/still assigned/);
    // Put the fixture's own membership back on its original role so later tests in this describe (which reuse companyA.ctx) aren't affected.
    await prisma.companyUser.update({ where: { id: companyA.companyUser.id }, data: { roleId: companyA.role.id } });
  });

  it('refuses to delete a role still named on a pending invitation', async () => {
    const role = await createRole(companyA.ctx, { name: `INVITED_${suffix}`, displayName: 'Invited', permissions: ['tag:view'] });
    await prisma.companyInvitation.create({
      data: {
        companyId: companyA.company.id, email: `pending-${suffix}@example.com`, roleId: role.id,
        tokenHash: `hash-${suffix}`, expiresAt: new Date(Date.now() + 86_400_000), invitedById: companyA.user.id,
      },
    });
    await expect(deleteRole(companyA.ctx, role.id)).rejects.toThrow(/still assigned/);
  });

  it('deletes an unused role, and audits it', async () => {
    const role = await createRole(companyA.ctx, { name: `UNUSED_${suffix}`, displayName: 'Unused', permissions: ['tag:view'] });
    await deleteRole(companyA.ctx, role.id);
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { tableName: 'roles', recordId: role.id, action: 'DELETE' } });
    expect(audit).not.toBeNull();
  });
});
