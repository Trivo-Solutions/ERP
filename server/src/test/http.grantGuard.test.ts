import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// Privilege-escalation guard: a role/user manager can hand out only the authority they hold themselves.

const DOMAIN = '@grantguard.example.com';
const PASSWORD = 'Guard-Passw0rd-123456';

describe('role/user managers cannot grant more than they hold', () => {
  const created: string[] = [];
  let admin: ReturnType<typeof apiWith>; let staff: ReturnType<typeof apiWith>;
  let code = ''; let managerRoleId = ''; let superRoleId = '';

  beforeAll(async () => {
    code = uniqueCompanyCode('GG');
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: 'Grant Guard', admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    admin = apiWith(login.body.data.accessToken, app);

    const roles = (await admin.get('/settings/roles')).body.data;
    superRoleId = roles.find((x: any) => x.name === 'SUPER_ADMIN').id;
    const role = await admin.post('/settings/roles', {
      name: 'ROLE_MANAGER', displayName: 'Role manager',
      permissions: ['role:view', 'role:create', 'role:edit', 'user:manage', 'tag:view'],
    });
    expect(role.status).toBe(201);
    managerRoleId = role.body.data.id;
    const inv = await admin.post('/auth/invitations', { email: `staff${DOMAIN}`, roleId: managerRoleId, allBranches: true });
    expect(inv.status).toBe(201);
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token: inv.body.data.token, name: 'Staff Person', password: PASSWORD });
    expect([200, 201]).toContain(acc.status);
    const sl = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: `staff${DOMAIN}`, password: PASSWORD });
    staff = apiWith(sl.body.data.accessToken, app);
  }, 120_000);
  afterAll(async () => {
    for (const id of created) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  it('refuses a new role that carries permissions the creator lacks, including the * wildcard', async () => {
    expect((await staff.post('/settings/roles', { name: 'GOD', displayName: 'God', permissions: ['*'] })).status).toBe(403);
    expect((await staff.post('/settings/roles', { name: 'FIN', displayName: 'Fin', permissions: ['report:financial_view'] })).status).toBe(403);
    expect((await staff.post('/settings/roles', { name: 'OK', displayName: 'Ok', permissions: ['tag:view', 'role:view'] })).status).toBe(201);
  });

  it('refuses editing a role (including their own) to add authority they lack, but allows trimming', async () => {
    expect((await staff.patch(`/settings/roles/${managerRoleId}`, { permissions: ['*'] })).status).toBe(403);
    expect((await staff.patch(`/settings/roles/${managerRoleId}`, { permissions: ['role:view', 'role:create', 'role:edit', 'user:manage', 'tag:view', 'masters:delete'] })).status).toBe(403);
    expect((await staff.patch(`/settings/roles/${managerRoleId}`, { permissions: ['role:view', 'role:create', 'role:edit', 'user:manage'] })).status).toBe(200);
  });

  it('refuses inviting someone into a role stronger than the inviter\'s own, and re-roling a member to it', async () => {
    expect((await staff.post('/auth/invitations', { email: `boss${DOMAIN}`, roleId: superRoleId, allBranches: true })).status).toBe(403);
    const members = (await staff.get('/auth/users')).body.data;
    const me = members.find((m: any) => m.user.email === `staff${DOMAIN}`);
    expect((await staff.patch(`/auth/users/${me.id}`, { roleId: superRoleId })).status).toBe(403);
  });

  it('the company super admin (holds *) can still grant anything', async () => {
    expect((await admin.post('/settings/roles', { name: 'ANYTHING', displayName: 'Anything', permissions: ['*'] })).status).toBe(201);
  });
});
