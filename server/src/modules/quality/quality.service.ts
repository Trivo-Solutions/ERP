import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { createInvoice } from '../sales/sales.service';
import { nextDocumentNumber } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertOwnedByCompany, assertOwnedIfPresent } from '../../middleware/tenant';

// G2: an item used to require a jobCardId (manufacturing lineage). A purchased finished-goods
// piece has no JobCard (CLAUDE.md §3), so tagId is the bought-in alternative — every item must
// carry at least one of the two, enforced here since the schema only makes each optional, not
// mutually-exclusive-required (same style as every other optional-FK pair in this codebase).
//
// companyId (Phase 2b) is stamped from ctx, same as everywhere else. jobCardId-only items (the
// older manufacturing QC-rework flow — JobCard itself still isn't company-scoped) still get a
// real companyId here: it's the CALLER's company, not derived from the job card.
export async function createHallmarkingBatch(data: {
  centerName: string; sentDate: Date;
  items: Array<{ jobCardId?: string; tagId?: string; karat: string; netWeight: number; inscriptionCode?: string }>;
}, ctx: TenantContext, userId: string) {
  const orphan = data.items.find((i) => !i.jobCardId && !i.tagId);
  if (orphan) {
    throw new AppError('Each hallmarking item needs either a jobCardId or a tagId', 400);
  }

  // Layer 2: any tagId supplied must belong to this company — a Company-B tagId must be
  // indistinguishable from a nonexistent one.
  const tagIds = data.items.map((i) => i.tagId).filter(Boolean) as string[];
  if (tagIds.length > 0) {
    const tags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({ where: { id: { in: tagIds }, companyId: ctx.companyId } }));
    const foundIds = new Set(tags.map((t) => t.id));
    const missing = tagIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);
  }
  // Layer 2: jobCardId is a plain (non-composite) FK, never previously checked — a forged
  // Company-B job card id would otherwise attach silently (Postgres FK checks bypass RLS).
  for (const jobCardId of new Set(data.items.map((i) => i.jobCardId).filter(Boolean) as string[])) {
    await assertOwnedIfPresent('jobCard', jobCardId, ctx.companyId, 'Job card');
  }

  return tenantTransaction(ctx.companyId, async (tx) => {
    const batchNumber = await nextDocumentNumber(ctx.companyId, 'HB', 'HB', tx);
    return tx.hallmarkingBatch.create({
      data: {
        companyId: ctx.companyId,
        batchNumber, centerName: data.centerName, sentDate: data.sentDate,
        itemCount: data.items.length,
        items: { createMany: { data: data.items } },
      },
      include: {
        items: { include: { jobCard: { select: { jobNumber: true } }, tag: { select: { tagNumber: true } } } },
      },
    });
  });
}

export async function receiveHallmarkingBatch(batchId: string, items: Array<{
  id: string; huid: string; bisStamp?: string; isVerified?: boolean;
}>, ctx: TenantContext) {
  await assertOwnedByCompany('hallmarkingBatch', batchId, ctx.companyId, 'Hallmarking batch');

  return tenantTransaction(ctx.companyId, async (tx) => {
    await tx.hallmarkingBatch.update({
      where: { id: batchId },
      data: { status: 'RECEIVED', returnDate: new Date() },
    });

    for (const item of items) {
      // Layer 2: the item being updated must belong to this batch, which was already proven to
      // belong to this company above — an id from a different batch/company can't be smuggled
      // through the items array.
      await tx.hallmarkingItem.updateMany({
        where: { id: item.id, batchId },
        data: { huid: item.huid, bisStamp: item.bisStamp, isVerified: item.isVerified ?? true },
      });
    }
  });
}

export async function createRepairJob(data: {
  originalJobCardId?: string; clientId?: string; tagId?: string;
  repairType: string; returnReason: string; clientName?: string;
  repairCost?: number; estimatedDays?: number; notes?: string;
}, ctx: TenantContext, userId: string) {
  // Layer 2: any clientId/tagId/originalJobCardId supplied must belong to this company.
  // originalJobCardId is a plain (non-composite) FK, never previously checked.
  if (data.clientId) {
    await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  }
  if (data.tagId) {
    await assertOwnedByCompany('jewelryTag', data.tagId, ctx.companyId, 'Tag');
  }
  await assertOwnedIfPresent('jobCard', data.originalJobCardId, ctx.companyId, 'Job card');

  return tenantTransaction(ctx.companyId, async (tx) => {
    const repairNumber = await nextDocumentNumber(ctx.companyId, 'REP', 'REP', tx);
    return tx.repairJob.create({
      data: { companyId: ctx.companyId, repairNumber, ...data, status: 'RECEIVED' },
    });
  });
}

// G1: cost/client/tag are often not all known at intake (e.g. cost is quoted after inspection) —
// this lets them be filled in before delivery/billing rather than forcing them at creation.
export async function updateRepairJob(id: string, data: {
  clientId?: string; tagId?: string; repairCost?: number; estimatedDays?: number; notes?: string;
}, ctx: TenantContext) {
  await assertOwnedByCompany('repairJob', id, ctx.companyId, 'Repair job');
  if (data.clientId) {
    await assertOwnedByCompany('client', data.clientId, ctx.companyId, 'Client');
  }
  if (data.tagId) {
    await assertOwnedByCompany('jewelryTag', data.tagId, ctx.companyId, 'Tag');
  }
  return tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.update({ where: { id }, data }));
}

