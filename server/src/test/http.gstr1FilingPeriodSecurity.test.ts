import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { saveAato } from '../modules/gst/aato.service';
import { tenantQuery } from '../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../shared/financialYear';
import { createGstr1FilingSnapshot } from '../modules/finance/gst/gstr1FilingSnapshot.service';
import { createGstr1FilingAttempt, recordGstr1FilingAttemptOutcome } from '../modules/finance/gst/gstr1FilingAttempt.service';

// G2g-6e — proves the NEW POST /finance/gstr1/filing-attempts/:attemptId/file and
// POST /finance/gstr1/periods/:periodId/lock routes actually enforce authentication/permission/
// ownership over real HTTP — the one thing gstr1FilingPeriod.service.test.ts cannot cover, since it
// calls the service functions directly with an already-trusted TenantContext. Mirrors
// http.gstr1FilingAttemptSecurity.test.ts's own conventions exactly (same fixtures/helpers);
// deliberately does not re-test eligibility/lifecycle/concurrency rules the service-level suite
// already covers.
describe('HTTP: G2g-6e GSTR-1 filing/period lifecycle security', () => {
  const suffix = `g6esec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  let monthOffset = 0;

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

  /** Builds a real ACCEPTED filing attempt via the already-proven G2g-6b/6c services directly —
   *  this suite's target is the NEW /file and /lock routes, not the services that build up to them. */
  async function acceptedAttempt(t: TestTenant, regId: string) {
    monthOffset += 1;
    const year = 2042 + Math.floor((3 + monthOffset) / 12);
    const month = (3 + monthOffset) % 12;
    const date = new Date(Date.UTC(year, month, 15));
    const fy = getFinancialYearForDate(date);
    const precedingFy = getPrecedingFinancialYear(fy);
    await saveAato(t.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(t.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });
    const from = `${fy.slice(0, 4)}-04-01`;
    const snap = await createGstr1FilingSnapshot(t.ctx, { gstRegistrationId: regId, from, to: date.toISOString() }, t.user.id);
    const row = await tenantQuery(t.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));
    const attempt = await createGstr1FilingAttempt(
      t.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, t.user.id,
    );
    const accepted = await recordGstr1FilingAttemptOutcome(t.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED' }, t.user.id);
    return { snap, period, attempt: accepted };
  }

  const filePath = (attemptId: string) => `/finance/gstr1/filing-attempts/${attemptId}/file`;
  const lockPath = (periodId: string) => `/finance/gstr1/periods/${periodId}/lock`;

  it('unauthenticated requests are rejected (401) on both routes', async () => {
    const noAuthFile = await apiWith(undefined, app).post(filePath('x'));
    expect(noAuthFile.status).toBe(401);
    const noAuthLock = await apiWith(undefined, app).post(lockPath('x'));
    expect(noAuthLock.status).toBe(401);
  });

  it('a caller without gst:filing_record is rejected (403) on both routes', async () => {
    const A = await tenantWith('NP', ['gst:period_view']); // no gst:filing_record
    const resFile = await apiWith(tokenFor(A), app).post(filePath('x'));
    expect(resFile.status).toBe(403);
    const resLock = await apiWith(tokenFor(A), app).post(lockPath('x'));
    expect(resLock.status).toBe(403);
  });

  it('a cross-company attemptId is rejected (404) on /file, and nothing is mutated', async () => {
    const A = await tenantWith('R1');
    const B = await tenantWith('R2');
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z2', legalName: 'Company B Reg', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });
    const { attempt, period } = await acceptedAttempt(B, regB.id);

    const res = await apiWith(tokenFor(A), app).post(filePath(attempt.id));
    expect(res.status).toBe(404);

    const periodRow = await tenantQuery(B.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } }));
    expect(periodRow.status).not.toBe('FILED');
  });

  it('valid /file (200), then a cross-company /lock is rejected (404), then the owning company\'s /lock succeeds (200)', async () => {
    const A = await tenantWith('OK1');
    const B = await tenantWith('OK2');
    const regA = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Lifecycle HTTP Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: regA.id, companyId: A.company.id });
    const { attempt, period } = await acceptedAttempt(A, regA.id);

    const fileRes = await apiWith(tokenFor(A), app).post(filePath(attempt.id));
    expect(fileRes.status).toBe(200);
    expect(fileRes.body.success).toBe(true);
    expect(fileRes.body.data.status).toBe('FILED');
    expect(fileRes.body.data.id).toBe(period.id);
    expect(fileRes.body.data.filedByAttemptId).toBe(attempt.id);

    const crossLock = await apiWith(tokenFor(B), app).post(lockPath(period.id));
    expect(crossLock.status).toBe(404);

    const lockRes = await apiWith(tokenFor(A), app).post(lockPath(period.id));
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.data.status).toBe('LOCKED');

    // A second /file against the same attempt is now rejected — period is terminal.
    const secondFile = await apiWith(tokenFor(A), app).post(filePath(attempt.id));
    expect(secondFile.status).toBe(409);

    const secondLock = await apiWith(tokenFor(A), app).post(lockPath(period.id));
    expect(secondLock.status).toBe(409);
  });

  it('an attempt that is not ACCEPTED is rejected (409) on /file', async () => {
    const A = await tenantWith('NA1');
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Not Accepted Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });

    monthOffset += 1;
    const year = 2042 + Math.floor((3 + monthOffset) / 12);
    const month = (3 + monthOffset) % 12;
    const date = new Date(Date.UTC(year, month, 15));
    const fy = getFinancialYearForDate(date);
    const precedingFy = getPrecedingFinancialYear(fy);
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });
    const from = `${fy.slice(0, 4)}-04-01`;
    const snap = await createGstr1FilingSnapshot(A.ctx, { gstRegistrationId: reg.id, from, to: date.toISOString() }, A.user.id);
    const row = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));
    const attempt = await createGstr1FilingAttempt(
      A.ctx, { gstRegistrationId: reg.id, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, A.user.id,
    ); // left ATTEMPTED — never accepted

    const res = await apiWith(tokenFor(A), app).post(filePath(attempt.id));
    expect(res.status).toBe(409);
  });

  it('a nonexistent attemptId / periodId is rejected (404), not a 500', async () => {
    const A = await tenantWith('NF1');
    const resFile = await apiWith(tokenFor(A), app).post(filePath('does-not-exist'));
    expect(resFile.status).toBe(404);
    const resLock = await apiWith(tokenFor(A), app).post(lockPath('does-not-exist'));
    expect(resLock.status).toBe(404);
  });
});
