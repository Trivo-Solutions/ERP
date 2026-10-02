import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { createGstRegistration } from '../modules/company/company.service';
import { tenantQuery } from '../shared/tenantContext';

// G8a — proves the permission gates (gst:integration_view/manage/test), the GST-registration
// ownership check on create, and the config ownership check on update/test are actually enforced
// by gstIntegration.router.ts over real HTTP — the one thing gstIntegration.service.test.ts's
// direct service calls cannot cover (those bypass requirePermission entirely). Mirrors
// http.gstr1Security.test.ts's own conventions.
describe('HTTP: G8a GST Integration Foundation — permission + tenant-isolation security', () => {
  const suffix = `g8asec${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanupTenants: TestTenant[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  const configRows: Array<{ id: string; companyId: string }> = [];

  afterAll(async () => {
    for (const c of configRows) await tenantQuery(c.companyId, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { id: c.id } }));
    for (const r of regRows) await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    for (const t of cleanupTenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    cleanupTenants.push(t);
    return t;
  }

  async function registrationFor(t: TestTenant, gstin: string) {
    const reg = await createGstRegistration(t.ctx, { gstin, legalName: `G8a HTTP Co ${gstin}`, stateCode: '24' });
    regRows.push({ id: reg.id, companyId: t.company.id });
    return reg.id;
  }

  it('rejects an unauthenticated request with 401', async () => {
    const res = await apiWith(undefined, app).get('/gst/integration/registrations/does-not-matter');
    expect(res.status).toBe(401);
  });

  it('rejects a user with no gst:integration_* permission with 403, for every route', async () => {
    const A = await tenantWith('NP', []);
    const regId = await registrationFor(A, '24AAAAA4000A1Z2');
    const token = tokenFor(A);

    const list = await apiWith(token, app).get(`/gst/integration/registrations/${regId}`);
    expect(list.status).toBe(403);

    const create = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'OTHER', environment: 'SANDBOX' });
    expect(create.status).toBe(403);
  });

  it('view-only permission can list but not create/update/test (403 on mutations)', async () => {
    const A = await tenantWith('VO', ['gst:integration_view']);
    const regId = await registrationFor(A, '24AAAAA5000A1Z1');
    const token = tokenFor(A);

    const list = await apiWith(token, app).get(`/gst/integration/registrations/${regId}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const create = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'OTHER', environment: 'SANDBOX' });
    expect(create.status).toBe(403);
  });

  it('manage permission can create/update but not test (403) without the separate test permission', async () => {
    const A = await tenantWith('MG', ['gst:integration_manage']);
    const regId = await registrationFor(A, '24AAAAA6000A1Z0');
    const token = tokenFor(A);

    const create = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'IRIS_IRP', environment: 'SANDBOX', label: 'http-created' });
    expect(create.status).toBe(201);
    expect(create.body.data.credentialKeys).toEqual([]);
    configRows.push({ id: create.body.data.id, companyId: A.company.id });

    const update = await apiWith(token, app).patch(`/gst/integration/${create.body.data.id}`, { label: 'renamed' });
    expect(update.status).toBe(200);
    expect(update.body.data.label).toBe('renamed');

    const test = await apiWith(token, app).post(`/gst/integration/${create.body.data.id}/test`, {});
    expect(test.status).toBe(403);
  });

  it('a config created with credentials never echoes a value back over HTTP — only credential keys', async () => {
    const A = await tenantWith('CR', ['gst:integration_manage']);
    const regId = await registrationFor(A, '24AAAAA7000A1Z9');
    const token = tokenFor(A);

    const create = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, {
      provider: 'NIC_IRP', environment: 'PRODUCTION', credentials: { clientSecret: 'must-never-appear-in-response' },
    });
    expect(create.status).toBe(201);
    configRows.push({ id: create.body.data.id, companyId: A.company.id });
    expect(create.body.data.credentialKeys).toEqual(['clientSecret']);
    expect(JSON.stringify(create.body)).not.toContain('must-never-appear-in-response');
  });

  it('test permission alone can run a connection test (health check), which never mutates anything but lastTested*', async () => {
    const A = await tenantWith('TE', ['gst:integration_manage', 'gst:integration_test']);
    const regId = await registrationFor(A, '24AAAAA8000A1Z8');
    const token = tokenFor(A);

    const create = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'OTHER', environment: 'SANDBOX' });
    configRows.push({ id: create.body.data.id, companyId: A.company.id });

    const test = await apiWith(token, app).post(`/gst/integration/${create.body.data.id}/test`, {});
    expect(test.status).toBe(200);
    expect(test.body.data.status).toBe('NOT_CONFIGURED');
    expect(test.body.data.correlationId).toBeTruthy();
  });

  it('refuses a forged cross-company GST registration id on create (404), creates nothing', async () => {
    const A = await tenantWith('X1', ['gst:integration_manage']);
    const B = await tenantWith('X2', ['gst:integration_manage']);
    const regIdB = await registrationFor(B, '24AAAAA9000A1Z7');

    const res = await apiWith(tokenFor(A), app).post(`/gst/integration/registrations/${regIdB}`, { provider: 'OTHER', environment: 'SANDBOX' });
    expect(res.status).toBe(404);

    const leaked = await tenantQuery(B.company.id, (tx) => tx.gstIntegrationConfig.findFirst({ where: { gstRegistrationId: regIdB } }));
    expect(leaked).toBeNull();
  });

  it("company A cannot list, read into, update, or test company B's config — every path 404s", async () => {
    const A = await tenantWith('Y1', ['gst:integration_view', 'gst:integration_manage', 'gst:integration_test']);
    const B = await tenantWith('Y2', ['gst:integration_manage']);
    const regIdB = await registrationFor(B, '24AAAAB0000A1Z6');
    const tokenB = tokenFor(B);
    const created = await apiWith(tokenB, app).post(`/gst/integration/registrations/${regIdB}`, { provider: 'OTHER', environment: 'PRODUCTION', label: "B's own" });
    configRows.push({ id: created.body.data.id, companyId: B.company.id });

    const tokenA = tokenFor(A);
    const list = await apiWith(tokenA, app).get(`/gst/integration/registrations/${regIdB}`);
    expect(list.status).toBe(404);

    const update = await apiWith(tokenA, app).patch(`/gst/integration/${created.body.data.id}`, { label: 'hijacked' });
    expect(update.status).toBe(404);

    const test = await apiWith(tokenA, app).post(`/gst/integration/${created.body.data.id}/test`, {});
    expect(test.status).toBe(404);

    // Nothing actually changed on B's row.
    const row = await tenantQuery(B.company.id, (tx) => tx.gstIntegrationConfig.findUniqueOrThrow({ where: { id: created.body.data.id } }));
    expect(row.label).toBe("B's own");
    expect(row.lastTestedAt).toBeNull();
  });

  it('a client-supplied companyId is rejected outright (400), never silently applied', async () => {
    const A = await tenantWith('CS', ['gst:integration_manage']);
    const regId = await registrationFor(A, '24AAAAB1000A1Z5');
    const res = await apiWith(tokenFor(A), app).post(`/gst/integration/registrations/${regId}`, { provider: 'OTHER', environment: 'SANDBOX', companyId: 'someone-elses-company' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown provider/environment with 400', async () => {
    const A = await tenantWith('IV', ['gst:integration_manage']);
    const regId = await registrationFor(A, '24AAAAB2000A1Z4');
    const token = tokenFor(A);
    const badProvider = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'FAKE_PROVIDER', environment: 'SANDBOX' });
    expect(badProvider.status).toBe(400);
    const badEnv = await apiWith(token, app).post(`/gst/integration/registrations/${regId}`, { provider: 'OTHER', environment: 'FAKE_ENV' });
    expect(badEnv.status).toBe(400);
  });
});
