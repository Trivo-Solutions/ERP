import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { saveAato } from '../modules/gst/aato.service';
import { tenantQuery } from '../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../shared/financialYear';

// G2g-4c-4 — proves the branch-access, registration-ownership, required-field, date-range, and
// permission checks are actually enforced by the router (finance.router.ts's new
// /reports/gstr1-export route) over real HTTP — the one thing gstr1Export.service.test.ts cannot
// cover, since it calls buildGstr1GstnExport() directly with an already-trusted TenantContext and
// never exercises requirePermission/resolveTenantContext. Mirrors http.gstr1Security.test.ts's own
// conventions exactly (same fixtures, same tenant/branch helpers).
describe('HTTP: G2g-4c-4 GSTR-1 GSTN export security', () => {
  const suffix = `g4c4sec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  // company_gst_registrations (and its AATO children) are FORCE-RLS even for the platform/owner
  // test role — deletion must go through tenantQuery (companyId-scoped).
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
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
      email: `g4c4sec-${label}-${suffix}@example.com`, allBranches: false,
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

  const path = '/finance/reports/gstr1-export';

  it('unauthenticated / unpermissioned requests are rejected', async () => {
    const noAuth = await apiWith(undefined, app).get(`${path}?gstRegistrationId=whatever&from=2026-04-01&to=2026-04-30`);
    expect(noAuth.status).toBe(401);

    const A = await createTestTenant(`NP${suffix}`, []); // no report:financial_view
    cleanupTenants.push(A);
    const noPerm = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=whatever&from=2026-04-01&to=2026-04-30`);
    expect(noPerm.status).toBe(403);
  });

  it('missing gstRegistrationId/from/to and a malformed or inverted date range are all rejected (400)', async () => {
    const A = await tenantWith('M');

    const noReg = await apiWith(tokenFor(A), app).get(`${path}?from=2026-04-01&to=2026-04-30`);
    expect(noReg.status).toBe(400);

    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'M Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });

    const noFrom = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${reg.id}&to=2026-04-30`);
    expect(noFrom.status).toBe(400);

    const noTo = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${reg.id}&from=2026-04-01`);
    expect(noTo.status).toBe(400);

    const malformed = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${reg.id}&from=not-a-date&to=2026-04-30`);
    expect(malformed.status).toBe(400);

    const inverted = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${reg.id}&from=2026-05-01&to=2026-04-01`);
    expect(inverted.status).toBe(400);
  });

  it('a cross-company gstRegistrationId is rejected (404); a nonexistent one is rejected (404); a same-company one is accepted', async () => {
    const A = await tenantWith('R1');
    const B = await tenantWith('R2');
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z4', legalName: 'Company B Reg', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regB.id}&from=2026-04-01&to=2026-04-30`);
    expect(crossCompany.status).toBe(404);

    const nonexistent = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=does-not-exist&from=2026-04-01&to=2026-04-30`);
    expect(nonexistent.status).toBe(404);

    const regA = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    // No AATO on file — the frozen validator blocks this (AATO_PRECEDING_FY_NOT_VERIFIED), but that
    // is a 400-with-diagnostics response, never a 404 — ownership passed, so the pipeline ran.
    const sameCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=2026-04-01&to=2026-04-30`);
    expect(sameCompany.status).toBe(400);
    expect(sameCompany.body.success).toBe(false);
    expect(Array.isArray(sameCompany.body.blockers)).toBe(true);
  });

  it('an inaccessible or cross-company branchId is rejected (404); the caller\'s own granted branch is accepted past the access-control layer', async () => {
    const A = await tenantWith('B1');
    const B = await tenantWith('B2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Company A Reg B', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const branch2 = await addBranch(A.company.id, suffix);
    const restricted = await restrictedTokenFor(A, A.branch.id, 'r');

    const inaccessible = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${branch2.id}&from=2026-04-01&to=2026-04-30`);
    expect(inaccessible.status).toBe(404);

    const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${B.branch.id}&from=2026-04-01&to=2026-04-30`);
    expect(crossCompany.status).toBe(404);

    // Own granted branch passes the access-control layer — it is then filing-validation-blocked
    // (PARTIAL_BRANCH_SCOPE, a branch-scoped export is never a complete filing) rather than a 404 —
    // proving access control and filing validation are two distinct layers, not conflated.
    const ownBranch = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${A.branch.id}&from=2026-04-01&to=2026-04-30`);
    expect(ownBranch.status).toBe(400);
    expect(ownBranch.body.blockers.some((b: { code: string }) => b.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
  });

  it('a complete, filing-grade export (AATO verified, company-wide scope) downloads the exact GSTN JSON unwrapped, with safe headers', async () => {
    const A = await tenantWith('OK');
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'OK Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });

    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const precedingFy = getPrecedingFinancialYear(fy);
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const from = `${fy.slice(0, 4)}-04-01`;
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${reg.id}&from=${from}&to=${now.toISOString()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="GSTR1_24AAAAA0000A1Z8_/);
    expect(res.headers['content-disposition']).not.toMatch(/[\\/]/);
    // No application wrapper — the body IS the GSTN payload (never {success, data: {...}}).
    expect(res.body).not.toHaveProperty('success');
    expect(res.body.gstin).toBe('24AAAAA0000A1Z8');
    expect(typeof res.body.fp).toBe('string');
  });
});
