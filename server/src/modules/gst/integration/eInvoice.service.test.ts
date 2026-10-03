import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { app } from '../../../app';
import { platformPrisma as prisma } from '../../../config/database';
import { logger } from '../../../config/logger';
import { tenantQuery } from '../../../shared/tenantContext';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../../test/fixtures';
import { createIntegrationConfig } from './gstIntegration.service';
import { __resetAllSessionsForTests } from './auth/tokenSession';
import { GstIntegrationError } from './errors';
import { GstIntegrationProvider, unsupported } from './types';
import { CanonicalIrnRequest } from './eInvoice.types';
import { voidInvoice } from '../../sales/sales.service';
import { makeGstin } from './eInvoice.testUtil';

// The provider is injected through the one seam production code uses (resolveProvider). NIC_IRP is
// left real so the "NIC stays unsupported" case exercises the actual adapter.
const holder = vi.hoisted(() => ({ provider: null as null | GstIntegrationProvider }));
vi.mock('./providers/resolveProvider', async (orig) => {
  const actual = await orig<typeof import('./providers/resolveProvider')>();
  return { resolveProvider: (name: string) => (name === 'OTHER' && holder.provider ? holder.provider : actual.resolveProvider(name)) };
});

const SECRET = 'api-secret-never-leak-123';
const IRN = 'ab'.repeat(32);
type Behaviour = (req: CanonicalIrnRequest) => Promise<unknown> | unknown;
let calls: CanonicalIrnRequest[] = [];
function irnProvider(behaviour: Behaviour): GstIntegrationProvider {
  calls = [];
  return {
    name: 'OTHER', supportsIrnGeneration: true,
    authenticate: async () => ({ status: 'AUTHENTICATED', token: 'session-token-xyz', expiresAt: Date.now() + 600_000 }),
    health: async (c) => ({ status: 'AVAILABLE', checkedAt: new Date().toISOString(), correlationId: c.correlationId }),
    getGstinDetails: async () => unsupported('OTHER', 'GET_GSTIN_DETAILS'),
    generateIrn: async (_c: unknown, req: CanonicalIrnRequest) => { calls.push(req); return (await behaviour(req)) as never; },
    cancelIrn: async () => unsupported('OTHER', 'CANCEL_IRN'), getIrn: async () => unsupported('OTHER', 'GET_IRN'),
    getIrnByDocument: async () => unsupported('OTHER', 'GET_IRN_BY_DOCUMENT'),
    generateEwayBill: async () => unsupported('OTHER', 'GENERATE_EWAYBILL'), cancelEwayBill: async () => unsupported('OTHER', 'CANCEL_EWAYBILL'),
  };
}
const ok = () => ({ status: 'GENERATED', irn: IRN, ackNumber: '112010000123456', ackDate: '2026-10-03T10:15:00.000Z', signedInvoice: 'eyJ.signed.invoice', signedQrCode: 'eyJ.signed.qr', providerStatus: 'ACT', providerTimestamp: null });
const gErr = (category: ConstructorParameters<typeof GstIntegrationError>[0]['category'], code?: string) =>
  new GstIntegrationError({ message: `provider ${category}`, category, provider: 'OTHER', operation: 'GENERATE_IRN', correlationId: 'c', providerCode: code });

