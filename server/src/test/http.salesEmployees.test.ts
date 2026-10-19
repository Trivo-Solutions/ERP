import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, createMember, addBranch, tokenFor, apiWith, TestTenant } from './fixtures';

// Sales employee management over real HTTP: direct creation (no invitation), forced first password change,
// duplicate / escalation / cross-company refusals, deactivation, audit, and the billing staff list.
describe('HTTP: sales employees', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const tenants: TestTenant[] = [];
  const extraEmails: string[] = [];

  afterAll(async () => {
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { email: { in: extraEmails } } });
    for (const t of tenants) await prisma.user.deleteMany({ where: { email: t.user.email } });
    await prisma.$disconnect();
  });

  async function setup(tag: string, permissions = ['user:manage', 'invoice:create']) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    tenants.push(t);
    // The role handed to a new employee: held in full by the caller, so assignable.
    const staffRole = await prisma.role.create({ data: { companyId: t.company.id, name: `STAFF_${tag}${suffix}`, displayName: 'Staff', permissions: ['invoice:create'] } });
    return { t, staffRole, api: apiWith(tokenFor(t), app) };
  }
  const body = (roleId: string, branchId: string, over: object = {}) => {
    const email = `emp-${Math.random().toString(36).slice(2, 8)}-${suffix}@example.com`;
    extraEmails.push(email);
    return { name: 'Asha Rao', email, employeeId: `E-${Math.random().toString(36).slice(2, 6)}`, phone: '9999999999', designation: 'Sales Executive', roleId, branchIds: [branchId], ...over };
  };

  it('creates an employee and login directly, returns a one-time temporary password, forces a change at first sign-in', async () => {
    const { t, staffRole, api } = await setup('A');
    const res = await api.post('/sales-employees', body(staffRole.id, t.branch.id));
    expect(res.status).toBe(201);
    const { employee, temporaryPassword } = res.body.data;
    expect(temporaryPassword).toHaveLength(16);
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/); // no hash anywhere
    expect(employee.accountStatus).toBe('PASSWORD_CHANGE_PENDING');
    expect(employee.branches).toEqual([{ id: t.branch.id, name: 'Test Branch' }]);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: employee.userId } });
    expect(row.password).not.toContain(temporaryPassword);
    expect(row.mustChangePassword).toBe(true);

    // Signs in with the temporary password... (login upper-cases the company code; the fixture's is mixed-case)
    await prisma.company.update({ where: { id: t.company.id }, data: { code: t.company.code.toUpperCase() } });
    const login = await apiWith(undefined, app).post('/auth/login', { companyCode: t.company.code.toUpperCase(), identifier: employee.email, password: temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
    const me = apiWith(login.body.data.accessToken, app);
    // ...but can do nothing except read /auth/me and change the password.
    const blocked = await me.get('/sales/staff');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await me.get('/auth/me')).status).toBe(200);
    const changed = await me.post('/auth/change-password', { current: temporaryPassword, next: 'a-Much-Better-Passphrase-77' });
    expect(changed.status).toBe(200);
    const after = apiWith(changed.body.data.accessToken, app);
    expect((await after.get('/sales/staff')).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: employee.userId } })).mustChangePassword).toBe(false);

    // The password is nowhere in the audit trail.
    const audit = await prisma.auditLog.findMany({ where: { companyId: t.company.id, recordId: employee.id } });
    expect(audit.map((a) => a.action)).toContain('CREATE');
    expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
  });

  it('listing and search never expose a password hash and respect status', async () => {
    const { t, staffRole, api } = await setup('L');
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id, { name: 'Findable Person' }));
    const list = await api.get('/sales-employees?search=findable');
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/\$2[aby]\$|"password"/);
    await api.patch(`/sales-employees/${c.body.data.employee.id}`, { isActive: false });
    expect((await api.get('/sales-employees?status=active')).body.data).toHaveLength(0);
    expect((await api.get('/sales-employees?status=inactive')).body.data).toHaveLength(1);
  });

  it('rejects a duplicate employee code, a duplicate email, and an email that has a login in another company', async () => {
    const a = await setup('D1');
    const b = await setup('D2');
    const first = body(a.staffRole.id, a.t.branch.id);
    expect((await a.api.post('/sales-employees', first)).status).toBe(201);
    const dupCode = await a.api.post('/sales-employees', body(a.staffRole.id, a.t.branch.id, { employeeId: first.employeeId }));
    expect(dupCode.status).toBe(409);
    expect(dupCode.body.error).toMatch(/Employee code/);
    expect((await a.api.post('/sales-employees', { ...first, employeeId: 'X-other' })).status).toBe(409); // same email
    const other = await b.api.post('/sales-employees', { ...body(b.staffRole.id, b.t.branch.id), email: first.email });
    expect(other.status).toBe(409); // never attached across companies
    // Same code in ANOTHER company is fine (codes are per company).
    expect((await b.api.post('/sales-employees', body(b.staffRole.id, b.t.branch.id, { employeeId: first.employeeId }))).status).toBe(201);
    // Nothing half-created by the failures: exactly one login per accepted email.
    expect(await prisma.user.count({ where: { email: first.email } })).toBe(1);
  });

  it('requires user:manage (403) and authentication (401)', async () => {
    const { t, staffRole } = await setup('P', ['invoice:create']);
    const api = apiWith(tokenFor(t), app);
    expect((await api.post('/sales-employees', body(staffRole.id, t.branch.id))).status).toBe(403);
    expect((await api.get('/sales-employees')).status).toBe(403);
    expect((await apiWith(undefined, app).get('/sales-employees')).status).toBe(401);
  });

  it('refuses role escalation, and editing or re-passwording someone more privileged', async () => {
    const { t, api } = await setup('E');
    const admin = await prisma.role.create({ data: { companyId: t.company.id, name: `ADM${suffix}`, displayName: 'Admin', permissions: ['*'] } });
    expect((await api.post('/sales-employees', body(admin.id, t.branch.id))).status).toBe(403);
    // A privileged member flagged as a sales employee cannot be touched by a lesser manager.
    const m = await createMember({ companyId: t.company.id, roleId: admin.id, email: `boss-${suffix}@example.com` });
    extraEmails.push(m.user.email);
    await prisma.companyUser.update({ where: { id: m.membership.id }, data: { isSalesEmployee: true } });
    expect((await api.patch(`/sales-employees/${m.membership.id}`, { isActive: false })).status).toBe(403);
    expect((await api.post(`/sales-employees/${m.membership.id}/temporary-password`)).status).toBe(403);
  });

  it('cannot reach or use another companys branch, role or employee', async () => {
    const a = await setup('X1');
    const b = await setup('X2');
    const foreign = await b.api.post('/sales-employees', body(b.staffRole.id, b.t.branch.id));
    const id = foreign.body.data.employee.id;
    expect((await a.api.post('/sales-employees', body(a.staffRole.id, b.t.branch.id))).status).toBe(404); // forged branch
    expect((await a.api.post('/sales-employees', body(b.staffRole.id, a.t.branch.id))).status).toBe(404); // forged role
    expect((await a.api.patch(`/sales-employees/${id}`, { isActive: false })).status).toBe(404);
    expect((await a.api.post(`/sales-employees/${id}/temporary-password`)).status).toBe(404);
    expect((await a.api.get('/sales-employees')).body.data).toHaveLength(0);
    expect((await prisma.companyUser.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
  });

  it('edits details and branches in one step, cannot deactivate itself, and issues a new temporary password', async () => {
    const { t, staffRole, api } = await setup('U');
    const second = await addBranch(t.company.id, `U${suffix}`);
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id));
    const { id, userId } = c.body.data.employee;
    const upd = await api.patch(`/sales-employees/${id}`, { designation: 'Manager', branchIds: [second.id], name: 'Renamed Person' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.designation).toBe('Manager');
    expect(upd.body.data.branches.map((x: any) => x.id)).toEqual([second.id]);
    expect(upd.body.data.name).toBe('Renamed Person');
    expect((await api.patch(`/sales-employees/${id}`, { passwordHash: 'x' })).status).toBe(400); // strict schema

    const before = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).password;
    const re = await api.post(`/sales-employees/${id}/temporary-password`);
    expect(re.status).toBe(200);
    expect(re.body.data.temporaryPassword).toHaveLength(16);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).password).not.toBe(before);

    const self = await api.patch(`/sales-employees/${t.companyUser.id}`, { isActive: false });
    expect(self.status).toBe(404); // the caller is not flagged as a sales employee, and could not disable itself anyway
  });

  it('an inactive employee disappears from the billing staff list; an active one is listed for billing', async () => {
    const { t, staffRole, api } = await setup('B');
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id, { name: 'Billing Person' }));
    const { id, userId } = c.body.data.employee;
    const ids = async () => (await api.get('/sales/staff')).body.data.map((s: any) => s.id);
    expect(await ids()).toContain(userId);
    await api.patch(`/sales-employees/${id}`, { isActive: false });
    expect(await ids()).not.toContain(userId);
  });
  it('signs in successfully even in the same second a temporary password was issued', async () => {
    const { t, staffRole, api } = await setup('S');
    const code = t.company.code.toUpperCase();
    await prisma.company.update({ where: { id: t.company.id }, data: { code } });
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id));
    const { id, email } = c.body.data.employee;
    const re = await api.post(`/sales-employees/${id}/temporary-password`);
    const login = await apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: email, password: re.body.data.temporaryPassword });
    expect(login.status).toBe(200);
    // ...and the issued token really works (it is not treated as older than the password change).
    expect((await apiWith(login.body.data.accessToken, app).get('/auth/me')).status).toBe(200);
    // The previous temporary password no longer works.
    expect((await apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: email, password: c.body.data.temporaryPassword })).status).toBe(401);
  });

  it('two simultaneous creates for one email: exactly one wins, nothing is left half-made', async () => {
    const { t, staffRole, api } = await setup('C');
    const b1 = body(staffRole.id, t.branch.id);
    const b2 = { ...b1, employeeId: 'OTHER-CODE' };
    const [r1, r2] = await Promise.all([api.post('/sales-employees', b1), api.post('/sales-employees', b2)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: b1.email } })).toBe(1);
    expect(await prisma.companyUser.count({ where: { companyId: t.company.id, isSalesEmployee: true } })).toBe(1);
    const winner = (r1.status === 201 ? r1 : r2).body.data.employee;
    expect(await prisma.userBranchAccess.count({ where: { companyUserId: winner.id } })).toBe(1);
  });

  it('a failing branch check rolls back / prevents the login and membership', async () => {
    const { t, staffRole, api } = await setup('R');
    const inactive = await prisma.branch.create({ data: { companyId: t.company.id, branchCode: `INACT-${suffix}`, name: 'Closed', isActive: false } });
    const b = body(staffRole.id, inactive.id);
    expect((await api.post('/sales-employees', b)).status).toBe(400);
    expect(await prisma.user.count({ where: { email: b.email } })).toBe(0);
    expect(await prisma.companyUser.count({ where: { companyId: t.company.id, isSalesEmployee: true } })).toBe(0);
  });

  it('deactivation and reactivation are audited, and the person cannot sign in while deactivated', async () => {
    const { t, staffRole, api } = await setup('V');
    const code = t.company.code.toUpperCase();
    await prisma.company.update({ where: { id: t.company.id }, data: { code } });
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id));
    const { id, email } = c.body.data.employee;
    const pw = c.body.data.temporaryPassword;
    const login = () => apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: email, password: pw });
    await api.patch(`/sales-employees/${id}`, { isActive: false });
    expect((await login()).status).toBe(401);
    await api.patch(`/sales-employees/${id}`, { isActive: true });
    expect((await login()).status).toBe(200);
    const audit = await prisma.auditLog.findMany({ where: { companyId: t.company.id, recordId: id }, orderBy: { timestamp: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['CREATE', 'DEACTIVATE', 'REACTIVATE']);
    expect(audit.every((a) => a.userId === t.user.id)).toBe(true);
  });

  it('marks an existing member as a sales employee without creating an account, and unmarking keeps the login', async () => {
    const { t, staffRole, api } = await setup('M');
    const m = await createMember({ companyId: t.company.id, roleId: staffRole.id, email: `exist-${suffix}@example.com`, name: 'Existing Person' });
    extraEmails.push(m.user.email);
    const usersBefore = await prisma.user.count();
    const membersBefore = await prisma.companyUser.count({ where: { companyId: t.company.id } });

    expect((await api.get('/sales-employees/members')).body.data.map((x: any) => x.id)).toContain(m.membership.id);
    const mark = await api.post('/sales-employees/existing', { companyUserId: m.membership.id, designation: 'Counter Sales' });
    expect(mark.status).toBe(201);
    expect(mark.body.data.designation).toBe('Counter Sales');
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.companyUser.count({ where: { companyId: t.company.id } })).toBe(membersBefore); // no duplicate account
    expect((await api.post('/sales-employees/existing', { companyUserId: m.membership.id })).status).toBe(409); // already marked
    expect((await api.get('/sales-employees')).body.data.map((x: any) => x.id)).toContain(m.membership.id);
    expect((await api.get('/sales-employees/members')).body.data.map((x: any) => x.id)).not.toContain(m.membership.id);

    expect((await api.post(`/sales-employees/${m.membership.id}/unmark`)).status).toBe(200);
    const kept = await prisma.companyUser.findUniqueOrThrow({ where: { id: m.membership.id } });
    expect(kept.isSalesEmployee).toBe(false);
    expect(kept.isActive).toBe(true);
    expect(await prisma.user.count({ where: { id: m.user.id } })).toBe(1); // login survives
    expect((await api.post(`/sales-employees/${m.membership.id}/unmark`)).status).toBe(404);
    const audit = await prisma.auditLog.findMany({ where: { companyId: t.company.id, recordId: m.membership.id } });
    expect(audit.map((a) => a.action).sort()).toEqual(['SALES_EMPLOYEE_MARK', 'SALES_EMPLOYEE_UNMARK']);
  });

  it('marking existing members is permission-gated, tenant-scoped and escalation-safe', async () => {
    const a = await setup('N1');
    const b = await setup('N2');
    const other = await createMember({ companyId: b.t.company.id, roleId: b.staffRole.id, email: `other-${suffix}@example.com` });
    extraEmails.push(other.user.email);
    expect((await a.api.post('/sales-employees/existing', { companyUserId: other.membership.id })).status).toBe(404); // another company
    expect((await a.api.get('/sales-employees/members')).body.data.map((x: any) => x.id)).not.toContain(other.membership.id);
    expect((await a.api.post('/sales-employees/existing', { companyUserId: 'not-an-id' })).status).toBe(400);
    const admin = await prisma.role.create({ data: { companyId: a.t.company.id, name: `ADMN${suffix}`, displayName: 'Admin', permissions: ['*'] } });
    const boss = await createMember({ companyId: a.t.company.id, roleId: admin.id, email: `boss2-${suffix}@example.com` });
    extraEmails.push(boss.user.email);
    expect((await a.api.post('/sales-employees/existing', { companyUserId: boss.membership.id })).status).toBe(403); // more privileged
    const noPerm = await setup('N3', ['invoice:create']);
    expect((await noPerm.api.get('/sales-employees/members')).status).toBe(403);
    expect((await noPerm.api.post('/sales-employees/existing', { companyUserId: noPerm.t.companyUser.id })).status).toBe(403);
  });
  it('an unused temporary password expires after 72 hours; reissuing gives a fresh one', async () => {
    const { t, staffRole, api } = await setup('T');
    const code = t.company.code.toUpperCase();
    await prisma.company.update({ where: { id: t.company.id }, data: { code } });
    const c = await api.post('/sales-employees', body(staffRole.id, t.branch.id));
    const { id, email, userId } = c.body.data.employee;
    const login = (pw: string) => apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: email, password: pw });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

    await prisma.user.update({ where: { id: userId }, data: { createdAt: hoursAgo(71) } });
    expect((await login(c.body.data.temporaryPassword)).status).toBe(200); // still inside the window
    await prisma.user.update({ where: { id: userId }, data: { createdAt: hoursAgo(73) } });
    const expired = await login(c.body.data.temporaryPassword);
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatch(/expired/i);
    expect((await login('definitely-not-the-password')).body.error).toBe('Invalid credentials'); // a wrong password learns nothing

    const re = await api.post(`/sales-employees/${id}/temporary-password`);
    expect((await login(re.body.data.temporaryPassword)).status).toBe(200); // reissue restarts the clock
    await prisma.user.update({ where: { id: userId }, data: { passwordChangedAt: hoursAgo(73) } });
    expect((await login(re.body.data.temporaryPassword)).status).toBe(401);
  });

  it('a branch-restricted manager cannot grant or manage reach beyond their own branches', async () => {
    const { t, staffRole, api: admin } = await setup('Q');
    const b2 = await addBranch(t.company.id, `Q${suffix}`);
    const restricted = apiWith(jwt.sign({
      userId: t.user.id, email: t.user.email, companyId: t.company.id, companyUserId: t.companyUser.id, roleId: t.role.id, roleName: t.role.name,
      permissions: t.role.permissions, branchAccess: { allBranches: false, branchIds: [t.branch.id] },
    }, env.JWT_SECRET, { expiresIn: '1h' }), app);

    // Granting: only own branches, never all-branches.
    expect((await restricted.post('/sales-employees', body(staffRole.id, b2.id))).status).toBe(403);
    expect((await restricted.post('/sales-employees', { ...body(staffRole.id, t.branch.id), allBranches: true })).status).toBe(403);
    const own = await restricted.post('/sales-employees', body(staffRole.id, t.branch.id));
    expect(own.status).toBe(201);

    // Employees confined elsewhere, or company-wide, are outside their reach.
    const elsewhere = (await admin.post('/sales-employees', body(staffRole.id, b2.id))).body.data.employee;
    const everywhere = (await admin.post('/sales-employees', { ...body(staffRole.id, t.branch.id), allBranches: true })).body.data.employee;
    const seen = (await restricted.get('/sales-employees')).body.data.map((e: any) => e.id);
    expect(seen).toContain(own.body.data.employee.id);
    expect(seen).toContain(everywhere.id); // works at their branch too: visible...
    expect(seen).not.toContain(elsewhere.id); // ...but one confined elsewhere is not
    for (const target of [elsewhere, everywhere]) {
      expect((await restricted.patch(`/sales-employees/${target.id}`, { designation: 'X' })).status, 'edit').toBe(403);
      expect((await restricted.post(`/sales-employees/${target.id}/temporary-password`)).status, 'reissue').toBe(403);
      expect((await restricted.post(`/sales-employees/${target.id}/unmark`)).status, 'unmark').toBe(403);
    }
    // ...and cannot widen their own employee's reach, but can move it within their own scope.
    const own2 = own.body.data.employee.id;
    expect((await restricted.patch(`/sales-employees/${own2}`, { allBranches: true })).status).toBe(403);
    expect((await restricted.patch(`/sales-employees/${own2}`, { branchIds: [b2.id] })).status).toBe(403);
    expect((await restricted.patch(`/sales-employees/${own2}`, { designation: 'Counter' })).status).toBe(200);

    // Existing members: only those they could take charge of are offered, and marking an out-of-scope one is refused.
    const wide = await createMember({ companyId: t.company.id, roleId: staffRole.id, email: `wide-${suffix}@example.com`, allBranches: true });
    extraEmails.push(wide.user.email);
    expect((await restricted.get('/sales-employees/members')).body.data.map((m: any) => m.id)).not.toContain(wide.membership.id);
    expect((await restricted.post('/sales-employees/existing', { companyUserId: wide.membership.id })).status).toBe(403);
    // A company-wide manager is unaffected.
    expect((await admin.post('/sales-employees/existing', { companyUserId: wide.membership.id })).status).toBe(201);
  });
});
