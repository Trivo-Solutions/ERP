import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../../app';
import { platformPrisma as prisma } from '../../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from '../../test/fixtures';
import { getTagPrintTspl, getTagPreviewValues } from './tagging.service';

// GET /tagging/tags/:id/preview-values — the designer's Preview Label. Same company/branch
// checks as the print path, and the values must be exactly what the printed label carries.
describe('getTagPreviewValues / GET /tagging/tags/:id/preview-values', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;      // owns the tag, has tag:view
  let noPerm: TestTenant; // a tenant with no tag:view
  let B: TestTenant;      // another company, has tag:view
  let otherBranchId: string;
  let tagId: string;
  let templateId: string;
  const PARITY_FIELDS = ['tagNumber', 'name', 'metalKarat', 'grossWeight', 'netWeight', 'sellingPrice', 'categoryName', 'branchName'];

  beforeAll(async () => {
    A = await createTestTenant(`PVA${suffix}`, ['tag:view']);
    noPerm = await createTestTenant(`PVN${suffix}`, ['sales:view']);
    B = await createTestTenant(`PVB${suffix}`, ['tag:view']);

    const otherBranch = await prisma.branch.create({
      data: { companyId: A.company.id, branchCode: `TSTBR2-${suffix}`, name: 'Other Branch' },
    });
    otherBranchId = otherBranch.id;
    const category = await prisma.productCategory.create({
      data: { companyId: A.company.id, code: `TSTCAT-PV-${suffix}`, name: 'Preview Category' },
    });
    const stockType = await prisma.stockType.create({
      data: { companyId: A.company.id, code: `TPV${suffix}`.slice(0, 8).toUpperCase(), name: 'Preview Stock Type' },
    });
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-PV-${suffix}`, companyId: A.company.id, branchId: A.branch.id,
        categoryId: category.id, stockTypeId: stockType.id,
        name: 'Preview Piece', metalType: 'GOLD', metalKarat: '22K',
        grossWeight: 29.245, netWeight: 26.625, sellingPrice: 30000, createdById: A.user.id,
      },
    });
    tagId = tag.id;
    const template = await prisma.tagTemplate.create({
      data: {
        companyId: A.company.id, name: `PV Template ${suffix}`, isDefault: false, widthMm: 50, heightMm: 30, gapMm: 2,
        layout: {
          elements: PARITY_FIELDS.map((f, i) => ({ id: `e${i}`, wing: 'front', type: 'text', xMm: 1, yMm: i * 3, boundField: f })),
        },
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.tagTemplate.deleteMany({ where: { id: templateId } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await prisma.productCategory.deleteMany({ where: { companyId: A.company.id } });
    await prisma.stockType.deleteMany({ where: { companyId: A.company.id } });
    await prisma.branch.deleteMany({ where: { id: otherBranchId } });
    for (const t of [A, noPerm, B]) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  it('returns the same resolved values the printed TSPL carries', async () => {
    const { values } = await getTagPreviewValues(A.ctx, tagId);
    const { tspl } = await getTagPrintTspl(A.ctx, tagId, templateId);
    for (const f of PARITY_FIELDS) {
      expect(values[f], f).not.toBe('');
      expect(tspl, f).toContain(`"${values[f]}"`);
    }
    expect(values.grossWeight).toBe('29.245g');
    expect(values.netPurity).toBe('22K / 26.625g');
  });

  it('serves the values over HTTP with tag:view', async () => {
    const res = await apiWith(tokenFor(A), app).get(`/tagging/tags/${tagId}/preview-values`);
    expect(res.status).toBe(200);
    expect(res.body.data.values.tagNumber).toBe(`TSTTAG-PV-${suffix}`);
  });

  it('is 403 over HTTP without tag:view', async () => {
    const res = await apiWith(tokenFor(noPerm), app).get(`/tagging/tags/${tagId}/preview-values`);
    expect(res.status).toBe(403);
  });

  it('cannot preview another company\'s tag (404), service and HTTP', async () => {
    await expect(getTagPreviewValues(B.ctx, tagId)).rejects.toMatchObject({ statusCode: 404 });
    const res = await apiWith(tokenFor(B), app).get(`/tagging/tags/${tagId}/preview-values`);
    expect(res.status).toBe(404);
  });

  it('branch access matches the print route: a user restricted to another branch gets 404 from both', async () => {
    const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [otherBranchId] } };
    await expect(getTagPreviewValues(restricted, tagId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getTagPrintTspl(restricted, tagId, templateId)).rejects.toMatchObject({ statusCode: 404 });

    const allowed = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [A.branch.id] } };
    await expect(getTagPreviewValues(allowed, tagId)).resolves.toHaveProperty('values.tagNumber');
  });

  it('returns 404 "Tag not found" for a nonexistent tag, same as the print route', async () => {
    await expect(getTagPreviewValues(A.ctx, 'nonexistent-id')).rejects.toThrow('Tag not found');
    await expect(getTagPrintTspl(A.ctx, 'nonexistent-id')).rejects.toThrow('Tag not found');
    const res = await apiWith(tokenFor(A), app).get('/tagging/tags/nonexistent-id/preview-values');
    expect(res.status).toBe(404);
  });
});
