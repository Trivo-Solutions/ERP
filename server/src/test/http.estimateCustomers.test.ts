import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// GET /estimation/customers: the "Send to billing" existing-customer picker. Name / mobile search, lean fields only,
// estimation:view required, and strictly the caller's own company.
describe('HTTP: estimation customer search', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];

  afterAll(async () => {
    for (const t of tenants) {
      await prisma.client.deleteMany({ where: { companyId: t.company.id } });
      await cleanupTestTenant(t);
    }
    await prisma.$disconnect();
  });

  async function setup(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    tenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }
  const mk = (companyId: string, code: string, over: Record<string, unknown>) =>
    prisma.client.create({ data: { companyId, clientCode: `${code}-${suffix}`, type: 'RETAIL', name: 'x', ...over } as any });

  it('requires authentication', async () => {
    expect((await apiWith(undefined, app).get('/estimation/customers')).status).toBe(401);
  });

  it('is 403 without estimation:view, even with client:view / invoice:create', async () => {
    const { api } = await setup('NP', ['client:view', 'invoice:create', 'estimation:manage']);
    expect((await api.get('/estimation/customers?q=ram')).status).toBe(403);
  });

  it('finds by name or mobile, returns only the picker fields, skips inactive and other companies', async () => {
    const a = await setup('A', ['estimation:view', 'client:view']);
    const b = await setup('B', ['estimation:view', 'client:view']);
    await mk(a.t.company.id, 'C1', { name: 'Ramesh Kumar', phone: '9876500011', address: '1 MG Road', panNumber: 'ABCDE1234F', creditLimit: 99999, currentBalance: 1234 });
    await mk(a.t.company.id, 'C2', { name: 'Suresh Rao', phone: '9123400022' });
    await mk(a.t.company.id, 'C3', { name: 'Ramya Inactive', phone: '9000000033', isActive: false });
    await mk(b.t.company.id, 'C4', { name: 'Ramesh Other', phone: '9876500011' });

    const byName = (await a.api.get('/estimation/customers?q=rame')).body.data;
    expect(byName.map((c: any) => c.name)).toEqual(['Ramesh Kumar']); // not the inactive Ramya, not B's Ramesh
    expect(Object.keys(byName[0]).sort()).toEqual(['address', 'clientCode', 'dateOfBirth', 'id', 'name', 'phone']);
    expect(byName[0]).not.toHaveProperty('panNumber');
    expect(JSON.stringify(byName)).not.toMatch(/panNumber|ABCDE1234F|creditLimit|currentBalance|99999|1234\b/);

    const byPhone = (await a.api.get('/estimation/customers?q=91234')).body.data;
    expect(byPhone.map((c: any) => c.name)).toEqual(['Suresh Rao']);

    expect((await a.api.get('/estimation/customers?q=zzzz')).body.data).toEqual([]);
    expect((await b.api.get('/estimation/customers?q=9876500011')).body.data.map((c: any) => c.name)).toEqual(['Ramesh Other']);
  });

  it('an empty or too-short search lists no one (no browsing the customer file)', async () => {
    const { t, api } = await setup('EMPTY', ['estimation:view', 'client:view']);
    await mk(t.company.id, 'E1', { name: 'Ramesh Kumar', phone: '9876500011' });
    for (const url of ['/estimation/customers', '/estimation/customers?q=', '/estimation/customers?q=%20%20', '/estimation/customers?q=r', '/estimation/customers?q=98']) {
      const r = await api.get(url);
      expect(r.status, url).toBe(200);
      expect(r.body.data, url).toEqual([]);
    }
  });

  it('results are capped, and a repeated ?q= is handled rather than crashing', async () => {
    const { t, api } = await setup('CAP', ['estimation:view', 'client:view']);
    for (let i = 0; i < 20; i++) await mk(t.company.id, `K${i}`, { name: `Cap ${String(i).padStart(2, '0')}`, phone: `98765000${String(i).padStart(2, '0')}` });
    expect((await api.get('/estimation/customers?q=cap')).body.data.length).toBe(15);
    const r = await api.get('/estimation/customers?q=cap&q=zzz'); // arrives as an array: ignored, so no term
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });

  it('matches a mobile however it is stored - spaces, dashes, +91, leading 0 - and however it is typed', async () => {
    const a = await setup('PH', ['estimation:view', 'client:view']);
    const b = await setup('PHB', ['estimation:view', 'client:view']);
    await mk(a.t.company.id, 'P1', { name: 'Plus Ninety One', phone: '+91 98765-00011' });
    await mk(a.t.company.id, 'P2', { name: 'Spaced', phone: '98765 00022' });
    await mk(a.t.company.id, 'P3', { name: 'Zero Prefixed', phone: '09876500033' });
    await mk(a.t.company.id, 'P4', { name: 'No Phone', phone: null });
    await mk(a.t.company.id, 'P5', { name: 'Gone', phone: '9876500044', isActive: false });
    await mk(b.t.company.id, 'P6', { name: 'Other Company', phone: '+91 98765 00011' });
    const names = async (q: string) => (await a.api.get(`/estimation/customers?q=${encodeURIComponent(q)}`)).body.data.map((c: any) => c.name);
    expect(await names('9876500011')).toEqual(['Plus Ninety One']);
    expect(await names('+91 98765 00011')).toEqual(['Plus Ninety One']);
    expect(await names('98765-00022')).toEqual(['Spaced']);
    expect(await names('919876500033')).toEqual(['Zero Prefixed']);
    expect(await names('09876500033')).toEqual(['Zero Prefixed']);
    expect(await names('00011')).toEqual(['Plus Ninety One']); // partial
    expect((await names('987650')).sort()).toEqual(['Plus Ninety One', 'Spaced', 'Zero Prefixed']);
    expect(await names('9876500044')).toEqual([]); // inactive
    // company B only ever sees its own copy of the same number
    expect((await b.api.get('/estimation/customers?q=9876500011')).body.data.map((c: any) => c.name)).toEqual(['Other Company']);
  });

  it('without client:view: name search only, and only id / name / code come back (no phone, DOB, address; no mobile matching)', async () => {
    const { t, api } = await setup('LP', ['estimation:view']);
    await mk(t.company.id, 'L1', { name: 'Ramesh Kumar', phone: '9876500011', address: '1 MG Road', dateOfBirth: new Date('1990-04-05') });
    const byName = (await api.get('/estimation/customers?q=rames')).body.data;
    expect(byName.map((c: any) => c.name)).toEqual(['Ramesh Kumar']);
    expect(Object.keys(byName[0]).sort()).toEqual(['clientCode', 'id', 'name']);
    expect(JSON.stringify(byName)).not.toMatch(/9876500011|MG Road|1990/);
    expect((await api.get('/estimation/customers?q=9876500011')).body.data).toEqual([]); // a number cannot be probed
    expect((await api.get('/estimation/customers?q=98765')).body.data).toEqual([]);
  });
});
