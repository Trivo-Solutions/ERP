import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database'; // fixtures/verification as the platform role; the code under test uses the runtime client
import { createInvoice, createSalesReturn } from '../sales/sales.service';
import {
  createRepairTransfer, sendRepairTransfer, cancelRepairTransfer, receiveRepairTransfer, inspectRepairCase, startRepair,
  completeRepair, finalInspect, retagTag, reprintTag, listRepairCases, listRepairTransfers, getRepairCase,
} from './returnRepair.service';
import { createTransfer } from './tagging.service';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../test/fixtures';
import { cleanupJournalEntries } from '../../test/ledger';
import { TenantContext } from '../../shared/tenantContext';

// Sold piece comes back -> branch sends it to Head Office -> HO receives, inspects (PASS | REPAIR | MELT) -> repair ->
// final inspection -> same tag back IN_STOCK; true retagging; reprint; registers; permissions and isolation.
describe('returned jewellery: return -> HO transfer -> inspection -> repair -> stock / retag', () => {
  const suffix = `RR${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant; // tenant under test
  let B: TestTenant; // second company, for isolation
  let hoId: string;
  let branchId: string;
  let clientId: string;
  let stockTypeId: string;
  let categoryId: string;
  let tagSeq = 0;
  let branchCtx: TenantContext; // a Jubilee-Hills-style user: granted ONLY the retail branch, never Head Office
  const invoiceIds: string[] = [];

  async function makeTag(overrides: Record<string, unknown> = {}) {
    return prisma.jewelryTag.create({
      data: {
        tagNumber: `TAG-${suffix}-${tagSeq++}`, companyId: A.company.id, branchId, name: 'Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 9, stoneWeight: 1, costPrice: 40000, sellingPrice: 48000, createdById: A.user.id,
        stockTypeId, categoryId, ...overrides,
      },
    });
  }
  const line = (tagId: string) => ({
    productCode: 'TAGGED', description: 'Tagged ring', quantity: 1, grossWeight: 10, netGoldWeight: 9,
    rateType: 'FIXED', goldRate: 48000, makingCharge: 0, tagId,
  });
  const sell = async (tagId: string) => {
    const inv = await createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(tagId)] }, A.ctx, A.user.id);
    invoiceIds.push(inv.id);
    return inv;
  };
  const tagRow = (id: string) => prisma.jewelryTag.findUniqueOrThrow({ where: { id } });
  const caseOf = (tagId: string) => prisma.repairCase.findFirstOrThrow({ where: { tagId }, orderBy: { createdAt: 'desc' } });
  const balance = async () => Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);
  const tagStatuses = async (tagId: string) =>
    (await prisma.tagHistory.findMany({ where: { tagId, event: 'STATUS_CHANGE' }, orderBy: { createdAt: 'asc' } })).map((h) => h.status);

  /** A tag sold, then returned by the customer at the branch. */
  async function returned() {
    const tag = await makeTag();
    const inv = await sell(tag.id);
    const ret = await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }], reason: 'Customer changed mind' }, branchCtx, A.user.id);
    return { tag, inv, ret, rc: await caseOf(tag.id) };
  }
  /** ...and carried to Head Office: transfer created + sent by the branch, received by HO. */
  async function atHo() {
    const r = await returned();
    const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id], reason: 'Inspection' }, branchCtx, A.user.id);
    await sendRepairTransfer(tr.id, branchCtx, A.user.id);
    await receiveRepairTransfer(tr.id, A.ctx, A.user.id);
    return { ...r, tr };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['invoice:create', 'sales:view', 'repair:view', 'repair:send', 'repair:receive', 'repair:inspect', 'repair:work', 'retag:create', 'retag:reprint']);
    B = await createTestTenant(`${suffix}B`, ['repair:view', 'repair:send', 'repair:receive', 'repair:inspect', 'repair:work', 'retag:create']);
    branchId = A.branch.id;
    const ho = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `HO-${suffix}`, name: 'Head Office', isHeadOffice: true } });
    hoId = ho.id;
    await prisma.branch.create({ data: { companyId: B.company.id, branchCode: `HOB-${suffix}`, name: 'Head Office B', isHeadOffice: true } });
    branchCtx = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branchId] } };
    clientId = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CL-${suffix}`, name: 'Return Customer', panNumber: 'ABCDE1234F', type: 'RETAIL' } })).id;
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: `R${suffix}`.slice(0, 6).toUpperCase(), name: 'RR ST' } })).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: `RC${suffix.slice(2, 6)}`.toUpperCase(), name: 'RR Cat' } })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries([
      ...invoiceIds,
      ...(await prisma.salesReturn.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true } })).map((r) => r.id),
    ]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  describe('sale return', () => {
    it('parks the SAME tag as RETURNED_PENDING_INSPECTION at its branch, opens one register row, credits the customer exactly once', async () => {
      const tag = await makeTag();
      const before = await balance();
      const inv = await sell(tag.id);
      const afterSale = await balance();
      expect(afterSale).toBeGreaterThan(before);

      const ret = await createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }], reason: 'Too big' }, branchCtx, A.user.id);

      const row = await tagRow(tag.id);
      expect(row.status).toBe('RETURNED_PENDING_INSPECTION');
      expect(row.tagNumber).toBe(tag.tagNumber);
      expect(row.branchId).toBe(branchId);
      expect(await balance()).toBeCloseTo(before); // credited once: the sale's debit is fully reversed, no more

      const cases = await prisma.repairCase.findMany({ where: { tagId: tag.id } });
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({ status: 'RETURNED_PENDING_TRANSFER', currentLocation: 'BRANCH', originBranchId: branchId, returnReason: 'Too big', salesReturnItemId: ret.items[0].id });
      expect(Number(cases[0].grossWeight)).toBe(10);
      expect(await prisma.journalEntry.count({ where: { referenceId: ret.id } })).toBe(1); // the return's own entry, nothing else
    });

    it('a pending-inspection piece cannot be sold, memo-ed or transferred as ordinary stock', async () => {
      const { tag } = await returned();
      await expect(createInvoice({ branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', items: [line(tag.id)] }, A.ctx, A.user.id))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(createTransfer({ fromBranchId: branchId, toBranchId: hoId, tagIds: [tag.id] }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect((await tagRow(tag.id)).status).toBe('RETURNED_PENDING_INSPECTION');
    });

    it('a duplicate return of the same line is rejected and opens no second register row', async () => {
      const { tag, inv } = await returned();
      await expect(createSalesReturn({ invoiceId: inv.id, items: [{ invoiceItemId: inv.items[0].id }] }, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(await prisma.repairCase.count({ where: { tagId: tag.id } })).toBe(1);
    });

    it('the Sales Return register shows branch, customer and inspection status', async () => {
      const { ret } = await returned();
      const rows = await apiWith(tokenFor(A), app).get('/sales/returns');
      expect(rows.status).toBe(200);
      const mine = rows.body.data.find((r: { id: string }) => r.id === ret.id);
      expect(mine).toMatchObject({ customerName: 'Return Customer', inspectionStatus: 'PENDING' });
      expect(mine.items[0].repairCase.status).toBe('RETURNED_PENDING_TRANSFER');
    });
  });

  describe('repair transfer (branch -> Head Office)', () => {
    it('create -> send -> HO receive moves custody step by step, never before HO actually receives', async () => {
      const { tag, rc } = await returned();
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [rc.id], reason: 'Inspection', remarks: 'bag 1' }, branchCtx, A.user.id);
      expect(tr).toMatchObject({ status: 'DRAFT', toBranchId: hoId, fromBranchId: branchId });
      expect(tr.transferNumber).toMatch(/^RT-/);
      expect((await tagRow(tag.id)).status).toBe('RETURNED_PENDING_INSPECTION'); // a draft moves nothing

      await sendRepairTransfer(tr.id, branchCtx, A.user.id);
      expect((await tagRow(tag.id))).toMatchObject({ status: 'IN_TRANSIT_TO_HO', branchId });
      expect(await caseOf(tag.id)).toMatchObject({ status: 'IN_TRANSIT_TO_HO', currentLocation: 'IN_TRANSIT', hoReceivedAt: null });

      const received = await receiveRepairTransfer(tr.id, A.ctx, A.user.id);
      expect(received.status).toBe('RECEIVED');
      expect(await tagRow(tag.id)).toMatchObject({ status: 'HO_RECEIVED', branchId: hoId });
      const c = await caseOf(tag.id);
      expect(c).toMatchObject({ status: 'HO_RECEIVED', currentLocation: 'HEAD_OFFICE', hoReceivedById: A.user.id });
      expect(c.hoReceivedAt).not.toBeNull();

      expect(await tagStatuses(tag.id)).toEqual(['SOLD', 'RETURNED_PENDING_INSPECTION', 'IN_TRANSIT_TO_HO', 'HO_RECEIVED']);
    });

    it('a transfer cannot be sent twice, nor received twice', async () => {
      const { rc, tr } = await atHo();
      await expect(sendRepairTransfer(tr.id, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(receiveRepairTransfer(tr.id, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await caseOf((await prisma.repairCase.findUniqueOrThrow({ where: { id: rc.id } })).tagId)).status).toBe('HO_RECEIVED');
    });

    it('two concurrent receives of one transfer: exactly one wins, the other is refused', async () => {
      const r = await returned();
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id);
      await sendRepairTransfer(tr.id, branchCtx, A.user.id);
      const results = await Promise.allSettled([receiveRepairTransfer(tr.id, A.ctx, A.user.id), receiveRepairTransfer(tr.id, A.ctx, A.user.id)]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect((await tagRow(r.tag.id)).status).toBe('HO_RECEIVED');
    });

    it('a branch user can send but can NEVER receive: custody stays in transit', async () => {
      const r = await returned();
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id);
      await sendRepairTransfer(tr.id, branchCtx, A.user.id);
      await expect(receiveRepairTransfer(tr.id, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect((await tagRow(r.tag.id)).status).toBe('IN_TRANSIT_TO_HO');
      expect((await prisma.repairTransfer.findUniqueOrThrow({ where: { id: tr.id } })).status).toBe('IN_TRANSIT');
    });

    it('receiving only some pieces leaves the transfer open until the last is in', async () => {
      const a = await returned();
      const b = await returned();
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [a.rc.id, b.rc.id] }, branchCtx, A.user.id);
      await sendRepairTransfer(tr.id, branchCtx, A.user.id);
      const part = await receiveRepairTransfer(tr.id, A.ctx, A.user.id, [a.rc.id]);
      expect(part.status).toBe('IN_TRANSIT');
      expect((await tagRow(a.tag.id)).status).toBe('HO_RECEIVED');
      expect((await tagRow(b.tag.id)).status).toBe('IN_TRANSIT_TO_HO');
      await expect(receiveRepairTransfer(tr.id, A.ctx, A.user.id, [a.rc.id])).rejects.toMatchObject({ statusCode: 409 });
      expect((await receiveRepairTransfer(tr.id, A.ctx, A.user.id, [b.rc.id])).status).toBe('RECEIVED');
    });

    it('a piece cannot be on two open transfers; a draft can be cancelled, a sent one cannot', async () => {
      const r = await returned();
      const t1 = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id);
      await expect(createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await cancelRepairTransfer(t1.id, branchCtx, A.user.id)).status).toBe('CANCELLED');
      const t2 = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id); // free again
      await sendRepairTransfer(t2.id, branchCtx, A.user.id);
      await expect(cancelRepairTransfer(t2.id, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(sendRepairTransfer(t1.id, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('a piece not at the sending branch / not awaiting transfer is refused', async () => {
      const { rc } = await atHo(); // already at HO
      await expect(createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [rc.id] }, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('inspection', () => {
    it('PASS puts the SAME tag back IN_STOCK at Head Office — no new tag — and cannot be done twice', async () => {
      const { tag } = await atHo();
      const tagsBefore = await prisma.jewelryTag.count({ where: { companyId: A.company.id } });
      const rc = await caseOf(tag.id);

      await inspectRepairCase(rc.id, { result: 'PASS', remarks: 'perfect' }, A.ctx, A.user.id);

      const row = await tagRow(tag.id);
      expect(row).toMatchObject({ id: tag.id, tagNumber: tag.tagNumber, status: 'IN_STOCK', branchId: hoId });
      expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id } })).toBe(tagsBefore);
      expect(await caseOf(tag.id)).toMatchObject({ status: 'INSPECTION_PASSED', inspectionResult: 'PASS', inspectedById: A.user.id });
      expect(await tagStatuses(tag.id)).toEqual(['SOLD', 'RETURNED_PENDING_INSPECTION', 'IN_TRANSIT_TO_HO', 'HO_RECEIVED', 'IN_STOCK']);
      await expect(inspectRepairCase(rc.id, { result: 'PASS' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });

    });

    it('a branch user cannot inspect, and an un-received piece cannot be inspected', async () => {
      const { tag, rc, tr } = await atHo();
      await expect(inspectRepairCase(rc.id, { result: 'PASS' }, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 403 });
      expect((await tagRow(tag.id)).status).toBe('HO_RECEIVED');
      const fresh = await returned(); // still at the branch
      await expect(inspectRepairCase(fresh.rc.id, { result: 'PASS' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(tr.id).toBeTruthy();
    });

    it('REPAIR_REQUIRED keeps it non-saleable and needs a reason; repair -> final inspection is mandatory before stock', async () => {
      const { tag } = await atHo();
      const rc = await caseOf(tag.id);
      await expect(inspectRepairCase(rc.id, { result: 'REPAIR_REQUIRED' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });

      await inspectRepairCase(rc.id, { result: 'REPAIR_REQUIRED', reason: 'Clasp broken', assignedToId: A.user.id }, A.ctx, A.user.id);
      expect((await tagRow(tag.id)).status).toBe('REPAIR_REQUIRED');
      expect(await caseOf(tag.id)).toMatchObject({ status: 'REPAIR_REQUIRED', repairReason: 'Clasp broken', assignedToId: A.user.id });

      // steps cannot be skipped
      await expect(completeRepair(rc.id, { details: 'x' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(finalInspect(rc.id, { result: 'PASS' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });

      await startRepair(rc.id, {}, A.ctx, A.user.id);
      expect((await tagRow(tag.id)).status).toBe('IN_REPAIR');
      expect((await caseOf(tag.id)).repairEmployeeId).toBe(A.user.id); // defaults to the assigned employee
      await expect(startRepair(rc.id, {}, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(completeRepair(rc.id, { details: '' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });

      await completeRepair(rc.id, { details: 'Clasp replaced', repairCost: 250 }, A.ctx, A.user.id);
      expect((await tagRow(tag.id)).status).toBe('REPAIR_COMPLETED'); // still not stock
      expect(Number((await caseOf(tag.id)).repairCost)).toBe(250);
      await expect(completeRepair(rc.id, { details: 'again' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });

      // a FAILED final inspection never returns it to stock
      await expect(finalInspect(rc.id, { result: 'FAIL' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 }); // needs a reason
      await finalInspect(rc.id, { result: 'FAIL', remarks: 'Clasp still loose' }, A.ctx, A.user.id);
      expect((await tagRow(tag.id)).status).toBe('REPAIR_REQUIRED');

      await startRepair(rc.id, {}, A.ctx, A.user.id);
      await completeRepair(rc.id, { details: 'Re-set clasp' }, A.ctx, A.user.id);
      await finalInspect(rc.id, { result: 'PASS' }, A.ctx, A.user.id);
      expect(await tagRow(tag.id)).toMatchObject({ id: tag.id, tagNumber: tag.tagNumber, status: 'IN_STOCK', branchId: hoId });
      expect(await caseOf(tag.id)).toMatchObject({ status: 'INSPECTION_PASSED', finalInspectedById: A.user.id });
      await expect(finalInspect(rc.id, { result: 'PASS' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });

      expect(await tagStatuses(tag.id)).toEqual([
        'SOLD', 'RETURNED_PENDING_INSPECTION', 'IN_TRANSIT_TO_HO', 'HO_RECEIVED', 'REPAIR_REQUIRED', 'IN_REPAIR', 'REPAIR_COMPLETED',
        'REPAIR_REQUIRED', 'IN_REPAIR', 'REPAIR_COMPLETED', 'IN_STOCK',
      ]);
    });

    it('MELT keeps it non-saleable and moves nothing in the Metal Vault or the ledger', async () => {
      const { tag } = await atHo();
      const rc = await caseOf(tag.id);
      const vaultBefore = await prisma.metalStock.count({ where: { companyId: A.company.id } });
      const movesBefore = await prisma.metalStockMovement.count({ where: { companyId: A.company.id } });
      const entriesBefore = await prisma.journalEntry.count();

      await inspectRepairCase(rc.id, { result: 'MELT', reason: 'Damaged beyond repair' }, A.ctx, A.user.id);

      expect((await tagRow(tag.id)).status).toBe('MELT_PENDING');
      expect(await caseOf(tag.id)).toMatchObject({ status: 'MELT_PENDING', inspectionResult: 'MELT' });
      expect(await prisma.metalStock.count({ where: { companyId: A.company.id } })).toBe(vaultBefore);
      expect(await prisma.metalStockMovement.count({ where: { companyId: A.company.id } })).toBe(movesBefore);
      expect(await prisma.journalEntry.count()).toBe(entriesBefore);
    });

    it('the whole pipeline posts no journal entry and moves no customer balance (no double credit)', async () => {
      const r = await returned();
      const balAfterReturn = await balance();
      const entries = await prisma.journalEntry.count({ where: { referenceType: { in: ['RepairCase', 'RepairTransfer'] } } });
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id);
      await sendRepairTransfer(tr.id, branchCtx, A.user.id);
      await receiveRepairTransfer(tr.id, A.ctx, A.user.id);
      await inspectRepairCase(r.rc.id, { result: 'PASS' }, A.ctx, A.user.id);
      expect(await balance()).toBeCloseTo(balAfterReturn);
      expect(await prisma.journalEntry.count({ where: { referenceType: { in: ['RepairCase', 'RepairTransfer'] } } })).toBe(entries);
    });
  });

  describe('retag & reprint', () => {
    it('reprint keeps the same tag and records an audit entry; it creates no tag', async () => {
      const { tag } = await atHo();
      const tagsBefore = await prisma.jewelryTag.count({ where: { companyId: A.company.id } });
      const out = await reprintTag(tag.id, 'label torn', A.ctx, A.user.id);
      expect(out).toMatchObject({ id: tag.id, tagNumber: tag.tagNumber });
      expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id } })).toBe(tagsBefore);
      const audit = await prisma.auditLog.findFirst({ where: { companyId: A.company.id, recordId: tag.id, action: 'REPRINT' } });
      expect(audit).toBeTruthy();
      expect(audit!.userId).toBe(A.user.id);
    });

    it('true retag: old tag -> RETAGGED (kept, linked), new tag active at HO, cost inherited, done once only', async () => {
      const { tag } = await atHo();
      const rc = await caseOf(tag.id);
      await prisma.jewelryTagMaterial.create({ data: { companyId: A.company.id, tagId: tag.id, code: 'GOLD22', materialType: 'METAL', weight: 9 } });

      await expect(retagTag({ repairCaseId: rc.id, reason: 'no change', changes: {} }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      await expect(retagTag({ repairCaseId: rc.id, reason: '', changes: { grossWeight: 9 } }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      await expect(retagTag({ repairCaseId: rc.id, reason: 'bad', changes: { grossWeight: 5, netWeight: 8 } }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });

      const out = await retagTag({ repairCaseId: rc.id, reason: 'Resized, weight changed', changes: { grossWeight: 9.5, netWeight: 8.7, stoneWeight: 0.8 } }, A.ctx, A.user.id);

      expect(out.retagNumber).toMatch(/^RTG-/);
      expect(out.oldTagNumber).toBe(tag.tagNumber);
      expect(out.newTagNumber).not.toBe(tag.tagNumber);
      const oldRow = await tagRow(tag.id);
      expect(oldRow.status).toBe('RETAGGED'); // never deleted
      const newRow = await tagRow(out.newTagId);
      expect(newRow).toMatchObject({ status: 'IN_STOCK', branchId: hoId, tagNumber: out.newTagNumber });
      expect(Number(newRow.grossWeight)).toBe(9.5);
      expect(Number(newRow.costPrice)).toBe(Number(oldRow.costPrice)); // cost is immutable across a retag
      expect(await prisma.jewelryTagMaterial.count({ where: { tagId: newRow.id } })).toBe(1);

      const link = await prisma.tagRetag.findUniqueOrThrow({ where: { id: out.id } });
      expect(link).toMatchObject({ oldTagId: tag.id, newTagId: newRow.id, branchId: hoId, retaggedById: A.user.id, approvedById: A.user.id, reason: 'Resized, weight changed' });
      expect((link.oldDetails as { grossWeight: number }).grossWeight).toBe(10);
      expect((link.newDetails as { grossWeight: number }).grossWeight).toBe(9.5);
      expect(await caseOf(tag.id)).toMatchObject({ status: 'RETAGGED' });

      await expect(retagTag({ repairCaseId: rc.id, reason: 'again', changes: { grossWeight: 9 } }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(await prisma.tagRetag.count({ where: { oldTagId: tag.id } })).toBe(1);
      await expect(reprintTag(tag.id, 'x', A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 }); // the old tag can no longer be printed
    });

    it('two concurrent retags of one piece: exactly one succeeds', async () => {
      const { tag } = await atHo();
      const rc = await caseOf(tag.id);
      const res = await Promise.allSettled([
        retagTag({ repairCaseId: rc.id, reason: 'a', changes: { grossWeight: 9.1 } }, A.ctx, A.user.id),
        retagTag({ repairCaseId: rc.id, reason: 'b', changes: { grossWeight: 9.2 } }, A.ctx, A.user.id),
      ]);
      expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.tagRetag.count({ where: { oldTagId: tag.id } })).toBe(1);
      expect(await prisma.jewelryTag.count({ where: { companyId: A.company.id, status: 'IN_STOCK', createdAt: { gte: new Date(Date.now() - 60_000) }, branchId: hoId, tagNumber: { not: tag.tagNumber } } })).toBeGreaterThanOrEqual(1);
    });

    it('only a piece Head Office holds and has not cleared can be retagged; a branch user cannot retag', async () => {
      const r = await returned(); // still at the branch
      await expect(retagTag({ repairCaseId: r.rc.id, reason: 'r', changes: { grossWeight: 9 } }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
      const h = await atHo();
      await expect(retagTag({ repairCaseId: h.rc.id, reason: 'r', changes: { grossWeight: 9 } }, branchCtx, A.user.id)).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('registers and branch scope', () => {
    it('the Repair Register lists the piece with customer / return / invoice / transfer, and filters work', async () => {
      const { tag, inv, ret, tr } = await atHo();
      const rows = await listRepairCases(A.ctx, { tagNumber: tag.tagNumber });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tagNumber: tag.tagNumber, customer: 'Return Customer', returnNumber: ret.returnNumber, invoiceNumber: inv.invoiceNumber,
        transferNumber: tr.transferNumber, status: 'HO_RECEIVED', currentLocation: 'HEAD_OFFICE', originBranchId: branchId, currentBranchId: hoId,
      });
      expect(rows[0].hoReceivedBy).toBe('Test User');
      expect((await listRepairCases(A.ctx, { status: 'HO_RECEIVED', returnNumber: ret.returnNumber })).map((r) => r.tagNumber)).toEqual([tag.tagNumber]);
      expect(await listRepairCases(A.ctx, { status: 'IN_REPAIR', tagNumber: tag.tagNumber })).toHaveLength(0);
      expect((await listRepairCases(A.ctx, { headOffice: true, tagNumber: tag.tagNumber })).length).toBe(1);
      expect((await getRepairCase(A.ctx, rows[0].id)).repairNumber).toBe(rows[0].repairNumber);
    });

    it('the Repair Transfer register answers "who sent what to HO, and did HO receive it"', async () => {
      const { tag, tr } = await atHo();
      const rows = await listRepairTransfers(A.ctx, { transferNumber: tr.transferNumber });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tagNumber: tag.tagNumber, fromBranch: 'Test Branch', toBranch: 'Head Office', status: 'RECEIVED', sentBy: 'Test User', receivedBy: 'Test User' });
      expect(rows[0].sentAt).not.toBeNull();
      expect(rows[0].receivedAt).not.toBeNull();
    });

    it('a user without the Head Office branch sees only cases touching their own branch', async () => {
      const { tag } = await returned();
      const other = await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `OTH-${suffix}-${tagSeq}`, name: 'Elsewhere' } });
      const elsewhereCtx: TenantContext = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [other.id] } };
      expect(await listRepairCases(elsewhereCtx, { tagNumber: tag.tagNumber })).toHaveLength(0);
      expect(await listRepairCases(branchCtx, { tagNumber: tag.tagNumber })).toHaveLength(1);
      const rc = await caseOf(tag.id);
      await expect(getRepairCase(elsewhereCtx, rc.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [rc.id] }, elsewhereCtx, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('company isolation', () => {
    it("another company cannot see, transfer, receive, inspect, repair or retag this company's pieces", async () => {
      const { tag, rc, tr } = await atHo();
      const bBranch = B.branch.id;
      expect(await listRepairCases(B.ctx, {})).toHaveLength(0);
      expect(await listRepairTransfers(B.ctx, {})).toHaveLength(0);
      await expect(getRepairCase(B.ctx, rc.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(createRepairTransfer({ fromBranchId: bBranch, repairCaseIds: [rc.id] }, B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(receiveRepairTransfer(tr.id, B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(inspectRepairCase(rc.id, { result: 'PASS' }, B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(startRepair(rc.id, {}, B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(retagTag({ repairCaseId: rc.id, reason: 'x', changes: { grossWeight: 1 } }, B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(reprintTag(tag.id, 'x', B.ctx, B.user.id)).rejects.toMatchObject({ statusCode: 404 });
      expect((await tagRow(tag.id)).status).toBe('HO_RECEIVED'); // untouched
    });
  });

  describe('audit', () => {
    it('every step writes a company-scoped audit entry naming the actor and action', async () => {
      const { rc, tr } = await atHo();
      await inspectRepairCase(rc.id, { result: 'REPAIR_REQUIRED', reason: 'polish' }, A.ctx, A.user.id);
      const actions = (await prisma.auditLog.findMany({ where: { companyId: A.company.id, recordId: { in: [rc.id, tr.id] } } })).map((a) => `${a.tableName}:${a.action}`);
      expect(actions).toEqual(expect.arrayContaining(['repair_cases:CREATE', 'repair_transfers:CREATE', 'repair_transfers:SEND', 'repair_transfers:RECEIVE', 'repair_cases:HO_RECEIVE', 'repair_cases:INSPECT']));
      const a = await prisma.auditLog.findFirstOrThrow({ where: { companyId: A.company.id, recordId: rc.id, action: 'INSPECT' } });
      expect(a.userId).toBe(A.user.id);
    });
  });

  describe('HTTP: permissions gate the routes', () => {
    it('receive / inspect / retag need their own permission; the sale-return permission alone is not enough (403), granted works', async () => {
      const weak = await createTestTenant(`${suffix}W`, ['repair:view', 'repair:send']);
      try {
        const api = apiWith(tokenFor(weak), app);
        expect((await api.post('/tagging/repair-transfers/x/receive', {})).status).toBe(403);
        expect((await api.post('/tagging/repairs/x/inspect', { result: 'PASS' })).status).toBe(403);
        expect((await api.post('/tagging/repairs/x/start', {})).status).toBe(403);
        expect((await api.post('/tagging/repairs/x/retag', { reason: 'r', changes: {} })).status).toBe(403);
        expect((await api.post('/tagging/tags/x/reprint', {})).status).toBe(403);
        expect((await api.get('/tagging/repairs')).status).toBe(200); // view is granted
      } finally { await cleanupTestTenant(weak); }

      const noView = await createTestTenant(`${suffix}N`, ['invoice:create']);
      try {
        const api = apiWith(tokenFor(noView), app);
        expect((await api.get('/tagging/repairs')).status).toBe(403);
        expect((await api.post('/tagging/repair-transfers', { fromBranchId: 'x', repairCaseIds: ['y'] })).status).toBe(403);
      } finally { await cleanupTestTenant(noView); }

      // granted: the full register + HO receive over real HTTP
      const r = await returned();
      const tr = await createRepairTransfer({ fromBranchId: branchId, repairCaseIds: [r.rc.id] }, branchCtx, A.user.id);
      const api = apiWith(tokenFor(A), app);
      expect((await api.post(`/tagging/repair-transfers/${tr.id}/send`, {})).status).toBe(200);
      const rec = await api.post(`/tagging/repair-transfers/${tr.id}/receive`, {});
      expect(rec.status).toBe(200);
      expect(rec.body.data.status).toBe('RECEIVED');
      const again = await api.post(`/tagging/repair-transfers/${tr.id}/receive`, {});
      expect(again.status).toBe(409);
      const list = await api.get(`/tagging/repair-transfers?transferNumber=${tr.transferNumber}`);
      expect(list.status).toBe(200);
      expect(list.body.data[0].status).toBe('RECEIVED');
    });
  });
});
