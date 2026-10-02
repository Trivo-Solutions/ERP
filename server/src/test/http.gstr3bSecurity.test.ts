import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';

describe('HTTP: G2g-7b GSTR-3B Outward Report Security (Auth, Permission, Registration, Branch, Tenant Isolation)', () => {
  const suffix = `g3bsec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let unprivilegedTenant: TestTenant;
  let regAId: string;
  let regBId: string;
  let branch2AId: string;
  let restrictedTokenA: string;

  const extraUserIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  beforeAll(async () => {
    // 1. Tenant A (Privileged)
    tenantA = await createTestTenant(`A-${suffix}`, ['report:financial_view']);

    // 2. Tenant B (Privileged, cross-company)
    tenantB = await createTestTenant(`B-${suffix}`, ['report:financial_view']);

    // 3. Unprivileged Tenant (missing report:financial_view)
    unprivilegedTenant = await createTestTenant(`U-${suffix}`, ['report:view']);

    // Registration for Tenant A
    const regA = await createGstRegistration(tenantA.ctx, {
      gstin: '24FFFFF6666F1Z5',
      legalName: 'Company A Reg',
      stateCode: '24',
      isPrimary: true,
      isActive: true,
    });
    regAId = regA.id;
    regRows.push({ id: regA.id, companyId: tenantA.company.id });

    // Registration for Tenant B
    const regB = await createGstRegistration(tenantB.ctx, {
      gstin: '24EEEEE5555E1Z5',
      legalName: 'Company B Reg',
      stateCode: '24',
      isPrimary: true,
      isActive: true,
    });
    regBId = regB.id;
    regRows.push({ id: regB.id, companyId: tenantB.company.id });

    // Branch 2 on Tenant A
    const b2 = await addBranch(tenantA.company.id, `2-${suffix}`);
    branch2AId = b2.id;

    // Restricted member on Tenant A granted ONLY primary branch
    const member = await createMember({
      companyId: tenantA.company.id,
      roleId: tenantA.role.id,
      email: `g3bsec-restr-${suffix}@example.com`,
      allBranches: false,
    });
    extraUserIds.push(member.user.id);
    await grantBranchAccess(tenantA.ctx, member.membership.id, tenantA.branch.id);
    restrictedTokenA = jwt.sign(
      {
        userId: member.user.id,
        email: member.user.email,
        companyId: tenantA.company.id,
        companyUserId: member.membership.id,
        roleId: tenantA.role.id,
        roleName: tenantA.role.name,
        permissions: tenantA.role.permissions,
        branchAccess: { allBranches: false, branchIds: [tenantA.branch.id] },
      },
      env.JWT_SECRET,
      { expiresIn: '1h' },
    );
  });

  afterAll(async () => {
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) =>
        tx.companyGstRegistration.deleteMany({ where: { id: r.id } })
      );
    }
    await cleanupTestTenant(tenantA);
    await cleanupTestTenant(tenantB);
    await cleanupTestTenant(unprivilegedTenant);
    for (const id of extraUserIds) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  });

  const path = '/finance/reports/gstr3b-outward';

  it('1. unauthenticated request is rejected (401)', async () => {
    const res = await apiWith('', app).get(path);
    expect(res.status).toBe(401);
  });

  it('2. missing report:financial_view permission is rejected (403)', async () => {
    const res = await apiWith(tokenFor(unprivilegedTenant), app).get(path);
    expect(res.status).toBe(403);
  });

  it('3. missing gstRegistrationId is rejected (400)', async () => {
    const res = await apiWith(tokenFor(tenantA), app).get(path);
    expect(res.status).toBe(400);
  });

  it('4. cross-company gstRegistrationId is rejected (404); same-company succeeds (200)', async () => {
    // Tenant A querying Tenant B's registration -> 404
    const crossCompany = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regBId}&taxPeriod=092026`
    );
    expect(crossCompany.status).toBe(404);

    // Tenant A querying its own registration -> 200
    const sameCompany = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regAId}&taxPeriod=092026`
    );
    expect(sameCompany.status).toBe(200);
    expect(sameCompany.body.success).toBe(true);
    expect(sameCompany.body.data).toHaveProperty('meta');
    expect(sameCompany.body.data).toHaveProperty('table31');
    expect(sameCompany.body.data).toHaveProperty('table32');
    expect(sameCompany.body.data.meta.gstRegistrationId).toBe(regAId);
    expect(sameCompany.body.data.meta.isCompleteGstinScope).toBe(true);
  });

  it('5. inaccessible or cross-company branchId is rejected (404); granted branch succeeds with partial scope diagnostic', async () => {
    // Inaccessible branch on Tenant A (restricted token only has primary branch, not branch2A)
    const inaccessible = await apiWith(restrictedTokenA, app).get(
      `${path}?gstRegistrationId=${regAId}&branchId=${branch2AId}&taxPeriod=092026`
    );
    expect(inaccessible.status).toBe(404);

    // Cross-company branch from Tenant B
    const crossCompanyBranch = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regAId}&branchId=${tenantB.branch.id}&taxPeriod=092026`
    );
    expect(crossCompanyBranch.status).toBe(404);

    // Accessible branch on Tenant A -> 200 with PARTIAL_BRANCH_SCOPE
    const accessible = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regAId}&branchId=${tenantA.branch.id}&taxPeriod=092026`
    );
    expect(accessible.status).toBe(200);
    expect(accessible.body.success).toBe(true);
    expect(accessible.body.data.meta.isCompleteGstinScope).toBe(false);
    expect(accessible.body.data.meta.partialScopeReason).toBe('PARTIAL_BRANCH_SCOPE');
    const branchDiag = accessible.body.data.diagnostics.find(
      (d: { code: string }) => d.code === 'PARTIAL_BRANCH_SCOPE'
    );
    expect(branchDiag).toBeDefined();
  });

  it('6. rejects invalid date/taxPeriod parameters (400)', async () => {
    // Invalid taxPeriod format
    const badPeriod = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regAId}&taxPeriod=bad_period`
    );
    expect(badPeriod.status).toBe(400);

    // Inverted dates (from > to)
    const invertedDates = await apiWith(tokenFor(tenantA), app).get(
      `${path}?gstRegistrationId=${regAId}&from=2026-09-30&to=2026-09-01`
    );
    expect(invertedDates.status).toBe(400);
  });
});
