import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createTagEstimate, sendEstimateToBilling, searchEstimateCustomers } from '../tagging/estimation.service';
import { createTestTenant, cleanupTestTenant, seedMetalRate, createMember, TestTenant } from '../../test/fixtures';
import { createOffer, todayString } from '../offers/offer.service';
import { decideApproval, listApprovals } from '../offers/offerApproval.service';

// Sending an estimate to billing makes the customer a real Client right away, so the next estimate's picker finds them.
describe('estimate hand-off creates / completes the customer', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  const tagIds: string[] = [];
  const estimateIds: string[] = [];

  async function makeTag(t: TestTenant) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `HO-${suffix}-${tagIds.length}`, companyId: t.company.id, branchId: t.branch.id, name: 'Ring',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
        costPrice: 20000, sellingPrice: 35000, status: 'IN_STOCK', createdById: t.user.id, saleMcRate: 0, saleVaPercent: 0,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }
  const estimate = async (t: TestTenant, extra: Record<string, unknown> = {}) => {
    const tag = await makeTag(t);
    const e = await createTagEstimate(tag.id, {
      items: [{ code: 'GOLD-22K', materialType: 'METAL', name: 'Gold 22K', weight: 5, saleRate: 6000 }],
      saleMcRate: 0, saleVaPercent: 0, ...extra,
    }, t.ctx, t.user.id);
    estimateIds.push(e.id);
    return e;
  };
  const clientsByPhone = (companyId: string, phone: string) =>
    prisma.client.findMany({ where: { companyId, phone: { contains: phone.slice(-10) } } });

  beforeAll(async () => {
    tenant = await createTestTenant(`HO${suffix}`, ['estimation:manage', 'estimation:view', 'client:view']);
    other = await createTestTenant(`HX${suffix}`, ['estimation:manage', 'estimation:view', 'client:view']);
    userId = tenant.user.id;
  });

  afterAll(async () => {
    await prisma.tagEstimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
    await prisma.tagEstimate.deleteMany({ where: { id: { in: estimateIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    for (const t of [tenant, other]) {
      await prisma.client.deleteMany({ where: { companyId: t.company.id } });
      await prisma.auditLog.deleteMany({ where: { userId: t.user.id } });
      await cleanupTestTenant(t);
    }
    await prisma.$disconnect();
  });

  it('send-and-save creates the customer, and the picker finds them for the next estimate (no PAN needed)', async () => {
    await estimate(tenant, { sendToBilling: true, customerName: 'Anita Rao', customerPhone: '+91 98765 11111', salesPersonId: userId });
    const rows = await clientsByPhone(tenant.company.id, '9876511111');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Anita Rao', type: 'RETAIL', phone: '9876511111', panNumber: null, isActive: true });
    expect(rows[0].clientCode).toMatch(/^CL-/);

    const found = await searchEstimateCustomers(tenant.ctx, 'anita');
    expect(found.map((c) => c.name)).toEqual(['Anita Rao']);

    const audit = await prisma.auditLog.findFirst({ where: { companyId: tenant.company.id, tableName: 'clients', recordId: rows[0].id, action: 'CREATE' } });
    expect(audit).toBeTruthy();
  });

  it('a second hand-off with the same mobile reuses that customer, filling only blanks and never overwriting', async () => {
    await estimate(tenant, { sendToBilling: true, customerName: 'Ravi Kumar', customerPhone: '9876522222', salesPersonId: userId });
    await estimate(tenant, {
      sendToBilling: true, customerName: 'Someone Else', customerPhone: '9876522222',
      customerPan: 'ABCDE1234F', customerAddress: '12 MG Road', salesPersonId: userId,
    });
    const rows = await clientsByPhone(tenant.company.id, '9876522222');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Ravi Kumar'); // name on file wins
    expect(rows[0].panNumber).toBe('ABCDE1234F'); // blank PAN filled
    expect(rows[0].address).toBe('12 MG Road');

    // a later, different PAN does not replace the one on file
    await estimate(tenant, { sendToBilling: true, customerName: 'Ravi Kumar', customerPhone: '9876522222', customerPan: 'ZZZZZ9999Z', salesPersonId: userId });
    expect((await clientsByPhone(tenant.company.id, '9876522222'))[0].panNumber).toBe('ABCDE1234F');
  });

  it('sending an already-saved estimate creates the customer from its stored details too', async () => {
    const e = await estimate(tenant);
    expect(await clientsByPhone(tenant.company.id, '9876533333')).toHaveLength(0);
    await sendEstimateToBilling(tenant.ctx, e.id, { customerName: 'Meena Joshi', customerPhone: '9876533333', customerPan: 'ABCDE1234F', salesPersonId: userId }, userId);
    const rows = await clientsByPhone(tenant.company.id, '9876533333');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Meena Joshi', panNumber: 'ABCDE1234F' });
  });

  it('a plain save (not sent to billing) creates no customer', async () => {
    await estimate(tenant, { customerName: 'Just Quoting', customerPhone: '9876544444' });
    expect(await clientsByPhone(tenant.company.id, '9876544444')).toHaveLength(0);
  });

  it('never matches or touches another company\'s customer with the same mobile', async () => {
    await prisma.client.create({ data: { companyId: other.company.id, clientCode: `OT-${suffix}`, name: 'Other Co Customer', type: 'RETAIL', phone: '9876555555' } });
    await estimate(tenant, { sendToBilling: true, customerName: 'Ours', customerPhone: '9876555555', customerPan: 'ABCDE1234F', salesPersonId: userId });
    const mine = await clientsByPhone(tenant.company.id, '9876555555');
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('Ours');
    const theirs = await clientsByPhone(other.company.id, '9876555555');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ name: 'Other Co Customer', panNumber: null });
  });
});

