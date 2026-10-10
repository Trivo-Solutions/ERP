import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice, amendInvoice } from '../sales/sales.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { createOffer, setOfferActive, todayString } from './offer.service';

// Offer management step 2b: "Apply offer" on the New Sale screen. A tagged line is priced from its material breakdown (the
// client applies the offered rates); the SERVER decides which offer it was (by invoice date) and stamps it, with the
// tagged rates it lowered, on the stored breakdown. A bill can never claim an offer that does not apply.
describe('New Sale: apply offer on a tagged line', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let clientId = ''; let rubyTypeId = '';
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  let seq = 0;

  const createInvoice = (data: any) => _createInvoice({ branchId: A.branch.id, ...data }, A.ctx, A.user.id);

  async function makeTag() {
    const grade = await prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId: rubyTypeId, quality: `Q${seq}` } });
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `SO-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby ring',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000,
        status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 1500, saleVaPercent: 18,
      },
    });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, ...o } as any });
    const gold = await m({ code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 });
    const ruby = await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id });
    return { tag, gold: gold.id, ruby: ruby.id };
  }

  // What the page sends after "Apply offer": the OFFERED rates (VA 18 -> 9, MC 1500 -> 750, ruby 1500 -> 800) + offerApplied.
  const line = (t: { tag: { id: string }; gold: string; ruby: string }, over: Record<string, unknown> = {}, bdOver: Record<string, unknown> = {}) => ({
    productCode: 'X', description: 'Ruby ring', quantity: 1, grossWeight: 10, netGoldWeight: 9, rateType: 'PER_GRAM', goldRate: 1,
    tagId: t.tag.id,
    materialBreakdown: {
      rows: [
        { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', rate: 6000 },
        { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: 800 },
      ],
      mcRate: 750, vaPercent: 9, offerApplied: true, ...bdOver,
    },
    ...over,
  });
  // 9g x 6000 = 54000 + ruby 800 = 54800; MC 9 x 750 = 6750; VA 9% of 54000 = 4860  =>  66410

  beforeAll(async () => {
    A = await createTestTenant(`SOA${suffix}`, ['invoice:create']);
    await seedMetalRate(A.company.id, '22K', 6000);
    B = await createTestTenant(`SOB${suffix}`, ['invoice:create']);
    rubyTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `SOCL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
  }, 60_000);

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: A.company.id } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    for (const t of [A, B]) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  const offerInput = (name: string) => ({
    name, effectiveFrom: todayString(), effectiveTo: null,
    rules: [
      { component: 'VA', mode: 'PERCENT_OFF', value: 50 },
      { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
      { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: rubyTypeId },
    ],
  }) as any;

  it('refuses a line that claims an offer when none applies - nothing is sold', async () => {
    const t = await makeTag();
    await expect(createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(t)] })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.tag.id } })).status).toBe('IN_STOCK');
  });

  it('stamps the offer + tagged rates on the stored breakdown, prices from the rows, and ignores a forged offer/baseRate', async () => {
    const o = await createOffer(A.ctx, offerInput('Festive'), A.user.id);
    const t = await makeTag();
    const forged = line(t, {}, { offer: { id: 'forged', name: 'Forged', baseMcRate: 1, baseVaPercent: 1 } });
    (forged.materialBreakdown.rows[1] as any).baseRate = 99999;
    const inv = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [forged] });
    invoiceIds.push(inv.id);

    const bd = inv.items[0].materialBreakdown as any;
    expect(Number(inv.items[0].unitPrice)).toBe(66410);
    // Step 3 also records the offered MC / VA (the floor below which a rate needs a manager's approval).
    expect(bd.offer).toEqual({ id: o.id, name: 'Festive', baseMcRate: 1500, baseVaPercent: 18, mcRate: 750, vaPercent: 9 });
    expect(bd.rows.find((r: any) => r.code === 'RUBY').offerRate).toBe(800);
    expect(bd.rows.find((r: any) => r.code === 'RUBY').baseRate).toBe(1500);
    expect(bd.rows.find((r: any) => r.code === 'G22').baseRate).toBe(6000);
    expect(bd.offerApplied).toBeUndefined();
    const tag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.tag.id }, include: { materials: true } });
    expect(tag.status).toBe('SOLD');
    expect(Number(tag.costPrice)).toBe(40000);
    expect(Number(tag.saleMcRate)).toBe(1500);
    expect(tag.materials.find((m) => m.id === t.ruby)?.saleRate?.toString()).toBe('1500');
    await setOfferActive(A.ctx, o.id, false, A.user.id);
  });

  it('a line without applyOffer carries no offer; offerApplied needs a tagged piece', async () => {
    const t = await makeTag();
    const plain = line(t, {}, { offerApplied: undefined });
    const inv = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [plain] });
    invoiceIds.push(inv.id);
    expect((inv.items[0].materialBreakdown as any).offer).toBeUndefined();
    await expect(createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(t, { tagId: undefined })] })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("another company's offer is never applied", async () => {
    await createOffer(B.ctx, { ...offerInput('B only'), rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 90 }] }, B.user.id);
    const t = await makeTag();
    await expect(createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(t)] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('amending keeps the snapshot even after the offer is switched off; a brand-new claim is still refused', async () => {
    const o = await createOffer(A.ctx, offerInput('Amend me'), A.user.id);
    const t = await makeTag();
    const inv = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(t)] });
    invoiceIds.push(inv.id);
    await setOfferActive(A.ctx, o.id, false, A.user.id);

    const stored = inv.items[0];
    const ruby700 = { rows: [
      { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', rate: 6000 },
      { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: 700 },
    ] };
    // Lowering the ruby under the offered 800 is a below-offer rate: it needs a manager's approval (offers step 3) - and the
    // stored snapshot still supplies the floor although the offer itself is now switched off.
    await expect(amendInvoice(inv.id, { reason: 'rate tweak', items: [{ ...line(t, { id: stored.id }, ruby700) }] as any }, A.ctx, A.user.id))
      .rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
    // Keeping the offered rates is fine and keeps the snapshot.
    const amended = await amendInvoice(inv.id, { reason: 'note only', notes: 'n', items: [{ ...line(t, { id: stored.id }) }] as any }, A.ctx, A.user.id);
    const after = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: stored.id } });
    expect((after.materialBreakdown as any).offer).toMatchObject({ id: o.id, name: 'Amend me' });
    expect((after.materialBreakdown as any).rows.find((r: any) => r.code === 'RUBY').baseRate).toBe(1500);
    expect(amended).toBeTruthy();

    // A different line with no stored snapshot cannot newly claim the (now switched off) offer.
    const t2 = await makeTag();
    const inv2 = await createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(t2, {}, { offerApplied: undefined })] });
    invoiceIds.push(inv2.id);
    await expect(amendInvoice(inv2.id, { reason: 'x', items: [line(t2, { id: inv2.items[0].id })] as any }, A.ctx, A.user.id))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  // One pricing engine: a tagged line sent with no rates of its own is priced like the tag / estimate / F4, from the piece's
  // stored rows - not by the per-gram shortcut (which put VA on the making charge and dropped the stones).
  it('prices a tagged line with no rates from the tag own rows: metal + stone + MC x metal wt + VA % of metal value', async () => {
    const t = await makeTag();
    const inv = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'X', description: 'Ruby ring', quantity: 1, grossWeight: 10, netGoldWeight: 9, tagId: t.tag.id }],
    });
    invoiceIds.push(inv.id);
    // 9g x 6000 = 54000 + ruby 1 x 1500 = 55500; MC 9 x 1500 = 13500; VA 18% of 54000 = 9720  =>  78720
    expect(Number(inv.items[0].totalPrice)).toBe(78720);
    expect((inv.items[0].materialBreakdown as any).mcRate).toBe(1500);
  });
});
