import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// Supplier edit / deactivate / delete over real HTTP: permission gating, cross-company safety,
// dependency rules, and audit entries.
describe('HTTP: supplier administration', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tenants: TestTenant[] = [];
  const supplierIds: string[] = [];

  afterAll(async () => {
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    for (const t of tenants) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  async function tenantWith(tag: string, permissions: string[]) {
    const t = await createTestTenant(`${tag}${suffix}`, permissions);
    tenants.push(t);
    return { t, api: apiWith(tokenFor(t), app) };
  }
  async function makeSupplier(companyId: string, label: string, extra: object = {}) {
    const s = await prisma.supplier.create({
      data: { companyId, supplierCode: `SA-${label}-${suffix}`, name: `Supplier ${label}`, type: 'OTHER', ...extra },
    });
    supplierIds.push(s.id);
    return s.id;
  }

  it('edit: granted succeeds (whitelisted fields only, audited), missing is 403', async () => {
    const { t, api } = await tenantWith('SAE', ['supplier:edit']);
    const id = await makeSupplier(t.company.id, 'e');
    const res = await api.patch(`/procurement/suppliers/${id}`, { name: 'Renamed', city: 'Surat', currentDue: 99999, supplierCode: 'HACK' });
    expect(res.status).toBe(200);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe('Renamed');
    expect(row.city).toBe('Surat');
    expect(Number(row.currentDue)).toBe(0);              // ledger-driven, not editable
    expect(row.supplierCode).toBe(`SA-e-${suffix}`);      // identity, not editable
    const audit = await prisma.auditLog.findFirst({ where: { tableName: 'suppliers', recordId: id, action: 'EDIT' } });
    expect(audit?.companyId).toBe(t.company.id);
    expect(audit?.userId).toBe(t.user.id);

    const no = await tenantWith('SAEN', ['supplier:view']);
    const id2 = await makeSupplier(no.t.company.id, 'e2');
    expect((await no.api.patch(`/procurement/suppliers/${id2}`, { name: 'x' })).status).toBe(403);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: id2 } })).name).toBe('Supplier e2');
  });

  it('cross-company supplier cannot be edited, deactivated or deleted (404, untouched)', async () => {
    const attacker = await tenantWith('SAX', ['supplier:edit', 'supplier:deactivate', 'supplier:delete']);
    const victim = await tenantWith('SAV', []);
    const id = await makeSupplier(victim.t.company.id, 'v');
    expect((await attacker.api.patch(`/procurement/suppliers/${id}`, { name: 'pwned' })).status).toBe(404);
    expect((await attacker.api.post(`/procurement/suppliers/${id}/deactivate`)).status).toBe(404);
    expect((await attacker.api.del(`/procurement/suppliers/${id}`)).status).toBe(404);
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe('Supplier v');
    expect(row.isActive).toBe(true);
  });

  it('nonexistent supplier is a clean 404', async () => {
    const { api } = await tenantWith('SA0', ['supplier:edit', 'supplier:delete']);
    expect((await api.patch('/procurement/suppliers/nope', { name: 'x' })).status).toBe(404);
    expect((await api.del('/procurement/suppliers/nope')).status).toBe(404);
  });

  it('deactivate / reactivate: gated, audited, redundant toggle is 409, hidden from default list', async () => {
    const { t, api } = await tenantWith('SAD', ['supplier:deactivate', 'supplier:view']);
    const id = await makeSupplier(t.company.id, 'd');
    expect((await api.post(`/procurement/suppliers/${id}/reactivate`)).status).toBe(409);
    expect((await api.post(`/procurement/suppliers/${id}/deactivate`)).status).toBe(200);
    expect((await api.post(`/procurement/suppliers/${id}/deactivate`)).status).toBe(409);
    expect((await api.get('/procurement/suppliers')).body.data.map((s: any) => s.id)).not.toContain(id);
    expect((await api.get('/procurement/suppliers?includeInactive=true')).body.data.map((s: any) => s.id)).toContain(id);
    expect((await api.post(`/procurement/suppliers/${id}/reactivate`)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { tableName: 'suppliers', recordId: id, action: { in: ['DEACTIVATE', 'REACTIVATE'] } } })).toBe(2);

    const no = await tenantWith('SADN', ['supplier:edit']);
    const id2 = await makeSupplier(no.t.company.id, 'd2');
    expect((await no.api.post(`/procurement/suppliers/${id2}/deactivate`)).status).toBe(403);
  });

  it('includeInactive is ignored without supplier:deactivate', async () => {
    const { t, api } = await tenantWith('SAI', ['supplier:view']);
    const id = await makeSupplier(t.company.id, 'i', { isActive: false });
    expect((await api.get('/procurement/suppliers?includeInactive=true')).body.data.map((s: any) => s.id)).not.toContain(id);
  });

  it('delete: unused supplier is removed and audited; one with history or a balance is refused (409)', async () => {
    const { t, api } = await tenantWith('SADL', ['supplier:delete']);
    const free = await makeSupplier(t.company.id, 'f');
    expect((await api.del(`/procurement/suppliers/${free}`)).status).toBe(200);
    expect(await prisma.supplier.count({ where: { id: free } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tableName: 'suppliers', recordId: free, action: 'DELETE', companyId: t.company.id } })).toBe(1);

    const owed = await makeSupplier(t.company.id, 'o', { currentDue: 500 });
    const res = await api.del(`/procurement/suppliers/${owed}`);
    expect(res.status).toBe(409);
    expect(await prisma.supplier.count({ where: { id: owed } })).toBe(1);

    const withPo = await makeSupplier(t.company.id, 'p');
    const po = await prisma.purchaseOrder.create({
      data: { companyId: t.company.id, poNumber: `PO-SA-${suffix}`, supplierId: withPo, poType: 'OUTRIGHT', orderDate: new Date() } as any,
    });
    expect((await api.del(`/procurement/suppliers/${withPo}`)).status).toBe(409);
    await prisma.purchaseOrder.delete({ where: { id: po.id } });

    const no = await tenantWith('SADLN', ['supplier:edit']);
    const id2 = await makeSupplier(no.t.company.id, 'x');
    expect((await no.api.del(`/procurement/suppliers/${id2}`)).status).toBe(403);
    expect(await prisma.supplier.count({ where: { id: id2 } })).toBe(1);
  });

  it('a purchase order cannot be raised against an inactive supplier', async () => {
    const { t, api } = await tenantWith('SAP', ['po:create']);
    const id = await makeSupplier(t.company.id, 'ia', { isActive: false });
    const res = await api.post('/procurement/orders', {
      supplierId: id, poType: 'OUTRIGHT', orderDate: new Date().toISOString(),
      items: [{ materialCode: 'X', materialName: 'X', materialType: 'METAL', quantity: 1, weight: 1, unit: 'GM', ratePerUnit: 1 }],
    });
    expect(res.status).toBe(409);
  });

  it('create / view still work through the older po:* permissions, and through supplier:* alone', async () => {
    const legacy = await tenantWith('SAL', ['po:create', 'po:view']);
    expect((await legacy.api.post('/procurement/suppliers', { name: 'Legacy', type: 'OTHER' })).status).toBe(201);
    expect((await legacy.api.get('/procurement/suppliers')).status).toBe(200);
    const modern = await tenantWith('SAM', ['supplier:create', 'supplier:view']);
    const created = await modern.api.post('/procurement/suppliers', { name: 'Modern', type: 'OTHER' });
    expect(created.status).toBe(201);
    supplierIds.push(created.body.data.id);
    const none = await tenantWith('SAZ', ['tag:view']);
    expect((await none.api.post('/procurement/suppliers', { name: 'No', type: 'OTHER' })).status).toBe(403);
    expect((await none.api.get('/procurement/suppliers')).status).toBe(403);
  });
});
