import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import {
  createTag, createTransfer, submitTransfer, approveTransfer, receiveTransfer, listTransfers,
} from './tagging.service';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';

// Receiving a branch transfer is piece by piece: the destination verifies what arrived and receives
// only that; the rest stays TRANSFERRED and the transfer is PARTIALLY_RECEIVED until the last one is in.
describe('branch transfer — receive only verified items', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let toBranchId: string;
  let categoryId: string;
  let stockTypeId: string;

  async function makeTag(name: string) {
    return createTag(tenant.ctx, {
      branchId: tenant.branch.id, stockTypeId, categoryId, name,
      metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, costPrice: 20000, sellingPrice: 25000,
    }, tenant.user.id);
  }

  async function dispatched(n: number) {
    const tags = [];
    for (let i = 0; i < n; i++) tags.push(await makeTag(`Recv Ring ${i}`));
    const tr = await createTransfer(
      { fromBranchId: tenant.branch.id, toBranchId, tagIds: tags.map((t) => t.id) }, tenant.ctx, tenant.user.id);
    await submitTransfer(tr.id, tenant.ctx, tenant.user.id);
    await approveTransfer(tr.id, tenant.ctx, tenant.user.id);
    return { tr, tags };
  }

  const tagRow = (id: string) => prisma.jewelryTag.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    tenant = await createTestTenant(`RCV${suffix}`, ['tag:create', 'branch:transfer', 'branch:approve']);
    toBranchId = (await addBranch(tenant.company.id, suffix)).id;
    categoryId = (await prisma.productCategory.create({ data: { companyId: tenant.company.id, code: `RC-${suffix}`, name: 'Recv Cat' } })).id;
    stockTypeId = (await prisma.stockType.create({ data: { companyId: tenant.company.id, code: `R${suffix}`.slice(0, 8).toUpperCase(), name: 'Recv ST' } })).id;
  });

  afterAll(async () => {
    await cleanupTestTenant(tenant);
  });

  it('receives only the verified pieces; the rest stay in transit and the transfer is PARTIALLY_RECEIVED', async () => {
    const { tr, tags } = await dispatched(3);
    const after = await receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[0].id, tags[1].id]);
    expect(after.status).toBe('PARTIALLY_RECEIVED');

    for (const t of [tags[0], tags[1]]) {
      const row = await tagRow(t.id);
      expect(row.status).toBe('IN_STOCK');
      expect(row.branchId).toBe(toBranchId);
    }
    const missing = await tagRow(tags[2].id);
    expect(missing.status).toBe('TRANSFERRED');
    expect(missing.branchId).toBe(tenant.branch.id);

    const items = await prisma.branchTransferItem.findMany({ where: { transferId: tr.id } });
    expect(items.filter((i) => i.receivedAt).map((i) => i.tagId).sort()).toEqual([tags[0].id, tags[1].id].sort());
  });

  it('receiving the remainder later completes the transfer as RECEIVED', async () => {
    const { tr, tags } = await dispatched(2);
    await receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[0].id]);
    const done = await receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[1].id]);
    expect(done.status).toBe('RECEIVED');
    expect(done.receivedAt).not.toBeNull();
    expect((await tagRow(tags[1].id)).status).toBe('IN_STOCK');
  });

  it('omitting tagIds receives everything outstanding (old behaviour)', async () => {
    const { tr, tags } = await dispatched(2);
    const done = await receiveTransfer(tr.id, tenant.ctx, tenant.user.id);
    expect(done.status).toBe('RECEIVED');
    for (const t of tags) expect((await tagRow(t.id)).branchId).toBe(toBranchId);
  });

  it('rejects an empty verified list, a foreign tag, and an already-received piece — changing nothing', async () => {
    const { tr, tags } = await dispatched(2);
    const other = await dispatched(1);

    await expect(receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [])).rejects.toThrow('Verify at least one');
    await expect(receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[0].id, other.tags[0].id])).rejects.toThrow('not awaiting receipt');
    expect((await tagRow(tags[0].id)).status).toBe('TRANSFERRED');

    await receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[0].id]);
    await expect(receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tags[0].id])).rejects.toThrow('not awaiting receipt');
  });

  it('cannot receive a transfer that has not been dispatched', async () => {
    const tag = await makeTag('Undispatched Ring');
    const tr = await createTransfer({ fromBranchId: tenant.branch.id, toBranchId, tagIds: [tag.id] }, tenant.ctx, tenant.user.id);
    await expect(receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [tag.id])).rejects.toThrow('Only DISPATCHED');
  });

  it('lists incoming transfers filtered by a comma list of statuses', async () => {
    const { tr } = await dispatched(2);
    const first = await prisma.branchTransferItem.findFirstOrThrow({ where: { transferId: tr.id } });
    await receiveTransfer(tr.id, tenant.ctx, tenant.user.id, [first.tagId]);

    const res = await listTransfers(tenant.ctx, { status: 'DISPATCHED,PARTIALLY_RECEIVED', incoming: true, toBranchId, limit: 100 });
    const row = res.transfers.find((x) => x.id === tr.id)!;
    expect(row.status).toBe('PARTIALLY_RECEIVED');
    expect(row.items.filter((i) => i.receivedAt)).toHaveLength(1);
    expect(res.transfers.every((x) => ['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(x.status))).toBe(true);
  });
});
