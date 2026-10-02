import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { saveAato } from '../modules/gst/aato.service';
import { tenantQuery } from '../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../shared/financialYear';
import { createGstr1FilingSnapshot } from '../modules/finance/gst/gstr1FilingSnapshot.service';

// G2g-6c — proves the NEW POST /finance/gstr1/filing-attempts, POST
// /finance/gstr1/filing-attempts/:attemptId/outcome, and GET /finance/gstr1/filing-attempts routes
// actually enforce authentication/permission/registration+period+snapshot ownership over real
// HTTP — the one thing gstr1FilingAttempt.service.test.ts cannot cover, since it calls the service
// functions directly with an already-trusted TenantContext. Mirrors
// http.gstr1SnapshotSecurity.test.ts's own conventions exactly (same fixtures/helpers);
// deliberately does not re-test numbering/concurrency/lifecycle rules the service-level suite
// already covers.
describe('HTTP: G2g-6c GSTR-1 filing attempt security', () => {
  const suffix = `g6csec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const r of regRows) {
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[] = ['gst:filing_record', 'gst:period_view', 'gst:snapshot_create']) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return t;
  }

  /** Builds a real, filing-eligible (DRAFT) snapshot + its resolved period key via the already-
   *  proven G2g-6b service directly — this suite's target is the ATTEMPT routes, not the snapshot
   *  builder, so setup goes straight to the service exactly like http.gstr1SnapshotSecurity.test.ts
   *  does for registration creation. */
  async function makeEligibleSnapshot(t: TestTenant, regId: string) {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const precedingFy = getPrecedingFinancialYear(fy);
    const from = `${fy.slice(0, 4)}-04-01`;
    await saveAato(t.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(t.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });
    const snap = await createGstr1FilingSnapshot(t.ctx, { gstRegistrationId: regId, from, to: now.toISOString() }, t.user.id);
    const row = await tenantQuery(t.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));
    return { snapshotId: snap.id, financialYear: period.financialYear, taxPeriod: period.taxPeriod };
  }

  const createPath = '/finance/gstr1/filing-attempts';
  const listPath = '/finance/gstr1/filing-attempts';

  it('unauthenticated / unpermissioned requests are rejected (create, outcome, list)', async () => {
    const noAuthCreate = await apiWith(undefined, app).post(createPath).send({});
    expect(noAuthCreate.status).toBe(401);
    const noAuthList = await apiWith(undefined, app).get(listPath);
    expect(noAuthList.status).toBe(401);

    const A = await tenantWith('NP', []); // no gst:filing_record / gst:period_view
    const noPermCreate = await apiWith(tokenFor(A), app).post(createPath).send({
      gstRegistrationId: 'x', financialYear: '2026-27', taxPeriod: '042026', snapshotId: 'x', mode: 'MANUAL_EXPORT',
    });
    expect(noPermCreate.status).toBe(403);
    const noPermList = await apiWith(tokenFor(A), app).get(`${listPath}?gstRegistrationId=x&financialYear=2026-27&taxPeriod=042026`);
    expect(noPermList.status).toBe(403);
  });

  it('a cross-company gstRegistrationId is rejected (404) on create', async () => {
    const A = await tenantWith('R1');
    const B = await tenantWith('R2');
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z2', legalName: 'Company B Reg', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });
    const eligible = await makeEligibleSnapshot(B, regB.id);

    const res = await apiWith(tokenFor(A), app).post(createPath).send({
      gstRegistrationId: regB.id, financialYear: eligible.financialYear, taxPeriod: eligible.taxPeriod, snapshotId: eligible.snapshotId, mode: 'MANUAL_EXPORT',
    });
    expect(res.status).toBe(404);
  });

  it("a cross-company snapshotId is rejected (404) against the caller's own real registration/period", async () => {
    const A = await tenantWith('R3');
    const B = await tenantWith('R4');
    const regA = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Company A Reg', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z2', legalName: 'Company B Reg 2', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const eligibleA = await makeEligibleSnapshot(A, regA.id);
    const eligibleB = await makeEligibleSnapshot(B, regB.id);

    const res = await apiWith(tokenFor(A), app).post(createPath).send({
      gstRegistrationId: regA.id, financialYear: eligibleA.financialYear, taxPeriod: eligibleA.taxPeriod, snapshotId: eligibleB.snapshotId, mode: 'MANUAL_EXPORT',
    });
    expect(res.status).toBe(404);
  });

  it('valid creation (201), then valid outcome recording (200), then an invalid transition (409)', async () => {
    const A = await tenantWith('OK1');
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Attempt HTTP Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });
    const eligible = await makeEligibleSnapshot(A, reg.id);

    const createRes = await apiWith(tokenFor(A), app).post(createPath).send({
      gstRegistrationId: reg.id, financialYear: eligible.financialYear, taxPeriod: eligible.taxPeriod, snapshotId: eligible.snapshotId, mode: 'MANUAL_EXPORT',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.attemptNumber).toBe(1);
    expect(createRes.body.data.status).toBe('ATTEMPTED');
    const attemptId = createRes.body.data.id;

    const outcomeRes = await apiWith(tokenFor(A), app).post(`${createPath}/${attemptId}/outcome`).send({ outcome: 'ACCEPTED', arn: 'AA123456789012A' });
    expect(outcomeRes.status).toBe(200);
    expect(outcomeRes.body.data.status).toBe('ACCEPTED');
    expect(outcomeRes.body.data.arn).toBe('AA123456789012A');

    const invalidRes = await apiWith(tokenFor(A), app).post(`${createPath}/${attemptId}/outcome`).send({ outcome: 'REJECTED' });
    expect(invalidRes.status).toBe(409);

    const listRes = await apiWith(tokenFor(A), app).get(`${listPath}?gstRegistrationId=${reg.id}&financialYear=${eligible.financialYear}&taxPeriod=${eligible.taxPeriod}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(attemptId);
    expect(listRes.body.data[0].status).toBe('ACCEPTED');
  });

  it("company A cannot read company B's filing-attempt history (404 on registration ownership, never a leaked empty list)", async () => {
    const A = await tenantWith('ISO1');
    const B = await tenantWith('ISO2');
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z2', legalName: 'Company B Iso', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });
    const eligible = await makeEligibleSnapshot(B, regB.id);

    const createRes = await apiWith(tokenFor(B), app).post(createPath).send({
      gstRegistrationId: regB.id, financialYear: eligible.financialYear, taxPeriod: eligible.taxPeriod, snapshotId: eligible.snapshotId, mode: 'MANUAL_EXPORT',
    });
    expect(createRes.status).toBe(201);

    const crossList = await apiWith(tokenFor(A), app).get(`${listPath}?gstRegistrationId=${regB.id}&financialYear=${eligible.financialYear}&taxPeriod=${eligible.taxPeriod}`);
    expect(crossList.status).toBe(404);

    const ownList = await apiWith(tokenFor(B), app).get(`${listPath}?gstRegistrationId=${regB.id}&financialYear=${eligible.financialYear}&taxPeriod=${eligible.taxPeriod}`);
    expect(ownList.status).toBe(200);
    expect(ownList.body.data).toHaveLength(1);
  });

  it("company B cannot record an outcome against company A's attempt (404)", async () => {
    const A = await tenantWith('ISO3');
    const B = await tenantWith('ISO4');
    const regA = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Company A Outc', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const eligible = await makeEligibleSnapshot(A, regA.id);

    const createRes = await apiWith(tokenFor(A), app).post(createPath).send({
      gstRegistrationId: regA.id, financialYear: eligible.financialYear, taxPeriod: eligible.taxPeriod, snapshotId: eligible.snapshotId, mode: 'MANUAL_EXPORT',
    });
    expect(createRes.status).toBe(201);
    const attemptId = createRes.body.data.id;

    const crossOutcome = await apiWith(tokenFor(B), app).post(`${createPath}/${attemptId}/outcome`).send({ outcome: 'ACCEPTED' });
    expect(crossOutcome.status).toBe(404);
  });

  it('missing required fields on create is rejected (400)', async () => {
    const A = await tenantWith('M1');
    const res = await apiWith(tokenFor(A), app).post(createPath).send({ financialYear: '2026-27', taxPeriod: '042026' });
    expect(res.status).toBe(400);
  });
});
