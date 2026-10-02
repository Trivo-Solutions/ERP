import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

// G2g-7e — proves the registration-ownership, branch-access, and permission checks on the two new
// GSTR-2B routes are actually enforced by the router over real HTTP — mirrors
// http.gstr3bRcmSecurity.test.ts's own conventions exactly.
describe('HTTP: G2g-7e GSTR-2B import/reconciliation security', () => {
  const suffix = `g7esec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const t of cleanupTenants) {
      await tenantQuery(t.company.id, (tx) => tx.gst2bDocument.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.gst2bStatement.deleteMany({ where: { companyId: t.company.id } }));
    }
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
    const member = await createMember({ companyId: t.company.id, roleId: t.role.id, email: `g7esec-${label}-${suffix}@example.com`, allBranches: false });
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

  function samplePayload(gstin: string, taxPeriod: string) {
    return { gstin, fp: taxPeriod, data: { gstin, rtnprd: taxPeriod, docdata: { b2b: [] } } };
  }

  describe('POST /finance/gstr2b/import', () => {
    it('missing gstRegistrationId is rejected (400)', async () => {
      const A = await tenantWith('IM1', ['report:financial_view']);
      const res = await apiWith(tokenFor(A), app).post('/finance/gstr2b/import').send(samplePayload('24AAAAA0000A1Z5', '092026'));
      expect(res.status).toBe(400);
    });

    it('a cross-company gstRegistrationId is rejected; a same-company one succeeds', async () => {
      const A = await tenantWith('IM2', ['report:financial_view']);
      const B = await tenantWith('IM3', ['report:financial_view']);
      const regB = await createGstRegistration(B.ctx, { gstin: '24HHHHH8888H1Z5', legalName: 'Company B Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regB.id, companyId: B.company.id });

      const crossCompany = await apiWith(tokenFor(A), app).post(`/finance/gstr2b/import?gstRegistrationId=${regB.id}`).send(samplePayload('24HHHHH8888H1Z5', '092026'));
      expect(crossCompany.status).toBe(404);

      const regA = await createGstRegistration(A.ctx, { gstin: '24IIIII9999I1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });
      const sameCompany = await apiWith(tokenFor(A), app).post(`/finance/gstr2b/import?gstRegistrationId=${regA.id}`).send(samplePayload('24IIIII9999I1Z5', '092026'));
      expect(sameCompany.status).toBe(201);
      expect(sameCompany.body.success).toBe(true);
      expect(sameCompany.body.data).toHaveProperty('statementId');
    });

    it('rejects a statement whose GSTIN does not match the registration (400)', async () => {
      const A = await tenantWith('IM4', ['report:financial_view']);
      const regA = await createGstRegistration(A.ctx, { gstin: '24JJJJJ1111J1Z5', legalName: 'Co A', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });
      const res = await apiWith(tokenFor(A), app).post(`/finance/gstr2b/import?gstRegistrationId=${regA.id}`).send(samplePayload('27WRONGG0000W1Z1', '092026'));
      expect(res.status).toBe(400);
    });

    it('unauthenticated / unpermissioned requests are rejected', async () => {
      const noAuth = await apiWith(undefined, app).post('/finance/gstr2b/import?gstRegistrationId=whatever').send({});
      expect(noAuth.status).toBe(401);

      const A = await tenantWith('IM5', []); // no report:financial_view
      const noPerm = await apiWith(tokenFor(A), app).post('/finance/gstr2b/import?gstRegistrationId=whatever').send({});
      expect(noPerm.status).toBe(403);
    });
  });

  describe('GET /finance/reports/gstr2b-reconciliation', () => {
    it('missing gstRegistrationId or taxPeriod is rejected (400)', async () => {
      const A = await tenantWith('RC1', ['report:financial_view']);
      const regA = await createGstRegistration(A.ctx, { gstin: '24KKKKK2222K1Z5', legalName: 'Co A', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });

      const noReg = await apiWith(tokenFor(A), app).get('/finance/reports/gstr2b-reconciliation?taxPeriod=092026');
      expect(noReg.status).toBe(400);

      const noPeriod = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regA.id}`);
      expect(noPeriod.status).toBe(400);
    });

    it('a cross-company gstRegistrationId is rejected; a same-company one succeeds', async () => {
      const A = await tenantWith('RC2', ['report:financial_view']);
      const B = await tenantWith('RC3', ['report:financial_view']);
      const regB = await createGstRegistration(B.ctx, { gstin: '24LLLLL3333L1Z5', legalName: 'Company B Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regB.id, companyId: B.company.id });
      const regA = await createGstRegistration(A.ctx, { gstin: '24MMMMM4444M1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });

      const crossCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regB.id}&taxPeriod=092026`);
      expect(crossCompany.status).toBe(404);

      const sameCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regA.id}&taxPeriod=092026`);
      expect(sameCompany.status).toBe(200);
      expect(sameCompany.body.success).toBe(true);
      expect(sameCompany.body.data).toHaveProperty('summary');
    });

    it('an inaccessible or cross-company branchId is rejected; the caller\'s own granted branch succeeds', async () => {
      const A = await tenantWith('RC4', ['report:financial_view']);
      const B = await tenantWith('RC5', ['report:financial_view']);
      const regA = await createGstRegistration(A.ctx, { gstin: '24NNNNN5555N1Z5', legalName: 'Co A', stateCode: '24', isPrimary: true, isActive: true });
      regRows.push({ id: regA.id, companyId: A.company.id });
      const branch2 = await addBranch(A.company.id, suffix);
      const restricted = await restrictedTokenFor(A, A.branch.id, 'r2');

      const inaccessible = await apiWith(restricted, app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regA.id}&taxPeriod=092026&branchId=${branch2.id}`);
      expect(inaccessible.status).toBe(404);

      const crossCompany = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regA.id}&taxPeriod=092026&branchId=${B.branch.id}`);
      expect(crossCompany.status).toBe(404);

      const ownBranch = await apiWith(restricted, app).get(`/finance/reports/gstr2b-reconciliation?gstRegistrationId=${regA.id}&taxPeriod=092026&branchId=${A.branch.id}`);
      expect(ownBranch.status).toBe(200);
    });

    it('unauthenticated / unpermissioned requests are rejected', async () => {
      const noAuth = await apiWith(undefined, app).get('/finance/reports/gstr2b-reconciliation?gstRegistrationId=whatever&taxPeriod=092026');
      expect(noAuth.status).toBe(401);

      const A = await tenantWith('RC6', []);
      const noPerm = await apiWith(tokenFor(A), app).get('/finance/reports/gstr2b-reconciliation?gstRegistrationId=whatever&taxPeriod=092026');
      expect(noPerm.status).toBe(403);
    });
  });
});
