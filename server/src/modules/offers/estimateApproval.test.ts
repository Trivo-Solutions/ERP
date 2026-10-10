import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice } from '../sales/sales.service';
import { createTagEstimate, sendEstimateToBilling, searchBillableEstimates } from '../tagging/estimation.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { seedMetalRate, createTestTenant, cleanupTestTenant, createMember, TestTenant } from '../../test/fixtures';
import { createOffer, todayString } from './offer.service';
import { decideApproval, cancelApproval, listApprovals } from './offerApproval.service';

// An estimate priced below its offer is sent FOR APPROVAL instead of to billing; the manager's approval releases it,
// and the same approval then covers the bill.
describe('estimate sent for approval', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let mgr: TestTenant; let clientId = ''; let rubyTypeId = '';
  const invoiceIds: string[] = []; const tagIds: string[] = []; const extraUserIds: string[] = [];
  let seq = 0;
  const cust = () => ({ customerName: 'Ramesh', customerPhone: '9876543210', salesPersonId: A.user.id });

  async function makeTag() {
    const grade = await prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId: rubyTypeId, quality: `Q${seq}` } });
    const tag = await prisma.jewelryTag.create({ data: {
      tagNumber: `EA-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby ring', metalType: 'GOLD', metalKarat: '22K',
      grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000, status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 1500, saleVaPercent: 18,
    } });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, ...o } as any });
    const gold = await m({ code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 });
    const ruby = await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id });
    return { tag, gold: gold.id, ruby: ruby.id };
  }
  type T = Awaited<ReturnType<typeof makeTag>>;
  const items = (t: T, ruby: number) => [
    { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', saleRate: 6000 },
    { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', saleRate: ruby },
  ];
  const estimate = (t: T, ruby: number, extra: Record<string, unknown> = {}) =>
    createTagEstimate(t.tag.id, { items: items(t, ruby), saleMcRate: 750, saleVaPercent: 9, ...extra } as any, A.ctx, A.user.id);
  const billable = async (num: string) => (await searchBillableEstimates(A.ctx, num)).filter((e) => e.estimateNumber === num);
  const pendingFor = async (estimateId: string) =>
    (await listApprovals(A.ctx, mgr.user.id, true, { status: 'PENDING' })).filter((x) => x.estimate?.id === estimateId);

  beforeAll(async () => {
    A = await createTestTenant(`EAA${suffix}`, ['invoice:create', 'estimation:manage']);
    await seedMetalRate(A.company.id, '22K', 6000);
    rubyTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `EACL-${suffix}`, name: 'Cust', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
    const role = await prisma.role.create({ data: { companyId: A.company.id, name: `MGR_${suffix}`, displayName: 'Mgr', permissions: ['discount:approve'] } });
    const m = await createMember({ companyId: A.company.id, roleId: role.id, email: `eamgr-${suffix}@example.com` });
    extraUserIds.push(m.user.id);
    mgr = { ...A, user: m.user, companyUser: m.membership, role, ctx: { ...A.ctx, userId: m.user.id, companyUserId: m.membership.id, roleId: role.id, permissions: role.permissions } } as TestTenant;
    await createOffer(A.ctx, { name: 'Festive', effectiveFrom: todayString(), effectiveTo: null, rules: [
      { component: 'VA', mode: 'PERCENT_OFF', value: 50 }, { component: 'MAKING_CHARGE', mode: 'PERCENT_OFF', value: 50 },
      { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: rubyTypeId },
    ] } as any, A.user.id);
  }, 60_000);

  afterAll(async () => {
    await prisma.discountApproval.deleteMany({ where: { companyId: A.company.id } });
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.tagEstimate.updateMany({ where: { companyId: A.company.id }, data: { invoiceId: null } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.tagEstimate.deleteMany({ where: { companyId: A.company.id } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: A.company.id } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(A);
    await prisma.user.deleteMany({ where: { id: { in: [A.user.id, ...extraUserIds] } } });
    await prisma.$disconnect();
  });

  it('at the offered rates it goes straight to billing', async () => {
    const t = await makeTag();
    const e = await estimate(t, 800, { sendToBilling: true, ...cust() });
    expect(e.status).toBe('SENT');
    expect(await billable(e.estimateNumber)).toHaveLength(1);
  });

  it('below the offer it needs a reason, then waits for approval and is NOT at the billing counter', async () => {
    const t = await makeTag();
    await expect(estimate(t, 700, { sendToBilling: true, ...cust() })).rejects.toMatchObject({ statusCode: 409, code: 'APPROVAL_REASON_REQUIRED' });
    const e = await estimate(t, 700, { sendToBilling: true, approvalReason: 'long-time customer', ...cust() });
    expect(e.status).toBe('AWAITING_APPROVAL');
    expect(await billable(e.estimateNumber)).toHaveLength(0);
    const [a] = await pendingFor(e.id);
    expect(a).toMatchObject({ scope: 'LINE', status: 'PENDING', estimate: { id: e.id } });
    await expect(sendEstimateToBilling(A.ctx, e.id, cust(), A.user.id)).rejects.toMatchObject({ statusCode: 409 }); // already waiting
  });

  it('approving releases it to billing, and the same approval pays for the bill', async () => {
    const t = await makeTag();
    const e = await estimate(t, 700, { sendToBilling: true, approvalReason: 'regular', ...cust() });
    const [a] = await pendingFor(e.id);
    await decideApproval(A.ctx, a.id, mgr.user.id, 'APPROVE', 'ok');
    expect(await billable(e.estimateNumber)).toHaveLength(1);

    // The biller (not the requester) finds the approval by estimate and bills the estimate's rates.
    const found = await listApprovals(A.ctx, 'someone-else', false, { estimateId: e.id, status: 'APPROVED' });
    expect(found).toHaveLength(1);
    const inv = await _createInvoice({
      branchId: A.branch.id, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', estimateIds: [e.id], approvalIds: found.map((f) => f.id),
      items: [{ productCode: 'X', description: 'Ruby ring', quantity: 1, grossWeight: 10, netGoldWeight: 9, rateType: 'PER_GRAM', goldRate: 1, tagId: t.tag.id,
        materialBreakdown: { rows: [
          { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', rate: 6000 },
          { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', rate: 700 },
        ], mcRate: 750, vaPercent: 9 } }],
    } as any, A.ctx, A.user.id);
    invoiceIds.push(inv.id);
    expect((await prisma.discountApproval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('USED');
  });

  it('rejecting sends it back to OPEN; a saved estimate can be sent for approval too; withdrawing pulls it back', async () => {
    const t = await makeTag();
    const saved = await estimate(t, 700);
    expect(saved.status).toBe('OPEN');
    await expect(sendEstimateToBilling(A.ctx, saved.id, cust(), A.user.id)).rejects.toMatchObject({ code: 'APPROVAL_REASON_REQUIRED' });
    const sent = await sendEstimateToBilling(A.ctx, saved.id, { ...cust(), approvalReason: 'festival' }, A.user.id);
    expect(sent.status).toBe('AWAITING_APPROVAL');
    const [a] = await pendingFor(saved.id);
    await decideApproval(A.ctx, a.id, mgr.user.id, 'REJECT', 'too low');
    expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe('OPEN');

    await sendEstimateToBilling(A.ctx, saved.id, { ...cust(), approvalReason: 'again' }, A.user.id);
    const [b] = await pendingFor(saved.id);
    await cancelApproval(A.ctx, b.id, A.user.id);
    expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe('OPEN');
  });
});
