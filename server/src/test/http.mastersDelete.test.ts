import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// DELETE on a master row over real HTTP: an unused row goes; a row something references is refused with a
// 409 (never a 500) and stays; another company's row is a 404.

const DOMAIN = '@httpmastersdelete.example.com';
const PASSWORD = 'MastersDelete-Passw0rd-123';

describe('HTTP: deleting master rows', () => {
  const created: string[] = [];
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;
  let companyA = ''; let branchA = '';

  async function bringUp(tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `MD ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { api: apiWith(login.body.data.accessToken, app), companyId: r.company.id, branchId: r.branch.id };
  }

  beforeAll(async () => {
    const x = await bringUp('MDA'); a = x.api; companyA = x.companyId; branchA = x.branchId;
    b = (await bringUp('MDB')).api;
  }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  it('deletes an unused row; a second delete / another company gets 404', async () => {
    const made = await a.post('/masters/collections', { code: 'TMP1', name: 'Temp' });
    expect(made.status).toBe(201);
    const id = made.body.data.id;

    expect((await b.del(`/masters/collections/${id}`)).status).toBe(404);
    expect((await a.get('/masters/collections')).body.data.some((c: any) => c.id === id)).toBe(true);

    expect((await a.del(`/masters/collections/${id}`)).status).toBe(200);
    expect((await a.get('/masters/collections')).body.data.some((c: any) => c.id === id)).toBe(false);
    expect((await a.del(`/masters/collections/${id}`)).status).toBe(404);
  });

  it('refuses (409, row kept) a category that has a sub-category or a tag', async () => {
    const cat = (await a.post('/masters/categories', { code: 'DELCAT', name: 'Del Cat' })).body.data;
    await a.post('/masters/subcategories', { code: 'DELSUB', name: 'Del Sub', categoryId: cat.id });
    const blocked = await a.del(`/masters/categories/${cat.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Deactivate/);
    expect((await a.get('/masters/categories')).body.data.some((c: any) => c.id === cat.id)).toBe(true);

    // a tag in a category pins it too
    const cat2 = (await a.post('/masters/categories', { code: 'TAGCAT', name: 'Tag Cat' })).body.data;
    const stockType = (await a.get('/masters/stock-types')).body.data[0].id;
    const tag = await a.post('/tagging/tags', {
      branchId: branchA, name: 'Piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
      stockTypeId: stockType, categoryId: cat2.id,
    });
    expect(tag.status).toBe(201);
    expect((await a.del(`/masters/categories/${cat2.id}`)).status).toBe(409);
  });

  it('deletes a karat nothing uses, refuses one a tag uses', async () => {
    const made = await a.post('/masters/karats', { code: '9K', metalType: 'GOLD', purity: '0.3750' });
    expect(made.status).toBe(201);
    const free = made.body.data;
    expect((await a.del(`/masters/karats/${free.id}`)).status).toBe(200);
    expect((await a.get('/masters/karats?includeInactive=true')).body.data.some((k: any) => k.code === '9K')).toBe(false);

    const used = (await a.get('/masters/karats')).body.data.find((k: any) => k.code === '22K');
    const blocked = await a.del(`/masters/karats/${used.id}`);
    expect(blocked.status).toBe(409);
    expect(await prisma.karatMaster.count({ where: { companyId: companyA, code: '22K' } })).toBe(1);
  });

  it('deletes a purchase order that received nothing; refuses one with a goods receipt', async () => {
    const sup = (await a.post('/procurement/suppliers', { name: 'Del Supplier', type: 'OTHER', gstNumber: '27AAAAA0000A1Z5', state: 'Maharashtra' })).body.data;
    const line = { materialCode: 'G22', materialName: '22K Gold', materialType: 'METAL', quantity: 1, weight: 10, unit: 'GM', karat: '22K', ratePerUnit: 6000 };
    const mk = () => a.post('/procurement/orders', { supplierId: sup.id, poType: 'OUTRIGHT', orderDate: '2026-09-01T00:00:00.000Z', items: [line] });

    const draft = await mk();
    expect(draft.status).toBe(201);
    const id = draft.body.data.id;
    expect((await b.del(`/procurement/orders/${id}`)).status).toBe(404);
    expect((await a.del(`/procurement/orders/${id}`)).status).toBe(200);
    expect((await a.get(`/procurement/orders/${id}`)).status).toBe(404);
    expect(await prisma.poItem.count({ where: { poId: id } })).toBe(0);

    const received = await mk();
    const grn = await a.post('/procurement/grn', {
      poId: received.body.data.id, branchId: branchA, receivedDate: '2026-09-02T00:00:00.000Z',
      items: [{ poItemId: received.body.data.poItems[0].id, invoiceQty: 1, invoiceWeight: 10, scaleWeight: 10 }],
    });
    expect(grn.status).toBe(201);
    const blocked = await a.del(`/procurement/orders/${received.body.data.id}`);
    expect(blocked.status).toBe(409);
    expect((await a.get(`/procurement/orders/${received.body.data.id}`)).status).toBe(200);
  });
});
