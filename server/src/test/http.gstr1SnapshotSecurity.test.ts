import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { saveAato } from '../modules/gst/aato.service';
import { tenantQuery } from '../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../shared/financialYear';

// G2g-6b — proves the NEW POST /finance/gstr1/snapshots route actually enforces
// authentication/permission/registration-ownership over real HTTP — the one thing
// gstr1FilingSnapshot.service.test.ts cannot cover, since it calls createGstr1FilingSnapshot()
// directly with an already-trusted TenantContext. Mirrors http.gstr1ExportSecurity.test.ts's own
// conventions exactly (same fixtures/helpers); deliberately does not re-test validation/
// canonicalization/hashing rules the service-level suite already covers.
describe('HTTP: G2g-6b GSTR-1 filing snapshot security', () => {
  const suffix = `g6bsec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

  async function tenantWith(tag: string) {
    const t = await createTestTenant(`${tag}${suffix}`, ['gst:snapshot_create']);
    cleanupTenants.push(t);
    return t;
  }

  const path = '/finance/gstr1/snapshots';

  it('unauthenticated / unpermissioned requests are rejected', async () => {
    const noAuth = await apiWith(undefined, app).post(path).send({ gstRegistrationId: 'whatever', from: '2026-04-01', to: '2026-04-30' });
    expect(noAuth.status).toBe(401);

    const A = await createTestTenant(`NP${suffix}`, []); // no gst:snapshot_create
    cleanupTenants.push(A);
    const noPerm = await apiWith(tokenFor(A), app).post(path).send({ gstRegistrationId: 'whatever', from: '2026-04-01', to: '2026-04-30' });
    expect(noPerm.status).toBe(403);
  });

  it('a cross-company gstRegistrationId is rejected (404); a nonexistent one is rejected (404)', async () => {
    const A = await tenantWith('R1');
    const B = await tenantWith('R2');
    const regB = await createGstRegistration(B.ctx, { gstin: '27AAAAA0000A1Z4', legalName: 'Company B Reg', stateCode: '27', isPrimary: true, isActive: true });
    regRows.push({ id: regB.id, companyId: B.company.id });

    const crossCompany = await apiWith(tokenFor(A), app).post(path).send({ gstRegistrationId: regB.id, from: '2026-04-01', to: '2026-04-30' });
    expect(crossCompany.status).toBe(404);

    const nonexistent = await apiWith(tokenFor(A), app).post(path).send({ gstRegistrationId: 'does-not-exist', from: '2026-04-01', to: '2026-04-30' });
    expect(nonexistent.status).toBe(404);
  });

  it('missing gstRegistrationId/from/to is rejected (400)', async () => {
    const A = await tenantWith('M');
    const noReg = await apiWith(tokenFor(A), app).post(path).send({ from: '2026-04-01', to: '2026-04-30' });
    expect(noReg.status).toBe(400);
  });

  it('a same-company registration with no AATO on file still creates a BLOCKED snapshot (200), never a 404/silent drop', async () => {
    const A = await tenantWith('OK1');
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Snap Co', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });

    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;
    const res = await apiWith(tokenFor(A), app).post(path).send({ gstRegistrationId: reg.id, from, to: now.toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.status).toBe('BLOCKED');
    expect(res.body.data.isValid).toBe(false);
  });

  it('a filing-grade registration (AATO verified) creates a DRAFT snapshot (201) with real hashes', async () => {
    const A = await tenantWith('OK2');
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z8', legalName: 'Snap Co 2', stateCode: '24', isPrimary: true, isActive: true });
    regRows.push({ id: reg.id, companyId: A.company.id });

    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const precedingFy = getPrecedingFinancialYear(fy);
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(A.ctx, { gstRegistrationId: reg.id, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const from = `${fy.slice(0, 4)}-04-01`;
    const res = await apiWith(tokenFor(A), app).post(path).send({ gstRegistrationId: reg.id, from, to: now.toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.isValid).toBe(true);
    expect(res.body.data.canonicalDtoHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.wireJsonHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
