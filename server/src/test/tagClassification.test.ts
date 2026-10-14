import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createTag, updateTag, getTagPrintTspl, getTagPreviewValues, getTag, listTags, searchTags } from '../modules/tagging/tagging.service';
import { updateSubCategory, unlinkSubCategory } from '../modules/masters/subCategory.service';
import { previewTagReclassification, applyTagReclassification } from '../modules/tagging/tagReclassification.service';
import { diagnoseTemplateLiterals, resolveTagClassification } from '../shared/tagClassification';

// The category + sub-category ids on a tag are the ONLY classification. The stored free-text `name` must never
// override them — in saving, printing, listing or reprinting — and every change to either leaves an audit row.
// Fixture mirrors the reported case: BOWL > 3 LEG (3LE) and BOWL > MATTU (MTU), plus a tag whose legacy stored
// name ("MATTU BOWL") disagrees with the sub-category it carries.
describe('tag classification is authoritative (BOWL > 3 LEG / MATTU)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const PERMS = ['tag:view', 'tag:create', 'tag:reclassify', 'masters:view', 'masters:create', 'masters:edit', 'masters:delete'];
  let A: TestTenant, B: TestTenant;
  let stockTypeId: string, bowlId: string, ringId: string;
  let legId: string, mattuId: string, ringSubId: string, inactiveId: string, bSubId: string;
  let templateId: string;
  const tagIds: string[] = [];

  const baseTag = () => ({
    branchId: A.branch.id, metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, stockTypeId, categoryId: bowlId,
  });
  const mk = async (extra: object = {}) => {
    const t = await createTag(A.ctx, { ...baseTag(), ...extra } as any, A.user.id);
    tagIds.push(t.id);
    return t;
  };
  const audits = (recordId: string, action?: string) =>
    prisma.auditLog.findMany({ where: { companyId: A.company.id, recordId, ...(action && { action }) }, orderBy: { timestamp: 'asc' } });
  const printed = async (tagId: string) => (await getTagPrintTspl(A.ctx, tagId, templateId)).tspl;

  beforeAll(async () => {
    A = await createTestTenant(`TCA${suffix}`, PERMS);
    B = await createTestTenant(`TCB${suffix}`, PERMS);
    const co = A.company.id;
    stockTypeId = (await prisma.stockType.create({ data: { companyId: co, code: 'S', name: 'Silver' } })).id;
    bowlId = (await prisma.productCategory.create({ data: { companyId: co, code: 'BWL', name: 'BOWL' } })).id;
    ringId = (await prisma.productCategory.create({ data: { companyId: co, code: 'RNG', name: 'RING' } })).id;
    legId = (await prisma.subCategory.create({ data: { companyId: co, code: '3LE', name: '3 LEG' } })).id;
    mattuId = (await prisma.subCategory.create({ data: { companyId: co, code: 'MTU', name: 'MATTU' } })).id;
    ringSubId = (await prisma.subCategory.create({ data: { companyId: co, code: 'PLN', name: 'PLAIN' } })).id;
    inactiveId = (await prisma.subCategory.create({ data: { companyId: co, code: 'OLD', name: 'OLD STYLE', isActive: false } })).id;
    bSubId = (await prisma.subCategory.create({ data: { companyId: B.company.id, code: '3LE', name: '3 LEG' } })).id;
    for (const [c, s] of [[bowlId, legId], [bowlId, mattuId], [bowlId, inactiveId], [ringId, ringSubId]]) {
      await prisma.categorySubCategory.create({ data: { companyId: co, categoryId: c, subCategoryId: s } });
    }
    templateId = (await prisma.tagTemplate.create({
      data: {
        companyId: co, name: `Classification ${suffix}`, isDefault: false, widthMm: 50, heightMm: 30, gapMm: 2,
        layout: {
          elements: [
            { id: 'cat', wing: 'front', type: 'text', xMm: 1, yMm: 1, boundField: 'categoryName' },
            { id: 'sub', wing: 'front', type: 'text', xMm: 1, yMm: 4, boundField: 'subCategoryName' },
            { id: 'subc', wing: 'front', type: 'text', xMm: 1, yMm: 7, boundField: 'subCategoryCode' },
            { id: 'nm', wing: 'front', type: 'text', xMm: 1, yMm: 10, boundField: 'name' },
            { id: 'lit', wing: 'front', type: 'text', xMm: 1, yMm: 13, literalText: 'MTU' },
          ],
        },
      },
    })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.tagTemplate.deleteMany({ where: { id: templateId } });
    await prisma.categorySubCategory.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.subCategory.deleteMany({ where: { companyId: { in: [A.company.id, B.company.id] } } });
    await prisma.productCategory.deleteMany({ where: { companyId: A.company.id } });
    await prisma.stockType.deleteMany({ where: { companyId: A.company.id } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
  });

  describe('saving', () => {
    it('stores the selected sub-category id, and derives the name from it — a client-supplied name is ignored', async () => {
      const t = await mk({ name: 'MATTU BOWL', subCategoryId: legId });
      expect(t.subCategoryId).toBe(legId);
      expect(t.name).toBe('3 LEG');
      const row = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.subCategoryId).toBe(legId);
      expect(row.name).toBe('3 LEG');
    });

    it('falls back to the category name when no sub-category is chosen', async () => {
      const t = await mk({});
      expect(t.name).toBe('BOWL');
    });

    it('rejects a sub-category that is not linked to the category (400) and audits the rejection', async () => {
      await expect(mk({ subCategoryId: ringSubId })).rejects.toMatchObject({ statusCode: 400 });
      const rejected = await prisma.auditLog.findMany({ where: { companyId: A.company.id, action: 'CLASSIFICATION_REJECTED' } });
      expect(rejected.some((r) => (r.newValues as any)?.subCategoryId === ringSubId && /not linked/.test((r.newValues as any).reason))).toBe(true);
    });

    it('rejects an inactive sub-category (400), another company\'s sub-category (404), and a bogus id', async () => {
      await expect(mk({ subCategoryId: inactiveId })).rejects.toMatchObject({ statusCode: 400 });
      await expect(mk({ subCategoryId: bSubId })).rejects.toMatchObject({ statusCode: 404 });
      await expect(mk({ subCategoryId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('audits the create with the resolved classification', async () => {
      const t = await mk({ subCategoryId: mattuId });
      const [row] = await audits(t.id, 'CREATE');
      expect(row.companyId).toBe(A.company.id);
      expect(row.userId).toBe(A.user.id);
      expect(row.newValues).toMatchObject({ categoryCode: 'BWL', subCategoryCode: 'MTU', subCategoryName: 'MATTU', tagNumber: t.tagNumber });
    });
  });

  describe('printing resolves category / sub-category from the saved ids, live', () => {
    it('BOWL > 3 LEG prints 3 LEG / 3LE and BOWL > MATTU prints MATTU / MTU', async () => {
      const leg = await mk({ subCategoryId: legId });
      const mattu = await mk({ subCategoryId: mattuId });
      const a = await printed(leg.id);
      expect(a).toContain('"BOWL"'); expect(a).toContain('"3 LEG"'); expect(a).toContain('"3LE"');
      expect(a).not.toContain('"MATTU"');
      const b = await printed(mattu.id);
      expect(b).toContain('"MATTU"'); expect(b).toContain('"MTU"'); expect(b).not.toContain('"3 LEG"');
    });

    it('a legacy stored name ("MATTU BOWL") cannot override the sub-category in any bound field', async () => {
      const t = await mk({ subCategoryId: legId });
      await prisma.jewelryTag.update({ where: { id: t.id }, data: { name: 'MATTU BOWL' } });   // the historic data shape
      const tspl = await printed(t.id);
      expect(tspl).not.toContain('MATTU BOWL');
      expect(tspl).toContain('"3 LEG"'); expect(tspl).toContain('"3LE"');
      const { values } = await getTagPreviewValues(A.ctx, t.id);
      expect(values.name).toBe('3 LEG');
      expect(values.subCategoryName).toBe('3 LEG');
      expect(values.subCategoryCode).toBe('3LE');
    });

    it('returns the exact resolved values before the print request is sent, plus template warnings', async () => {
      const t = await mk({ subCategoryId: mattuId });
      const out = await getTagPrintTspl(A.ctx, t.id, templateId);
      expect(out.resolved.category).toEqual({ name: 'BOWL', code: 'BWL' });
      expect(out.resolved.subCategory).toEqual({ name: 'MATTU', code: 'MTU' });
      // the static "MTU" text element is the same on every label — it is flagged, never silently trusted
      expect(out.warnings.some((w) => w.elementId === 'lit' && w.code === 'LITERAL_MATCHES_MASTER')).toBe(true);
    });

    it('static template text stays static: it prints MTU on a 3 LEG tag, and the diagnostic is the only guard', async () => {
      const leg = await mk({ subCategoryId: legId });
      const out = await getTagPrintTspl(A.ctx, leg.id, templateId);
      expect(out.tspl).toContain('"MTU"');                  // the literal element — exactly the masquerade risk
      expect(out.resolved.subCategory!.code).toBe('3LE');   // …which the resolved block contradicts, so the screen can show it
      expect(out.warnings.map((w) => w.elementId)).toContain('lit');
    });

    it('a sub-category rename is followed by the label at once, and the tag row is untouched (documented effect)', async () => {
      const t = await mk({ subCategoryId: legId });
      const before = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } });
      await updateSubCategory(A.company.id, legId, { name: '3 LEGS', reason: 'spelling' }, A.user.id);
      try {
        const tspl = await printed(t.id);
        expect(tspl).toContain('"3 LEGS"');
        const after = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.name).toBe(before.name);               // stored legacy text is never rewritten by a master edit
        const [rename] = (await audits(legId, 'RENAME')).slice(-1);
        expect(rename.oldValues).toMatchObject({ name: '3 LEG', code: '3LE' });
        expect(rename.newValues).toMatchObject({ name: '3 LEGS', reason: 'spelling' });
        expect((rename.newValues as any).affectedTags).toBeGreaterThanOrEqual(1);
        expect(rename.userId).toBe(A.user.id);
      } finally {
        await updateSubCategory(A.company.id, legId, { name: '3 LEG' }, A.user.id);
      }
    });

    it('prints and reprints are audited with the template and the exact values, through the same mapping', async () => {
      const t = await mk({ subCategoryId: mattuId });
      await getTagPrintTspl(A.ctx, t.id, templateId, { userId: A.user.id, requestId: 'req-1' });
      await getTagPrintTspl(A.ctx, t.id, templateId, { userId: A.user.id, requestId: 'req-2', reprint: true });
      const [p] = await audits(t.id, 'PRINT_LABEL');
      const [r] = await audits(t.id, 'REPRINT_LABEL');
      expect(p.newValues).toMatchObject({ templateId, requestId: 'req-1', resolved: { subCategory: { name: 'MATTU', code: 'MTU' } } });
      expect(r.newValues).toMatchObject({ requestId: 'req-2', resolved: { subCategory: { name: 'MATTU', code: 'MTU' } } });
      expect(p.companyId).toBe(A.company.id);
    });
  });

  describe('editing', () => {
    it('changing the sub-category re-derives the name and audits before / after', async () => {
      const t = await mk({ subCategoryId: legId });
      const u = await updateTag(t.id, { subCategoryId: mattuId, name: 'whatever the client says' } as any, A.ctx, A.user.id);
      expect(u.subCategoryId).toBe(mattuId);
      expect(u.name).toBe('MATTU');
      const [c] = await audits(t.id, 'CLASSIFICATION_CHANGE');
      expect(c.oldValues).toMatchObject({ subCategoryCode: '3LE', subCategoryId: legId });
      expect(c.newValues).toMatchObject({ subCategoryCode: 'MTU', subCategoryId: mattuId });
    });

    it('an edit that sends an invalid pair fails and changes nothing', async () => {
      const t = await mk({ subCategoryId: legId });
      await expect(updateTag(t.id, { subCategoryId: ringSubId } as any, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } })).subCategoryId).toBe(legId);
    });

    it('an edit that leaves category / sub-category alone leaves the stored name alone', async () => {
      const t = await mk({ subCategoryId: legId });
      await prisma.jewelryTag.update({ where: { id: t.id }, data: { name: 'LEGACY TEXT' } });
      const u = await updateTag(t.id, { notes: 'x' } as any, A.ctx, A.user.id);
      expect(u.name).toBe('LEGACY TEXT');
    });

    it('the tag_history trigger records the sub-category change with the actor', async () => {
      const t = await mk({ subCategoryId: legId });
      await updateTag(t.id, { subCategoryId: mattuId } as any, A.ctx, A.user.id);
      const h = await prisma.tagHistory.findMany({ where: { tagId: t.id }, orderBy: { createdAt: 'asc' } });
      const edit = h.find((x) => x.changedFields.includes('subCategoryId'));
      expect(edit).toBeTruthy();
      expect((edit!.changes as any).subCategoryId).toEqual({ from: legId, to: mattuId });
    });
  });

  describe('reading', () => {
    it('legacy tags stay readable: lists, search and getTag show the LIVE classification; the stored text rides along', async () => {
      const t = await mk({ subCategoryId: legId });
      await prisma.jewelryTag.update({ where: { id: t.id }, data: { name: 'MATTU BOWL' } });
      const got = await getTag(A.ctx, t.id);
      expect(got.name).toBe('3 LEG'); expect(got.storedName).toBe('MATTU BOWL');
      expect(got.subCategory).toMatchObject({ id: legId, code: '3LE' });
      const list = await listTags(A.ctx, { limit: 200 });
      expect(list.tags.find((x) => x.id === t.id)!.name).toBe('3 LEG');
      const found = await searchTags(A.ctx, t.tagNumber);
      expect(found[0].name).toBe('3 LEG');
      // searchable by the live sub-category even though the stored text says MATTU BOWL / something else
      await prisma.jewelryTag.update({ where: { id: t.id }, data: { name: 'STALE TEXT' } });
      expect((await searchTags(A.ctx, '3 LEG')).map((x) => x.id)).toContain(t.id);
    });

    it('a tag with no classification at all falls back to its stored name', () => {
      expect(resolveTagClassification({ name: 'OLD ITEM' }).displayName).toBe('OLD ITEM');
      expect(resolveTagClassification({ name: 'x', category: { name: 'BOWL' } }).displayName).toBe('BOWL');
    });

    it('diagnoseTemplateLiterals is pure and flags the legacy name field', () => {
      const w = diagnoseTemplateLiterals([{ id: 'a', type: 'text', boundField: 'name' }, { id: 'b', type: 'text', literalText: 'mattu' }], [{ name: 'MATTU', code: 'MTU' }]);
      expect(w.map((x) => x.code).sort()).toEqual(['LEGACY_NAME_FIELD', 'LITERAL_MATCHES_MASTER']);
    });
  });

  describe('master audit', () => {
    it('deactivate / link / unlink are audited with actor and company', async () => {
      const sub = await prisma.subCategory.create({ data: { companyId: A.company.id, code: 'TMP', name: 'TEMP' } });
      const { linkSubCategory } = await import('../modules/masters/subCategory.service');
      await linkSubCategory(A.company.id, sub.id, ringId, A.user.id);
      await updateSubCategory(A.company.id, sub.id, { isActive: false }, A.user.id);
      await unlinkSubCategory(A.company.id, sub.id, ringId, A.user.id);
      const rows = await prisma.auditLog.findMany({ where: { companyId: A.company.id, tableName: { in: ['sub_categories', 'category_sub_categories'] } } });
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['LINK', 'DEACTIVATE', 'UNLINK']));
      expect(rows.every((r) => r.userId === A.user.id && r.companyId === A.company.id)).toBe(true);
      await prisma.subCategory.delete({ where: { id: sub.id } });
    });

    it("every audit row a tag produces carries its own company, and none leaks into another company's trail", async () => {
      const t = await mk({ subCategoryId: legId });
      await updateTag(t.id, { subCategoryId: mattuId } as any, A.ctx, A.user.id);
      const rows = await audits(t.id);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.every((r) => r.companyId === A.company.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { companyId: B.company.id, recordId: t.id } })).toBe(0);
    });
  });

  describe('approved correction (dry run, then apply)', () => {
    it('preview changes nothing; apply changes ONLY the listed tags, with before/after + reason + reference audited', async () => {
      const t1 = await mk({ subCategoryId: legId });
      const t2 = await mk({ subCategoryId: legId });
      const untouched = await mk({ subCategoryId: legId });        // same sub-category, same name — NOT listed
      const items = [{ tagId: t1.id, subCategoryId: mattuId }, { tagId: t2.id, subCategoryId: legId }];

      const pv = await previewTagReclassification(A.ctx, items);
      expect(pv.changeCount).toBe(1);
      expect(pv.rows[0]).toMatchObject({ willChange: true, before: { subCategory: '3 LEG' }, after: { subCategory: 'MATTU', subCategoryCode: 'MTU' } });
      expect(pv.rows[1].willChange).toBe(false);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t1.id } })).subCategoryId).toBe(legId);   // dry run wrote nothing

      const out = await applyTagReclassification(A.ctx, A.user.id, { items, reason: 'Owner confirmed these are MATTU', reference: 'OSSP-APPROVAL-1', confirm: true });
      expect(out.applied).toBe(1);
      const r1 = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t1.id } });
      expect(r1.subCategoryId).toBe(mattuId); expect(r1.name).toBe('MATTU');
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: untouched.id } })).subCategoryId).toBe(legId);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t2.id } })).subCategoryId).toBe(legId);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t1.id } })).costPrice.toString()).toBe(t1.costPrice.toString());

      const [a] = await audits(t1.id, 'CLASSIFICATION_CORRECTION');
      expect(a.oldValues).toMatchObject({ subCategory: '3 LEG', subCategoryId: legId });
      expect(a.newValues).toMatchObject({ subCategory: 'MATTU', reason: 'Owner confirmed these are MATTU', reference: 'OSSP-APPROVAL-1', administrativeCorrection: true, batchId: out.batchId });
      expect(a.userId).toBe(A.user.id);
      expect(await audits(t2.id, 'CLASSIFICATION_CORRECTION')).toHaveLength(0);
    });

    it('is all-or-nothing: one refused row (unlinked sub-category) applies nothing', async () => {
      const t1 = await mk({ subCategoryId: legId });
      const t2 = await mk({ subCategoryId: legId });
      await expect(applyTagReclassification(A.ctx, A.user.id, {
        items: [{ tagId: t1.id, subCategoryId: mattuId }, { tagId: t2.id, subCategoryId: ringSubId }],
        reason: 'test rollback', reference: 'ref', confirm: true,
      })).rejects.toMatchObject({ statusCode: 409 });
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t1.id } })).subCategoryId).toBe(legId);
      expect(await audits(t1.id, 'CLASSIFICATION_CORRECTION')).toHaveLength(0);
    });

    it('needs a reason, a reference and explicit confirmation', async () => {
      const t = await mk({ subCategoryId: legId });
      const items = [{ tagId: t.id, subCategoryId: mattuId }];
      await expect(applyTagReclassification(A.ctx, A.user.id, { items, reference: 'r', confirm: true })).rejects.toMatchObject({ statusCode: 400 });
      await expect(applyTagReclassification(A.ctx, A.user.id, { items, reason: 'long enough', confirm: true })).rejects.toMatchObject({ statusCode: 400 });
      await expect(applyTagReclassification(A.ctx, A.user.id, { items, reason: 'long enough', reference: 'r' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('cannot touch another company\'s tag, and a missing tag is reported safely', async () => {
      const t = await mk({ subCategoryId: legId });
      const asB = { ...B.ctx };
      await expect(applyTagReclassification(asB, B.user.id, { items: [{ tagId: t.id, subCategoryId: bSubId }], reason: 'attack attempt', reference: 'r', confirm: true }))
        .rejects.toMatchObject({ statusCode: 404 });
      const pv = await previewTagReclassification(asB, [{ tagId: t.id, subCategoryId: bSubId }, { tagId: 'missing', subCategoryId: bSubId }]);
      expect(pv.rows.every((r) => r.refusal === 'Tag not found')).toBe(true);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } })).subCategoryId).toBe(legId);
    });

    it('is permission-gated over HTTP (403 without tag:reclassify, 200 with)', async () => {
      const t = await mk({ subCategoryId: legId });
      const viewer = await createTestTenant(`TCV${suffix}`, ['tag:view', 'tag:create']);
      const denied = await apiWith(tokenFor(viewer), app).post('/tagging/tags/reclassify/preview', { items: [{ tagId: t.id, subCategoryId: mattuId }] });
      expect(denied.status).toBe(403);
      await cleanupTestTenant(viewer);
      const ok = await apiWith(tokenFor(A), app).post('/tagging/tags/reclassify/preview', { items: [{ tagId: t.id, subCategoryId: mattuId }] });
      expect(ok.status).toBe(200);
      expect(ok.body.data.changeCount).toBe(1);
    });
  });
});
