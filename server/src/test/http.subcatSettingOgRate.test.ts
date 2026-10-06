import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// Three small master/rate changes: the
// Setting Type master is company-isolated, and the daily rate sheet carries an optional OG (old gold) rate.

const DOMAIN = '@httpsubcatsettingog.example.com';
const PASSWORD = 'SubcatSetting-Passw0rd-123';

describe('HTTP: setting types, OG rate', () => {
  const created: string[] = [];
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;

  async function bringUp(tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `SS ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    return apiWith(login.body.data.accessToken, app);
  }

  beforeAll(async () => { a = await bringUp('SSA'); b = await bringUp('SSB'); }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  it('setting types: create, list active only, isolated per company, 403-free CRUD for the admin', async () => {
    const made = await a.post('/masters/setting-types', { code: 'prg', name: 'Prong' });
    expect(made.status).toBe(201);
    expect(made.body.data.code).toBe('PRG');
    const id = made.body.data.id;

    expect((await b.get('/masters/setting-types')).body.data).toHaveLength(0);
    expect((await b.patch(`/masters/setting-types/${id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await b.del(`/masters/setting-types/${id}`)).status).toBe(404);

    expect((await a.patch(`/masters/setting-types/${id}`, { isActive: false })).status).toBe(200);
    expect((await a.get('/masters/setting-types?active=true')).body.data).toHaveLength(0);
    expect((await a.get('/masters/setting-types')).body.data).toHaveLength(1);
    expect((await a.del(`/masters/setting-types/${id}`)).status).toBe(200);
  });

  it('rate sheet stores an OG rate, a rate-only re-save keeps it, null clears it, and bad values are 400', async () => {
    const date = '2026-10-03';
    const save = (rates: any[]) => a.post('/designs/rates/batch', { date, rates });
    const sheetRow = async () => (await a.get(`/designs/rates/sheet?date=${date}`)).body.data.find((r: any) => r.karat === '24K');

    expect((await save([{ karat: '24K', ratePerGram: 6500, ogRatePerGram: 6100 }])).status).toBe(200);
    expect(Number((await sheetRow()).ogRatePerGram)).toBe(6100);

    expect((await save([{ karat: '24K', ratePerGram: 6550 }])).status).toBe(200);
    const kept = await sheetRow();
    expect(Number(kept.ratePerGram)).toBe(6550);
    expect(Number(kept.ogRatePerGram)).toBe(6100);

    expect((await save([{ karat: '24K', ratePerGram: 6550, ogRatePerGram: 0 }])).status).toBe(400);
    expect((await save([{ karat: '24K', ratePerGram: 6550, ogRatePerGram: null }])).status).toBe(200);
    expect((await sheetRow()).ogRatePerGram).toBeNull();
  });
});
