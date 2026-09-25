import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import {
  listEstimateTemplates, getEstimateTemplateById, createEstimateTemplate, updateEstimateTemplate,
} from './estimateTemplate.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

describe('Estimate Template CRUD (print designer)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const validLayout = { elements: [{ id: 'e1', type: 'text', xMm: 1, yMm: 1, literalText: 'Test' }] };
  // Not fixed to A4 — a real target here is a narrow continuous-roll thermal/receipt printer
  // (e.g. Epson POS), so width/height are configurable per template, not hardcoded.
  const dims = { widthMm: 80, heightMm: 200 };

  let userId: string;
  let tenant: TestTenant;
  const createdIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`ESTTPL${suffix}`, []);
    userId = tenant.user.id;
  });

  afterAll(async () => {
    await prisma.estimateTemplate.deleteMany({ where: { id: { in: createdIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('creates a template with isDefault:false by default', async () => {
    const t = await createEstimateTemplate(tenant.company.id, { name: `Test Template ${suffix}`, ...dims, layout: validLayout }, userId);
    createdIds.push(t.id);
    expect(t.name).toBe(`Test Template ${suffix}`);
    expect(t.isDefault).toBe(false);
    expect(Number(t.widthMm)).toBe(80);
    expect(Number(t.heightMm)).toBe(200);
  });

  it('rejects a layout without an elements array', async () => {
    await expect(
      createEstimateTemplate(tenant.company.id, { name: `Bad ${suffix}`, ...dims, layout: { foo: 1 } }, userId)
    ).rejects.toThrow(/elements/);
  });

  it('rejects an empty name', async () => {
    await expect(
      createEstimateTemplate(tenant.company.id, { name: '  ', ...dims, layout: validLayout }, userId)
    ).rejects.toThrow('Template name is required');
  });

  it('rejects a missing/zero paper width or height', async () => {
    await expect(
      createEstimateTemplate(tenant.company.id, { name: `NoDims ${suffix}`, widthMm: 0, heightMm: 200, layout: validLayout }, userId)
    ).rejects.toThrow('Paper width and height are required');
    await expect(
      createEstimateTemplate(tenant.company.id, { name: `NoDims2 ${suffix}`, widthMm: 80, heightMm: 0, layout: validLayout }, userId)
    ).rejects.toThrow('Paper width and height are required');
  });

  it('creating a new default unsets the previous default', async () => {
    const t1 = await createEstimateTemplate(tenant.company.id, { name: `Default A ${suffix}`, ...dims, layout: validLayout, isDefault: true }, userId);
    createdIds.push(t1.id);
    const t2 = await createEstimateTemplate(tenant.company.id, { name: `Default B ${suffix}`, ...dims, layout: validLayout, isDefault: true }, userId);
    createdIds.push(t2.id);

    expect((await getEstimateTemplateById(tenant.company.id, t1.id)).isDefault).toBe(false);
    expect((await getEstimateTemplateById(tenant.company.id, t2.id)).isDefault).toBe(true);
  });

  it('updates a template, including its layout and dimensions', async () => {
    const t = await createEstimateTemplate(tenant.company.id, { name: `To Update ${suffix}`, ...dims, layout: validLayout }, userId);
    createdIds.push(t.id);

    const updated = await updateEstimateTemplate(tenant.company.id, t.id, { name: 'Updated Name', widthMm: 58, layout: { elements: [] } });
    expect(updated.name).toBe('Updated Name');
    expect(Number(updated.widthMm)).toBe(58);
    expect(Number(updated.heightMm)).toBe(200); // untouched
    expect((updated.layout as any).elements).toEqual([]);
  });

  it('setting isDefault on update unsets any other default, not itself', async () => {
    const t = await createEstimateTemplate(tenant.company.id, { name: `Becomes Default ${suffix}`, ...dims, layout: validLayout }, userId);
    createdIds.push(t.id);

    const updated = await updateEstimateTemplate(tenant.company.id, t.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);

    const defaults = await prisma.estimateTemplate.findMany({ where: { companyId: tenant.company.id, isDefault: true } });
    expect(defaults.map((d) => d.id)).toEqual([t.id]);
  });

  it('throws for an unknown template id on update', async () => {
    await expect(updateEstimateTemplate(tenant.company.id, 'nonexistent-id', { name: 'x' })).rejects.toThrow('Estimate template not found');
  });

  it('lists templates with the default first', async () => {
    const list = await listEstimateTemplates(tenant.company.id);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].isDefault).toBe(true);
  });
});
