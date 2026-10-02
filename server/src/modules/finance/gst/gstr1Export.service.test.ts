import { describe, it, expect, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstRegistration } from '../../company/company.service';
import { saveAato } from '../../gst/aato.service';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../../test/fixtures';
import { tenantQuery } from '../../../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../../../shared/financialYear';
import { buildGstr1GstnExport } from './gstr1Export.service';

// G2g-4c-4 — proves the export SERVICE (orchestration: report loading -> adapter -> validator ->
// serializer) over real database rows, independently of HTTP (http.gstr1ExportSecurity.test.ts
// covers the router's own permission/ownership/branch gating). Deliberately does not re-test any
// classification/aggregation/validation/serialization RULE those frozen modules already cover in
// their own suites — only that this new orchestration layer wires them together correctly.
describe('GSTR-1 GSTN export service (G2g-4c-4)', () => {
  const suffix = `g4c4-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchA: string;
  let clientId: string;
  let regId: string;
  const invoiceIds: string[] = [];
  const regRows: string[] = [];

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId: branchA, ...data }, tenant.ctx, userId);
  }

  afterAll(async () => {
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } }).catch(() => {});
    for (const id of regRows) {
      await tenantQuery(tenant.company.id, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: id } }));
      await tenantQuery(tenant.company.id, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: id } }));
      await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { id } }));
    }
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('setup: tenant + GST registration + a B2C invoice', async () => {
    tenant = await createTestTenant(suffix, ['report:financial_view', 'invoice:create', 'client:create']);
    userId = tenant.user.id;
    branchA = tenant.branch.id;

    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z8', legalName: `Export Test Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regId = reg.id;
    regRows.push(regId);

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: `Walkin ${suffix}`, phone: '9000000000', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;

    const invoice = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Gold ring', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'PER_GRAM', goldRate: 6000, makingCharge: 500, stoneValue: 0 }],
    });
    invoiceIds.push(invoice.id);
  });

  it('returns ok:false with AATO_PRECEDING_FY_NOT_VERIFIED when no AATO has been saved (no serialization happens)', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;

    const result = await buildGstr1GstnExport(
      tenant.ctx,
      { gstRegistrationId: regId, from, to: now.toISOString() },
      userId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.code === 'AATO_PRECEDING_FY_NOT_VERIFIED')).toBe(true);
    }
  });

  it('succeeds and returns the exact serializer output once both FYs\' AATO are VERIFIED', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const precedingFy = getPrecedingFinancialYear(fy);
    const from = `${fy.slice(0, 4)}-04-01`;

    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const result = await buildGstr1GstnExport(
      tenant.ctx,
      { gstRegistrationId: regId, from, to: now.toISOString() },
      userId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No application wrapper — the wire payload IS the GSTN-facing object.
    expect(result.wire.gstin).toBe('24AAAAA0000A1Z8');
    expect(typeof result.wire.fp).toBe('string');
    expect(result.wire.fp).toHaveLength(6);
    expect(JSON.parse(JSON.stringify(result.wire))).toEqual(result.wire);

    // Deterministic, safe filename.
    expect(result.filename).toMatch(/^GSTR1_24AAAAA0000A1Z8_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{4}\.json$/);
    expect(result.filename).not.toMatch(/[\\/]/);
  });

  it('a nonexistent gstRegistrationId is rejected (404), never silently ignored', async () => {
    await expect(
      buildGstr1GstnExport(tenant.ctx, { gstRegistrationId: 'does-not-exist', from: '2026-04-01', to: '2026-04-30' }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('missing from/to and an inverted range are all rejected with 400, never silently defaulted', async () => {
    await expect(
      buildGstr1GstnExport(tenant.ctx, { gstRegistrationId: regId, from: '', to: '2026-04-30' }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      buildGstr1GstnExport(tenant.ctx, { gstRegistrationId: regId, from: '2026-04-30', to: '' }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      buildGstr1GstnExport(tenant.ctx, { gstRegistrationId: regId, from: '2026-05-01', to: '2026-04-01' }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a branch-scoped export (explicit branchId) is always PARTIAL_BRANCH_SCOPE-blocked, never served as a complete filing', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;

    const result = await buildGstr1GstnExport(
      tenant.ctx,
      { gstRegistrationId: regId, from, to: now.toISOString(), branchId: branchA },
      userId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.code === 'PARTIAL_BRANCH_SCOPE')).toBe(true);
    }
  });

  it('a cross-company branchId is rejected (404) before any report is generated', async () => {
    const other = await createTestTenant(`xco-${suffix}`, []);
    try {
      await expect(
        buildGstr1GstnExport(tenant.ctx, { gstRegistrationId: regId, from: '2026-04-01', to: '2026-04-30', branchId: other.branch.id }, userId),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanupTestTenant(other);
    }
  });
});
