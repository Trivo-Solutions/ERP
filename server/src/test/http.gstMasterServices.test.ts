import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// GST Phase C — proves the /gst router's own concerns over real HTTP: authentication is required,
// masters:view gates every route (the same permission every other read-only reference-data lookup
// in this app already uses), and the response envelope/status-code contract for each outcome is
// what PHASE_C_GST_MASTER_SERVICES.md documents. Service-level behavior (checksum correctness,
// provider outcome mapping, HSN/SAC search semantics) is covered by gstin.test.ts / gstProvider.test.ts
// / hsnSac.test.ts — this file only covers what those unit tests structurally cannot: real
// authenticate()/requirePermission() middleware over a real request.
describe('HTTP: GST master services (/gst)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const cleanupTenants: TestTenant[] = [];
  const hsnIds: string[] = [];

  const VALID_GSTIN = '24AAAAA0000A1Z8'; // see gstin.test.ts

  afterAll(async () => {
    await prisma.hsnCode.deleteMany({ where: { id: { in: hsnIds } } });
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`GST${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }

  // ─── Authentication ─────────────────────────────────────────────────────

  it('rejects an unauthenticated request', async () => {
    const res = await apiWith(undefined, app).get(`/gst/gstin/validate?gstin=${VALID_GSTIN}`);
    expect(res.status).toBe(401);
  });

  // ─── masters:view gating ────────────────────────────────────────────────

  it('masters:view alone can reach every /gst route; a role without it is 403 on all of them', async () => {
    const granted = await tenantWith('GR', ['masters:view']);
    const denied = await tenantWith('DN', ['invoice:view']); // an unrelated permission

    const routes = [
      `/gst/gstin/validate?gstin=${VALID_GSTIN}`,
      `/gst/gstin/lookup?gstin=${VALID_GSTIN}`,
      `/gst/hsn/search?q=x`,
      `/gst/sac/search?q=x`,
      `/gst/hsn/NOPE`,
      `/gst/sac/NOPE`,
      `/gst/codes/validate?code=NOPE&codeType=HSN`,
    ];

    for (const route of routes) {
      const ok = await granted.api.get(route);
      expect(ok.status, `granted -> ${route}`).not.toBe(403);
      const forbidden = await denied.api.get(route);
      expect(forbidden.status, `denied -> ${route}`).toBe(403);
    }
  });

  // ─── GSTIN validate ─────────────────────────────────────────────────────

  it('GET /gst/gstin/validate returns a structured result for a valid GSTIN', async () => {
    const { api } = await tenantWith('VAL', ['masters:view']);
    const res = await api.get(`/gst/gstin/validate?gstin=${VALID_GSTIN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: expect.objectContaining({ valid: true, gstin: VALID_GSTIN, stateCode: '24' }) });
  });

  it('GET /gst/gstin/validate returns valid:false (still 200) for a malformed GSTIN, not a thrown error', async () => {
    const { api } = await tenantWith('VALX', ['masters:view']);
    const res = await api.get('/gst/gstin/validate?gstin=NOT-A-GSTIN');
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.errors.length).toBeGreaterThan(0);
  });

  // ─── GSTIN lookup ───────────────────────────────────────────────────────

  it('GET /gst/gstin/lookup — malformed GSTIN is 400 GST_INVALID_GSTIN', async () => {
    const { api } = await tenantWith('LKI', ['masters:view']);
    const res = await api.get('/gst/gstin/lookup?gstin=NOT-A-GSTIN');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: expect.objectContaining({ code: 'GST_INVALID_GSTIN' }) });
  });

  it('GET /gst/gstin/lookup — no provider configured in this test environment is 503 GST_PROVIDER_NOT_CONFIGURED', async () => {
    const { api } = await tenantWith('LKC', ['masters:view']);
    const res = await api.get(`/gst/gstin/lookup?gstin=${VALID_GSTIN}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: expect.objectContaining({ code: 'GST_PROVIDER_NOT_CONFIGURED' }) });
  });

  // ─── HSN / SAC ──────────────────────────────────────────────────────────

  it('HSN search finds a seeded code by description and 404s an exact lookup for an unknown one', async () => {
    const { api } = await tenantWith('HSN', ['masters:view']);
    const code = `HTTPHSN${suffix}`;
    const created = await prisma.hsnCode.create({ data: { code, description: `HTTP test jewellery ${suffix}`, gstRate: 0.03, isActive: true, codeType: 'HSN' } });
    hsnIds.push(created.id);

    const search = await api.get(`/gst/hsn/search?q=${encodeURIComponent(`jewellery ${suffix}`)}`);
    expect(search.status).toBe(200);
    expect(search.body.data.results.some((r: { code: string }) => r.code === code)).toBe(true);

    const exact = await api.get(`/gst/hsn/${code}`);
    expect(exact.status).toBe(200);
    expect(exact.body.data.code).toBe(code);

    const missing = await api.get(`/gst/hsn/NO-SUCH-${suffix}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('GST_HSN_NOT_FOUND');
  });

  it('codes/validate reports valid:true for the seeded code and valid:false for an unknown one', async () => {
    const { api } = await tenantWith('CDV', ['masters:view']);
    const code = `HTTPVALID${suffix}`;
    const created = await prisma.hsnCode.create({ data: { code, description: 'HTTP validate test', gstRate: 0.03, isActive: true, codeType: 'HSN' } });
    hsnIds.push(created.id);

    const good = await api.get(`/gst/codes/validate?code=${code}&codeType=HSN`);
    expect(good.body.data.valid).toBe(true);

    const bad = await api.get(`/gst/codes/validate?code=NOPE-${suffix}&codeType=HSN`);
    expect(bad.body.data.valid).toBe(false);
  });

  // ─── Tenant/company isolation ───────────────────────────────────────────
  // HsnCode/GSTIN utilities are global reference data (no companyId) — there is no per-company
  // record to leak here, but a request from ANY company must still see the identical, single
  // global master list. This is the expected, documented shape (CLAUDE.md §11's allow-list), not
  // a gap: proven by both companies finding the same seeded code below.

  it('the same global HSN row is visible to two different companies (expected — it is shared reference data, not tenant data)', async () => {
    const code = `SHAREDHSN${suffix}`;
    const created = await prisma.hsnCode.create({ data: { code, description: 'Shared reference row', gstRate: 0.03, isActive: true, codeType: 'HSN' } });
    hsnIds.push(created.id);

    const companyA = await tenantWith('SHA', ['masters:view']);
    const companyB = await tenantWith('SHB', ['masters:view']);

    const fromA = await companyA.api.get(`/gst/hsn/${code}`);
    const fromB = await companyB.api.get(`/gst/hsn/${code}`);
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    expect(fromA.body.data).toEqual(fromB.body.data);
  });
});