// G1: explicit "out" — deliverRepairJob (rather than a blind status PATCH) stamps deliveredDate,
// giving in/out tracking beyond the generic status string.
export async function deliverRepairJob(id: string, ctx: TenantContext) {
  await assertOwnedByCompany('repairJob', id, ctx.companyId, 'Repair job');
  const repair = await tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.findUniqueOrThrow({ where: { id } }));
  if (repair.status === 'DELIVERED') throw new AppError('Repair job already delivered', 400);

  return tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.update({
    where: { id }, data: { status: 'DELIVERED', deliveredDate: new Date() },
  }));
}

// G1: "charge" — bills the customer for a repair via the same createInvoice() every other sale
// goes through (one free-text FIXED-rate line; a repair charge isn't a physical tagged item, so
// it never touches inventory or a tag's status). invoiceId (unique) makes this idempotent — a
// repair already billed against a STILL-LIVE invoice can't be billed again.
// J3.5 Finding 2: the guard used to be "invoiceId is set", full stop — which meant voiding a
// mistaken repair bill (Invoice Void, J3.3) left the repair permanently unbillable (invoiceId
// stayed set, pointing at a dead invoice, and nothing ever re-checked its status). It now checks
// whether the LINKED invoice is still live: null invoiceId -> unbilled; invoiceId pointing at a
// non-VOID invoice -> already billed, blocked; invoiceId pointing at a VOID invoice -> eligible to
// bill again. The old (voided) invoice is never deleted or unlinked from history — it stays fully
// queryable by its own id, and RECEIVE its own audit trail — REBILL's audit entry below is what
// records "this repair moved from voided invoice X to new invoice Y", not a schema change.
// branchId: RepairJob itself carries no branch yet (not in the multi-tenant prototype's model
// set) — billing still needs one, since SalesInvoice.branchId is now required and never
// inferred (see the multi-tenant blueprint's §7/§13 reasoning), so the caller supplies which
// branch this repair is being billed from. ctx.companyId/branchAccess are validated by
// createInvoice() itself (assertBranchAccessible), same as any other invoice.
export async function billRepairJob(id: string, branchId: string, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('repairJob', id, ctx.companyId, 'Repair job');
  const repair = await tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.findUniqueOrThrow({
    where: { id }, include: { invoice: { select: { status: true } } },
  }));
  const previousInvoiceId = repair.invoiceId;
  const previousInvoiceWasVoid = !!repair.invoice && repair.invoice.status === 'VOID';
  if (repair.invoiceId && !previousInvoiceWasVoid) {
    throw new AppError('Repair job already billed', 400);
  }
  if (!repair.clientId) throw new AppError('Repair job has no client to bill', 400);
  if (repair.repairCost == null || Number(repair.repairCost) <= 0) {
    throw new AppError('Repair job has no repair cost to bill', 400);
  }

  const invoice = await createInvoice({
    clientId: repair.clientId, invoiceDate: new Date(), invoiceType: 'REPAIR', branchId,
    items: [{
      productCode: 'REPAIR', description: `Repair charge — ${repair.repairNumber}`,
      quantity: 1, grossWeight: 0, netGoldWeight: 0, rateType: 'FIXED', goldRate: Number(repair.repairCost),
    }],
  }, ctx, userId);

  // The unique invoiceId is reassigned to the new invoice — RepairJob points at whichever invoice is
  // currently the live bill for it, exactly like every other "current state" field on this row; the
  // superseded VOID invoice remains a real, independently queryable SalesInvoice row (never deleted),
  // and the REBILL audit entry below is the durable record of the old -> new link.
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.update({ where: { id }, data: { invoiceId: invoice.id } }));

  await createAuditEntry(
    'repair_jobs', id, userId, previousInvoiceWasVoid ? 'REBILL' : 'BILL',
    previousInvoiceWasVoid ? { invoiceId: previousInvoiceId } : undefined,
    { invoiceId: invoice.id },
    ctx.companyId,
  );

  return updated;
}

export async function addRepairTransaction(repairJobId: string, data: {
  type: string; weight?: number; pieces?: number; costValue?: number; notes?: string;
}, ctx: TenantContext) {
  await assertOwnedByCompany('repairJob', repairJobId, ctx.companyId, 'Repair job');

  return tenantTransaction(ctx.companyId, async (tx) => {
    const txn = await tx.repairTransaction.create({
      data: { companyId: ctx.companyId, repairJobId, ...data },
    });

    if (data.type === 'METAL_ADDITION' && data.weight) {
      await tx.repairJob.update({
        where: { id: repairJobId },
        data: { additionalMetal: { increment: data.weight } },
      });
    } else if (data.type === 'SCRAP_RECOVERY' && data.weight) {
      await tx.repairJob.update({
        where: { id: repairJobId },
        data: { metalRecovered: { increment: data.weight } },
      });
    }

    return txn;
  });
}

export async function listHallmarkingBatches(ctx: TenantContext) {
  return tenantQuery(ctx.companyId, (_tx) => _tx.hallmarkingBatch.findMany({
    where: { companyId: ctx.companyId },
    include: { _count: { select: { items: true } } },
    orderBy: { sentDate: 'desc' },
    take: 50,
  }));
}

export async function listRepairJobs(ctx: TenantContext, status?: string) {
  return tenantQuery(ctx.companyId, (_tx) => _tx.repairJob.findMany({
    where: { companyId: ctx.companyId, ...(status && { status }) },
    include: {
      originalJobCard: { select: { jobNumber: true, design: { select: { name: true } } } },
      client: { select: { id: true, clientCode: true, name: true } },
      tag: { select: { id: true, tagNumber: true, name: true } },
      invoice: { select: { id: true, invoiceNumber: true, status: true } },
      transactions: true,
    },
    orderBy: { createdAt: 'desc' },
  }));
}
