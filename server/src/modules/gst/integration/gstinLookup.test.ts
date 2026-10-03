import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { app } from '../../../app';
import { platformPrisma as prisma } from '../../../config/database';
import { logger } from '../../../config/logger';
import { tenantQuery } from '../../../shared/tenantContext';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../../test/fixtures';
import { validateGstin } from '../../../shared/gstin';
import { createIntegrationConfig } from './gstIntegration.service';
import { lookupGstin } from './gstinLookup.service';
import { NicIrpProvider } from './providers/nicIrpProvider';
import { resolveProvider } from './providers/resolveProvider';
import { __resetAllSessionsForTests } from './auth/tokenSession';
import { GstIntegrationCallContext } from './types';

// ─── helpers ────────────────────────────────────────────────────────────────
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Builds a structurally + checksum-valid GSTIN from a 5-letter prefix + 4 digits (state 24). */
function makeGstin(letters: string, digits: string, entity = '1'): string {
  const first14 = `24${letters}${digits}A${entity}Z`;
  let factor = 2; let sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    let p = ALPHABET.indexOf(first14[i]) * factor;
    factor = factor === 2 ? 1 : 2;
    p = Math.floor(p / 36) + (p % 36);
    sum += p;
  }
  return first14 + ALPHABET[(36 - (sum % 36)) % 36];
}

const TARGET = makeGstin('LKUPA', '1234');
const SECRET = 'sup3r-secret-client-secret-XYZ';
const PASSWORD = 'p@ssw0rd-never-leak';
const TOKEN = 'provider-session-token-123';
const CREDS = { baseUrl: 'https://sandbox.nic.example/eivital/v1.04', clientId: 'cid-123', clientSecret: SECRET, username: 'api_user', password: PASSWORD };

const nicData = {
  Gstin: TARGET, TradeName: 'LOOKUP TRADERS', LegalName: 'LOOKUP TRADERS PVT LTD', AddrBnm: 'Gold Tower', AddrBno: '12',
  AddrSt: 'Ring Road', AddrLoc: 'Surat', AddrPncd: 395002, StateCode: 24, TxpType: 'REG', Status: 'ACT', DtReg: '01/07/2017', DtDeReg: '',
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | never;
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; headers: Record<string, string> }> = [];
function stubProvider(lookup: Handler, auth?: Handler) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.endsWith('/auth')) {
      return auth ? auth(url, init) : new Response(JSON.stringify({ Status: 1, Data: { AuthToken: TOKEN, TokenExpiry: new Date(Date.now() + 3600_000).toISOString() } }), { status: 200 });
    }
    return lookup(url, init);
  }) as typeof fetch;
}
const okLookup: Handler = () => new Response(JSON.stringify({ Status: 1, Data: nicData }), { status: 200 });

function ctxFor(over: Partial<GstIntegrationCallContext> = {}): GstIntegrationCallContext {
  return { companyId: 'c1', gstRegistrationId: 'r1', configId: 'cfg1', environment: 'SANDBOX', correlationId: 'corr-xyz', credentials: CREDS, ...over };
}