// Business rule: the customer is created the moment an estimate is sent to billing - even when it is priced below its
// offer and so waits for a manager - and rejecting the approval does not take the customer away.

describe('estimate hand-off customer: approval pending / rejected, and concurrency', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let mgr: TestTenant; let rubyTypeId = '';
  const tagIds: string[] = []; const extraUserIds: string[] = [];
  let seq = 0;

  async function makeTag(withStone = true) {
    const tag = await prisma.jewelryTag.create({ data: {
      tagNumber: `HA-${suffix}-${seq++}`, companyId: A.company.id, branchId: A.branch.id, name: 'Ruby ring', metalType: 'GOLD', metalKarat: '22K',
      grossWeight: 10, netWeight: 9, costPrice: 40000, sellingPrice: 70000, status: 'IN_STOCK', createdById: A.user.id, saleMcRate: 1500, saleVaPercent: 18,
    } });
    tagIds.push(tag.id);
    const m = (o: Record<string, unknown>) => prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, ...o } as any });
    const gold = await m({ code: 'G22', materialType: 'METAL', weight: 9, saleRate: 6000 });
    if (!withStone) return { tag, gold: gold.id, ruby: '' };
    const grade = await prisma.stoneGrade.create({ data: { companyId: A.company.id, stoneTypeId: rubyTypeId, quality: `Q${seq}` } });
    const ruby = await m({ code: 'RUBY', materialType: 'STONE', unit: 'CT', weight: 1, saleRate: 1500, stoneGradeId: grade.id });
    return { tag, gold: gold.id, ruby: ruby.id };
  }
  type T = Awaited<ReturnType<typeof makeTag>>;
  // `ruby` below the offered 800 -> priced below the offer -> needs a manager.
  const send = (t: T, ruby: number, extra: Record<string, unknown>) => createTagEstimate(t.tag.id, {
    items: [
      { materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', saleRate: 6000 },
      { materialId: t.ruby, code: 'RUBY', materialType: 'STONE', name: 'RUBY', weight: 1, unit: 'CT', saleRate: ruby },
    ],
    saleMcRate: 750, saleVaPercent: 9, sendToBilling: true, salesPersonId: A.user.id, ...extra,
  } as any, A.ctx, A.user.id);
  const byPhone = (phone: string) => prisma.client.findMany({ where: { companyId: A.company.id, phone } });

  beforeAll(async () => {
    A = await createTestTenant(`HB${suffix}`, ['invoice:create', 'estimation:manage', 'estimation:view']);
    await seedMetalRate(A.company.id, '22K', 6000);
    rubyTypeId = (await prisma.stoneType.create({ data: { companyId: A.company.id, code: 'RUBY', name: 'Ruby' } })).id;
    const role = await prisma.role.create({ data: { companyId: A.company.id, name: `MGR_${suffix}`, displayName: 'Mgr', permissions: ['discount:approve'] } });
    const m = await createMember({ companyId: A.company.id, roleId: role.id, email: `homgr-${suffix}@example.com` });
    extraUserIds.push(m.user.id);
    mgr = { ...A, user: m.user, companyUser: m.membership, role, ctx: { ...A.ctx, userId: m.user.id, companyUserId: m.membership.id, roleId: role.id, permissions: role.permissions } } as TestTenant;
    await createOffer(A.ctx, { name: 'Festive', effectiveFrom: todayString(), effectiveTo: null, rules: [
      { component: 'STONE', mode: 'FIXED_RATE', value: 800, stoneTypeId: rubyTypeId },
    ] } as any, A.user.id);
  }, 60_000);

  afterAll(async () => {
    await prisma.discountApproval.deleteMany({ where: { companyId: A.company.id } });
    await prisma.tagEstimateItem.deleteMany({ where: { companyId: A.company.id } });
    await prisma.tagEstimate.deleteMany({ where: { companyId: A.company.id } });
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.stoneGrade.deleteMany({ where: { companyId: A.company.id } });
    await prisma.client.deleteMany({ where: { companyId: A.company.id } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: [A.user.id, ...extraUserIds] } } });
    await cleanupTestTenant(A);
    await prisma.user.deleteMany({ where: { id: { in: [A.user.id, ...extraUserIds] } } });
    await prisma.$disconnect();
  });

  it('the customer exists as soon as the estimate is sent for approval, and a rejection does not remove them', async () => {
    const t = await makeTag();
    const e = await send(t, 700, { customerName: 'Pending Pooja', customerPhone: '9876566666', approvalReason: 'regular customer' });
    expect(e.status).toBe('AWAITING_APPROVAL'); // not yet released to billing ...
    const before = await byPhone('9876566666');
    expect(before).toHaveLength(1); // ... but the customer is already on file
    expect(before[0].name).toBe('Pending Pooja');

    const [a] = (await listApprovals(A.ctx, mgr.user.id, true, { status: 'PENDING' })).filter((x) => x.estimate?.id === e.id);
    await decideApproval(A.ctx, a.id, mgr.user.id, 'REJECT', 'no');
    expect((await prisma.tagEstimate.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('OPEN');
    const after = await byPhone('9876566666');
    expect(after.map((c) => c.id)).toEqual([before[0].id]); // same customer, still there
  });

  it('concurrent hand-offs for the same new mobile create exactly one customer (sending already-saved estimates)', async () => {
    // Sending a saved estimate allocates no document number, so nothing else serialises these transactions: only the
    // hand-off's own per-mobile lock stops two of them each finding "no such customer" and both creating one.
    // 24-way on purpose: with the lock removed, 6 requests did not reliably overlap, 24 reliably produced 10-16 duplicates.
    const tags = await Promise.all(Array.from({ length: 24 }, (_, i) => i).map(() => makeTag(false)));
    const saved = await Promise.all(tags.map((t) => createTagEstimate(t.tag.id, {
      items: [{ materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', saleRate: 6000 }],
      saleMcRate: 1500, saleVaPercent: 18,
    } as any, A.ctx, A.user.id)));
    expect(await byPhone('9876577777')).toHaveLength(0); // saving alone created nobody
    const results = await Promise.allSettled(saved.map((e) => sendEstimateToBilling(
      A.ctx, e.id, { customerName: 'Racing Rani', customerPhone: '+91 98765 77777', salesPersonId: A.user.id }, A.user.id)));
    expect(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected'))).toBe(true);
    const rows = await byPhone('9876577777');
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('concurrent send-and-save hand-offs for the same new mobile also create exactly one customer', async () => {
    const tags = await Promise.all([1, 2, 3, 4].map(() => makeTag(false)));
    const results = await Promise.allSettled(tags.map((t) => createTagEstimate(t.tag.id, {
      items: [{ materialId: t.gold, code: 'G22', materialType: 'METAL', name: 'G22', weight: 9, unit: 'GM', saleRate: 6000 }],
      saleMcRate: 1500, saleVaPercent: 18, sendToBilling: true, salesPersonId: A.user.id,
      customerName: 'Racing Ravi', customerPhone: '9876588888',
    } as any, A.ctx, A.user.id)));
    expect(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected'))).toBe(true);
    expect(await byPhone('9876588888')).toHaveLength(1);
  });

  it('no customer sensitive value is written to the audit trail beyond the source marker', async () => {
    const c = (await byPhone('9876566666'))[0];
    const logs = await prisma.auditLog.findMany({ where: { companyId: A.company.id, tableName: 'clients', recordId: c.id } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.map((l) => [l.oldValues, l.newValues]))).not.toMatch(/9876566666|Pending Pooja|ABCDE\d{4}[A-Z]/);
  });
});
