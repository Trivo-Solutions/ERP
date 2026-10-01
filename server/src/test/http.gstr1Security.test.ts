import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { createInvoice } from '../modules/sales/sales.service';
import { tenantQuery } from '../shared/tenantContext';

// G2g-3e — proves the branch-access, registration-ownership, and required-field checks are
// actually enforced by the router (finance.router.ts's new /reports/gstr1-outward and
// /reports/gstr1-credit-notes routes), over real HTTP — the one thing the service-level tests in
// gstr1Reporting.service.test.ts cannot cover, since those call the service functions directly
// with already-trusted arguments and never exercise assertBranchAccessible/assertOwnedByCompany or
// the requirePermission gate. Mirrors http.gstReportSecurity.test.ts's own conventions exactly.
describe('HTTP: G2g-3e GSTR-1 report branch + registration + permission security', () => {
  const suffix = `g3esec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
  // company_gst_registrations is FORCE-RLS even for the platform/owner test role — deletion must
  // go through tenantQuery (companyId-scoped), so each row's own company is tracked.
  const regRows: Array<{ id: string; companyId: string }> = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const clientIds: string[] = [];

  afterAll(async () => {
    for (const r of regRows) await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    for (const id of extraUserIds) await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string) {
    const t = await createTestTenant(`${tag}${suffix}`, ['report:financial_view', 'invoice:create']);
    cleanupTenants.push(t);
    return t;
  }

  /** A restricted (allBranches:false) membership + signed token, granted only `grantedBranchId`. */
  async function restrictedTokenFor(t: TestTenant, grantedBranchId: string, label: string) {
    const member = await createMember({
      companyId: t.company.id, roleId: t.role.id,
      email: `g3esec-${label}-${suffix}@example.com`, allBranches: false,
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

  for (const [pathIndex, path] of ['/finance/reports/gstr1-outward', '/finance/reports/gstr1-credit-notes', '/finance/reports/gstr1-table12'].entries()) {
    describe(`${path}`, () => {
      it('3. missing gstRegistrationId is rejected (400), never silently defaulted', async () => {
        const A = await tenantWith(`M${pathIndex}`);
        const res = await apiWith(tokenFor(A), app).get(path);
        expect(res.status).toBe(400);
      });

      it('2/1. a cross-company gstRegistrationId is rejected; a same-company one succeeds', async () => {
        const A = await tenantWith(`R1${pathIndex}`);
        const B = await tenantWith(`R2${pathIndex}`);
        const regB = await createGstRegistration(B.ctx, { gstin: '24EEEEE5555E1Z5', legalName: 'Company B Reg', stateCode: '24', isPrimary: true, isActive: true });
        regRows.push({ id: regB.id, companyId: B.company.id });

        const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regB.id}`);
        expect(crossCompany.status).toBe(404);

        const regA = await createGstRegistration(A.ctx, { gstin: '24FFFFF6666F1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
        regRows.push({ id: regA.id, companyId: A.company.id });
        const sameCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}`);
        expect(sameCompany.status).toBe(200);
        expect(sameCompany.body.success).toBe(true);
        expect(sameCompany.body.data).toHaveProperty('meta');
      });

      it('7/8. an inaccessible or cross-company branchId is rejected; the caller\'s own granted branch succeeds', async () => {
        const A = await tenantWith(`B1${pathIndex}`);
        const B = await tenantWith(`B2${pathIndex}`);
        const regA = await createGstRegistration(A.ctx, { gstin: '24GGGGG7777G1Z5', legalName: 'Company A Reg B', stateCode: '24', isPrimary: true, isActive: true });
        regRows.push({ id: regA.id, companyId: A.company.id });
        const branch2 = await addBranch(A.company.id, `${pathIndex}-${suffix}`);
        const restricted = await restrictedTokenFor(A, A.branch.id, `${pathIndex}r`); // granted only A's primary branch

        const inaccessible = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${branch2.id}`);
        expect(inaccessible.status).toBe(404);

        const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${B.branch.id}`);
        expect(crossCompany.status).toBe(404);

        const ownBranch = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${A.branch.id}`);
        expect(ownBranch.status).toBe(200);
      });

      it('unauthenticated / unpermissioned requests are rejected', async () => {
        const noAuth = await apiWith(undefined, app).get(`${path}?gstRegistrationId=whatever`);
        expect(noAuth.status).toBe(401);

        const A = await createTestTenant(`NP${pathIndex}${suffix}`, []); // no report:financial_view
        cleanupTenants.push(A);
        const noPerm = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=whatever`);
        expect(noPerm.status).toBe(403);
      });
    });
  }

  it('17. tenant isolation: a fresh company sees zero GSTR-1 activity even when another company has invoices in the same period', async () => {
    const A = await tenantWith('ISO1');
    const B = await tenantWith('ISO2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24HHHHH8888H1Z5', legalName: 'Company A Iso Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const regB = await createGstRegistration(B.ctx, { gstin: '24JJJJJ9999J1Z5', legalName: 'Company B Iso Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const client = await prisma.client.create({
      data: { companyId: A.company.id, clientCode: `TSTCL-ISO-${suffix}`, name: 'Iso Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientIds.push(client.id);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-ISO-${suffix}`, companyId: A.company.id, branchId: A.branch.id,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: 4000, sellingPrice: 5000, createdById: A.user.id,
      },
    });
    tagIds.push(tag.id);
    const invoiceDate = new Date();
    const invoice = await createInvoice(
      {
        branchId: A.branch.id, clientId: client.id, invoiceDate, invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 5000, tagId: tag.id }],
      },
      A.ctx, A.user.id,
    );
    invoiceIds.push(invoice.id);

    const from = new Date(invoiceDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(invoiceDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

    // Company A, scoped to its own registration, sees the invoice (sanity: the fixture is real).
    const resA = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr1-outward?gstRegistrationId=${regA.id}&from=${from}&to=${to}`);
    expect(resA.status).toBe(200);
    expect(resA.body.data.meta.invoicesConsidered).toBeGreaterThan(0);

    // Company B, scoped to ITS OWN registration and the identical date window, sees nothing of A's data.
    const resB = await apiWith(tokenFor(B), app).get(`/finance/reports/gstr1-outward?gstRegistrationId=${regB.id}&from=${from}&to=${to}`);
    expect(resB.status).toBe(200);
    expect(resB.body.data.meta.invoicesConsidered).toBe(0);
    expect(resB.body.data.b2b).toHaveLength(0);
    expect(resB.body.data.b2cl).toHaveLength(0);
    expect(resB.body.data.b2cs).toHaveLength(0);

    const resBCn = await apiWith(tokenFor(B), app).get(`/finance/reports/gstr1-credit-notes?gstRegistrationId=${regB.id}&from=${from}&to=${to}`);
    expect(resBCn.status).toBe(200);
    expect(resBCn.body.data.meta.notesConsidered).toBe(0);

    // G2g-3f: Table 12 shares the identical loading layer — same isolation guarantee re-verified here.
    const resATable12 = await apiWith(tokenFor(A), app).get(`/finance/reports/gstr1-table12?gstRegistrationId=${regA.id}&from=${from}&to=${to}`);
    expect(resATable12.status).toBe(200);
    expect(resATable12.body.data.meta.invoicesConsidered).toBeGreaterThan(0);
    expect(resATable12.body.data.rows.length).toBeGreaterThan(0);

    const resBTable12 = await apiWith(tokenFor(B), app).get(`/finance/reports/gstr1-table12?gstRegistrationId=${regB.id}&from=${from}&to=${to}`);
    expect(resBTable12.status).toBe(200);
    expect(resBTable12.body.data.meta.invoicesConsidered).toBe(0);
    expect(resBTable12.body.data.rows).toHaveLength(0);
  });
});
