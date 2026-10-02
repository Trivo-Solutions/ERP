import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

// G2g-7d — proves the branch-access, registration-ownership, and permission checks on the new
// RCM report/liability routes are actually enforced by the router, over real HTTP — the one thing
// the service-level tests (gstr3bRcmBooking.test.ts) cannot cover, since those call the service
// functions directly with already-trusted TenantContext objects. Mirrors
// http.gstr1Security.test.ts's own conventions exactly.
describe('HTTP: G2g-7d RCM report/liability branch + registration + permission security', () => {
  const suffix = `g7dsec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const r of regRows) await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    for (const id of extraUserIds) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, perms: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, perms);
    cleanupTenants.push(t);
    return t;
  }

  async function restrictedTokenFor(t: TestTenant, grantedBranchId: string, label: string) {
    const member = await createMember({
      companyId: t.company.id, roleId: t.role.id,
      email: `g7dsec-${label}-${suffix}@example.com`, allBranches: false,
    });
    extraUserIds.push(member.user.id);
    await grantBranchAccess(t.ctx, member.membership.id, grantedBranchId);
    return jwt.sign(
      {
        userId: member.user.id, email: member.user.email, companyId: t.company.id, companyUserId: member.membership.id,
        roleId: t.role.id, roleName: t.role.name, permissions: t.role.permissions,
        branchAccess: { allBranches: false, branchIds: [grantedBranchId] },
      },
      env.JWT_SECRET, { expiresIn: '1h' },
    );
  }

  describe('GET /finance/reports/gstr3b-rcm', () => {
    it('missing gstRegistrationId is rejected (400), never silently defaulted', async () => {
      const A = await tenantWith('M', ['report:financial_view']);
      const res = await apiWith(tokenFor(A), app).get('/finance/reports/gstr3b-rcm');
      expect(res.status).toBe(400);
    });

    it('a cross-company gstRegistrationId is rejected; a same-company one succeeds', async () => {
      const A = await tenantWith('R1', ['report:financial_view']);
      const B = await tenantWith('R2', ['report:financial_view']);
      const regB = await createGstRegistration(B.ctx, { gstin: '24EEEEE5555E1Z5', legalName: 'Company B Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regB.id, companyId: B.company.id });

      const crossCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr3b-rcm?gstRegistrationId=${regB.id}`);
      expect(crossCompany.status).toBe(404);

      const regA = await createGstRegistration(A.ctx, { gstin: '24FFFFF6666F1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });
      const sameCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr3b-rcm?gstRegistrationId=${regA.id}`);
      expect(sameCompany.status).toBe(200);
      expect(sameCompany.body.success).toBe(true);
      expect(sameCompany.body.data).toHaveProperty('table3_1d');
      expect(sameCompany.body.data).toHaveProperty('table4A3');
    });

    it('an inaccessible or cross-company branchId is rejected; the caller\'s own granted branch succeeds', async () => {
      const A = await tenantWith('B1', ['report:financial_view']);
      const B = await tenantWith('B2', ['report:financial_view']);
      const regA = await createGstRegistration(A.ctx, { gstin: '24GGGGG7777G1Z5', legalName: 'Company A Reg B', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });
      const branch2 = await addBranch(A.company.id, suffix);
      const restricted = await restrictedTokenFor(A, A.branch.id, 'r');

      const inaccessible = await apiWith(restricted, app).get(`/finance/reports/gstr3b-rcm?gstRegistrationId=${regA.id}&branchId=${branch2.id}`);
      expect(inaccessible.status).toBe(404);

      const crossCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr3b-rcm?gstRegistrationId=${regA.id}&branchId=${B.branch.id}`);
      expect(crossCompany.status).toBe(404);

      const ownBranch = await apiWith(restricted, app).get(`/finance/reports/gstr3b-rcm?gstRegistrationId=${regA.id}&branchId=${A.branch.id}`);
      expect(ownBranch.status).toBe(200);
    });

    it('unauthenticated / unpermissioned requests are rejected', async () => {
      const noAuth = await apiWith(undefined, app).get('/finance/reports/gstr3b-rcm?gstRegistrationId=whatever');
      expect(noAuth.status).toBe(401);

      const A = await tenantWith('NP', []); // no report:financial_view
      const noPerm = await apiWith(tokenFor(A), app).get('/finance/reports/gstr3b-rcm?gstRegistrationId=whatever');
      expect(noPerm.status).toBe(403);
    });
  });

  describe('GET /finance/rcm-liabilities', () => {
    it('requires report:financial_view', async () => {
      const A = await tenantWith('L1', []);
      const noPerm = await apiWith(tokenFor(A), app).get('/finance/rcm-liabilities');
      expect(noPerm.status).toBe(403);

      const B = await tenantWith('L2', ['report:financial_view']);
      const ok = await apiWith(tokenFor(B), app).get('/finance/rcm-liabilities');
      expect(ok.status).toBe(200);
      expect(ok.body.data.rows).toEqual([]);
    });
  });

  describe('POST /finance/rcm-liabilities/:id/mark-paid', () => {
    it('requires journal:create', async () => {
      const A = await tenantWith('P1', ['report:financial_view']); // no journal:create
      const res = await apiWith(tokenFor(A), app).post('/finance/rcm-liabilities/whatever/mark-paid').send({ mode: 'CASH' });
      expect(res.status).toBe(403);
    });

    it('requires a payment mode (400) and 404s on a nonexistent id for an authorized caller', async () => {
      const A = await tenantWith('P2', ['journal:create']);
      const missingMode = await apiWith(tokenFor(A), app).post('/finance/rcm-liabilities/whatever/mark-paid').send({});
      expect(missingMode.status).toBe(400);

      const notFound = await apiWith(tokenFor(A), app).post('/finance/rcm-liabilities/whatever/mark-paid').send({ mode: 'CASH' });
      expect(notFound.status).toBe(404);
    });
  });
});
