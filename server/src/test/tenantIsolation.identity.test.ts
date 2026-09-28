import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import {
  createTestTenant, cleanupTestTenant, addBranch, createMember, tokenFor, apiWith, TestTenant, REAL_ROLE_SPLIT, rlsClient } from './fixtures';
import { createAuditEntry, createPlatformAuditEntry } from '../middleware/audit';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 of full company isolation: identity and membership.
//
//   User        = global LOGIN identity (email, password hash, name).
//   CompanyUser = the person inside ONE company (employee id, department, phone, username, role,
//                 branch access, last login there).
//
// Vasavi (Company A) and Shree Silver Palace (Company B) — nothing about a person in one company
// may be visible in, or affect, the other, even when it is the very same global login.
// ═══════════════════════════════════════════════════════════════════════════

const ADMIN_PERMS = ['user:manage', 'audit:view', 'invoice:create', 'tag:view', 'masters:view'];
const GENERIC_INVALID = 'Invalid or expired invitation';

describe('Phase 2: identity & membership isolation — Vasavi vs Shree Silver Palace', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = (tag: string) => `${tag}-${suffix}@example.com`;

  let A: TestTenant; // Vasavi
  let B: TestTenant; // Shree Silver Palace
  let C: TestTenant; // a third company nobody is a member of
  let branchA2: { id: string };
  let apiA: ReturnType<typeof apiWith>;
  let apiB: ReturnType<typeof apiWith>;
  const pub = () => apiWith(undefined, app);

  // People. `shared` is ONE global login that belongs to BOTH companies.
  let shared: Awaited<ReturnType<typeof createMember>>;     // A: E001/Sales    B: E001/Accounts
  let sharedB: Awaited<ReturnType<typeof createMember>>;
  let vasOnly: Awaited<ReturnType<typeof createMember>>;    // A only: E002, username "ravi"
  let shrOnly: Awaited<ReturnType<typeof createMember>>;    // B only: E002, username "ravi"

  beforeAll(async () => {
    A = await createTestTenant(`IDA${suffix}`.toUpperCase(), ADMIN_PERMS);
    B = await createTestTenant(`IDB${suffix}`.toUpperCase(), ADMIN_PERMS);
    C = await createTestTenant(`IDC${suffix}`.toUpperCase(), ADMIN_PERMS);
    branchA2 = await addBranch(A.company.id, `a2${suffix}`);
    apiA = apiWith(tokenFor(A), app);
    apiB = apiWith(tokenFor(B), app);

    // Same employee id AND same username in both companies — must both be creatable.
    shared = await createMember({
      companyId: A.company.id, roleId: A.role.id, email: email('shared'), name: 'Shared Person',
      employeeId: 'E001', department: 'Sales', phone: '+91-A-SALES-001',
    });
    sharedB = await createMember({
      companyId: B.company.id, roleId: B.role.id, email: email('shared'), existingUserId: shared.user.id,
      employeeId: 'E001', department: 'Accounts', phone: '+91-B-ACCTS-001',
    });
    vasOnly = await createMember({
      companyId: A.company.id, roleId: A.role.id, email: email('vasonly'), name: 'Vasavi Only',
      employeeId: 'E002', department: 'VasaviSecretDept', phone: '+91-VASAVI-ONLY', username: 'ravi',
      password: 'Vasavi-Only-Passw0rd!', allBranches: false, // branch-restricted, so login must honour explicit grants
    });
    shrOnly = await createMember({
      companyId: B.company.id, roleId: B.role.id, email: email('shronly'), name: 'Shree Only',
      employeeId: 'E002', department: 'ShreeSecretDept', phone: '+91-SHREE-ONLY', username: 'ravi',
      password: 'Shree-Only-Passw0rd!',
    });
  });

  afterAll(async () => {
    await prisma.platformAuditLog.deleteMany({ where: { action: { startsWith: `TEST_PLATFORM_${suffix}` } } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await cleanupTestTenant(C);
    // Extra users (created by createMember or by accepting an invitation) — memberships are gone now.
    const extra = await prisma.user.findMany({ where: { email: { contains: suffix } }, select: { id: true } });
    const ids = extra.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const listUsers = async (api: ReturnType<typeof apiWith>) => (await api.get('/auth/users')).body.data as any[];

  // ─── 1. The schema itself ───────────────────────────────────────────────────
  describe('the data model', () => {
    it('the global users table holds login identity only — no employee id / department / phone', async () => {
      const cols: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`);
      const names = cols.map((c) => c.column_name);
      for (const gone of ['employeeId', 'department', 'phone']) expect(names).not.toContain(gone);
      expect(names).toEqual(expect.arrayContaining(['email', 'password', 'name']));
    });

    it('company_users carries the employee data, and employeeId is unique PER company (not globally)', async () => {
      const cols: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'company_users'`);
      expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(['employeeId', 'department', 'phone', 'lastLoginAt']));
      // setup already created E001 and E002 in BOTH companies; a third E001 in the same company must fail
      await expect(prisma.companyUser.update({ where: { id: vasOnly.membership.id }, data: { employeeId: 'E001' } })).rejects.toThrow();
    });

    it('user_branch_access is company-owned (companyId) and audit_logs.companyId is NOT NULL', async () => {
      const nullable: Array<{ table_name: string; is_nullable: string }> = await prisma.$queryRawUnsafe(
        `SELECT table_name, is_nullable FROM information_schema.columns WHERE column_name = 'companyId' AND table_name IN ('user_branch_access','audit_logs','company_invitations')`);
      expect(nullable.map((r) => r.table_name).sort()).toEqual(['audit_logs', 'company_invitations', 'user_branch_access']);
      for (const r of nullable) expect(r.is_nullable, r.table_name).toBe('NO');
    });
  });

  // ─── 2. Employee IDs ───────────────────────────────────────────────────────
  describe('employee IDs are unique per company, independent across companies', () => {
    it('Company A and Company B both have E001 and E002 — each works independently', async () => {
      const ids = async (api: ReturnType<typeof apiWith>) => (await listUsers(api)).map((u) => u.employeeId).filter(Boolean).sort();
      expect(await ids(apiA)).toEqual(['E001', 'E002']);
      expect(await ids(apiB)).toEqual(['E001', 'E002']);
    });

    it('a duplicate INSIDE one company is refused with a message that concerns only that company', async () => {
      const r = await apiA.patch(`/auth/users/${vasOnly.membership.id}`, { employeeId: 'E001' });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('Employee ID is already in use in this company');
      expect(JSON.stringify(r.body)).not.toMatch(/Shree|Company B|another company|other compan/i);
    });

    it('claiming an id that exists ONLY in the other company never errors — no cross-company existence signal', async () => {
      expect((await apiA.patch(`/auth/users/${vasOnly.membership.id}`, { employeeId: 'E-VAS-ONLY' })).status).toBe(200);
      const r = await apiB.patch(`/auth/users/${shrOnly.membership.id}`, { employeeId: 'E-VAS-ONLY' });
      expect(r.status, JSON.stringify(r.body)).toBe(200); // B is free to use it: it is B's own namespace
      expect((await apiB.patch(`/auth/users/${shrOnly.membership.id}`, { employeeId: 'E002' })).status).toBe(200); // put back
    });

    it('a client cannot smuggle a companyId into a membership edit (rejected, not applied)', async () => {
      const r = await apiA.patch(`/auth/users/${vasOnly.membership.id}`, { department: 'x', companyId: B.company.id });
      expect(r.status).toBe(400);
    });

    it('an unknown field in a membership edit is rejected (strict schema — no mass assignment)', async () => {
      const r = await apiA.patch(`/auth/users/${vasOnly.membership.id}`, { userId: shrOnly.user.id });
      expect(r.status).toBe(400);
    });
  });

  // ─── 3. Employee details never cross companies ─────────────────────────────
  describe('employee details never appear in the other company\'s responses', () => {
    const VASAVI_MARKERS = ['VasaviSecretDept', '+91-VASAVI-ONLY', 'E-VAS-ONLY', 'Vasavi Only'];
    const SHREE_MARKERS = ['ShreeSecretDept', '+91-SHREE-ONLY', 'Shree Only'];
    const surfaces = ['/auth/users', '/auth/me', '/sales/staff', '/auth/invitations', '/settings/audit-logs'];

    it('Company B\'s users / me / staff / invitations / audit endpoints contain none of Vasavi\'s employee data', async () => {
      for (const ep of surfaces) {
        const res = await apiB.get(ep);
        expect(res.status, ep).toBe(200);
        const body = JSON.stringify(res.body);
        for (const m of VASAVI_MARKERS) expect(body, `${ep} leaked ${m}`).not.toContain(m);
      }
    });

    it('…and the reverse: Company A sees none of Shree\'s', async () => {
      for (const ep of surfaces) {
        const body = JSON.stringify((await apiA.get(ep)).body);
        for (const m of SHREE_MARKERS) expect(body, `${ep} leaked ${m}`).not.toContain(m);
      }
    });

    it('Company A\'s own view does show its own details (control — the isolation is not just "hide everything")', async () => {
      const mine = (await listUsers(apiA)).find((u) => u.id === vasOnly.membership.id);
      expect(mine).toMatchObject({ employeeId: 'E-VAS-ONLY', department: 'VasaviSecretDept', phone: '+91-VASAVI-ONLY', username: 'ravi' });
    });

    it('no response ever carries a password hash or the global User.lastLogin', async () => {
      for (const ep of ['/auth/users', '/auth/me']) {
        const body = JSON.stringify((await apiA.get(ep)).body);
        expect(body).not.toMatch(/"password"/);
        expect(body).not.toMatch(/\$2[aby]\$/); // a bcrypt hash
      }
      for (const u of await listUsers(apiA)) expect(u.user.lastLogin).toBeUndefined();
    });
  });

  // ─── 4. The same global User in both companies ─────────────────────────────
  describe('one global login that belongs to BOTH companies keeps two separate identities', () => {
    it('A sees E001/Sales, B sees E001/Accounts — for the very same User', async () => {
      const a = (await listUsers(apiA)).find((u) => u.user.id === shared.user.id);
      const b = (await listUsers(apiB)).find((u) => u.user.id === shared.user.id);
      expect(a).toMatchObject({ employeeId: 'E001', department: 'Sales', phone: '+91-A-SALES-001' });
      expect(b).toMatchObject({ employeeId: 'E001', department: 'Accounts', phone: '+91-B-ACCTS-001' });
    });

    it('neither company\'s response contains the other company\'s facts about that person', async () => {
      const bodyA = JSON.stringify(await listUsers(apiA));
      const bodyB = JSON.stringify(await listUsers(apiB));
      expect(bodyA).not.toContain('Accounts');
      expect(bodyA).not.toContain('+91-B-ACCTS-001');
      expect(bodyB).not.toContain('+91-A-SALES-001');
      expect(bodyB).not.toMatch(/"department":"Sales"/);
    });

    it('editing the person in A changes nothing in B', async () => {
      const r = await apiA.patch(`/auth/users/${shared.membership.id}`, { department: 'Dispatch', phone: '+91-A-CHANGED' });
      expect(r.status).toBe(200);
      const bRow = await prisma.companyUser.findUniqueOrThrow({ where: { id: sharedB.membership.id } });
      expect(bRow).toMatchObject({ department: 'Accounts', phone: '+91-B-ACCTS-001', employeeId: 'E001' });
      await apiA.patch(`/auth/users/${shared.membership.id}`, { department: 'Sales', phone: '+91-A-SALES-001' });
    });

    it('a company admin cannot edit ANOTHER company\'s membership of that same person (404)', async () => {
      const r = await apiA.patch(`/auth/users/${sharedB.membership.id}`, { department: 'HACKED' });
      expect(r.status).toBe(404);
      expect((await prisma.companyUser.findUniqueOrThrow({ where: { id: sharedB.membership.id } })).department).toBe('Accounts');
    });

    it('last-login is per company: signing in to A is invisible to B', async () => {
      const login = await pub().post('/auth/login', { companyCode: A.company.code, identifier: shared.user.email, password: shared.password });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const a = (await listUsers(apiA)).find((u) => u.user.id === shared.user.id);
      const b = (await listUsers(apiB)).find((u) => u.user.id === shared.user.id);
      expect(a.lastLoginAt).toBeTruthy();
      expect(b.lastLoginAt).toBeNull(); // B must not learn that this person was active in A
    });
  });

  // ─── 5. Authentication ─────────────────────────────────────────────────────
  describe('authentication resolves the right company, always', () => {
    const login = (companyCode: string, identifier: string, password: string) =>
      pub().post('/auth/login', { companyCode, identifier, password });

    it('one person, two companies: each login lands in exactly the company asked for', async () => {
      const ra = await login(A.company.code, shared.user.email, shared.password);
      const rb = await login(B.company.code, shared.user.email, shared.password);
      const ta = jwt.decode(ra.body.data.accessToken) as any;
      const tb = jwt.decode(rb.body.data.accessToken) as any;
      expect(ta).toMatchObject({ companyId: A.company.id, companyUserId: shared.membership.id, userId: shared.user.id });
      expect(tb).toMatchObject({ companyId: B.company.id, companyUserId: sharedB.membership.id, userId: shared.user.id });
      expect(ta.roleId).toBe(A.role.id); // company-specific role
      expect(tb.roleId).toBe(B.role.id);
    });

    it('a login for a company you are NOT a member of fails exactly like a wrong password (no distinguishing signal)', async () => {
      const notMember = await login(C.company.code, shared.user.email, shared.password);
      const wrongPw = await login(A.company.code, shared.user.email, 'definitely-wrong');
      const noCompany = await login('NO-SUCH-CO', shared.user.email, shared.password);
      for (const r of [notMember, wrongPw, noCompany]) {
        expect(r.status).toBe(401);
        expect(r.body.error).toBe('Invalid credentials');
      }
    });

    it('company-scoped usernames: "ravi" resolves to A\'s person in A and B\'s person in B, never across', async () => {
      const ra = await login(A.company.code, 'ravi', vasOnly.password);
      const rb = await login(B.company.code, 'ravi', shrOnly.password);
      expect((jwt.decode(ra.body.data.accessToken) as any)).toMatchObject({ companyId: A.company.id, userId: vasOnly.user.id });
      expect((jwt.decode(rb.body.data.accessToken) as any)).toMatchObject({ companyId: B.company.id, userId: shrOnly.user.id });
      expect((await login(A.company.code, 'ravi', shrOnly.password)).status).toBe(401); // B's person's password in A
    });

    it('a client-supplied companyId on login is rejected outright, never used', async () => {
      const r = await pub().post('/auth/login', { companyCode: A.company.code, identifier: shared.user.email, password: shared.password, companyId: B.company.id });
      expect(r.status).toBe(400);
    });

    it('a token whose claims name Company B but Company A\'s membership is refused (server re-validates the membership)', async () => {
      const forged = jwt.sign(
        { userId: shared.user.id, email: shared.user.email, companyId: B.company.id, companyUserId: shared.membership.id,
          roleId: A.role.id, roleName: 'X', permissions: ['*'], branchAccess: { allBranches: true, branchIds: [] } },
        env.JWT_SECRET, { expiresIn: '1h' });
      expect((await apiWith(forged, app).get('/auth/users')).status).toBe(401);
    });

    it('Company A\'s token lists only Company A\'s people', async () => {
      const emails = (await listUsers(apiA)).map((u) => u.user.email);
      expect(emails).not.toContain(shrOnly.user.email);
      expect(emails).toContain(vasOnly.user.email);
    });

    it('refresh keeps the same company', async () => {
      const rb = await login(B.company.code, shared.user.email, shared.password);
      const refreshed = await pub().post('/auth/refresh', { refreshToken: rb.body.data.refreshToken });
      expect((jwt.decode(refreshed.body.data.accessToken) as any).companyId).toBe(B.company.id);
    });

    it('deactivating a membership takes effect immediately (token AND login both refused)', async () => {
      const token = (await login(A.company.code, 'ravi', vasOnly.password)).body.data.accessToken;
      expect((await apiWith(token, app).get('/auth/me')).status).toBe(200);
      await prisma.companyUser.update({ where: { id: vasOnly.membership.id }, data: { isActive: false } });
      expect((await apiWith(token, app).get('/auth/me')).status).toBe(401);
      expect((await login(A.company.code, 'ravi', vasOnly.password)).status).toBe(401);
      await prisma.companyUser.update({ where: { id: vasOnly.membership.id }, data: { isActive: true } });
    });

    it('deactivating a COMPANY cuts off tokens it already issued, not just new logins', async () => {
      const tokenC = tokenFor(C);
      expect((await apiWith(tokenC, app).get('/auth/me')).status).toBe(200);
      await prisma.company.update({ where: { id: C.company.id }, data: { isActive: false } });
      expect((await apiWith(tokenC, app).get('/auth/me')).status).toBe(401);
      const refresh = jwt.sign({ userId: C.user.id, companyUserId: C.companyUser.id }, env.JWT_REFRESH_SECRET, { expiresIn: '1h' });
      expect((await pub().post('/auth/refresh', { refreshToken: refresh })).status).toBe(401);
      await prisma.company.update({ where: { id: C.company.id }, data: { isActive: true } });
      expect((await apiWith(tokenC, app).get('/auth/me')).status).toBe(200);
    });

    it('there is no longer any endpoint that creates a user directly from an email (the old attach-by-email route is gone)', async () => {
      const r = await apiA.post('/auth/users', { email: shrOnly.user.email, name: 'x', roleId: A.role.id, password: 'whatever123' });
      expect(r.status).toBe(404);
      expect(await prisma.companyUser.count({ where: { companyId: A.company.id, userId: shrOnly.user.id } })).toBe(0);
    });
  });

  // ─── 6. Branch access ──────────────────────────────────────────────────────
  describe('branch access can never cross companies', () => {
    it('Company B cannot attach a Company A branch to its own member (404), nothing is stored', async () => {
      const r = await apiB.post(`/company/users/${shrOnly.membership.id}/branch-access`, { branchId: A.branch.id });
      expect(r.status).toBe(404);
      expect(await prisma.userBranchAccess.count({ where: { companyUserId: shrOnly.membership.id } })).toBe(0);
    });

    it('Company B cannot grant its own branch to a Company A member (404)', async () => {
      const r = await apiB.post(`/company/users/${vasOnly.membership.id}/branch-access`, { branchId: B.branch.id });
      expect(r.status).toBe(404);
      expect(await prisma.userBranchAccess.count({ where: { companyUserId: vasOnly.membership.id } })).toBe(0);
    });

    it('Company A grants its own branch to its own member — stored with Company A\'s id; a repeat is a 409', async () => {
      const r = await apiA.post(`/company/users/${vasOnly.membership.id}/branch-access`, { branchId: A.branch.id });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.companyId).toBe(A.company.id);
      expect((await apiA.post(`/company/users/${vasOnly.membership.id}/branch-access`, { branchId: A.branch.id })).status).toBe(409);
    });

    it('Company B cannot revoke Company A\'s grant (404) — it is still there', async () => {
      const r = await apiB.del(`/company/users/${vasOnly.membership.id}/branch-access/${A.branch.id}`);
      expect(r.status).toBe(404);
      expect(await prisma.userBranchAccess.count({ where: { companyUserId: vasOnly.membership.id, branchId: A.branch.id } })).toBe(1);
    });

    it('the DATABASE refuses a cross-company grant even if application code were bypassed (composite FKs)', async () => {
      // Company A's membership + Company B's branch, stamped with either company:
      await expect(prisma.userBranchAccess.create({ data: { companyId: A.company.id, companyUserId: vasOnly.membership.id, branchId: B.branch.id } })).rejects.toThrow(/foreign key/i);
      await expect(prisma.userBranchAccess.create({ data: { companyId: B.company.id, companyUserId: vasOnly.membership.id, branchId: B.branch.id } })).rejects.toThrow(/foreign key/i);
    });

    it('an invitation naming another company\'s branch or role is refused (404)', async () => {
      const wrongBranch = await apiB.post('/auth/invitations', { email: email('wb'), roleId: B.role.id, branchIds: [A.branch.id] });
      expect(wrongBranch.status).toBe(404);
      const wrongRole = await apiB.post('/auth/invitations', { email: email('wr'), roleId: A.role.id });
      expect(wrongRole.status).toBe(404);
    });

    it('login only honours grants that belong to the member\'s own company', async () => {
      const r = await pub().post('/auth/login', { companyCode: A.company.code, identifier: 'ravi', password: vasOnly.password });
      expect(r.body.data.user.branchAccess.branchIds).toEqual([A.branch.id]);
      await apiA.del(`/company/users/${vasOnly.membership.id}/branch-access/${A.branch.id}`);
    });

    it('GET /company/branches lists only the caller\'s own company\'s branches', async () => {
      const r = await apiA.get('/company/branches');
      expect(r.status).toBe(200);
      const ids: string[] = r.body.data.map((b: any) => b.id);
      expect(ids).toContain(A.branch.id);
      expect(ids).toContain(branchA2.id);
      expect(ids).not.toContain(B.branch.id);
    });

    it('GET /company/users/:id/branch-access reflects this company\'s own grants; a cross-company id is a 404', async () => {
      await apiA.post(`/company/users/${vasOnly.membership.id}/branch-access`, { branchId: branchA2.id });
      const mine = await apiA.get(`/company/users/${vasOnly.membership.id}/branch-access`);
      expect(mine.status).toBe(200);
      expect(mine.body.data).toEqual(expect.arrayContaining([branchA2.id]));

      const cross = await apiB.get(`/company/users/${vasOnly.membership.id}/branch-access`);
      expect(cross.status).toBe(404);

      await apiA.del(`/company/users/${vasOnly.membership.id}/branch-access/${branchA2.id}`);
    });
  });

  // ─── 7. Audit ──────────────────────────────────────────────────────────────
  describe('audit trail isolation', () => {
    let auditA: string; let auditB: string;

    beforeAll(async () => {
      // Real audited actions, one per company.
      const ga = await apiA.post(`/company/users/${vasOnly.membership.id}/branch-access`, { branchId: branchA2.id });
      const gb = await apiB.post(`/company/users/${shrOnly.membership.id}/branch-access`, { branchId: B.branch.id });
      auditA = ga.body.data.id; auditB = gb.body.data.id;
    });

    it('each company sees its own audit events…', async () => {
      const a = JSON.stringify((await apiA.get('/settings/audit-logs?table=user_branch_access')).body);
      const b = JSON.stringify((await apiB.get('/settings/audit-logs?table=user_branch_access')).body);
      expect(a).toContain(auditA);
      expect(b).toContain(auditB);
    });

    it('…and never the other company\'s (both directions)', async () => {
      const a = JSON.stringify((await apiA.get('/settings/audit-logs')).body);
      const b = JSON.stringify((await apiB.get('/settings/audit-logs')).body);
      expect(a).not.toContain(auditB);
      expect(b).not.toContain(auditA);
    });

    it('an audit event cannot be written into another company\'s trail (acting user is not a member there)', async () => {
      const before = await prisma.auditLog.count({ where: { companyId: B.company.id, recordId: `forged-${suffix}` } });
      await expect(createAuditEntry('jewelry_tags', `forged-${suffix}`, vasOnly.user.id, 'CREATE', undefined, undefined, B.company.id))
        .rejects.toThrow(/not a member/i);
      expect(await prisma.auditLog.count({ where: { companyId: B.company.id, recordId: `forged-${suffix}` } })).toBe(before);
    });

    it('a company audit event without a company is refused at runtime, not stored', async () => {
      await expect((createAuditEntry as any)('jewelry_tags', 'x', vasOnly.user.id, 'CREATE', undefined, undefined, undefined))
        .rejects.toThrow(/companyId/i);
    });

    it('the database itself refuses an audit_logs row with no company (NOT NULL)', async () => {
      await expect(prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, "companyId", "tableName", "recordId", "userId", action) VALUES ('nullco-${suffix}', NULL, 't', 'r', '${vasOnly.user.id}', 'CREATE')`,
      )).rejects.toThrow();
    });

    it('platform events go to platform_audit_logs — explicitly platform-scoped, never in any company\'s trail', async () => {
      const action = `TEST_PLATFORM_${suffix}`;
      await createPlatformAuditEntry({ actorUserId: vasOnly.user.id, action, subjectType: 'company', subjectId: 'c1', metadata: { note: 'operator action' } });
      expect(await prisma.platformAuditLog.count({ where: { action } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action } })).toBe(0);
      for (const api of [apiA, apiB]) expect(JSON.stringify((await api.get('/settings/audit-logs')).body)).not.toContain(action);
      const cols: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_audit_logs'`);
      expect(cols.map((c) => c.column_name)).not.toContain('companyId'); // it cannot be silently attributed to a company
    });

    it('RLS: a session scoped to A cannot read B\'s audit rows, nor INSERT one stamped with B\'s id', async () => {
      const ROLLBACK = new Error('__rollback__');
      let seen: string[] = [];
      try {
        await rlsClient.$transaction(async (tx) => {
          if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY`);
          await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
          seen = (await tx.$queryRawUnsafe<Array<{ companyId: string }>>(`SELECT DISTINCT "companyId" FROM audit_logs`)).map((r) => r.companyId);
          throw ROLLBACK;
        });
      } catch (e) { if (e !== ROLLBACK) throw e; }
      expect(seen).toEqual([A.company.id]);

      await expect(rlsClient.$transaction(async (tx) => {
        if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await tx.$executeRaw`INSERT INTO audit_logs (id, "companyId", "tableName", "recordId", "userId", action)
          VALUES (${'rls-' + suffix}, ${B.company.id}, 't', 'r', ${vasOnly.user.id}, 'CREATE')`;
      })).rejects.toThrow(/row-level security/i);
    });

    it('RLS covers the new membership tables: user_branch_access and company_invitations', async () => {
      for (const table of ['user_branch_access', 'company_invitations']) {
        const ROLLBACK = new Error('__rollback__');
        let seen: string[] = [];
        try {
          await rlsClient.$transaction(async (tx) => {
            if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
            await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
            seen = (await tx.$queryRawUnsafe<Array<{ companyId: string }>>(`SELECT DISTINCT "companyId" FROM "${table}"`)).map((r) => r.companyId);
            throw ROLLBACK;
          });
        } catch (e) { if (e !== ROLLBACK) throw e; }
        expect(seen.every((c) => c === A.company.id), table).toBe(true);
      }
    });
  });

  // ─── 8. Invitations ────────────────────────────────────────────────────────
  describe('invitations: membership is only ever created by an explicit, recipient-accepted invitation', () => {
    const NEW_PASSWORD = 'NewHire-Passw0rd!';
    let newHireToken: string;
    let newHireInvitationId: string;

    it('a company admin can invite; the response carries a one-time token, and only its hash is stored', async () => {
      const r = await apiA.post('/auth/invitations', {
        email: email('newhire'), roleId: A.role.id, branchIds: [A.branch.id, branchA2.id],
        employeeId: 'E-NEW', department: 'Dispatch', phone: '+91-NEW-HIRE', username: 'newhire',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      newHireToken = r.body.data.token;
      newHireInvitationId = r.body.data.id;
      expect(newHireToken.length).toBeGreaterThan(30);
      const row = await prisma.companyInvitation.findUniqueOrThrow({ where: { id: newHireInvitationId } });
      expect(row.tokenHash).not.toBe(newHireToken);
      expect(row.tokenHash).toBe(crypto.createHash('sha256').update(newHireToken).digest('hex'));
      expect(JSON.stringify((await apiA.get('/auth/invitations')).body)).not.toContain(newHireToken); // never retrievable again
      expect(row.companyId).toBe(A.company.id);
    });

    it('inviting the email of a login that exists in ANOTHER company: same response shape, and NO membership is created', async () => {
      const forNew = await apiA.post('/auth/invitations', { email: email('probe-new'), roleId: A.role.id });
      const forExisting = await apiA.post('/auth/invitations', { email: shrOnly.user.email, roleId: A.role.id });
      expect(forExisting.status).toBe(201);
      expect(forNew.status).toBe(201);
      expect(Object.keys(forExisting.body.data).sort()).toEqual(Object.keys(forNew.body.data).sort());
      expect(forExisting.body.data.status).toBe(forNew.body.data.status);
      // The old behaviour would have attached shrOnly to Company A right here. Now: nothing until they accept.
      expect(await prisma.companyUser.count({ where: { companyId: A.company.id, userId: shrOnly.user.id } })).toBe(0);
    });

    it('Company B cannot see, list or revoke Company A\'s invitations', async () => {
      expect(JSON.stringify((await apiB.get('/auth/invitations')).body)).not.toContain(email('newhire'));
      expect((await apiB.del(`/auth/invitations/${newHireInvitationId}`)).status).toBe(404);
      expect((await prisma.companyInvitation.findUniqueOrThrow({ where: { id: newHireInvitationId } })).status).toBe('PENDING');
    });

    it('inviting someone already in YOUR company, or reusing a taken employee id/username, is a 409 that concerns only your company', async () => {
      const dupMember = await apiA.post('/auth/invitations', { email: vasOnly.user.email, roleId: A.role.id });
      expect(dupMember.status).toBe(409);
      const dupEmp = await apiA.post('/auth/invitations', { email: email('dupemp'), roleId: A.role.id, employeeId: 'E001' });
      expect(dupEmp.status).toBe(409);
      expect(dupEmp.body.error).toBe('Employee ID is already in use in this company');
      const dupUser = await apiA.post('/auth/invitations', { email: email('dupuser'), roleId: A.role.id, username: 'ravi' });
      expect(dupUser.status).toBe(409);
    });

    it('accepting (public, unauthenticated) with a NEW email creates the login and the membership with the staged details', async () => {
      const r = await pub().post('/auth/invitations/accept', { token: newHireToken, name: 'New Hire', password: NEW_PASSWORD });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.company.code).toBe(A.company.code);

      const membership = await prisma.companyUser.findUniqueOrThrow({ where: { id: r.body.data.companyUserId }, include: { user: true } });
      expect(membership).toMatchObject({
        companyId: A.company.id, roleId: A.role.id, employeeId: 'E-NEW', department: 'Dispatch', phone: '+91-NEW-HIRE', username: 'newhire',
      });
      expect(membership.user.email).toBe(email('newhire'));
      const grants = await prisma.userBranchAccess.findMany({ where: { companyUserId: membership.id } });
      expect(grants.map((g) => g.branchId).sort()).toEqual([A.branch.id, branchA2.id].sort());
      expect(grants.every((g) => g.companyId === A.company.id)).toBe(true);

      // …and they can now sign in, into Company A only.
      const login = await pub().post('/auth/login', { companyCode: A.company.code, identifier: email('newhire'), password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect((await pub().post('/auth/login', { companyCode: B.company.code, identifier: email('newhire'), password: NEW_PASSWORD })).status).toBe(401);
    });

    it('a used token cannot be replayed', async () => {
      const again = await pub().post('/auth/invitations/accept', { token: newHireToken, name: 'Someone Else', password: 'Another-Passw0rd!' });
      expect(again.status).toBe(400);
      expect(again.body.error).toBe(GENERIC_INVALID);
      expect(await prisma.user.count({ where: { email: email('newhire') } })).toBe(1);
    });

    it('accepting for an EXISTING login requires that login\'s password; success links it without touching it or the other company', async () => {
      const inv = await apiA.post('/auth/invitations', {
        email: shrOnly.user.email, roleId: A.role.id, employeeId: 'E-SHR-IN-A', department: 'Loaned to Vasavi', branchIds: [A.branch.id],
      });
      const token = inv.body.data.token;

      const wrong = await pub().post('/auth/invitations/accept', { token, name: 'Attacker', password: 'not-their-password' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe(GENERIC_INVALID);
      expect(await prisma.companyUser.count({ where: { companyId: A.company.id, userId: shrOnly.user.id } })).toBe(0);

      const ok = await pub().post('/auth/invitations/accept', { token, name: 'Ignored New Name', password: shrOnly.password });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: shrOnly.user.id } });
      expect(user.name).toBe('Shree Only'); // global name is NOT overwritten by the invitation form
      expect((await pub().post('/auth/login', { companyCode: B.company.code, identifier: 'ravi', password: shrOnly.password })).status).toBe(200); // password unchanged
      const inA = await prisma.companyUser.findUniqueOrThrow({ where: { companyId_userId: { companyId: A.company.id, userId: shrOnly.user.id } } });
      const inB = await prisma.companyUser.findUniqueOrThrow({ where: { id: shrOnly.membership.id } });
      expect(inA).toMatchObject({ employeeId: 'E-SHR-IN-A', department: 'Loaned to Vasavi' });
      expect(inB).toMatchObject({ employeeId: 'E002', department: 'ShreeSecretDept', phone: '+91-SHREE-ONLY' }); // B's record untouched
      // Two memberships, two roles — company-specific:
      expect(inA.roleId).toBe(A.role.id);
      expect(inB.roleId).toBe(B.role.id);
    });

    it('EVERY failure returns the identical generic error — the endpoint cannot be used to discover who has an account', async () => {
      const expired = (await apiA.post('/auth/invitations', { email: email('expired'), roleId: A.role.id })).body.data;
      await prisma.companyInvitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const revoked = (await apiA.post('/auth/invitations', { email: email('revoked'), roleId: A.role.id })).body.data;
      expect((await apiA.del(`/auth/invitations/${revoked.id}`)).status).toBe(200);
      const shrTwo = await createMember({ companyId: B.company.id, roleId: B.role.id, email: email('shrtwo'), name: 'Shree Two', password: 'Shree-Two-Passw0rd!' });
      const existingLogin = (await apiA.post('/auth/invitations', { email: shrTwo.user.email, roleId: A.role.id })).body.data;

      const attempts = await Promise.all([
        pub().post('/auth/invitations/accept', { token: crypto.randomBytes(32).toString('base64url'), name: 'Nope', password: 'Whatever-123!' }), // unknown token
        pub().post('/auth/invitations/accept', { token: expired.token, name: 'Nope', password: 'Whatever-123!' }),                                // expired
        pub().post('/auth/invitations/accept', { token: revoked.token, name: 'Nope', password: 'Whatever-123!' }),                                // revoked
        pub().post('/auth/invitations/accept', { token: existingLogin.token, name: 'Nope', password: 'wrong-for-existing' }),                     // existing login, wrong password
        pub().post('/auth/invitations/accept', { token: newHireToken, name: 'Nope', password: 'Whatever-123!' }),                                  // already used
      ]);
      for (const r of attempts) {
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ success: false, error: GENERIC_INVALID });
      }
      expect(await prisma.companyUser.count({ where: { companyId: A.company.id, userId: shrTwo.user.id } })).toBe(0); // the failed accepts attached nothing
    });

    it('two simultaneous accepts of one token: exactly one wins, exactly one membership exists', async () => {
      const inv = (await apiA.post('/auth/invitations', { email: email('race'), roleId: A.role.id })).body.data;
      const [r1, r2] = await Promise.all([
        pub().post('/auth/invitations/accept', { token: inv.token, name: 'Racer One', password: 'Racer-Passw0rd-1!' }),
        pub().post('/auth/invitations/accept', { token: inv.token, name: 'Racer Two', password: 'Racer-Passw0rd-2!' }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 400]);
      expect(await prisma.user.count({ where: { email: email('race') } })).toBe(1);
      expect(await prisma.companyUser.count({ where: { companyId: A.company.id, user: { email: email('race') } } })).toBe(1);
    });

    it('a re-invite supersedes the earlier pending one (the old token stops working)', async () => {
      const first = (await apiA.post('/auth/invitations', { email: email('reinvite'), roleId: A.role.id })).body.data;
      const second = (await apiA.post('/auth/invitations', { email: email('reinvite'), roleId: A.role.id })).body.data;
      const old = await pub().post('/auth/invitations/accept', { token: first.token, name: 'Old Token', password: 'Reinvite-Passw0rd!' });
      expect(old.status).toBe(400);
      const fresh = await pub().post('/auth/invitations/accept', { token: second.token, name: 'Fresh Token', password: 'Reinvite-Passw0rd!' });
      expect(fresh.status).toBe(201);
    });

    it('invitation state is visible to its own company only, with EXPIRED computed', async () => {
      const list = (await apiA.get('/auth/invitations')).body.data as any[];
      expect(list.find((i) => i.email === email('expired'))?.status).toBe('EXPIRED');
      expect(list.find((i) => i.email === email('revoked'))?.status).toBe('REVOKED');
      expect(list.find((i) => i.email === email('newhire'))?.status).toBe('ACCEPTED');
      expect(list.every((i) => !('tokenHash' in i))).toBe(true);
    });
  });
});
