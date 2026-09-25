import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import {
  createRepairJob, updateRepairJob, deliverRepairJob, billRepairJob, createHallmarkingBatch,
} from './quality.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// G1: repair job intake extended for the post-pivot "customer brings a piece in to fix" flow —
// an optional real Client/JewelryTag link (on top of the older manufacturing clientName/
// originalJobCardId), explicit in/out dates, and billing via the same createInvoice() every
// other sale goes through.
describe('Repair jobs (G1)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  let tagId: string;
  const repairIds: string[] = [];
  const invoiceIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`REPAIR${suffix}`, ['invoice:create', 'repair:manage']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-REP-${suffix}`, name: 'Repair Test Client', type: 'RETAIL' },
    });
    clientId = client.id;

    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-REP-${suffix}`, companyId: tenant.company.id, branchId, name: 'Repaired Ring',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
        costPrice: 20000, sellingPrice: 25000, createdById: userId,
      },
    });
    tagId = tag.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.repairJob.deleteMany({ where: { id: { in: repairIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  async function makeRepair(overrides: Partial<Parameters<typeof createRepairJob>[0]> = {}) {
    const repair = await createRepairJob({
      repairType: 'CUSTOMER_REPAIR', returnReason: 'Clasp broken', clientId, tagId,
      ...overrides,
    }, tenant.ctx, userId);
    repairIds.push(repair.id);
    return repair;
  }

  it('creates a repair job linked to a real client and tag, independent of any JobCard', async () => {
    const repair = await makeRepair();
    expect(repair.clientId).toBe(clientId);
    expect(repair.tagId).toBe(tagId);
    expect(repair.originalJobCardId).toBeNull();
    expect(repair.status).toBe('RECEIVED');
    expect(repair.receivedDate).toBeInstanceOf(Date);
  });

  it('deliverRepairJob stamps deliveredDate and flips status', async () => {
    const repair = await makeRepair();
    const delivered = await deliverRepairJob(repair.id, tenant.ctx);
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.deliveredDate).toBeInstanceOf(Date);
  });

  it('rejects delivering an already-delivered repair job', async () => {
    const repair = await makeRepair();
    await deliverRepairJob(repair.id, tenant.ctx);
    await expect(deliverRepairJob(repair.id, tenant.ctx)).rejects.toThrow(AppError);
  });

  it('bills a repair job with a client and cost via the normal invoicing path', async () => {
    const repair = await makeRepair();
    await updateRepairJob(repair.id, { repairCost: 1500 }, tenant.ctx);

    const billed = await billRepairJob(repair.id, branchId, tenant.ctx, userId);
    expect(billed.invoiceId).toBeTruthy();
    invoiceIds.push(billed.invoiceId!);

    const invoice = await prisma.salesInvoice.findUniqueOrThrow({
      where: { id: billed.invoiceId! }, include: { items: true },
    });
    expect(invoice.clientId).toBe(clientId);
    expect(Number(invoice.totalAmount)).toBeGreaterThan(0);
    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].tagId).toBeNull(); // repair labor isn't a physical stock item
  });

  it('rejects billing a repair job with no client', async () => {
    const repair = await makeRepair({ clientId: undefined, repairCost: 1000 });
    await expect(billRepairJob(repair.id, branchId, tenant.ctx, userId)).rejects.toThrow(AppError);
  });

  it('rejects billing a repair job with no repair cost set', async () => {
    const repair = await makeRepair();
    await expect(billRepairJob(repair.id, branchId, tenant.ctx, userId)).rejects.toThrow(AppError);
  });

  it('rejects billing the same repair job twice', async () => {
    const repair = await makeRepair();
    await updateRepairJob(repair.id, { repairCost: 800 }, tenant.ctx);
    const billed = await billRepairJob(repair.id, branchId, tenant.ctx, userId);
    invoiceIds.push(billed.invoiceId!);

    await expect(billRepairJob(repair.id, branchId, tenant.ctx, userId)).rejects.toThrow(AppError);
  });
});

// G2: a hallmarking item used to require a jobCardId. tagId is the alternative for purchased
// finished-goods pieces (no JobCard) — at least one of the two is required at the app layer.
describe('createHallmarkingBatch (G2)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let tagId: string;
  const batchIds: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant(`HM${suffix}`, ['hallmark:manage']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-HM-${suffix}`, companyId: tenant.company.id, branchId, name: 'Bought-in Bangle',
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 8, netWeight: 8,
        costPrice: 30000, sellingPrice: 36000, createdById: userId,
      },
    });
    tagId = tag.id;
  });

  afterAll(async () => {
    await prisma.hallmarkingItem.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.hallmarkingBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: tagId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('accepts a tag-only item (no JobCard) for a purchased finished-goods piece', async () => {
    const batch = await createHallmarkingBatch({
      centerName: 'BIS Test Center', sentDate: new Date(),
      items: [{ tagId, karat: '22K', netWeight: 8 }],
    }, tenant.ctx, userId);
    batchIds.push(batch.id);

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].tagId).toBe(tagId);
    expect(batch.items[0].jobCardId).toBeNull();
  });

  it('rejects an item with neither jobCardId nor tagId', async () => {
    await expect(createHallmarkingBatch({
      centerName: 'BIS Test Center', sentDate: new Date(),
      items: [{ karat: '22K', netWeight: 8 }],
    }, tenant.ctx, userId)).rejects.toThrow(AppError);
  });
});
