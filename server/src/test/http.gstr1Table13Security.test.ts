import { describe, it, expect, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, addBranch, createMember, TestTenant } from './fixtures';
import { grantBranchAccess, createGstRegistration } from '../modules/company/company.service';
import { createInvoice } from '../modules/sales/sales.service';
import { tenantQuery } from '../shared/tenantContext';

// G2g-3g-3 — proves the branch-access, registration-ownership, required-field, and date-range
// checks around the new `/finance/reports/gstr1-table13` route are actually enforced over real
// HTTP — the one thing gstr1Table13Reporting.service.test.ts cannot cover, since it calls
// getGstr1Table13Report() directly with already-trusted arguments and never exercises the
// requirePermission gate or the router's own boundary validation. Kept as its own file rather than
// folded into http.gstr1Security.test.ts's shared loop: unlike gstr1-outward/gstr1-credit-notes/
// gstr1-table12 (which default `from`/`to` to the current fiscal year when omitted), Table 13's
// `from`/`to` are REQUIRED — a missing date is a 400, not a silently-defaulted range — so it cannot
// share that loop's assumptions.
describe('HTTP: G2g-3g-3 GSTR-1 Table 13 report security', () => {
  const suffix = `g13sec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const extraUserIds: string[] = [];
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
      email: `g13sec-${label}-${suffix}@example.com`, allBranches: false,
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

  /** One retail invoice (a single FIXED-rate tagged line) in the given branch, for report fixtures. */
  async function makeInvoice(t: TestTenant, branchId: string, price: number) {
    const client = await prisma.client.create({
      data: { companyId: t.company.id, clientCode: `TSTCL-G13H-${suffix}-${clientIds.length}`, name: 'Table13 Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientIds.push(client.id);
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-G13H-${suffix}-${tagIds.length}`, companyId: t.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: t.user.id,
      },
    });
    tagIds.push(tag.id);
    const invoice = await createInvoice(
      {
        branchId, clientId: client.id, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id }],
      },
      t.ctx, t.user.id,
    );
    invoiceIds.push(invoice.id);
    await prisma.salesInvoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED' } });
    return invoice;
  }

  const path = '/finance/reports/gstr1-table13';
  const WIDE_FROM = '2020-01-01';
  const WIDE_TO = '2035-12-31';

  it('1. no authentication -> 401', async () => {
    const noAuth = await apiWith(undefined, app).get(`${path}?gstRegistrationId=whatever&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(noAuth.status).toBe(401);
  });

  it('2. authenticated without report:financial_view -> 403', async () => {
    const A = await createTestTenant(`NP${suffix}`, []); // no report:financial_view
    cleanupTenants.push(A);
    const noPerm = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=whatever&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(noPerm.status).toBe(403);
  });

  it('3. missing gstRegistrationId -> 400, never silently defaulted', async () => {
    const A = await tenantWith('M');
    const res = await apiWith(tokenFor(A), app).get(`${path}?from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(res.status).toBe(400);
  });

  it('4. cross-company gstRegistrationId -> 404', async () => {
    const A = await tenantWith('R1');
    const B = await tenantWith('R2');
    const regB = await createGstRegistration(B.ctx, { gstin: '24KKKKK1111K1Z5', legalName: 'Company B Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regB.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(crossCompany.status).toBe(404);
  });

  it('5. missing from -> 400', async () => {
    const A = await tenantWith('MF');
    const regA = await createGstRegistration(A.ctx, { gstin: '24LLLLL2222L1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&to=${WIDE_TO}`);
    expect(res.status).toBe(400);
  });

  it('6. missing to -> 400', async () => {
    const A = await tenantWith('MT');
    const regA = await createGstRegistration(A.ctx, { gstin: '24MMMMM3333M1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}`);
    expect(res.status).toBe(400);
  });

  it('7. malformed from -> 400', async () => {
    const A = await tenantWith('BF');
    const regA = await createGstRegistration(A.ctx, { gstin: '24NNNNN4444N1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=not-a-date&to=${WIDE_TO}`);
    expect(res.status).toBe(400);
  });

  it('8. malformed to -> 400', async () => {
    const A = await tenantWith('BT');
    const regA = await createGstRegistration(A.ctx, { gstin: '24OOOOO5555O1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=not-a-date`);
    expect(res.status).toBe(400);
  });

  it('9. to < from -> 400', async () => {
    const A = await tenantWith('INV');
    const regA = await createGstRegistration(A.ctx, { gstin: '24PPPPP6666P1Z5', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=2026-06-01&to=2026-01-01`);
    expect(res.status).toBe(400);
  });

  it('10/11/12. cross-company / inaccessible branchId is rejected (404); the caller\'s own granted branch succeeds (200)', async () => {
    const A = await tenantWith('B1');
    const B = await tenantWith('B2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24QQQQQ7777Q1Z5', legalName: 'Company A Reg B', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const branch2 = await addBranch(A.company.id, suffix);
    const restricted = await restrictedTokenFor(A, A.branch.id, 'r');

    const inaccessible = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${branch2.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(inaccessible.status).toBe(404);

    const crossCompany = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${B.branch.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(crossCompany.status).toBe(404);

    const ownBranch = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${A.branch.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(ownBranch.status).toBe(200);
  });

  it('13. tenant isolation: company A cannot retrieve company B\'s Table 13 data', async () => {
    const A = await tenantWith('ISO1');
    const B = await tenantWith('ISO2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24RRRRR8888R1Z5', legalName: 'Company A Iso Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const regB = await createGstRegistration(B.ctx, { gstin: '24SSSSS9999S1Z5', legalName: 'Company B Iso Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    await makeInvoice(A, A.branch.id, 5000);

    const resA = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(resA.status).toBe(200);
    expect(resA.body.data.meta.salesInvoicesConsidered).toBeGreaterThan(0);

    // Company B, scoped to ITS OWN registration, sees nothing of A's data even over the same window.
    const resB = await apiWith(tokenFor(B), app).get(`${path}?gstRegistrationId=${regB.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(resB.status).toBe(200);
    expect(resB.body.data.meta.salesInvoicesConsidered).toBe(0);
    expect(resB.body.data.series).toHaveLength(0);

    // A cross-company registration id is rejected outright, not merely filtered to empty.
    const cross = await apiWith(tokenFor(B), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(cross.status).toBe(404);
  });

  it('14/17/18/19/20. company-wide report succeeds and preserves series/summary/diagnostics/meta and the historical document number', async () => {
    const A = await tenantWith('WIDE');
    const regA = await createGstRegistration(A.ctx, { gstin: '24TTTTT0000T1Z5', legalName: 'Company A Wide Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const invoice = await makeInvoice(A, A.branch.id, 6000);

    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    // 17. response integrity: engine output (series/summary/diagnostics) and meta both present, unrestructured.
    expect(Array.isArray(data.series)).toBe(true);
    expect(data.summary).toBeDefined();
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.meta).toBeDefined();
    expect(data.meta.gstRegistrationId).toBe(regA.id);
    expect(data.meta.branchId).toBeNull();
    expect(data.meta.salesInvoicesConsidered).toBeGreaterThan(0);
    expect(data.meta.creditNotesConsidered).toBe(0);

    // 18. isPartialBranchSeries preserved (full-access caller, no branch filter -> false).
    expect(data.meta.isPartialBranchSeries).toBe(false);

    // 19. diagnostics array is not stripped (present, even if empty for a clean single-invoice run).
    expect(data.diagnostics).toBeDefined();

    // 20. historical document number preserved unchanged, unconverted.
    const outwardSeries = data.series.filter((s: { category: string }) => s.category === 'OUTWARD_INVOICE');
    expect(outwardSeries.length).toBeGreaterThan(0);
    const docs = outwardSeries.flatMap((s: { fromDocumentNumber: string; toDocumentNumber: string }) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docs).toContain(invoice.invoiceNumber);
  });

  it('15. branch-filtered report succeeds and marks isPartialBranchSeries true', async () => {
    const A = await tenantWith('BF2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24UUUUU1111U1Z5', legalName: 'Company A BF Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    await makeInvoice(A, A.branch.id, 6500);

    const res = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&branchId=${A.branch.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.branchId).toBe(A.branch.id);
    expect(res.body.data.meta.isPartialBranchSeries).toBe(true);
  });

  it('16. a branch-restricted user receives only their permitted branch\'s data, not the whole company\'s', async () => {
    const A = await tenantWith('RESTR');
    const regA = await createGstRegistration(A.ctx, { gstin: '24VVVVV2222V1Z5', legalName: 'Company A Restr Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const branch2 = await addBranch(A.company.id, `restr-${suffix}`);

    const invA = await makeInvoice(A, A.branch.id, 7000);
    await makeInvoice(A, branch2.id, 7100);

    const restricted = await restrictedTokenFor(A, A.branch.id, 'restr2');
    // No explicit branchId — the restricted caller's own branch grant scopes the query server-side.
    const res = await apiWith(restricted, app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(res.status).toBe(200);
    expect(res.body.data.meta.isPartialBranchSeries).toBe(true);
    expect(res.body.data.meta.salesInvoicesConsidered).toBe(1);
    const docs = res.body.data.series.flatMap((s: { fromDocumentNumber: string; toDocumentNumber: string }) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docs).toContain(invA.invoiceNumber);

    // The full-access owner, same registration and window, sees both branches' invoices.
    const full = await apiWith(tokenFor(A), app).get(`${path}?gstRegistrationId=${regA.id}&from=${WIDE_FROM}&to=${WIDE_TO}`);
    expect(full.body.data.meta.salesInvoicesConsidered).toBe(2);
  });
});
