import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';

// G2g-2: proves the branch-access and gstRegistrationId ownership checks are actually enforced by
// the router (finance.router.ts), over real HTTP — the one thing the service-level tests in
// finance.service.test.ts cannot cover, since those call getGstSummary/getPurchaseGstSummary
// directly with already-trusted opts and never exercise assertBranchAccessible/assertOwnedIfPresent.
describe('HTTP: G2g-2 GST report branch + registration security', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  // company_gst_registrations is FORCE-RLS even for the platform/owner test role (G1 migration) —
  // deletion must go through tenantQuery (companyId-scoped), so each row's own company is tracked.
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const r of regRows) await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    for (const id of extraUserIds) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string) {
    const t = await createTestTenant(`${tag}${suffix}`, ['report:financial_view']);
    cleanupTenants.push(t);
    return t;
  }

  /** A restricted (allBranches:false) membership + signed token, granted only `grantedBranchId`. */
  async function restrictedTokenFor(t: TestTenant, grantedBranchId: string, label: string) {
    const member = await createMember({
      companyId: t.company.id, roleId: t.role.id,
      email: `gstsec-${label}-${suffix}@example.com`, allBranches: false,
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

  it('branch access (test 8): a branch that exists in the company but the caller has no grant to is rejected', async () => {
    const A = await tenantWith('GSA1');
    const branch2 = await addBranch(A.company.id, `GSA1-2-${suffix}`);
    const token = await restrictedTokenFor(A, A.branch.id, 'r1'); // granted only branch 1, not branch2

    const res = await apiWith(token, app).get(`/finance/reports/gst-summary?branchId=${branch2.id}`);
    expect(res.status).toBe(404);
  });

  it('branch access: a restricted caller\'s own granted branchId succeeds', async () => {
    const A = await tenantWith('GSA2');
    const token = await restrictedTokenFor(A, A.branch.id, 'r2');

    const res = await apiWith(token, app).get(`/finance/reports/gst-summary?branchId=${A.branch.id}`);
    expect(res.status).toBe(200);
  });

  it('branch access (test 9): a cross-company branchId cannot bypass company isolation', async () => {
    const A = await tenantWith('GSA3');
    const B = await tenantWith('GSB3');

    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/gst-summary?branchId=${B.branch.id}`);
    expect(res.status).toBe(404);
  });

  it('GST registration (test 3): a cross-company gstRegistrationId cannot be used', async () => {
    const A = await tenantWith('GSA4');
    const B = await tenantWith('GSB4');
    const regB = await createGstRegistration(B.ctx, { gstin: '24CCCCC3333C1Z5', legalName: 'Company B Registration', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/gst-summary?gstRegistrationId=${regB.id}`);
    expect(res.status).toBe(404);
  });

  it('a same-company gstRegistrationId succeeds', async () => {
    const A = await tenantWith('GSA6');
    const regA = await createGstRegistration(A.ctx, { gstin: '24DDDDD4444D1Z5', legalName: 'Company A Registration', stateCode: '24', isPrimary: false, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });

    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/gst-summary?gstRegistrationId=${regA.id}`);
    expect(res.status).toBe(200);
  });

  it('the purchase-side report enforces the same branch isolation', async () => {
    const A = await tenantWith('GSA5');
    const B = await tenantWith('GSB5');

    const res = await apiWith(tokenFor(A), app).get(`/finance/reports/purchase-gst-summary?branchId=${B.branch.id}`);
    expect(res.status).toBe(404);
  });
});
