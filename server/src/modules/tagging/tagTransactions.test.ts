import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { getTagTransactions } from './tagTransactions.service';
import { createTestTenant, purgeCompany, addBranch, TestTenant } from '../../test/fixtures';

// The ledger is read straight from the source documents, so these tests build real documents for one tag
// (purchase/tag, transfer out+in, memo out+return, sale, sale return) and check the rows, their order, who is
// named as the entry user, that cost is never exposed, and that nothing crosses a company or branch boundary.
describe('getTagTransactions (jewel transaction history)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let branch2Id: string;
  let tagId: string;
  let bTagId: string;

  beforeAll(async () => {
    A = await createTestTenant(`TX-A${suffix}`, ['tag:view']);
    B = await createTestTenant(`TX-B${suffix}`, ['tag:view']);
    branch2Id = (await addBranch(A.company.id, `TX${suffix}`)).id;

    const mkTag = (t: TestTenant, n: string) => prisma.jewelryTag.create({
      data: {
        tagNumber: `TX-${n}-${suffix}`, companyId: t.company.id, branchId: t.branch.id, name: 'Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 9, costPrice: 1000, sellingPrice: 1200, createdById: t.user.id, createdAt: new Date('2026-01-01T10:00:00Z'),
      },
    });
    tagId = (await mkTag(A, 'A')).id;
    bTagId = (await mkTag(B, 'B')).id;

    const client = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `TX-C-${suffix}`, name: 'Lingaswamy', type: 'RETAIL' } });

    // transfer A.branch -> branch2, dispatched then received
    const transfer = await prisma.branchTransfer.create({
      data: {
        companyId: A.company.id, transferNumber: `BT-${suffix}`, fromBranchId: A.branch.id, toBranchId: branch2Id, status: 'RECEIVED',
        requestedById: A.user.id, approvedById: A.user.id, dispatchedAt: new Date('2026-02-01T10:00:00Z'), receivedAt: new Date('2026-02-02T10:00:00Z'),
      },
    });
    await prisma.branchTransferItem.create({ data: { companyId: A.company.id, transferId: transfer.id, tagId, receivedAt: new Date('2026-02-02T10:00:00Z') } });

    // memo out and handed back
    const memo = await prisma.memoOut.create({
      data: {
        companyId: A.company.id, branchId: branch2Id, memoNumber: `AP-${suffix}`, clientId: client.id,
        sentDate: new Date('2026-03-01T10:00:00Z'), returnDeadline: new Date('2026-03-15T10:00:00Z'), status: 'RETURNED',
      },
    });
    await prisma.memoItem.create({
      data: {
        companyId: A.company.id, memoId: memo.id, tagId, productCode: 'R1', description: 'Ring', pieces: 1, grossWeight: 10, netGoldWeight: 9,
        estimatedValue: 1200, status: 'RETURNED', returnedPieces: 1,
      },
    });

    // The hand-back is recorded only as a status flip, captured by the tag_history trigger — drive it through
    // real status changes, then place the flip where the memo timeline says it happened.
    await prisma.jewelryTag.update({ where: { id: tagId }, data: { status: 'ON_APPROVAL' } });
    await prisma.jewelryTag.update({ where: { id: tagId }, data: { status: 'IN_STOCK' } });
    const flip = await prisma.tagHistory.findFirstOrThrow({ where: { tagId, event: 'STATUS_CHANGE', status: 'IN_STOCK' } });
    await prisma.tagHistory.update({ where: { id: flip.id }, data: { createdAt: new Date('2026-03-05T10:00:00Z') } });
    // and the CREATED row too, so no later-than-the-documents timestamp leaks into the timeline
    await prisma.tagHistory.updateMany({ where: { tagId, event: { in: ['CREATED', 'STATUS_CHANGE'] }, status: { not: 'IN_STOCK' } }, data: { createdAt: new Date('2026-03-02T10:00:00Z') } });

    // sold, then returned
    const invoice = await prisma.salesInvoice.create({
      data: {
        companyId: A.company.id, branchId: branch2Id, invoiceNumber: `TI-${suffix}`, clientId: client.id, invoiceDate: new Date('2026-04-01T10:00:00Z'),
        invoiceType: 'TAX', subtotal: 1200, totalAmount: 1236, balanceDue: 0, status: 'PAID',
      },
    });
    const line = await prisma.invoiceItem.create({
      data: {
        companyId: A.company.id, invoiceId: invoice.id, tagId, productCode: 'R1', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 9,
        rateType: 'FIXED', goldRate: 1200, makingCharge: 0, unitPrice: 1200, totalPrice: 1200, taxRate: 0.03,
      },
    });
    const ret = await prisma.salesReturn.create({
      data: { companyId: A.company.id, returnNumber: `SR-${suffix}`, invoiceId: invoice.id, clientId: client.id, returnDate: new Date('2026-04-10T10:00:00Z'), totalAmount: 1200, reason: 'Customer changed mind' },
    });
    await prisma.salesReturnItem.create({ data: { companyId: A.company.id, returnId: ret.id, invoiceItemId: line.id, tagId, amount: 1200 } });
  });

  afterAll(async () => {
    // This suite creates clients, memos, transfers and invoices, which cleanupTestTenant doesn't know about.
    await purgeCompany(A.company.id);
    await purgeCompany(B.company.id);
    await prisma.user.deleteMany({ where: { id: { in: [A.user.id, B.user.id] } } });
  });

  it('lists every document the tag has been on, newest first, with book / number / party / branch', async () => {
    const { tag, rows } = await getTagTransactions(A.ctx, tagId);
    expect(tag.tagNumber).toBe(`TX-A-${suffix}`);
    expect(rows.map((r) => r.type)).toEqual([
      'SALE_RETURN', 'SALE', 'MEMO_RETURN', 'MEMO_OUT', 'TRANSFER_RECEIVE', 'TRANSFER_ISSUE', 'TAGGED',
    ]);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.SALE).toMatchObject({ transaction: 'Jewelry Sales', docNo: `TI-${suffix}`, party: 'Lingaswamy', branchName: 'Second Test Branch', amount: 1200 });
    expect(byType.SALE_RETURN).toMatchObject({ docNo: `SR-${suffix}`, remarks: 'Customer changed mind', amount: 1200 });
    expect(byType.TRANSFER_ISSUE).toMatchObject({ docNo: `BT-${suffix}`, branchName: 'Test Branch', party: 'Second Test Branch' });
    expect(byType.TRANSFER_RECEIVE).toMatchObject({ branchName: 'Second Test Branch', party: 'Test Branch' });
    expect(byType.MEMO_OUT).toMatchObject({ docNo: `AP-${suffix}`, party: 'Lingaswamy' });
    expect(byType.TAGGED.entryBy).toBe('Test User');
    expect(byType.TRANSFER_ISSUE.entryBy).toBe('Test User');
  });

  it('never exposes the cost price — not on the tag header and not on the purchase row', async () => {
    const { tag, rows } = await getTagTransactions(A.ctx, tagId);
    expect(tag).not.toHaveProperty('costPrice');
    expect(rows.find((r) => r.type === 'TAGGED')?.amount).toBeNull();
    expect(JSON.stringify({ tag, rows })).not.toContain('1000');
  });

  it('shows a voided sale as a second row', async () => {
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId: A.company.id, invoiceNumber: `TI-${suffix}` } });
    await prisma.salesInvoice.update({ where: { id: inv.id }, data: { status: 'VOID', voidedAt: new Date('2026-04-20T10:00:00Z'), voidReason: 'wrong customer' } });
    const { rows } = await getTagTransactions(A.ctx, tagId);
    expect(rows[0]).toMatchObject({ type: 'SALE_VOID', remarks: 'wrong customer' });
  });

  it('404s for another company\'s tag and for a nonexistent id', async () => {
    await expect(getTagTransactions(A.ctx, bTagId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getTagTransactions(A.ctx, 'nope')).rejects.toBeInstanceOf(AppError);
  });

  it('404s for a tag in a branch the caller has no grant for', async () => {
    const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branch2Id] } };
    await expect(getTagTransactions(restricted, tagId)).rejects.toMatchObject({ statusCode: 404 });
    const allowed = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } };
    await expect(getTagTransactions(allowed, tagId)).resolves.toBeTruthy();
  });
});
