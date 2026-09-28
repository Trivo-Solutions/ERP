import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { updateClient, setClientActive, deleteClient } from './orders.service';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// J3 Decision 3: deactivate/reactivate is its own action, distinct from client:edit. isActive is no
// longer one of updateClient's writable fields — this is the regression test for that split.
describe('updateClient — isActive is no longer edit-writable (J3 Decision 3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let clientId: string;

  beforeAll(async () => {
    tenant = await createTestTenant(`CE${suffix}`, ['client:edit']);
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-CE-${suffix}`, name: 'Edit Test', type: 'RETAIL' },
    });
    clientId = c.id;
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('silently ignores isActive: false on an ordinary edit — only name/phone/etc. actually change', async () => {
    const updated = await updateClient(clientId, tenant.company.id, { name: 'Edit Test Renamed', isActive: false } as any);
    expect(updated.name).toBe('Edit Test Renamed');
    expect(updated.isActive).toBe(true); // untouched — isActive is not in CLIENT_WRITABLE_KEYS
  });
});

describe('setClientActive — deactivate/reactivate (J3.1)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  const clientIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-DA-${label}-${suffix}`, name: `Client ${label}`, type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`DA${suffix}`, ['client:deactivate']);
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('deactivates an active client and records a real audit before/after', async () => {
    const clientId = await makeClient('deact');
    const updated = await setClientActive(clientId, tenant.company.id, false, tenant.user.id, 'Duplicate record');
    expect(updated.isActive).toBe(false);

    const audit = await prisma.auditLog.findFirst({ where: { recordId: clientId, action: 'DEACTIVATE' } });
    expect(audit).not.toBeNull();
    expect((audit!.oldValues as any).isActive).toBe(true);
    expect((audit!.newValues as any).isActive).toBe(false);
    expect((audit!.newValues as any).reason).toBe('Duplicate record');
  });

  it('reactivates an inactive client and records REACTIVATE', async () => {
    const clientId = await makeClient('react');
    await setClientActive(clientId, tenant.company.id, false, tenant.user.id, undefined);
    const updated = await setClientActive(clientId, tenant.company.id, true, tenant.user.id, undefined);
    expect(updated.isActive).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { recordId: clientId, action: 'REACTIVATE' } });
    expect(audit).not.toBeNull();
  });

  it('rejects deactivating an already-inactive client', async () => {
    const clientId = await makeClient('doubledeact');
    await setClientActive(clientId, tenant.company.id, false, tenant.user.id, undefined);
    await expect(setClientActive(clientId, tenant.company.id, false, tenant.user.id, undefined)).rejects.toThrow(/already inactive/);
  });

  it('rejects reactivating an already-active client', async () => {
    const clientId = await makeClient('doublereact');
    await expect(setClientActive(clientId, tenant.company.id, true, tenant.user.id, undefined)).rejects.toThrow(/already active/);
  });

  it('rejects a cross-company client id (404, indistinguishable from nonexistent)', async () => {
    const other = await createTestTenant(`DAOTHER${suffix}`, ['client:deactivate']);
    try {
      const otherClient = await prisma.client.create({
        data: { companyId: other.company.id, clientCode: `TSTCL-DAX-${suffix}`, name: 'Other co client', type: 'RETAIL' },
      });
      await expect(setClientActive(otherClient.id, tenant.company.id, false, tenant.user.id, undefined)).rejects.toThrow(/not found/i);
      await prisma.client.deleteMany({ where: { id: otherClient.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });
});

describe('deleteClient — administrative hard delete (J3 Decision 4)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  const clientIds: string[] = [];
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];

  async function makeClient(label: string) {
    const c = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-DL-${label}-${suffix}`, name: `Client ${label}`, type: 'RETAIL' },
    });
    clientIds.push(c.id);
    return c.id;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`DL${suffix}`, ['client:delete']);
  });

  afterAll(async () => {
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('permanently deletes a client with zero transaction history, and audits FORCE_DELETE', async () => {
    const clientId = await makeClient('zero');
    const result = await deleteClient(clientId, tenant.ctx, tenant.user.id, 'Created by mistake, never used');
    expect(result).toEqual({ id: clientId, deleted: true });

    const gone = await prisma.client.findUnique({ where: { id: clientId } });
    expect(gone).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { recordId: clientId, action: 'FORCE_DELETE' } });
    expect(audit).not.toBeNull();
    expect((audit!.oldValues as any).name).toBe('Client zero');
    expect((audit!.oldValues as any).reason).toBe('Created by mistake, never used');
  });

  it('rejects deletion when the client has invoice history', async () => {
    const clientId = await makeClient('hasinvoice');
    const branchId = tenant.branch.id;
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId, invoiceNumber: `TSTINV-DL-${suffix}`, clientId,
        invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 100, taxAmount: 0, totalAmount: 100, balanceDue: 100,
      },
    });
    invoiceIds.push(inv.id);

    await expect(deleteClient(clientId, tenant.ctx, tenant.user.id, 'test')).rejects.toThrow(/transaction history/);
    expect(await prisma.client.findUnique({ where: { id: clientId } })).not.toBeNull(); // never touched
  });

  it('rejects deletion when the client has been used as a manufacturer on a JewelryTag', async () => {
    const clientId = await makeClient('manufacturer');
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-DL-${suffix}`, companyId: tenant.company.id, branchId: tenant.branch.id, name: 'Piece',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 1, netWeight: 1, stoneWeight: 0,
        costPrice: 1000, sellingPrice: 1500, createdById: tenant.user.id, manufacturerId: clientId,
      },
    });
    tagIds.push(tag.id);

    await expect(deleteClient(clientId, tenant.ctx, tenant.user.id, 'test')).rejects.toThrow(/transaction history/);
  });

  it('requires a reason', async () => {
    const clientId = await makeClient('noreason');
    await expect(deleteClient(clientId, tenant.ctx, tenant.user.id, '')).rejects.toThrow(/reason is required/);
  });

  // J3.5 Finding 6: the dependency count-check and the delete are two separate statements, so a
  // dependent row created in that narrow window is only caught by the FK layer at delete time, not
  // by the earlier check — deleteClient now translates that into the same clean 409 rather than
  // letting a raw constraint violation surface. A genuine interleaved race is inherently timing-
  // dependent and not reliably reproducible in a test; what IS deterministic, and what this fix's
  // safety net actually depends on, is that a real FK violation against `clients` is recognized by
  // isBlockedByForeignKey (the same helper masters.router.ts/settings.service.ts already use) —
  // proven here directly, independent of timing.
  it('a real FK violation against clients (an active dependency at delete time) is recognized by isBlockedByForeignKey', async () => {
    const clientId = await makeClient('fkcheck');
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id, invoiceNumber: `TSTINV-DL-FK-${suffix}`, clientId,
        invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 100, taxAmount: 0, totalAmount: 100, balanceDue: 100,
      },
    });
    invoiceIds.push(inv.id);

    let caught: unknown;
    try {
      await prisma.client.delete({ where: { id: clientId } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isBlockedByForeignKey(caught)).toBe(true);
    // Nothing was actually removed — the same guarantee deleteClient's own catch relies on.
    expect(await prisma.client.findUnique({ where: { id: clientId } })).not.toBeNull();
  });

  it('rejects a cross-company client id (404, indistinguishable from nonexistent)', async () => {
    const other = await createTestTenant(`DLOTHER${suffix}`, ['client:delete']);
    try {
      const otherClient = await prisma.client.create({
        data: { companyId: other.company.id, clientCode: `TSTCL-DLX-${suffix}`, name: 'Other co client', type: 'RETAIL' },
      });
      await expect(deleteClient(otherClient.id, tenant.ctx, tenant.user.id, 'test')).rejects.toThrow(/not found/i);
      await prisma.client.deleteMany({ where: { id: otherClient.id } });
    } finally {
      await cleanupTestTenant(other);
    }
  });
});
