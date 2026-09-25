import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { apiWith, createTestTenant, cleanupTestTenant, purgeCompany, tokenFor, uniqueCompanyCode, TestTenant } from './fixtures';

// The TRIVO operator API (POST /platform/companies, ...): separate from every company's API, guarded
// by an operator key, disabled unless configured.

const KEY = 'trivo-platform-test-key-0123456789abcdef-XYZ';
const EMAIL_DOMAIN = '@platformapi.example.com';

describe('TRIVO platform (operator) API', () => {
  const created: string[] = [];
  let tenant: TestTenant; // an ordinary company user, to prove a company token is NOT an operator credential
  const savedKey = process.env.TRIVO_PLATFORM_API_KEY;

  // key === null means "send no key at all" (undefined would trigger the default)
  const op = (key: string | null = KEY) => {
    const auth: Record<string, string> = key ? { 'x-trivo-platform-key': key } : {};
    return {
      get: (p: string) => request(app).get(`/api/v1${p}`).set(auth),
      post: (p: string, body: object) => request(app).post(`/api/v1${p}`).set(auth).send(body),
      patch: (p: string, body: object) => request(app).patch(`/api/v1${p}`).set(auth).send(body),
    };
  };
  const body = (over: Record<string, unknown> = {}) => {
    const code = uniqueCompanyCode('PA');
    return { code, name: `Platform API ${code}`, admin: { email: `${code.toLowerCase()}${EMAIL_DOMAIN}`, name: 'Owner Person', password: 'Owner-Passw0rd-123' }, ...over };
  };

  beforeAll(async () => {
    tenant = await createTestTenant(`PAPI${Date.now().toString(36)}`.toUpperCase(), ['*']);
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TRIVO_PLATFORM_API_KEY; else process.env.TRIVO_PLATFORM_API_KEY = savedKey;
    // Discover every company these tests created via their admins' e-mails (not just the ids we tracked).
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: EMAIL_DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('is DISABLED (404, as if it did not exist) when no operator key is configured', async () => {
    delete process.env.TRIVO_PLATFORM_API_KEY;
    const r = await op(KEY).post('/platform/companies', body());
    expect(r.status).toBe(404);
    expect((await op(KEY).get('/platform/companies')).status).toBe(404);
  });

  describe('with an operator key configured', () => {
    beforeAll(() => { process.env.TRIVO_PLATFORM_API_KEY = KEY; });

    it('a missing key and a wrong key get the identical generic 401', async () => {
      const none = await op(null).post('/platform/companies', body());
      const wrong = await op('not-the-key-not-the-key-not-the-key-000').post('/platform/companies', body());
      const almost = await op(KEY.slice(0, -1) + 'X').post('/platform/companies', body());
      for (const r of [none, wrong, almost]) {
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({ success: false, error: 'Unauthorized' });
      }
    });

    it('a company\'s own login token is NOT an operator credential', async () => {
      const r = await apiWith(tokenFor(tenant), app).post('/platform/companies', body());
      expect(r.status).toBe(401);
      expect((await apiWith(tokenFor(tenant), app).get('/platform/companies')).status).toBe(401);
    });

    it('creates a company, its admin can log in, and the new company\'s data is its own', async () => {
      const b = body();
      const r = await op().post('/platform/companies', b);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      created.push(r.body.data.company.id);
      expect(r.body.data.company.code).toBe(b.code);
      expect(r.body.data.starterPackage.version).toBeGreaterThanOrEqual(1);

      const login = await apiWith(undefined, app).post('/auth/login', { companyCode: b.code, identifier: b.admin.email, password: b.admin.password });
      expect(login.status).toBe(200);
      expect(login.body.data.user.role).toBe('SUPER_ADMIN');
      // …and it works with real data straight away (starter masters are there)
      const cats = await apiWith(login.body.data.accessToken, app).get('/masters/categories');
      expect(cats.body.data.length).toBeGreaterThan(5);
    });

    it('validation: a body carrying a companyId, an unknown field, or bad values is rejected (400)', async () => {
      expect((await op().post('/platform/companies', body({ companyId: 'x' }))).status).toBe(400);
      expect((await op().post('/platform/companies', body({ isActive: false }))).status).toBe(400);
      expect((await op().post('/platform/companies', body({ code: 'bad code!' }))).status).toBe(400);
      expect((await op().post('/platform/companies', body({ admin: { email: 'nope', name: 'x' } }))).status).toBe(400);
    });

    it('a duplicate code is refused with a generic message that reveals nothing about the existing company', async () => {
      const first = body();
      const ok = await op().post('/platform/companies', first);
      created.push(ok.body.data.company.id);
      const dup = await op().post('/platform/companies', { ...first, name: 'Totally Different Name', admin: { email: `other${Date.now()}${EMAIL_DOMAIN}`, name: 'Someone Else', password: 'Owner-Passw0rd-123' } });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe('That company code is not available');
      expect(JSON.stringify(dup.body)).not.toContain(first.name);
    });

    it('lists companies as identity metadata ONLY — never any business data', async () => {
      const r = await op().get('/platform/companies');
      expect(r.status).toBe(200);
      expect(r.body.data.length).toBeGreaterThan(0);
      for (const c of r.body.data) expect(Object.keys(c).sort()).toEqual(['code', 'createdAt', 'id', 'isActive', 'name', 'starterPackageVersion']);
    });

    it('lists the released Starter Package versions (summary only)', async () => {
      const r = await op().get('/platform/starter-packages');
      expect(r.status).toBe(200);
      expect(r.body.data[0]).toMatchObject({ version: 1 });
      expect(JSON.stringify(r.body)).not.toMatch(/companyId/);
    });

    it('suspending a company cuts off new logins AND tokens it already holds; re-activating restores them', async () => {
      const b = body();
      const made = await op().post('/platform/companies', b);
      const id = made.body.data.company.id; created.push(id);
      const login = await apiWith(undefined, app).post('/auth/login', { companyCode: b.code, identifier: b.admin.email, password: b.admin.password });
      const token = login.body.data.accessToken;
      expect((await apiWith(token, app).get('/auth/me')).status).toBe(200);

      expect((await op().patch(`/platform/companies/${id}/status`, { isActive: false })).status).toBe(200);
      expect((await apiWith(token, app).get('/auth/me')).status).toBe(401);
      expect((await apiWith(undefined, app).post('/auth/login', { companyCode: b.code, identifier: b.admin.email, password: b.admin.password })).status).toBe(401);

      expect((await op().patch(`/platform/companies/${id}/status`, { isActive: true })).status).toBe(200);
      expect((await apiWith(token, app).get('/auth/me')).status).toBe(200);
      expect(await prisma.platformAuditLog.count({ where: { subjectId: id, action: { in: ['COMPANY_SUSPENDED', 'COMPANY_ACTIVATED'] } } })).toBe(2);
    });
  });
});