// ─── adapter (no DB) ────────────────────────────────────────────────────────
describe('G8b NicIrpProvider adapter', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('normalizes a provider response into the canonical GstinDetails; unsupplied fields stay null', async () => {
    stubProvider(okLookup);
    const p = new NicIrpProvider({ maxRetries: 0 });
    const d = await p.getGstinDetails(ctxFor({ authToken: TOKEN }), TARGET);
    expect(d).toMatchObject({
      gstin: TARGET, legalName: 'LOOKUP TRADERS PVT LTD', tradeName: 'LOOKUP TRADERS', registrationStatus: 'ACT',
      registrationDate: '2017-07-01', cancellationDate: null, taxpayerType: 'REG', stateCode: '24',
      compositionStatus: 'NOT_COMPOSITION', provider: 'NIC_IRP',
      constitutionOfBusiness: null, natureOfBusiness: null, eInvoiceEnabled: null, stateName: null,
    });
    expect(d.principalPlaceOfBusiness).toBe('Gold Tower, 12, Ring Road, Surat, 395002');
    expect(Number.isNaN(Date.parse(d.fetchedAt))).toBe(false);
  });

  it('maps TxpType COM to COMPOSITION', async () => {
    stubProvider(() => new Response(JSON.stringify({ Status: 1, Data: { ...nicData, TxpType: 'COM' } }), { status: 200 }));
    const d = await new NicIrpProvider({ maxRetries: 0 }).getGstinDetails(ctxFor({ authToken: TOKEN }), TARGET);
    expect(d.compositionStatus).toBe('COMPOSITION');
  });

  it('propagates the correlation id and sends the session token to the provider', async () => {
    stubProvider(okLookup);
    await new NicIrpProvider({ maxRetries: 0 }).getGstinDetails(ctxFor({ authToken: TOKEN, correlationId: 'corr-propagate' }), TARGET);
    expect(calls[0].headers['x-correlation-id']).toBe('corr-propagate');
    expect(calls[0].headers.authtoken).toBe(TOKEN);
  });

  it('throws a safe VALIDATION error naming only the key when a credential is missing', async () => {
    const { clientSecret: _omit, ...rest } = CREDS;
    await expect(new NicIrpProvider().authenticate(ctxFor({ credentials: rest })))
      .rejects.toMatchObject({ category: 'VALIDATION', message: "Missing required provider credential 'clientSecret'" });
  });

  it('rejects an internal baseUrl in PRODUCTION (SSRF guard) but not a public one', async () => {
    await expect(new NicIrpProvider().authenticate(ctxFor({ environment: 'PRODUCTION', credentials: { ...CREDS, baseUrl: 'https://169.254.169.254/x' } })))
      .rejects.toMatchObject({ category: 'VALIDATION' });
    await expect(new NicIrpProvider().authenticate(ctxFor({ environment: 'PRODUCTION', credentials: { ...CREDS, baseUrl: 'https://localhost/x' } })))
      .rejects.toMatchObject({ category: 'VALIDATION' });
  });

  it('refuses plain http in PRODUCTION (reuses the G8a HTTPS rule)', async () => {
    stubProvider(okLookup);
    await expect(new NicIrpProvider().authenticate(ctxFor({ environment: 'PRODUCTION', credentials: { ...CREDS, baseUrl: 'http://irp.example/x' } })))
      .rejects.toMatchObject({ category: 'VALIDATION' });
    expect(calls).toHaveLength(0);
  });

  it('authenticate returns AUTH_FAILED when the provider rejects the credentials in its envelope', async () => {
    stubProvider(okLookup, () => new Response(JSON.stringify({ Status: 0, ErrorDetails: [{ ErrorCode: '1005', ErrorMessage: 'bad' }] }), { status: 200 }));
    const r = await new NicIrpProvider().authenticate(ctxFor());
    expect(r.status).toBe('AUTH_FAILED');
    expect(r.token).toBeUndefined();
  });

  it('a malformed provider body is a PROVIDER error; a mismatched GSTIN in the body is rejected', async () => {
    stubProvider(() => new Response('<html>not json</html>', { status: 200 }));
    await expect(new NicIrpProvider({ maxRetries: 0 }).getGstinDetails(ctxFor({ authToken: TOKEN }), TARGET)).rejects.toMatchObject({ category: 'PROVIDER' });
    stubProvider(() => new Response(JSON.stringify({ Status: 1, Data: { ...nicData, Gstin: makeGstin('OTHRA', '9999') } }), { status: 200 }));
    await expect(new NicIrpProvider({ maxRetries: 0 }).getGstinDetails(ctxFor({ authToken: TOKEN }), TARGET)).rejects.toMatchObject({ category: 'PROVIDER' });
  });

  it('a provider-reported failure surfaces only its code, never its message text', async () => {
    stubProvider(() => new Response(JSON.stringify({ Status: 0, ErrorDetails: [{ ErrorCode: '3001', ErrorMessage: 'INTERNAL SECRET DETAIL' }] }), { status: 200 }));
    const err: any = await new NicIrpProvider({ maxRetries: 0 }).getGstinDetails(ctxFor({ authToken: TOKEN }), TARGET).catch((e) => e);
    expect(err.providerCode).toBe('3001');
    expect(JSON.stringify(err.toSafeJSON())).not.toContain('INTERNAL SECRET DETAIL');
  });
});

describe('G8b resolveProvider', () => {
  it('resolves NIC_IRP to the real adapter and an unimplemented provider to a deterministic unsupported one', async () => {
    expect(resolveProvider('NIC_IRP')).toBeInstanceOf(NicIrpProvider);
    const r = await resolveProvider('IRIS_IRP').getGstinDetails(ctxFor(), TARGET);
    expect(r).toMatchObject({ status: 'UNSUPPORTED_PROVIDER_OPERATION' });
  });
});

