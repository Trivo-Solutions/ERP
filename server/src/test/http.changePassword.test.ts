import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { purgeCompany, uniqueCompanyCode } from './fixtures';

// Admin change-password: current password required, policy enforced, every OTHER session signed out, the caller's own
// session carried on with fresh tokens, and another company's login unaffected.

const DOMAIN = '@changepw.example.com';
const OLD = 'Temporary-Passw0rd-123';
const NEW = 'A-Brand-New-Passphrase-77';

describe('POST /auth/change-password', () => {
  const created: string[] = [];
  let code = ''; let email = ''; let otherCode = ''; let otherEmail = '';

  const login = (c: string, e: string, p: string) =>
    request(app).post('/api/v1/auth/login').send({ companyCode: c, identifier: e, password: p });
  const change = (token: string, body: unknown) =>
    request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${token}`).send(body as object);

  beforeAll(async () => {
    code = uniqueCompanyCode('CPA'); email = `${code.toLowerCase()}${DOMAIN}`;
    otherCode = uniqueCompanyCode('CPB'); otherEmail = `${otherCode.toLowerCase()}${DOMAIN}`;
    for (const [c, e] of [[code, email], [otherCode, otherEmail]]) {
      const r = await provisionCompany({ code: c, name: `ChangePw ${c}`, admin: { email: e, name: 'Owner Person', password: OLD } });
      created.push(r.company.id);
    }
  }, 120_000);
  afterAll(async () => {
    for (const id of created) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  it('refuses a wrong current password, a weak/short/reused/personal new password, and changes nothing', async () => {
    const s = (await login(code, email, OLD)).body.data;
    expect((await change(s.accessToken, { current: 'not-the-password-1', next: NEW })).status).toBe(400);
    expect((await change(s.accessToken, { current: OLD, next: 'Short1!' })).status).toBe(400);
    expect((await change(s.accessToken, { current: OLD, next: OLD })).status).toBe(400);
    expect((await change(s.accessToken, { current: OLD, next: 'aaaaaaaaaaaaaaaa' })).status).toBe(400);
    expect((await change(s.accessToken, { current: OLD, next: `x${email}xx` })).status).toBe(400);
    expect((await change(s.accessToken, { current: OLD })).status).toBe(400);
    expect((await change(s.accessToken, { next: NEW })).status).toBe(400);
    expect((await change(s.accessToken, { current: { $ne: '' }, next: NEW })).status).toBe(400);
    expect((await login(code, email, OLD)).status).toBe(200); // old password still works
    expect((await request(app).post('/api/v1/auth/change-password').send({ current: OLD, next: NEW })).status).toBe(401);
  });

  it('on success: old password dead, new works, other sessions revoked, the caller keeps a working session', async () => {
    const device1 = (await login(code, email, OLD)).body.data;
    const device2 = (await login(code, email, OLD)).body.data;
    const res = await change(device1.accessToken, { current: OLD, next: NEW });
    expect(res.status).toBe(200);
    const fresh = res.body.data;
    expect(fresh.accessToken && fresh.refreshToken).toBeTruthy();

    expect((await login(code, email, OLD)).status).toBe(401);
    expect((await login(code, email, NEW)).status).toBe(200);

    // The other device is signed out: access token AND refresh token are refused.
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${device2.accessToken}`)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: device2.refreshToken })).status).toBe(401);
    // ...and so is the caller's own pre-change token, but the tokens returned by the change work.
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${device1.accessToken}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${fresh.accessToken}`)).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: fresh.refreshToken })).status).toBe(200);
  });

  it('writes an audit entry for this company and does not touch another company', async () => {
    const audit = await prisma.auditLog.findMany({ where: { action: 'PASSWORD_CHANGE', company: { code } } });
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0])).not.toContain(NEW);
    expect((await login(otherCode, otherEmail, OLD)).status).toBe(200);
  });
});
