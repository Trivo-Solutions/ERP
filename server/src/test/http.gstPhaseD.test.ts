import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';

describe('HTTP: GST Phase D — AATO & Compliance Validation (/gst)', () => {
  const suffix = `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let tenantNoPerms: TestTenant;

  let apiA: ReturnType<typeof apiWith>;
  let apiB: ReturnType<typeof apiWith>;
  let apiNoPerms: ReturnType<typeof apiWith>;

  let regAId: string;
  let regBId: string;

  beforeAll(async () => {
    tenantA = await createTestTenant(`GSTD-A-${suffix}`, ['gst:registration_view', 'gst:registration_create', 'gst:registration_edit', 'masters:view']);
    tenantB = await createTestTenant(`GSTD-B-${suffix}`, ['gst:registration_view', 'gst:registration_create', 'gst:registration_edit', 'masters:view']);
    tenantNoPerms = await createTestTenant(`GSTD-N-${suffix}`, ['sales:view']); // unrelated permission

    apiA = apiWith(tokenFor(tenantA), app);
    apiB = apiWith(tokenFor(tenantB), app);
    apiNoPerms = apiWith(tokenFor(tenantNoPerms), app);

    const regA = await createGstRegistration(tenantA.ctx, {
      gstin: '24AAAAA0000A1Z8',
      legalName: 'Tenant A Primary Corp',
      stateCode: '24',
      isPrimary: true,
    });
    regAId = regA.id;

    const regB = await createGstRegistration(tenantB.ctx, {
      gstin: '27AAAAA0000A1Z5',
      legalName: 'Tenant B Corp',
      stateCode: '27',
      isPrimary: true,
    });
    regBId = regB.id;
  });

  afterAll(async () => {
    await prisma.branch.updateMany({ where: { companyId: { in: [tenantA.company.id, tenantB.company.id, tenantNoPerms.company.id] } }, data: { gstRegistrationId: null } });

    for (const companyId of [tenantA.company.id, tenantB.company.id, tenantNoPerms.company.id]) {
      await tenantQuery(companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { companyId } }));
      await tenantQuery(companyId, (tx) => tx.companyGstAato.deleteMany({ where: { companyId } }));
      await tenantQuery(companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId } }));
    }

    await cleanupTestTenant(tenantA);
    await cleanupTestTenant(tenantB);
    await cleanupTestTenant(tenantNoPerms);
  });

  describe('Authentication & Authorization', () => {
    it('rejects unauthenticated requests to Phase D endpoints with 401', async () => {
      const unauth = apiWith(undefined, app);

      const r1 = await unauth.get(`/gst/aato?gstRegistrationId=${regAId}`);
      expect(r1.status).toBe(401);

      const r2 = await unauth.get(`/gst/aato/history?gstRegistrationId=${regAId}`);
      expect(r2.status).toBe(401);

      const r3 = await unauth.post('/gst/aato', {
        gstRegistrationId: regAId,
        financialYear: '2024-25',
        turnover: 100000,
      });
      expect(r3.status).toBe(401);

      const r4 = await unauth.post('/gst/compliance/validate', {
        gstin: '24AAAAA0000A1Z8',
      });
      expect(r4.status).toBe(401);
    });

    it('rejects callers without gst:registration_view with 403 on GET /gst/aato and /gst/aato/history', async () => {
      const r1 = await apiNoPerms.get(`/gst/aato?gstRegistrationId=${regAId}`);
      expect(r1.status).toBe(403);

      const r2 = await apiNoPerms.get(`/gst/aato/history?gstRegistrationId=${regAId}`);
      expect(r2.status).toBe(403);
    });

    it('rejects callers without gst:registration_edit with 403 on POST /gst/aato', async () => {
      const r = await apiNoPerms.post('/gst/aato', {
        gstRegistrationId: regAId,
        financialYear: '2024-25',
        turnover: 100000,
      });
      expect(r.status).toBe(403);
    });

    it('rejects callers without masters:view with 403 on /gst/compliance/validate', async () => {
      const r = await apiNoPerms.post('/gst/compliance/validate', {
        gstin: '24AAAAA0000A1Z8',
      });
      expect(r.status).toBe(403);
    });
  });

  describe('Tenant Selector Rejection', () => {
    it('rejects client-supplied companyId in POST /gst/aato body (rejectClientTenantSelectors)', async () => {
      const res = await apiA.post('/gst/aato', {
        gstRegistrationId: regAId,
        financialYear: '2024-25',
        turnover: 5000000,
        companyId: tenantB.company.id, // Forgery attempt
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Request must not specify: companyId');
    });
  });

  describe('AATO CRUD and History over HTTP', () => {
    it('saves AATO, returns current and preceding context, and records history', async () => {
      // 1. Create AATO for FY 2023-24
      const resPrev = await apiA.post('/gst/aato', {
        gstRegistrationId: regAId,
        financialYear: '2023-24',
        turnover: 8000000,
        source: 'MANUAL',
        verificationStatus: 'VERIFIED',
        notes: 'FY 23-24 audited',
      });
      expect(resPrev.status).toBe(200);
      expect(resPrev.body.success).toBe(true);
      expect(resPrev.body.data.financialYear).toBe('2023-24');
      expect(resPrev.body.data.turnover).toBe(8000000);
      expect(resPrev.body.data.verificationStatus).toBe('VERIFIED');

      // 2. Create AATO for FY 2024-25
      const resCurr = await apiA.post('/gst/aato', {
        gstRegistrationId: regAId,
        financialYear: '2024-25',
        turnover: 12000000,
        source: 'MANUAL',
        notes: 'FY 24-25 provisional',
      });
      expect(resCurr.status).toBe(200);
      expect(resCurr.body.data.turnover).toBe(12000000);
      expect(resCurr.body.data.verificationStatus).toBe('UNVERIFIED'); // Manual defaults to UNVERIFIED!

      // 3. GET /gst/aato?financialYear=2024-25
      const getRes = await apiA.get(`/gst/aato?gstRegistrationId=${regAId}&financialYear=2024-25`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.aato.turnover).toBe(12000000);
      expect(getRes.body.data.financialYear).toBe('2024-25');
      expect(getRes.body.data.precedingFinancialYear).toBe('2023-24');
      expect(getRes.body.data.precedingAato.turnover).toBe(8000000);

      // 4. GET /gst/aato/history
      const histRes = await apiA.get(`/gst/aato/history?gstRegistrationId=${regAId}&financialYear=2024-25`);
      expect(histRes.status).toBe(200);
      expect(histRes.body.data.length).toBeGreaterThanOrEqual(1);
      expect(histRes.body.data[0].financialYear).toBe('2024-25');
    });
  });

  describe('Compliance Validation over HTTP', () => {
    it('POST /gst/compliance/validate returns clean structured validation for valid payload', async () => {
      const res = await apiA.post('/gst/compliance/validate', {
        gstin: '24AAAAA0000A1Z8',
        hsnCode: '7113',
        codeType: 'HSN',
        supplyType: 'B2B',
        uqc: 'GMS',
        precedingTurnover: 20000000,
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.errors).toHaveLength(0);
      expect(res.body.data.info.length).toBeGreaterThan(0);
    });

    it('POST /gst/compliance/validate returns structured errors, warnings, and info for problematic payload', async () => {
      const res = await apiA.post('/gst/compliance/validate', {
        gstin: 'INVALID_GSTIN_XYZ',
        hsnCode: '998311', // SAC code under HSN
        codeType: 'HSN',
        uqc: 'BAD_UQC',
        precedingTurnover: 70000000, // > 5 Cr
        precedingVerificationStatus: 'VERIFIED',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.errors.length).toBeGreaterThan(0);
      expect(res.body.data.warnings.length).toBeGreaterThan(0);
    });

    it('GET /gst/compliance/validate also works identically', async () => {
      const res = await apiA.get('/gst/compliance/validate?gstin=24AAAAA0000A1Z8&hsnCode=7113&uqc=GMS&supplyType=B2B&precedingTurnover=20000000&precedingVerificationStatus=VERIFIED');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
    });

    it('Test 11: POST /gst/compliance/validate with gstRegistrationId uses preceding FY AATO authoritatively', async () => {
      const res = await apiA.post('/gst/compliance/validate', {
        gstRegistrationId: regAId,
        financialYear: '2024-25',
        hsnCode: '7113', // 4 digits
        codeType: 'HSN',
        supplyType: 'B2B',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.metadata.aatoThreshold.state).toBe('PRECEDING_FY_AATO_VERIFIED');
      expect(res.body.data.metadata.aatoThreshold.status).toBe('authoritative');
      expect(res.body.data.metadata.aatoThreshold.mandatedMinHsnDigits).toBe(4);
      expect(res.body.data.metadata.aatoThreshold.precedingTurnover).toBe(8000000);
      expect(res.body.data.metadata.aatoThreshold.currentTurnover).toBe(12000000);
    });
  });

  describe('Tenant Isolation over HTTP', () => {
    it('Company A cannot read Company B registration AATO (returns 404)', async () => {
      const res = await apiA.get(`/gst/aato?gstRegistrationId=${regBId}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      // Ensure error does not echo raw ID
      expect(res.body.error).not.toContain(regBId);
    });

    it('Company A cannot update Company B registration AATO (returns 404)', async () => {
      const res = await apiA.post('/gst/aato', {
        gstRegistrationId: regBId,
        financialYear: '2024-25',
        turnover: 99999999,
      });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).not.toContain(regBId);
    });

    it('Company A cannot read Company B AATO history (returns 404)', async () => {
      const res = await apiA.get(`/gst/aato/history?gstRegistrationId=${regBId}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).not.toContain(regBId);
    });
  });
});