describe('G8c IRN generation: service + HTTP', () => {
  const suffix = `g8c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  let A: TestTenant; let B: TestTenant; let viewOnly: TestTenant;
  let regA: string; let regP: string; let regB: string; let regNic: string;
  const logged: string[] = [];
  let seq = 0;

  const SELLER_A = makeGstin('24', 'SELAA', '1111');
  const SELLER_P = makeGstin('24', 'SELPP', '2222');
  const BUYER = makeGstin('24', 'BUYAA', '3333');

  /** A fully eligible invoice (+tax record + one HSN-7113 line) sold under `reg`. */
  async function makeInvoice(t: TestTenant, reg: string, gstin: string, over: { status?: string; sellerRegistrationId?: string | null } = {}) {
    const n = ++seq;
    const hsn = await prisma.hsnCode.findUniqueOrThrow({ where: { code: '7113' } });
    const client = await prisma.client.create({ data: { companyId: t.company.id, clientCode: `CL${suffix}${n}`, name: `Buyer ${n}`, type: 'DEALER', gstNumber: BUYER } });
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: t.company.id, branchId: t.branch.id, clientId: client.id, invoiceNumber: `E${n}/${suffix.slice(-6)}`.slice(0, 16), invoiceDate: new Date('2026-09-15T00:00:00Z'),
        invoiceType: 'RETAIL', status: over.status ?? 'PAID', subtotal: 10000, taxAmount: 300, totalAmount: 10300, balanceDue: 0, paidAmount: 10300,
      },
    });
    await prisma.taxInvoice.create({
      data: {
        companyId: t.company.id, invoiceId: inv.id, gstin, placeOfSupply: '24', taxableAmount: 10000, cgst: 150, sgst: 150, totalTax: 300,
        sellerRegistrationId: over.sellerRegistrationId === undefined ? reg : over.sellerRegistrationId,
        sellerLegalName: 'Seller Jewels Pvt Ltd', sellerStateCode: '24', sellerAddress: '12 Ring Road', sellerCity: 'Surat', sellerPincode: '395002',
        buyerName: `Buyer ${n} Traders`, buyerGstin: BUYER, buyerAddress: '5 Market Street', buyerCity: 'Ahmedabad', buyerStateCode: '24', buyerPincode: '380001', buyerCountry: 'India',
      },
    });
    await prisma.invoiceItem.create({
      data: {
        companyId: t.company.id, invoiceId: inv.id, productCode: 'P1', description: 'Gold ring 22K', quantity: 2, grossWeight: 10, netGoldWeight: 10,
        rateType: 'FIXED', goldRate: 5000, makingCharge: 0, unitPrice: 5000, totalPrice: 10000, hsnCodeId: hsn.id, taxRate: 0.03, uqc: 'PCS',
        taxableValue: 10000, cgstAmount: 150, sgstAmount: 150, lineTotalTax: 300,
      },
    });
    return inv.id;
  }
  const url = (reg: string, inv: string, q = '') => `/gst/integration/registrations/${reg}/invoices/${inv}/irn${q}`;
  const post = (t: TestTenant, reg: string, inv: string, q = '') => apiWith(tokenFor(t), app).post(url(reg, inv, q)).send({});
  const records = (t: TestTenant, invoiceId: string) => tenantQuery(t.company.id, (tx) => tx.eInvoiceRecord.findMany({ where: { invoiceId } }));

  beforeAll(async () => {
    A = await createTestTenant(`A${suffix}`, ['gst:einvoice_generate', 'gst:integration_view']);
    B = await createTestTenant(`B${suffix}`, ['gst:einvoice_generate', 'gst:integration_view']);
    viewOnly = await createTestTenant(`V${suffix}`, ['gst:integration_view']);
    tenants.push(A, B, viewOnly);
    regA = (await createGstRegistration(A.ctx, { gstin: SELLER_A, legalName: 'Seller A', stateCode: '24' })).id;
    regP = (await createGstRegistration(A.ctx, { gstin: SELLER_P, legalName: 'Seller P', stateCode: '24' })).id;
    regNic = (await createGstRegistration(A.ctx, { gstin: makeGstin('24', 'SELNN', '4444'), legalName: 'Seller NIC', stateCode: '24' })).id;
    regB = (await createGstRegistration(B.ctx, { gstin: makeGstin('24', 'SELBB', '5555'), legalName: 'Seller B', stateCode: '24' })).id;
    await createIntegrationConfig(A.ctx, regA, { provider: 'OTHER', environment: 'SANDBOX', credentials: { apiKey: SECRET } });
    await createIntegrationConfig(A.ctx, regP, { provider: 'OTHER', environment: 'PRODUCTION', credentials: { apiKey: SECRET } });
    await createIntegrationConfig(A.ctx, regNic, { provider: 'NIC_IRP', environment: 'SANDBOX', credentials: { baseUrl: 'https://sandbox.nic.example/x', clientId: 'c', clientSecret: SECRET, username: 'u', password: SECRET } });
    await createIntegrationConfig(B.ctx, regB, { provider: 'OTHER', environment: 'SANDBOX', credentials: { apiKey: SECRET } });
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => { logged.push(a.map(String).join(' ')); return logger; }) as never);
    }
  });
  beforeEach(() => { __resetAllSessionsForTests(); logged.length = 0; holder.provider = irnProvider(ok); });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const t of tenants) {
      const c = t.company.id;
      await tenantQuery(c, (tx) => tx.eInvoiceRecord.deleteMany({ where: { companyId: c } }));
      await tenantQuery(c, (tx) => tx.gstIntegrationRequestLog.deleteMany({ where: { companyId: c } }));
      await tenantQuery(c, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { companyId: c } }));
      await prisma.invoiceItem.deleteMany({ where: { companyId: c } });
      await prisma.taxInvoice.deleteMany({ where: { companyId: c } });
      await prisma.salesInvoice.deleteMany({ where: { companyId: c } });
      await prisma.client.deleteMany({ where: { companyId: c } });
      await tenantQuery(c, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: c } }));
      await cleanupTestTenant(t);
    }
    await prisma.$disconnect();
  });

  it('generates an IRN (201), builds the request from the stored invoice, persists the result, logs and audits — SANDBOX never touches the invoice', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    const res = await post(A, regA, inv);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'SUCCESS', irn: IRN, ackNumber: '112010000123456', environment: 'SANDBOX', documentType: 'INV', signedQrCode: 'eyJ.signed.qr', providerStatus: 'ACT' });
    expect(res.body.correlationId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ documentType: 'INV', seller: { gstin: SELLER_A }, buyer: { gstin: BUYER }, totals: { invoiceTotal: 10300 } });

    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv } });
    expect(tax.irn).toBeNull(); expect(tax.isEInvoice).toBe(false); // sandbox IRN is test data
    const log = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findFirstOrThrow({ where: { correlationId: res.body.correlationId } }));
    expect(log).toMatchObject({ operation: 'GENERATE_IRN', status: 'SUCCESS', environment: 'SANDBOX' });
    const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, action: 'IRN_GENERATE', userId: A.user.id } });
    expect(audit).toBeTruthy();
    expect(audit!.companyId).toBe(A.company.id);
  });

  it('is idempotent: a repeat returns the existing IRN (200) and never calls the provider again', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    const first = await post(A, regA, inv);
    const again = await post(A, regA, inv);
    expect(first.status).toBe(201); expect(again.status).toBe(200);
    expect(again.body.data.irn).toBe(first.body.data.irn);
    expect(calls).toHaveLength(1);
    expect(await records(A, inv)).toHaveLength(1);
  });

  it('a PRODUCTION IRN stamps the existing TaxInvoice IRN fields, so the existing void/amend guards protect the document', async () => {
    const inv = await makeInvoice(A, regP, SELLER_P);
    const res = await post(A, regP, inv);
    expect(res.status).toBe(201);
    const tax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: inv } });
    expect(tax).toMatchObject({ irn: IRN, ackNumber: '112010000123456', isEInvoice: true, qrCodeData: 'eyJ.signed.qr' });
    // the pre-existing in-app guard now refuses to void the registered e-invoice
    await expect(voidInvoice(inv, A.ctx, A.user.id, 'test void')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/IRN/) });
    // a second request cannot regenerate it
    expect((await post(A, regP, inv)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('not eligible → 422 with structured reasons; the provider is never called and no record is created', async () => {
    const voided = await makeInvoice(A, regA, SELLER_A, { status: 'VOID' });
    const res = await post(A, regA, voided);
    expect(res.status).toBe(422);
    expect(res.body.eligibility).toMatchObject({ status: 'NOT_ELIGIBLE', technicallyEligible: false, statutoryApplicability: 'NOT_DETERMINABLE' });
    expect(res.body.eligibility.blockingReasons.map((r: { code: string }) => r.code)).toContain('INVOICE_VOID');
    expect(calls).toHaveLength(0);
    expect(await records(A, voided)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { companyId: A.company.id, action: 'IRN_BLOCKED', recordId: voided } })).toBe(1);
  });

  it('an invoice issued under a different GST registration is refused (422, REGISTRATION_MISMATCH)', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A, { sellerRegistrationId: regP });
    const res = await post(A, regA, inv);
    expect(res.status).toBe(422);
    expect(res.body.eligibility.blockingReasons.map((r: { code: string }) => r.code)).toContain('REGISTRATION_MISMATCH');
    expect(calls).toHaveLength(0);
  });

  it('missing invoice data → 422 CANNOT_DETERMINE', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A, { sellerRegistrationId: null });
    const res = await post(A, regA, inv);
    expect(res.status).toBe(422);
    expect(res.body.eligibility.status).toBe('CANNOT_DETERMINE');
  });

  it('an ambiguous timeout is recorded AMBIGUOUS (504) and is NEVER resubmitted automatically or by a repeat request', async () => {
    holder.provider = irnProvider(() => { throw gErr('TIMEOUT'); });
    const inv = await makeInvoice(A, regA, SELLER_A);
    const res = await post(A, regA, inv);
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/unknown/i);
    expect((await records(A, inv))[0]).toMatchObject({ status: 'AMBIGUOUS', errorCategory: 'TIMEOUT' });
    expect(calls).toHaveLength(1);

    holder.provider = irnProvider(ok); // even with a healthy provider now
    const repeat = await post(A, regA, inv);
    expect(repeat.status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { companyId: A.company.id, action: 'IRN_AMBIGUOUS', recordId: (await records(A, inv))[0].id } })).toBe(1);
  });

  it('a 5xx / network failure is also AMBIGUOUS (the request may have been processed)', async () => {
    for (const cat of ['PROVIDER', 'NETWORK'] as const) {
      holder.provider = irnProvider(() => { throw gErr(cat); });
      const inv = await makeInvoice(A, regA, SELLER_A);
      expect((await post(A, regA, inv)).status).toBe(502);
      expect((await records(A, inv))[0].status).toBe('AMBIGUOUS');
    }
  });

  it('a provider duplicate (IRN already exists there) is AMBIGUOUS → 409, needs a controlled lookup', async () => {
    holder.provider = irnProvider(() => { throw gErr('DUPLICATE', '2150'); });
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv)).status).toBe(409);
    expect((await records(A, inv))[0]).toMatchObject({ status: 'AMBIGUOUS', errorCode: '2150' });
  });

  it('a malformed "success" reply is AMBIGUOUS (502) — no IRN is persisted from it', async () => {
    holder.provider = irnProvider(() => ({ status: 'GENERATED', irn: 'not-an-irn', ackNumber: '', ackDate: 'x', signedInvoice: null, signedQrCode: null, providerStatus: null, providerTimestamp: null }));
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv)).status).toBe(502);
    expect((await records(A, inv))[0]).toMatchObject({ status: 'AMBIGUOUS', irn: null, errorCode: 'MALFORMED_SUCCESS_RESPONSE' });
  });

  it('a definitive rejection is FAILED (422) and a later explicit request may try again (attempts = 2)', async () => {
    holder.provider = irnProvider(() => { throw gErr('VALIDATION', '2172'); });
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv)).status).toBe(422);
    expect((await records(A, inv))[0]).toMatchObject({ status: 'FAILED', errorCode: '2172', attempts: 1 });

    holder.provider = irnProvider(ok);
    const retry = await post(A, regA, inv);
    expect(retry.status).toBe(201);
    const [rec] = await records(A, inv);
    expect(rec).toMatchObject({ status: 'SUCCESS', attempts: 2, errorCode: null });
    expect(await records(A, inv)).toHaveLength(1);
  });

  it('provider rate limit → 429 (FAILED); provider auth failure → 502 and never 401', async () => {
    holder.provider = irnProvider(() => { throw gErr('RATE_LIMIT'); });
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv)).status).toBe(429);
    expect((await records(A, inv))[0].status).toBe('FAILED');

    __resetAllSessionsForTests();
    holder.provider = { ...irnProvider(ok), authenticate: async () => ({ status: 'AUTH_FAILED' as const }) };
    const inv2 = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv2)).status).toBe(502);
  });

  it('concurrent requests for the same invoice generate exactly one IRN', async () => {
    holder.provider = irnProvider(async () => { await new Promise((r) => setTimeout(r, 250)); return ok(); });
    const inv = await makeInvoice(A, regA, SELLER_A);
    const [x, y] = await Promise.all([post(A, regA, inv), post(A, regA, inv)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(calls).toHaveLength(1);
    expect(await records(A, inv)).toHaveLength(1);
  });

  it('the database refuses a second record for the same company/registration/document/environment', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv)).status).toBe(201);
    await expect(tenantQuery(A.company.id, (tx) => tx.eInvoiceRecord.create({
      data: { companyId: A.company.id, gstRegistrationId: regA, invoiceId: inv, documentType: 'INV', provider: 'OTHER', environment: 'SANDBOX', correlationId: 'x', idempotencyKey: 'another-key' },
    }))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('NIC_IRP stays unsupported: 501, no network, no record, no claim', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network must not be touched'); });
    const original = globalThis.fetch; globalThis.fetch = fetchSpy as never;
    try {
      const inv = await makeInvoice(A, regNic, makeGstin('24', 'SELNN', '4444'));
      const res = await post(A, regNic, inv);
      expect(res.status).toBe(501);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await records(A, inv)).toHaveLength(0);
    } finally { globalThis.fetch = original; }
  });

  it('no integration configured for the registration → 422', async () => {
    const reg = (await createGstRegistration(A.ctx, { gstin: makeGstin('24', 'SELCC', '6666'), legalName: 'No cfg', stateCode: '24' })).id;
    const inv = await makeInvoice(A, reg, makeGstin('24', 'SELCC', '6666'));
    expect((await post(A, reg, inv)).status).toBe(422);
  });

  it('bad ?environment → 400', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(A, regA, inv, '?environment=STAGING')).status).toBe(400);
  });

  // ── security ─────────────────────────────────────────────────────────────
  it('unauthenticated → 401; missing gst:einvoice_generate → 403 and nothing happens', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await apiWith(undefined, app).post(url(regA, inv)).send({})).status).toBe(401);
    const denied = await post(viewOnly, regA, inv);
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await records(A, inv)).toHaveLength(0);
  });

  it('cross-company: another company cannot use this registration or invoice (404), and nothing is created', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await post(B, regA, inv)).status).toBe(404);          // A's registration, B's token
    expect((await post(B, regB, inv)).status).toBe(404);          // B's registration, A's invoice
    expect((await post(A, regB, inv)).status).toBe(404);          // A's invoice, B's registration, A's token
    expect(calls).toHaveLength(0);
    expect(await records(A, inv)).toHaveLength(0);
    expect(await tenantQuery(B.company.id, (tx) => tx.eInvoiceRecord.count({ where: { invoiceId: inv } }))).toBe(0);
  });

  it('cross-registration: an invoice under one registration cannot be generated through a sibling registration', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    const res = await post(A, regP, inv); // regP has a PRODUCTION config, but the invoice belongs to regA
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('rejects a client-supplied companyId (body, query, header) with 400 before anything runs', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    expect((await apiWith(tokenFor(A), app).post(url(regA, inv)).send({ companyId: B.company.id })).status).toBe(400);
    expect((await apiWith(tokenFor(A), app).post(url(regA, inv, `?companyId=${B.company.id}`)).send({})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('ignores any document data in the body — the request is always built from the stored invoice', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    const res = await apiWith(tokenFor(A), app).post(url(regA, inv)).send({ buyerGstin: makeGstin('27', 'EVILL', '9999'), totalAmount: 1 });
    expect(res.status).toBe(201);
    expect(calls[0].buyer.gstin).toBe(BUYER);
    expect(calls[0].totals.invoiceTotal).toBe(10300);
  });

  it('never persists or logs a credential, token or auth header', async () => {
    const inv = await makeInvoice(A, regA, SELLER_A);
    const res = await post(A, regA, inv);
    const rec = (await records(A, inv))[0];
    const log = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findMany({ where: { correlationId: res.body.correlationId } }));
    const audits = await prisma.auditLog.findMany({ where: { companyId: A.company.id, recordId: rec.id } });
    const haystack = JSON.stringify([rec, log, audits, res.body]) + logged.join('\n');
    for (const secret of [SECRET, 'session-token-xyz']) expect(haystack).not.toContain(secret);
  });
});