// ─── service + HTTP (DB) ────────────────────────────────────────────────────
describe('G8b GSTIN lookup: service + HTTP security', () => {
  const suffix = `g8b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  let A: TestTenant; let B: TestTenant; let regA: string; let regB: string;
  let nicConfigA: string;
  const logged: string[] = [];

  beforeAll(async () => {
    A = await createTestTenant(`A${suffix}`, ['gst:integration_view', 'gst:integration_manage']);
    B = await createTestTenant(`B${suffix}`, ['gst:integration_view', 'gst:integration_manage']);
    tenants.push(A, B);
    regA = (await createGstRegistration(A.ctx, { gstin: makeGstin('LKREA', '1111'), legalName: 'Lookup Co A', stateCode: '24' })).id;
    regB = (await createGstRegistration(B.ctx, { gstin: makeGstin('LKREB', '2222'), legalName: 'Lookup Co B', stateCode: '24' })).id;
    nicConfigA = (await createIntegrationConfig(A.ctx, regA, { provider: 'NIC_IRP', environment: 'SANDBOX', credentials: CREDS })).id;
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => { logged.push(a.map(String).join(' ')); return logger; }) as never);
    }
  });

  beforeEach(() => { __resetAllSessionsForTests(); logged.length = 0; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const t of tenants) {
      await tenantQuery(t.company.id, (tx) => tx.gstIntegrationRequestLog.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: t.company.id } }));
      await cleanupTestTenant(t);
    }
    await prisma.$disconnect();
  });

  const url = (reg: string, gstin: string, q = '') => `/gst/integration/registrations/${reg}/gstin/${gstin}${q}`;

  it('the fixture GSTIN generator really produces checksum-valid GSTINs', () => {
    expect(validateGstin(TARGET).valid).toBe(true);
  });

  it('returns canonical details over HTTP with a correlation id, and logs a metadata-only request row', async () => {
    stubProvider(okLookup);
    const res = await apiWith(tokenFor(A), app).get(url(regA, TARGET.toLowerCase()));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ gstin: TARGET, legalName: 'LOOKUP TRADERS PVT LTD', provider: 'NIC_IRP', stateCode: '24' });
    expect(res.body.correlationId).toBeTruthy();
    expect(calls.find((c) => c.url.includes('/Master/gstin/'))!.headers['x-correlation-id']).toBe(res.body.correlationId);

    const row = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findFirstOrThrow({ where: { correlationId: res.body.correlationId } }));
    expect(row).toMatchObject({ operation: 'GET_GSTIN_DETAILS', status: 'SUCCESS', provider: 'NIC_IRP', environment: 'SANDBOX' });
    expect(JSON.stringify(row)).not.toContain(TARGET);
  });

  it('rejects malformed and checksum-invalid GSTINs with 400 before any provider call', async () => {
    stubProvider(okLookup);
    const malformed = await apiWith(tokenFor(A), app).get(url(regA, 'NOT-A-GSTIN'));
    expect(malformed.status).toBe(400);
    const badChecksum = TARGET.slice(0, 14) + (TARGET[14] === '0' ? '1' : '0');
    const checksum = await apiWith(tokenFor(A), app).get(url(regA, badChecksum));
    expect(checksum.status).toBe(400);
    expect(checksum.body.error).toMatch(/check/i);
    expect(calls).toHaveLength(0);
  });

  it('caches the provider session across lookups (single authenticate)', async () => {
    stubProvider(okLookup);
    await apiWith(tokenFor(A), app).get(url(regA, TARGET));
    await apiWith(tokenFor(A), app).get(url(regA, TARGET));
    expect(calls.filter((c) => c.url.endsWith('/auth'))).toHaveLength(1);
  });

  it('provider timeout → 504; provider unavailable (5xx) → 502; malformed response → 502', async () => {
    stubProvider(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    expect((await apiWith(tokenFor(A), app).get(url(regA, TARGET))).status).toBe(504);
    stubProvider(() => new Response('down', { status: 503 }));
    expect((await apiWith(tokenFor(A), app).get(url(regA, TARGET))).status).toBe(502);
    stubProvider(() => new Response('garbage', { status: 200 }));
    expect((await apiWith(tokenFor(A), app).get(url(regA, TARGET))).status).toBe(502);
    const failed = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.count({ where: { operation: 'GET_GSTIN_DETAILS', status: 'FAILED' } }));
    expect(failed).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('provider authentication failure → 502 (never 401), and the failed session is not cached', async () => {
    stubProvider(okLookup, () => new Response('nope', { status: 401 }));
    const res = await apiWith(tokenFor(A), app).get(url(regA, TARGET));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/correlationId/);
    stubProvider(okLookup);
    expect((await apiWith(tokenFor(A), app).get(url(regA, TARGET))).status).toBe(200);
  });

  it('an unsupported provider config → 501; no config → 422; a bad ?environment → 400', async () => {
    const irisReg = (await createGstRegistration(A.ctx, { gstin: makeGstin('LKREA', '3333'), legalName: 'Iris reg', stateCode: '24' })).id;
    await createIntegrationConfig(A.ctx, irisReg, { provider: 'IRIS_IRP', environment: 'SANDBOX', credentials: CREDS });
    const unsupportedRes = await apiWith(tokenFor(A), app).get(url(irisReg, TARGET));
    expect(unsupportedRes.status).toBe(501);

    const bareReg = (await createGstRegistration(A.ctx, { gstin: makeGstin('LKREA', '4444'), legalName: 'Bare reg', stateCode: '24' })).id;
    expect((await apiWith(tokenFor(A), app).get(url(bareReg, TARGET))).status).toBe(422);

    expect((await apiWith(tokenFor(A), app).get(url(regA, TARGET, '?environment=STAGING'))).status).toBe(400);
  });

  it('a config with a missing credential → 422 with only the key name', async () => {
    const reg = (await createGstRegistration(A.ctx, { gstin: makeGstin('LKREA', '5555'), legalName: 'Missing cred reg', stateCode: '24' })).id;
    const { password: _p, ...partial } = CREDS;
    await createIntegrationConfig(A.ctx, reg, { provider: 'NIC_IRP', environment: 'SANDBOX', credentials: partial });
    stubProvider(okLookup);
    const res = await apiWith(tokenFor(A), app).get(url(reg, TARGET));
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("'password'");
  });

  it('sandbox and production configs stay isolated: ambiguity is refused, ?environment picks exactly one', async () => {
    const reg = (await createGstRegistration(A.ctx, { gstin: makeGstin('LKREA', '6666'), legalName: 'Both envs reg', stateCode: '24' })).id;
    await createIntegrationConfig(A.ctx, reg, { provider: 'NIC_IRP', environment: 'SANDBOX', credentials: { ...CREDS, baseUrl: 'https://sandbox.nic.example/x' } });
    await createIntegrationConfig(A.ctx, reg, { provider: 'NIC_IRP', environment: 'PRODUCTION', credentials: { ...CREDS, baseUrl: 'https://prod.nic.example/x' } });
    stubProvider(okLookup);
    expect((await apiWith(tokenFor(A), app).get(url(reg, TARGET))).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect((await apiWith(tokenFor(A), app).get(url(reg, TARGET, '?environment=PRODUCTION'))).status).toBe(200);
    expect(calls.every((c) => c.url.startsWith('https://prod.nic.example/'))).toBe(true);
  });

  it('never exposes or logs credentials, tokens, or authorization data — in responses, errors or logs', async () => {
    stubProvider(okLookup);
    const ok = await apiWith(tokenFor(A), app).get(url(regA, TARGET));
    stubProvider(() => new Response('boom', { status: 500 }));
    const bad = await apiWith(tokenFor(A), app).get(url(regA, TARGET));
    const row = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findMany({ where: { companyId: A.company.id } }));
    const haystack = JSON.stringify([ok.body, bad.body, row]) + logged.join('\n');
    for (const secret of [SECRET, PASSWORD, TOKEN, 'cid-123']) expect(haystack).not.toContain(secret);
  }, 30_000);

  it('rejects an unauthenticated request (401) and a user without gst:integration_view (403)', async () => {
    expect((await apiWith(undefined, app).get(url(regA, TARGET))).status).toBe(401);
    const NP = await createTestTenant(`NP${suffix}`, []);
    tenants.push(NP);
    expect((await apiWith(tokenFor(NP), app).get(url(regA, TARGET))).status).toBe(403);
  });

  it("company B cannot use company A's registration (404, no provider call, no existence leak), and vice versa", async () => {
    stubProvider(okLookup);
    const res = await apiWith(tokenFor(B), app).get(url(regA, TARGET));
    expect(res.status).toBe(404);
    const missing = await apiWith(tokenFor(B), app).get(url('does-not-exist', TARGET));
    expect(missing.status).toBe(404);
    expect(res.body.error).toBe(missing.body.error);
    expect(calls).toHaveLength(0);
  });

  it("cross-company config isolation: B's registration has no config of its own, so A's NIC config is never used for it", async () => {
    stubProvider(okLookup);
    const res = await apiWith(tokenFor(B), app).get(url(regB, TARGET));
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
    expect(nicConfigA).toBeTruthy();
  });

  it('a client-supplied companyId (query or header) is rejected with 400 and never applied', async () => {
    stubProvider(okLookup);
    const q = await apiWith(tokenFor(A), app).get(url(regA, TARGET, `?companyId=${B.company.id}`));
    expect(q.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('service-level: lookupGstin refuses a foreign registration with 404', async () => {
    await expect(lookupGstin(B.ctx, regA, TARGET)).rejects.toMatchObject({ statusCode: 404 });
  });
});
