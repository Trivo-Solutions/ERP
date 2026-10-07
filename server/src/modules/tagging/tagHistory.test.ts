import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { runWithTenantContext } from '../../shared/tenantContext';
import { updateTag, retireTag } from './tagging.service';
import { getTagHistory } from './tagHistory.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// The history rows are written by the tag_history_capture trigger — these tests prove that, not the
// service: any change to a tag, from any code path, leaves a row with the right diff and actor.
describe('barcode history (tag_history trigger + getTagHistory)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let branch2Id: string;
  let branchAName: string;
  let userAName: string;
  let tagId: string;
  let bTagId: string;

  beforeAll(async () => {
    A = await createTestTenant(`TH-A${suffix}`, ['tag:edit']);
    B = await createTestTenant(`TH-B${suffix}`, []);
    // TestTenant's branch/user types only carry id + code/email, so read the names the fixture stored.
    branchAName = (await prisma.branch.findUniqueOrThrow({ where: { id: A.branch.id }, select: { name: true } })).name;
    userAName = (await prisma.user.findUniqueOrThrow({ where: { id: A.user.id }, select: { name: true } })).name;
    branch2Id = (await prisma.branch.create({ data: { companyId: A.company.id, branchCode: `TH-BR2-${suffix}`, name: 'Second Branch' } })).id;
    const mk = (t: TestTenant, n: string) => prisma.jewelryTag.create({
      data: {
        tagNumber: `TH-${n}-${suffix}`, companyId: t.company.id, branchId: t.branch.id, name: 'Ring', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 10, netWeight: 9, costPrice: 1000, sellingPrice: 1200, createdById: t.user.id,
      },
    });
    tagId = (await mk(A, 'A')).id;
    bTagId = (await mk(B, 'B')).id;
  });

  afterAll(async () => {
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
  });

  it('records CREATED on insert with the full row as the snapshot', async () => {
    const r = await getTagHistory(A.ctx, { tagId });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].event).toBe('CREATED');
    expect(r.rows[0].data.tagNumber).toBe(`TH-A-${suffix}`);
    expect(r.rows[0].data.branchName).toBe(branchAName);
    expect(Number(r.rows[0].data.costPrice)).toBe(1000);
  });

  it('records a field-level before/after diff and the acting user for an edit made through the service', async () => {
    await runWithTenantContext(A.ctx, () => updateTag(tagId, { name: 'Ring v2', sellingPrice: 1500 }, A.ctx, A.user.id));
    const r = await getTagHistory(A.ctx, { tagId });
    const edit = r.rows[0];
    expect(edit.event).toBe('EDITED');
    expect(edit.changes.name).toEqual({ from: 'Ring', to: 'Ring v2' });
    expect(Number(edit.changes.sellingPrice.to)).toBe(1500);
    expect(edit.changedFields).toEqual(expect.arrayContaining(['name', 'sellingPrice']));
    expect(edit.changedFields).not.toContain('updatedAt');
    expect(edit.actorUserId).toBe(A.user.id);
    expect(edit.actorName).toBe(userAName);
  });

  it('records a status change, and a branch change with the branch shown by name', async () => {
    await runWithTenantContext(A.ctx, () => retireTag(tagId, A.ctx, A.user.id));
    await prisma.jewelryTag.update({ where: { id: tagId }, data: { branchId: branch2Id } });
    const r = await getTagHistory(A.ctx, { tagId });
    const [branchChange, statusChange] = r.rows;
    expect(statusChange.event).toBe('STATUS_CHANGE');
    expect(statusChange.changes.status).toEqual({ from: 'IN_STOCK', to: 'RETIRED' });
    expect(branchChange.event).toBe('BRANCH_CHANGE');
    expect(branchChange.changes.branchId).toEqual({ from: branchAName, to: 'Second Branch' });
    expect(branchChange.actorUserId).toBeNull(); // a bare platform write has no request actor
  });

  it('filters by event, status, user and date range', async () => {
    expect((await getTagHistory(A.ctx, { tagId, event: 'STATUS_CHANGE' })).rows).toHaveLength(1);
    expect((await getTagHistory(A.ctx, { tagId, status: 'RETIRED' })).rows.length).toBeGreaterThan(0);
    expect((await getTagHistory(A.ctx, { tagId, userId: A.user.id })).rows).toHaveLength(2); // the edit + the retire
    const future = new Date(Date.now() + 86_400_000 * 2);
    expect((await getTagHistory(A.ctx, { tagId, dateFrom: future })).rows).toHaveLength(0);
    expect((await getTagHistory(A.ctx, { tagId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date() })).rows.length).toBeGreaterThan(0);
    await expect(getTagHistory(A.ctx, { event: 'NOPE' })).rejects.toBeInstanceOf(AppError);
  });

  it('records DELETED and keeps the history after the tag row is gone', async () => {
    const t = await prisma.jewelryTag.create({
      data: { tagNumber: `TH-DEL-${suffix}`, companyId: A.company.id, branchId: A.branch.id, name: 'Gone', metalType: 'GOLD', grossWeight: 1, netWeight: 1, createdById: A.user.id },
    });
    await prisma.jewelryTag.delete({ where: { id: t.id } });
    const r = await getTagHistory(A.ctx, { tagNumber: `TH-DEL-${suffix}` });
    expect(r.rows.map((x) => x.event)).toEqual(['DELETED', 'CREATED']);
  });

  it("never shows another company's history, and a restricted user only sees their own branch", async () => {
    expect((await getTagHistory(A.ctx, { tagId: bTagId })).rows).toHaveLength(0);
    expect((await getTagHistory(B.ctx, {})).rows.every((x) => x.tagNumber === `TH-B-${suffix}`)).toBe(true);

    const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branch2Id] } };
    const r = await getTagHistory(restricted, { tagId });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.branchName === 'Second Branch')).toBe(true);
    expect((await getTagHistory(restricted, { branchId: A.branch.id })).rows).toHaveLength(0);
  });

  it('cannot be edited or deleted by the application role (append-only)', async () => {
    // Under the single-role test DB the privilege revoke (db-secure.sql) is inert; the real-role proof is
    // `npm run test:rls`. Here: the table carries the tenant policy and the trigger exists.
    const pol: Array<{ n: number }> = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'tag_history' AND policyname = 'tenant_isolation'`);
    const trg: Array<{ n: number }> = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'tag_history_capture'`);
    expect(pol[0].n).toBe(1);
    expect(trg[0].n).toBe(1);
  });
});
