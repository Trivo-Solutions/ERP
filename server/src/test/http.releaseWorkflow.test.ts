import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { businessDayString } from '../shared/businessDay';
import { apiWith, purgeCompany, uniqueCompanyCode, createTestTenant, cleanupTestTenant, tokenFor } from './fixtures';

// RELEASE WORKFLOW, over real HTTP with synthetic data: metal rate -> tag -> stock value -> estimate -> the rate moves ->
// estimate / bill from estimate / direct sale / offer / discount + GST -> permissions -> tenant boundary.
// Every expected figure below is computed here by hand (plain arithmetic), never by calling the pricing code under test.
//
// The reference piece: a 22K ruby ring, 10 g of metal, 1 ct ruby @ 1500, MC 100 per g, VA 10 % of the metal value.
//   price(R) = 10 x R  +  1500  +  10 x 100  +  10 % x 10 x R   =  11 x R + 2500          (R = the 22K rate per gram)
//   GST 3 % (HSN 7113, from the master), invoice total rounded to the nearest rupee.
const DOMAIN = '@httprelease.example.com';
const PASSWORD = 'Release-Passw0rd-123';
const r2 = (n: number) => Math.round(n * 100) / 100;

describe('release workflow: rate -> tag -> stock -> estimate -> bill, over HTTP', () => {
  const created: string[] = [];
  const createdUsers: Array<{ companyId: string; userId: string }> = [];
  const A: Record<string, any> = {}; const B: Record<string, any> = {};
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;
  const today = businessDayString();
  let g1 = 0; let g2 = 0;                   // the 22K rate before / after the move
  const BASE1 = 6550; const BASE2 = 7000;   // 24K rate entered by the operator

  async function bringUp(into: Record<string, any>, tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `Release ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    createdUsers.push({ companyId: r.company.id, userId: (r.admin as any).userId });
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    into.token = login.body.data.accessToken; into.companyId = r.company.id; into.branchId = r.branch.id;
    into.userId = (r.admin as any).userId;
    const api = apiWith(into.token, app);
    into.category = (await api.get('/masters/categories')).body.data[0].id;
    into.stockType = (await api.get('/masters/stock-types')).body.data[0].id;
    return api;
  }

  const setBaseRate = (api: ReturnType<typeof apiWith>, rate: number) => api.post('/designs/rates/batch', { date: today, rates: [{ karat: '24K', ratePerGram: rate }] });
  const rate22 = async (api: ReturnType<typeof apiWith>) => {
    const row = (await api.get(`/designs/rates/sheet?date=${today}`)).body.data.find((x: any) => x.karat === '22K');
    return { rate: Number(row.ratePerGram), purity: Number(row.purity) };
  };
  const ringBody = (o: Record<string, any>, over: Record<string, unknown> = {}) => ({
    branchId: o.branchId, stockTypeId: o.stockType, categoryId: o.category, name: 'Ruby ring', makeType: 'GOLD', metalType: 'GOLD', metalKarat: '22K',
    grossWeight: 11, netWeight: 10, costPrice: 40000, saleMcRate: 100, saleVaPercent: 10,
    materials: [
      { code: 'G22', materialType: 'METAL', weight: 10, unit: 'GM', saleRate: 1 },       // a stale stored metal rate: must never price anything
      { code: 'RUBY', materialType: 'STONE', weight: 1, unit: 'CT', saleRate: 1500 },
    ], ...over,
  });
  const newRing = async (api: ReturnType<typeof apiWith>, o: Record<string, any>, over: Record<string, unknown> = {}) => {
    const res = await api.post('/tagging/tags', ringBody(o, over));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  };

  beforeAll(async () => { a = await bringUp(A, 'RLA'); b = await bringUp(B, 'RLB'); }, 120_000);
  // Cleanup removes ONLY what this run created: the companies it provisioned and the two logins it made, both tracked by id
  // the moment they exist (so a run that dies half-way through bringUp still cleans up what it had). Nothing is discovered by
  // e-mail domain, and no tag or company is deleted "to make a user deletable": a login still referenced after its company has
  // been purged is reported with the exact reference, never forced.
  afterAll(async () => {
    const problems: string[] = [];
    const purged = new Set<string>();
    for (const id of created) {
      try { await purgeCompany(id); purged.add(id); } catch (e) { problems.push((e as Error).message); }
    }
    // A login is only removed once the company it created data in is gone; otherwise leave it and say why.
    const safeUsers = createdUsers.filter((u) => purged.has(u.companyId)).map((u) => u.userId);
    for (const userId of safeUsers) {
      try { await prisma.user.delete({ where: { id: userId } }); }
      catch (e) { problems.push(`user ${userId} still referenced: ${String((e as Error).message).trim().split(/\r?\n/).filter(Boolean).pop()}`); }
    }
    for (const u of createdUsers.filter((x) => !purged.has(x.companyId))) problems.push(`user ${u.userId} kept: its company ${u.companyId} was not purged`);
    await prisma.$disconnect();
    if (problems.length) throw new Error(`release-workflow cleanup left fixtures behind:\n - ${problems.join('\n - ')}`);
  });

  it('1-2. enter the metal rate, then tag the ring (and refuse a tag with a sale rate left blank)', async () => {
    expect((await setBaseRate(a, BASE1)).status).toBe(200);
    const r = await rate22(a);
    g1 = r.rate;
    expect(g1).toBeCloseTo(Math.round(BASE1 * r.purity / 0.999 * 100) / 100, 2);   // 22K is derived from the 24K rate: base x purity / 99.9

    expect((await a.post('/tagging/tags', ringBody(A, { saleVaPercent: undefined }))).status).toBe(400);          // blank VA refused
    expect((await a.post('/tagging/tags', ringBody(A, { materials: [{ code: 'RUBY', materialType: 'STONE', weight: 1 }] }))).status).toBe(400); // stone with no rate
    A.tag1 = await newRing(a, A);
    expect(A.tag1.status).toBe('IN_STOCK');
    expect(Number(A.tag1.saleMcRate)).toBe(100);
    expect(Number(A.tag1.saleVaPercent)).toBe(10);
  });

  it('3. stock value is the live price beside the cost, not the stale figure stored at tagging', async () => {
    const hand = (await a.get('/tagging/reports/stock-on-hand')).body.data;
    expect(hand.totals.count).toBe(1);
    expect(hand.totals.sellingValue).toBeCloseTo(r2(11 * g1 + 2500), 2);
    expect(hand.totals.costValue).toBe(40000);
    expect(hand.totals.unpricedCount).toBe(0);
    const book = (await a.get('/tagging/reports/stock-book')).body.data;
    expect(book.rows[0].sellingPrice).toBeCloseTo(r2(11 * g1 + 2500), 2);
    expect(book.rows[0].costPrice).toBe(40000);
  });

  it('4. estimate: every component at the live gold rate, GST from the HSN master', async () => {
    const view = (await a.get(`/estimation/tags/${A.tag1.id}`)).body.data;
    expect(view.goldRate).toMatchObject({ karat: '22K', isToday: true });
    expect(Number(view.goldRate.ratePerGram)).toBeCloseTo(g1, 2);
    const gold = view.materials.find((m: any) => m.materialType === 'METAL');
    expect(Number(gold.saleRate)).toBeCloseTo(g1, 2);        // not the stored 1

    const est = await a.post(`/estimation/tags/${A.tag1.id}/estimates`, {
      items: view.materials.map((m: any) => ({ materialId: m.id, code: m.code, materialType: m.materialType, weight: Number(m.weight), unit: m.unit, saleRate: Number(m.saleRate) })),
      saleMcRate: Number(view.saleMcRate), saleVaPercent: Number(view.saleVaPercent),
    });
    expect(est.status, JSON.stringify(est.body)).toBe(201);
    A.est = est.body.data;
    const total = r2(11 * g1 + 2500);
    expect(Number(A.est.totalSaleAmount)).toBeCloseTo(total, 1);
    expect(Number(A.est.taxRate)).toBe(0.03);
    expect(Number(A.est.gstAmount)).toBeCloseTo(total * 0.03, 1);
    expect(Number(A.est.netPayableAmount)).toBeCloseTo(total * 1.03, 1);
    // valid for today only
    expect(new Date(A.est.validUntil).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(A.est.validUntil).getTime() - Date.now()).toBeLessThan(24 * 3600 * 1000);
  });

  it('5. the gold rate moves: the saved estimate keeps its price and shows the indicator; stock value follows; cost does not move', async () => {
    expect((await setBaseRate(a, BASE2)).status).toBe(200);
    g2 = (await rate22(a)).rate;
    expect(g2).toBeGreaterThan(g1);

    const list = (await a.get(`/estimation/tags/${A.tag1.id}/estimates`)).body.data;
    expect(Number(list[0].totalSaleAmount)).toBe(Number(A.est.totalSaleAmount));
    expect(list[0]).toMatchObject({ goldRateChanged: true, expired: false });
    expect(list[0].goldRateAtEstimate).toBeCloseTo(g1, 2);
    expect(list[0].goldRateNow).toBeCloseTo(g2, 2);

    const hand = (await a.get('/tagging/reports/stock-on-hand')).body.data;
    expect(hand.totals.sellingValue).toBeCloseTo(r2(11 * g2 + 2500), 2);
    expect(hand.totals.costValue).toBe(40000);
  });

  it('6. estimate -> recall -> send -> bill: the invoice keeps the estimate\'s price, GST and rounded total reconcile', async () => {
    expect((await a.post(`/estimation/estimates/${A.est.id}/recall`, {})).status).toBe(409);   // never sent: nothing to recall
    const cust = { customerName: 'Walk-in', customerPhone: '9876500000', salesPersonId: A.userId };
    const sent = await a.post(`/estimation/estimates/${A.est.id}/send-to-billing`, cust);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await a.post(`/estimation/estimates/${A.est.id}/recall`, { reason: 'customer wants another look' })).body.data.status).toBe('OPEN');
    expect((await a.post(`/estimation/estimates/${A.est.id}/send-to-billing`, cust)).status).toBe(200);

    A.client = (await a.post('/orders/clients', { name: 'Release Customer', type: 'RETAIL', panNumber: 'ABCDE1234F' })).body.data.id;
    const stored = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: A.est.id }, include: { items: true } });
    const breakdown = {
      rows: stored.items.map((i) => ({ materialId: i.materialId ?? undefined, code: i.code, materialType: i.materialType, name: i.name ?? i.code, weight: Number(i.weight), unit: i.unit, rate: Number(i.saleRate) })),
      mcRate: Number(stored.saleMcRate), vaPercent: Number(stored.saleVaPercent),
    };
    const inv = await a.post('/sales/invoices', {
      clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', estimateIds: [A.est.id],
      items: [{ productCode: A.tag1.tagNumber, description: 'Ruby ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: A.tag1.id, materialBreakdown: breakdown }],
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const priced = r2(11 * g1 + 2500);                       // the estimate's rate, NOT today's
    expect(Number(inv.body.data.items[0].totalPrice)).toBeCloseTo(priced, 1);
    const tax = priced * 0.03;
    expect(Number(inv.body.data.taxAmount)).toBeCloseTo(tax, 1);
    expect(Number(inv.body.data.totalAmount)).toBe(Math.round(priced + tax));
    expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: A.est.id } })).status).toBe('INVOICED');
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: A.tag1.id } })).status).toBe('SOLD');
    expect((await a.post(`/estimation/estimates/${A.est.id}/recall`, {})).status).toBe(409);   // billed: can never be recalled
    expect((await a.get(`/tagging/reports/stock-on-hand`)).body.data.totals.count).toBe(0);     // and it left stock
  });

  it('7. direct sale of a fully priced tag is at TODAY\'s rate; a discount reduces the taxable value and its GST', async () => {
    A.tag2 = await newRing(a, A);
    const line = { productCode: A.tag2.tagNumber, description: 'Ruby ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: A.tag2.id };
    const inv = await a.post('/sales/invoices', {
      clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', discountAmount: 500, items: [line],
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const priced = r2(11 * g2 + 2500);
    expect(Number(inv.body.data.items[0].totalPrice)).toBeCloseTo(priced, 1);
    const taxable = priced - 500;
    expect(Number(inv.body.data.taxAmount)).toBeCloseTo(taxable * 0.03, 1);
    expect(Number(inv.body.data.totalAmount)).toBe(Math.round(taxable * 1.03));
  });

  it('8. an offer lowers VA / MC on a tagged line, the invoice records it, and the price is the hand-computed offered price', async () => {
    const offer = await a.post('/offers', { name: 'Festive VA', effectiveFrom: today, effectiveTo: null, rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 50 }] });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    A.tag3 = await newRing(a, A);
    const breakdown = {
      rows: [{ materialId: undefined, code: 'G22', materialType: 'METAL', name: 'G22', weight: 10, unit: 'GM', rate: g2 }, { code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: 1500 }],
      mcRate: 100, vaPercent: 5, offerApplied: true,        // VA 10 % -> 5 % : half off
    };
    const inv = await a.post('/sales/invoices', {
      clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: A.tag3.tagNumber, description: 'Ruby ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: A.tag3.id, materialBreakdown: breakdown }],
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const offered = r2(10 * g2 + 1500 + 1000 + 0.05 * 10 * g2);
    expect(Number(inv.body.data.items[0].totalPrice)).toBeCloseTo(offered, 1);
    expect(inv.body.data.items[0].materialBreakdown.offer).toMatchObject({ name: 'Festive VA', baseVaPercent: 10 });
    // selling BELOW the offered VA (zero tolerance) needs a manager's approval: refused with the exact list
    A.tag4 = await newRing(a, A);
    const below = await a.post('/sales/invoices', {
      clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: A.tag4.tagNumber, description: 'Ruby ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, tagId: A.tag4.id, materialBreakdown: { ...breakdown, vaPercent: 2 } }],
    });
    expect(below.status).toBe(409);
    expect(below.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: A.tag4.id } })).status).toBe('IN_STOCK');
  });

  it('9. permissions: entering the rate needs rate:update (system:config / invoice:create are not enough); an estimate is not billable by a viewer', async () => {
    const cfg = await createTestTenant(`RLC${Date.now().toString(36)}`, ['system:config', 'invoice:create', 'design:view']);
    const rate = await createTestTenant(`RLR${Date.now().toString(36)}`, ['rate:update', 'design:view']);
    try {
      const body = { date: today, rates: [{ karat: '24K', ratePerGram: 7100 }] };
      expect((await apiWith(tokenFor(cfg), app).post('/designs/rates/batch', body)).status).toBe(403);
      expect((await apiWith(tokenFor(rate), app).post('/designs/rates/batch', body)).status).toBe(200);
      expect((await apiWith(tokenFor(cfg), app).post('/estimation/estimates/x/recall', {})).status).toBe(403);   // no estimation:manage
    } finally { await cleanupTestTenant(cfg); await cleanupTestTenant(rate); }
  });

  it('10. tenant boundary: the other company sees none of it and cannot touch it', async () => {
    const stock = (await b.get('/tagging/reports/stock-on-hand')).body.data;
    expect(stock.totals.count).toBe(0);
    expect((await b.get(`/tagging/tags/${A.tag2.id}`)).status).toBe(404);
    expect((await b.get(`/estimation/tags/${A.tag2.id}`)).status).toBe(404);
    expect((await b.post(`/estimation/estimates/${A.est.id}/recall`, {})).status).toBe(404);
    expect((await b.post('/sales/invoices', {
      clientId: A.client, branchId: B.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
      items: [{ productCode: 'X', description: 'forged', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1, tagId: A.tag2.id }],
    })).status).toBeGreaterThanOrEqual(400);
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: A.tag2.id } })).status).toBe('SOLD');   // untouched by B's attempt
    // B has no rate of its own: its tag price is refused, not borrowed from A
    expect((await b.get(`/tagging/reports/stock-book`)).body.data.rows).toHaveLength(0);
    expect((await b.post('/tagging/tags', ringBody(B))).status).toBe(409);   // no 22K rate in B yet
  });
});
