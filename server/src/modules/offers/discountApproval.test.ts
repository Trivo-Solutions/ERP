import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice, amendInvoice, voidInvoice } from '../sales/sales.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, createMember, tokenFor, TestTenant } from '../../test/fixtures';
import { createOffer, setOfferActive, todayString } from './offer.service';
import { requestApproval, decideApproval, cancelApproval, listApprovals } from './offerApproval.service';

// Offer management step 3: a rate below the offered rate (a hand override) or an extra discount on an offer bill needs a
// second person's, exact-match, single-use approval - enforced by the server inside the bill's own transaction.
describe('below-offer approvals', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  let mgr: TestTenant;            // a second person in company A holding discount:approve
  let clientId = ''; let rubyTypeId = '';
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const extraUserIds: string[] = [];
  let seq = 0;

  const createInvoice = (data: any) => _createInvoice({ branchId: A.branch.id, ...data }, A.ctx, A.user.id);

  async function makeTag() {
    const co = A;
    const grade = await prisma.stoneGrade.create({ data: { companyId: co.company.id, stoneTypeId: rubyTypeId, quality: `Q${seq}` } });
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `DA-${suffix}-${seq++}`, companyId: co.company.id, branchId: co.branch.id, name: 'Ruby ring',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000,
        status: 'IN_STOCK', createdById: co.user.id, saleMcRate: 1500, saleVaPercent: 18,
      },
    });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: co.company.id, tagId: tag.id, ...o } as any });
    const gold = await m({ code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 });
    const ruby = await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id });
    return { tag, gold: gold.id, ruby: ruby.id };
  }
  type T = Awaited<ReturnType<typeof makeTag>>;

  // The offer (below): VA 18 -> 9, MC 1500 -> 750, ruby -> 800. `ruby` / `mc` / `va` are the rates the bill charges.
  const breakdown = (t: T, o: { ruby?: number; mc?: number; va?: number; applied?: boolean } = {}) => ({
    rows: [
      { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', rate: 6000 },
      { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: o.ruby ?? 800 },
    ],
    mcRate: o.mc ?? 750, vaPercent: o.va ?? 9, ...(o.applied === false ? {} : { offerApplied: true }),
  });
  const line = (t: T, o: Parameters<typeof breakdown>[1] = {}, over: Record<string, unknown> = {}) => ({
    productCode: 'X', description: 'Ruby ring', quantity: 1, grossWeight: 10, netGoldWeight: 9, rateType: 'PER_GRAM', goldRate: 1,
    tagId: t.tag.id, materialBreakdown: breakdown(t, o), ...over,
  });
  const bill = (items: unknown[], extra: Record<string, unknown> = {}) =>
    createInvoice({ clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items, ...extra });
  const ask = (t: T, o: Parameters<typeof breakdown>[1], reason = 'regular customer') =>
    requestApproval(A.ctx, { scope: 'LINE', tagId: t.tag.id, materialBreakdown: breakdown(t, o), reason }, A.user.id);
  const approve = (id: string) => decideApproval(A.ctx, id, mgr.user.id, 'APPROVE', 'ok');
  const rowOf = (id: string) => prisma.discountApproval.findUniqueOrThrow({ where: { id } });

  let offerId = '';
  beforeAll(async () => {
    A = await createTestTenant(`DAA${suffix}`, ['invoice:create', 'invoice:edit']);
    await seedMetalRate(A.company.id, '22K', 6000);
    B = await createTestTenant(`DAB${suffix}`, ['invoice:create', 'discount:approve']);
    rubyTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `DACL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
    const mgrRole = await prisma.role.create({ data: { companyId: A.company.id, name: `MGR_${suffix}`, displayName: 'Mgr', permissions: ['discount:approve'] } });
    const m = await createMember({ companyId: A.company.id, roleId: mgrRole.id, email: `mgr-${suffix}@example.com` });
    extraUserIds.push(m.user.id);
    mgr = { ...A, user: m.user, companyUser: m.membership, role: mgrRole, ctx: { ...A.ctx, userId: m.user.id, companyUserId: m.membership.id, roleId: mgrRole.id, permissions: mgrRole.permissions } } as TestTenant;
    offerId = (await createOffer(A.ctx, {
      name: 'Festive', effectiveFrom: todayString(), effectiveTo: null,
      rules: [
        { component: 'VA', mode: 'PERCENT_OFF', value: 50 },
        { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
        { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: rubyTypeId },
      ],
    } as any, A.user.id)).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.discountApproval.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesReturnItem.deleteMany({ where: { companyId: A.company.id } });
    await prisma.salesReturn.deleteMany({ where: { companyId: A.company.id } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    for (const t of [A, B]) await cleanupTestTenant(t);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
    await prisma.$disconnect();
  });

  it('a bill at the offered rates needs no approval', async () => {
    const t = await makeTag();
    const inv = await bill([line(t)]);
    invoiceIds.push(inv.id);
    expect(inv.status).not.toBe('VOID');
    // The stored snapshot now records what the offer gave (the approval floor).
    const bd = inv.items[0].materialBreakdown as any;
    expect(bd.offer).toMatchObject({ id: offerId, mcRate: 750, vaPercent: 9 });
    expect(bd.rows.find((r: any) => r.code === 'RUBY').offerRate).toBe(800);
  });

  it('a hand-lowered rate is refused with the exact list of what needs approval - and nothing is sold', async () => {
    const t = await makeTag();
    const err: any = await bill([line(t, { ruby: 700, mc: 600 })]).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
    expect(err.details.needs).toHaveLength(1);
    expect(err.details.needs[0]).toMatchObject({ scope: 'LINE', tagId: t.tag.id, requested: { mcRate: 600, rows: [{ materialId: t.ruby, rate: 700 }] } });
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.tag.id } })).status).toBe('IN_STOCK');
  });

  it('request -> a different person approves -> the bill goes through and the approval is spent, once', async () => {
    const t = await makeTag();
    const req = await ask(t, { ruby: 700 });
    expect(req.status).toBe('PENDING');
    expect(await ask(t, { ruby: 700 })).toMatchObject({ id: req.id }); // identical open request is returned, not duplicated

    // Not yet approved: refused.
    await expect(bill([line(t, { ruby: 700 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });

    expect((await approve(req.id)).status).toBe('APPROVED');
    const inv = await bill([line(t, { ruby: 700 })], { approvalIds: [req.id] });
    invoiceIds.push(inv.id);
    const used = await rowOf(req.id);
    expect(used).toMatchObject({ status: 'USED', usedInvoiceId: inv.id, decidedById: mgr.user.id, requestedById: A.user.id });

    // Single use: put the same piece back on the shelf (void) and try the very same approval again.
    await voidInvoice(inv.id, A.ctx, A.user.id, 'test');
    await expect(bill([line(t, { ruby: 700 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.tag.id } })).status).toBe('IN_STOCK');
  });

  it('is tied to the exact figures: a lower rate, another piece, or an extra component needs its own approval', async () => {
    const t = await makeTag(); const t2 = await makeTag();
    const req = await ask(t, { ruby: 700 });
    await approve(req.id);
    await expect(bill([line(t, { ruby: 650 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' }); // lower
    await expect(bill([line(t2, { ruby: 700 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' }); // other piece
    await expect(bill([line(t, { ruby: 700, mc: 700 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' }); // more below
    expect((await rowOf(req.id)).status).toBe('APPROVED'); // none of the refusals spent it
    const inv = await bill([line(t, { ruby: 700 })], { approvalIds: [req.id] });
    invoiceIds.push(inv.id);
  });

  it('lowering a rate WITHOUT pressing Apply offer is gated the same way', async () => {
    const t = await makeTag();
    // Tagged rates are higher than the offered ones; here the biller hand-types a rate under the offered one, offer not applied.
    await expect(bill([line(t, { ruby: 700, applied: false })])).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
    // ...while plainly selling at the tagged rates (above the offered ones) is untouched.
    const ok = await bill([line(t, { ruby: 1500, mc: 1500, va: 18, applied: false })]);
    invoiceIds.push(ok.id);
  });

  it('an extra discount on a bill carrying an applied offer needs approval; without an applied offer it is ordinary', async () => {
    const t = await makeTag();
    const err: any = await bill([line(t)], { discountAmount: 500 }).catch((e) => e);
    expect(err.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
    expect(err.details.needs[0]).toMatchObject({ scope: 'DISCOUNT', amount: 500 });

    const req = await requestApproval(A.ctx, { scope: 'DISCOUNT', discountAmount: 500, reason: 'old customer' }, A.user.id);
    await approve(req.id);
    await expect(bill([line(t)], { discountAmount: 600, approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' }); // bigger
    const inv = await bill([line(t)], { discountAmount: 500, approvalIds: [req.id] });
    invoiceIds.push(inv.id);
    expect(Number(inv.discountAmount)).toBe(500);

    const t2 = await makeTag();
    const plain = await bill([line(t2, { ruby: 1500, mc: 1500, va: 18, applied: false })], { discountAmount: 500 });
    invoiceIds.push(plain.id);
  });

  it('the person who asked can never approve their own request; a rejected or cancelled one cannot be used', async () => {
    const t = await makeTag();
    const req = await ask(t, { ruby: 700 });
    await expect(decideApproval(A.ctx, req.id, A.user.id, 'APPROVE')).rejects.toMatchObject({ statusCode: 403 });
    await expect(prisma.discountApproval.update({ where: { id: req.id }, data: { status: 'APPROVED', decidedById: A.user.id } })).rejects.toThrow(); // the DB refuses too
    await expect(decideApproval(A.ctx, req.id, mgr.user.id, 'REJECT')).rejects.toMatchObject({ statusCode: 400 }); // a reason is required
    expect((await decideApproval(A.ctx, req.id, mgr.user.id, 'REJECT', 'too low')).status).toBe('REJECTED');
    await expect(approve(req.id)).rejects.toMatchObject({ statusCode: 409 }); // already decided
    await expect(bill([line(t, { ruby: 700 })], { approvalIds: [req.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });

    const req2 = await ask(t, { ruby: 710 });
    await approve(req2.id);
    await expect(cancelApproval(A.ctx, req2.id, mgr.user.id)).rejects.toMatchObject({ statusCode: 403 }); // only the requester withdraws
    expect((await cancelApproval(A.ctx, req2.id, A.user.id)).status).toBe('CANCELLED');
    await expect(bill([line(t, { ruby: 710 })], { approvalIds: [req2.id] })).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
  });

  it('nothing to approve -> 409; an unknown piece or empty reason is refused', async () => {
    const t = await makeTag();
    await expect(ask(t, { ruby: 800 })).rejects.toMatchObject({ statusCode: 409 }); // at the offered rate
    await expect(requestApproval(A.ctx, { scope: 'LINE', tagId: t.tag.id, materialBreakdown: breakdown(t, { ruby: 700 }), reason: '  ' }, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(requestApproval(A.ctx, { scope: 'LINE', tagId: 'nope', materialBreakdown: breakdown(t, { ruby: 700 }), reason: 'x' }, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a failed bill releases the approval (it is spent only if the bill is saved)', async () => {
    const t = await makeTag();
    const req = await ask(t, { ruby: 700 });
    await approve(req.id);
    // STORE_CREDIT is settled after the approval is consumed in the same transaction; this customer has none -> the bill fails.
    await expect(bill([line(t, { ruby: 700 })], { approvalIds: [req.id], payments: [{ mode: 'STORE_CREDIT', amount: 100, paymentDate: new Date() }] })).rejects.toBeTruthy();
    expect((await rowOf(req.id)).status).toBe('APPROVED');
    expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.tag.id } })).status).toBe('IN_STOCK');
  });

  it('amending: rates the invoice already had approved carry over; lowering further needs a new approval', async () => {
    const t = await makeTag();
    const req = await ask(t, { ruby: 700 });
    await approve(req.id);
    const inv = await bill([line(t, { ruby: 700 })], { approvalIds: [req.id] });
    invoiceIds.push(inv.id);
    const id = inv.items[0].id;

    await amendInvoice(inv.id, { reason: 'fix note', notes: 'x', items: [line(t, { ruby: 700 }, { id })] as any }, A.ctx, A.user.id); // unchanged rates, no ids
    await expect(amendInvoice(inv.id, { reason: 'lower', items: [line(t, { ruby: 650 }, { id })] as any }, A.ctx, A.user.id))
      .rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
    const req2 = await ask(t, { ruby: 650 });
    await approve(req2.id);
    await amendInvoice(inv.id, { reason: 'lower', approvalIds: [req2.id], items: [line(t, { ruby: 650 }, { id })] as any }, A.ctx, A.user.id);
    expect(await rowOf(req2.id)).toMatchObject({ status: 'USED', usedInvoiceId: inv.id });
  });

  it('an offer switched off later does not lift the floor of a bill that already claimed it', async () => {
    const o2 = await createOffer(A.ctx, { name: 'Short', effectiveFrom: todayString(), effectiveTo: null, priority: 50, rules: [{ component: 'VA', mode: 'PERCENT_OFF', value: 80 }] } as any, A.user.id);
    const t = await makeTag();
    const l = line(t, { va: 3.6 }); // 80% off 18 = 3.6 (priority 50 beats Festive); MC / ruby unchanged = tagged
    (l.materialBreakdown as any).mcRate = 1500; (l.materialBreakdown as any).rows[1].rate = 1500;
    const inv = await bill([l]);
    invoiceIds.push(inv.id);
    await setOfferActive(A.ctx, o2.id, false, A.user.id);
    const lower = line(t, { va: 3 }); (lower.materialBreakdown as any).mcRate = 1500; (lower.materialBreakdown as any).rows[1].rate = 1500;
    await expect(amendInvoice(inv.id, { reason: 'x', items: [{ ...lower, id: inv.items[0].id }] as any }, A.ctx, A.user.id)).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED' });
  });

  it('company isolation: another company cannot see, decide or spend this approval, nor request on this tag', async () => {
    const t = await makeTag();
    const req = await ask(t, { ruby: 700 });
    await expect(decideApproval(B.ctx, req.id, B.user.id, 'APPROVE')).rejects.toMatchObject({ statusCode: 404 });
    await expect(cancelApproval(B.ctx, req.id, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(requestApproval(B.ctx, { scope: 'LINE', tagId: t.tag.id, materialBreakdown: breakdown(t, { ruby: 700 }), reason: 'x' }, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await listApprovals(B.ctx, B.user.id, true, {})).toEqual([]);
    expect((await rowOf(req.id)).status).toBe('PENDING');
  });

  it('listing: an approver sees every request, anyone else only their own; audit rows are written', async () => {
    const mine = await listApprovals(A.ctx, A.user.id, false, {});
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.requestedBy.id === A.user.id)).toBe(true);
    expect(await listApprovals(A.ctx, mgr.user.id, false, {})).toEqual([]); // the manager asked for nothing
    const all = await listApprovals(A.ctx, mgr.user.id, true, { status: 'PENDING' });
    expect(all.every((r) => r.status === 'PENDING')).toBe(true);

    const first = mine[mine.length - 1];
    const audit = await prisma.auditLog.findMany({ where: { companyId: A.company.id, tableName: 'discount_approvals', recordId: first.id } });
    expect(audit.some((a) => a.action === 'CREATE' && a.userId === A.user.id)).toBe(true);
    const approvedId = (await prisma.discountApproval.findFirstOrThrow({ where: { companyId: A.company.id, status: 'USED' } })).id;
    const decided = await prisma.auditLog.findMany({ where: { companyId: A.company.id, tableName: 'discount_approvals', recordId: approvedId, action: 'APPROVE' } });
    expect(decided).toHaveLength(1);
    expect(decided[0].userId).toBe(mgr.user.id);
  });

  describe('over HTTP', () => {
    const asUser = (t: TestTenant) => ({ Authorization: `Bearer ${tokenFor(t)}` });
    const api = '/api/v1/offers/approvals';

    it('requesting needs a billing permission, deciding needs discount:approve, and a non-approver sees only their own', async () => {
      const t = await makeTag();
      const body = { scope: 'LINE', tagId: t.tag.id, materialBreakdown: breakdown(t, { ruby: 700 }), reason: 'regular customer' };
      const created = await request(app).post(api).set(asUser(A)).send(body);
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      // The requester has no discount:approve -> 403, even though they asked.
      expect((await request(app).post(`${api}/${id}/approve`).set(asUser(A)).send({})).status).toBe(403);
      // A holder of discount:approve but the same person is refused by the service rule; a different one succeeds.
      const ok = await request(app).post(`${api}/${id}/approve`).set(asUser(mgr)).send({ note: 'fine' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('APPROVED');

      // The manager (no billing permission, but discount:approve) can list; the biller sees only their own.
      expect((await request(app).get(api).set(asUser(mgr))).status).toBe(200);
      const own = await request(app).get(api).set(asUser(A));
      expect(own.status).toBe(200);
      expect(own.body.data.every((r: any) => r.requestedBy.id === A.user.id)).toBe(true);

      // Company B (has the permission) cannot decide company A's request.
      expect((await request(app).post(`${api}/${id}/approve`).set(asUser(B)).send({})).status).toBe(404);
    });

    it('a user with neither billing nor approval permission is refused', async () => {
      const nobody = await createTestTenant(`DAN${suffix}`, ['report:view']);
      try {
        expect((await request(app).get(api).set(asUser(nobody))).status).toBe(403);
        expect((await request(app).post(api).set(asUser(nobody)).send({})).status).toBe(403);
      } finally {
        await cleanupTestTenant(nobody);
        await prisma.user.deleteMany({ where: { email: nobody.user.email } });
      }
    });

    it('POST /sales/invoices answers 409 with code + details so the screen can ask for the approvals', async () => {
      const t = await makeTag();
      const res = await request(app).post('/api/v1/sales/invoices').set(asUser(A)).send({
        branchId: A.branch.id, clientId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', items: [line(t, { ruby: 700 })],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
      expect(res.body.details.needs[0].scope).toBe('LINE');
    });
  });
});
