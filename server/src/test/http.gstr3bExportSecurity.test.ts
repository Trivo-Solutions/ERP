import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';

// G2g-7g — proves GET /finance/reports/gstr3b-export enforces the same security contract every
// sibling GST report route already does: authentication, report:financial_view permission, GST
// registration ownership, branch access, and basic tax-period validation — exercised over real HTTP,
// mirroring http.gstr3bReconciliationSecurity.test.ts's own proven pattern exactly.
describe('HTTP: G2g-7g GSTR-3B export security', () => {
  const suffix = `g7gxsec${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const r of regRows) await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    for (const id of extraUserIds) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  });

  let gstinCounter = 0;
  async function tenantWith(tag: string, permissions: string[] = ['report:financial_view']) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    const n = String(++gstinCounter).padStart(4, '0');
    const reg = await createGstRegistration(t.ctx, { gstin: `24AAAAA${n}A1Z5`, legalName: `${tag} Reg`, stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: t.company.id });
    return { t, regId: reg.id };
  }

  async function restrictedTokenFor(t: TestTenant, grantedBranchId: string, label: string) {
    const member = await createMember({ companyId: t.company.id, roleId: t.role.id, email: `g7gxsec-${label}-${suffix}@example.com`, allBranches: false });
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

  it('401s without authentication', async () => {
    const { regId } = await tenantWith('G7GX1');
    const res = await apiWith(undefined, app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026`);
    expect(res.status).toBe(401);
  });

  it('403s for a caller without report:financial_view', async () => {
    const { t, regId } = await tenantWith('G7GX2', ['invoice:create']);
    const res = await apiWith(tokenFor(t), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026`);
    expect(res.status).toBe(403);
  });

  it('400s without gstRegistrationId', async () => {
    const { t } = await tenantWith('G7GX3');
    const res = await apiWith(tokenFor(t), app).get('/finance/reports/gstr3b-export?taxPeriod=092026');
    expect(res.status).toBe(400);
  });

  it('400s without taxPeriod', async () => {
    const { t, regId } = await tenantWith('G7GX4');
    const res = await apiWith(tokenFor(t), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}`);
    expect(res.status).toBe(400);
  });

  it('a cross-company gstRegistrationId cannot be used', async () => {
    const { t: A } = await tenantWith('G7GX5A');
    const { regId: regB } = await tenantWith('G7GX5B');
    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regB}&taxPeriod=092026`);
    expect(res.status).toBe(404);
  });

  it('a same-company gstRegistrationId with valid taxPeriod succeeds', async () => {
    const { t, regId } = await tenantWith('G7GX6');
    const res = await apiWith(tokenFor(t), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026`);
    expect(res.status).toBe(200);
    expect(res.body.data.export.metadata.gstRegistrationId).toBe(regId);
    expect(typeof res.body.data.validation.isFilingReady).toBe('boolean');
  });

  it('a cross-company branchId cannot bypass company isolation', async () => {
    const { t: A, regId } = await tenantWith('G7GX7A');
    const { t: B } = await tenantWith('G7GX7B');
    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026&branchId=${B.branch.id}`);
    expect(res.status).toBe(404);
  });

  it('a restricted caller\'s own granted branchId succeeds, but a non-granted branch in the same company is rejected', async () => {
    const { t: A, regId } = await tenantWith('G7GX8');
    const branch2 = await addBranch(A.company.id, `G7GX8-2-${suffix}`);
    const grantedToken = await restrictedTokenFor(A, A.branch.id, 'r1');
    const ok = await apiWith(grantedToken, app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026&branchId=${A.branch.id}`);
    expect(ok.status).toBe(200);
    const rejected = await apiWith(grantedToken, app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=092026&branchId=${branch2.id}`);
    expect(rejected.status).toBe(404);
  });

  it('an invalid taxPeriod is rejected with 400', async () => {
    const { t, regId } = await tenantWith('G7GX9');
    const res = await apiWith(tokenFor(t), app).get(`/finance/reports/gstr3b-export?gstRegistrationId=${regId}&taxPeriod=notaperiod`);
    expect(res.status).toBe(400);
  });
});
