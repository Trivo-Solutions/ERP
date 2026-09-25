import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { manufacturerForSupplier } from './tagging.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// A tag's Manufacturer is a Client (type MANUFACTURER); a PO is raised on a Supplier. This gives the tag screens
// the Client that matches the PO's supplier — found by GSTIN or name, created once if there is none.
describe('manufacturerForSupplier', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  const supplierIds: string[] = [];

  const mkSupplier = async (extra: Record<string, unknown>) => {
    const s = await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `MS-${supplierIds.length}-${suffix}`, type: 'OTHER', name: 'Ornament House', ...extra },
    });
    supplierIds.push(s.id);
    return s;
  };

  beforeAll(async () => { tenant = await createTestTenant(`MFR${suffix}`, ['tag:create']); });
  afterAll(async () => {
    await prisma.client.deleteMany({ where: { companyId: tenant.company.id } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('creates the manufacturer once, from the supplier\'s own details — and returns the same one after that', async () => {
    const s = await mkSupplier({ gstNumber: '27aaaaa0000a1z5', panNumber: 'AAAAA0000A', phone: '9999900000', city: 'Mumbai', state: 'Maharashtra', contactName: 'R. Shah' });
    const m1 = await manufacturerForSupplier(tenant.ctx, s.id);
    expect(m1.type).toBe('MANUFACTURER');
    expect(m1.name).toBe('Ornament House');
    expect(m1.gstNumber).toBe('27AAAAA0000A1Z5');
    expect([m1.phone, m1.city, m1.contactPerson]).toEqual(['9999900000', 'Mumbai', 'R. Shah']);
    const m2 = await manufacturerForSupplier(tenant.ctx, s.id);
    expect(m2.id).toBe(m1.id);
    expect(await prisma.client.count({ where: { companyId: tenant.company.id, type: 'MANUFACTURER' } })).toBe(1);
  });

  it('reuses an existing manufacturer with the same GSTIN, or failing that the same name (any case)', async () => {
    const existing = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `CL-X-${suffix}`, name: 'Some Trading Name', type: 'MANUFACTURER', gstNumber: '29BBBBB1111B1Z5' },
    });
    const byGst = await mkSupplier({ name: 'Different Name Pvt', gstNumber: '29bbbbb1111b1z5' });
    expect((await manufacturerForSupplier(tenant.ctx, byGst.id)).id).toBe(existing.id);

    const byName = await mkSupplier({ name: 'SOME trading NAME' });
    expect((await manufacturerForSupplier(tenant.ctx, byName.id)).id).toBe(existing.id);
  });

  it('does not treat a customer with the same name as a manufacturer', async () => {
    await prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `CL-C-${suffix}`, name: 'Walk Same Name', type: 'RETAIL' } });
    const s = await mkSupplier({ name: 'Walk Same Name' });
    const m = await manufacturerForSupplier(tenant.ctx, s.id);
    expect(m.type).toBe('MANUFACTURER');
  });

  it("another company's supplier is a 404 and creates nothing", async () => {
    const other = await createTestTenant(`MFRX${suffix}`, ['tag:create']);
    try {
      const foreign = await prisma.supplier.create({
        data: { companyId: other.company.id, supplierCode: `MSX-${suffix}`, type: 'OTHER', name: 'Foreign Supplier' },
      });
      const before = await prisma.client.count({ where: { companyId: tenant.company.id } });
      await expect(manufacturerForSupplier(tenant.ctx, foreign.id)).rejects.toThrow(/not found/i);
      expect(await prisma.client.count({ where: { companyId: tenant.company.id } })).toBe(before);
      await prisma.supplier.deleteMany({ where: { id: foreign.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });
});
