import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createGstRegistration } from '../modules/company/company.service';
import { resolveFilingPeriodMmYYYY } from '../modules/finance/gst/gstr3bReporting.service';
import { getFinancialYearForDate } from '../shared/financialYear';
import { tenantQuery } from '../shared/tenantContext';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';

// G2g-7g close-out, brief §12 — minimum HTTP coverage: a FILED/LOCKED GSTR-3B period produces a
// 4xx over real HTTP on a representative route (POST /sales/invoices, the void route), and an OPEN
// period leaves existing behavior (2xx) untouched. The full matrix of mutation families is already
// proven at the service level in g2g7gGstr3bMutationGuard.test.ts — this file only proves the HTTP
// layer (requirePermission -> ... -> the guard -> the error) doesn't swallow or mistranslate the
// rejection, the same minimal-HTTP posture every other G2g-6/7 phase in this codebase already took
// (no dedicated HTTP file exists for gstr1FilingProtection.ts's own guard either).
describe('HTTP: GSTR-3B filing mutation protection (G2g-7g)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let api: ReturnType<typeof apiWith>;
  let clientId: string;
  const invoiceIds: string[] = [];
  const regIds: string[] = [];

  afterAll(async () => {
    for (const id of regIds) {
      await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { gstRegistrationId: id, returnType: 'GSTR3B' } }));
    }
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    for (const id of regIds) {
      await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { id } }));
    }
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  beforeAll(async () => {
    tenant = await createTestTenant(`h7g${suffix}`, ['invoice:create', 'invoice:void']);
    api = apiWith(tokenFor(tenant), app);
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `H7GCL-${suffix}`, name: 'HTTP G7g Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  async function makeInvoice() {
    const res = await api.post('/sales/invoices', {
      clientId, branchId: tenant.branch.id, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Chain', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000 }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.data.id);
    return res.body.data;
  }

  it('OPEN period (none created) — creating and voiding an invoice succeed as before', async () => {
    const invoice = await makeInvoice();
    const voided = await api.post(`/sales/invoices/${invoice.id}/void`, { reason: 'http test' });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
  });

  it('a FILED GSTR-3B period -> 409 over real HTTP when voiding, and the invoice is left unchanged', async () => {
    // The registration must exist BEFORE the invoice is created — resolveSellerRegistration()
    // falls back to "no registration" (a legacy Company-row snapshot, sellerRegistrationId null)
    // for any invoice created before this company has one, and a null registration is never
    // protected (gstr3bFilingProtection.ts's own documented no-op).
    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA7100A1Z5', legalName: `HTTP G7g Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regIds.push(reg.id);
    const invoice = await makeInvoice();
    const now = new Date();
    await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.create({
      data: {
        companyId: tenant.company.id, gstRegistrationId: reg.id, returnType: 'GSTR3B',
        financialYear: getFinancialYearForDate(now), taxPeriod: resolveFilingPeriodMmYYYY(now), status: 'FILED',
      },
    }));

    const res = await api.post(`/sales/invoices/${invoice.id}/void`, { reason: 'http test blocked' });
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.message ?? JSON.stringify(res.body)).toEqual(expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'));

    const fresh = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(fresh.status).not.toBe('VOID');
  });
});
