import { prisma } from '../../config/database';
import { createAuditEntry } from '../../middleware/audit';
import { nextSimpleCode, nextDocumentNumber } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';

export async function issueToArtisan(data: {
  artisanId: string; metalType: string; karat: string; issuedWeight: number;
  jobCardRef?: string; notes?: string;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('artisan', data.artisanId, ctx.companyId, 'Artisan');
  const artisan = await tenantQuery(ctx.companyId, (_tx) => _tx.artisan.findUniqueOrThrow({ where: { id: data.artisanId } }));

  const entry = await tenantTransaction(ctx.companyId, async (tx) => {
    const newBalance = Number(artisan.metalBalance) + data.issuedWeight;
    await tx.artisan.update({ where: { id: data.artisanId }, data: { metalBalance: newBalance } });

    return tx.karigarLedger.create({
      data: {
        companyId: ctx.companyId,
        artisanId: data.artisanId,
        date: new Date(),
        transactionType: 'ISSUE',
        metalType: data.metalType,
        karat: data.karat,
        issuedWeight: data.issuedWeight,
        balanceAfter: newBalance,
        jobCardRef: data.jobCardRef,
        issuedById: userId,
        notes: data.notes,
      },
    });
  });

  await createAuditEntry('karigar_ledger', entry.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return entry;
}

export async function returnFromArtisan(data: {
  artisanId: string; metalType: string; karat?: string;
  returnedWeight: number; scrapWeight: number;
  jobCardRef?: string; notes?: string;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('artisan', data.artisanId, ctx.companyId, 'Artisan');
  const artisan = await tenantQuery(ctx.companyId, (_tx) => _tx.artisan.findUniqueOrThrow({ where: { id: data.artisanId } }));
  const lossWeight = Number(artisan.metalBalance) - data.returnedWeight - data.scrapWeight;
  const effectiveIssued = Number(artisan.metalBalance);
  const lossPercent = effectiveIssued > 0 ? (lossWeight / effectiveIssued) * 100 : 0;

  // Check tolerance
  const processEntry = data.jobCardRef
    ? await tenantQuery(ctx.companyId, (_tx) => _tx.jobProcess.findFirst({ where: { jobCardId: data.jobCardRef, companyId: ctx.companyId } }))
    : null;

  const tolerance = processEntry
    ? await tenantQuery(ctx.companyId, (_tx) => _tx.processTolerance.findUnique({
        where: { companyId_processName: { companyId: ctx.companyId, processName: processEntry.processName } },
      }))
    : null;

  const maxLoss = tolerance ? Number(tolerance.maxLossPercent) : 5;
  const excessLossWeight = lossPercent > maxLoss ? (lossWeight - effectiveIssued * (maxLoss / 100)) : 0;
  const deductionRate = tolerance ? Number(tolerance.deductionRate) : 0;
  const laborDeduction = excessLossWeight * deductionRate;

  const entry = await tenantTransaction(ctx.companyId, async (tx) => {
    const newBalance = Number(artisan.metalBalance) - data.returnedWeight - data.scrapWeight;
    await tx.artisan.update({ where: { id: data.artisanId }, data: { metalBalance: Math.max(0, newBalance) } });

    return tx.karigarLedger.create({
      data: {
        companyId: ctx.companyId,
        artisanId: data.artisanId,
        date: new Date(),
        transactionType: 'RETURN_FINISHED',
        metalType: data.metalType,
        karat: data.karat,
        returnedWeight: data.returnedWeight,
        scrapWeight: data.scrapWeight,
        lossWeight,
        lossPercent,
        balanceAfter: Math.max(0, newBalance),
        jobCardRef: data.jobCardRef,
        issuedById: userId,
        notes: data.notes,
      },
    });
  });

  return { entry, lossPercent, excessLossWeight, laborDeduction };
}

export async function getArtisanLedger(ctx: TenantContext, artisanId: string, from?: Date, to?: Date) {
  await assertOwnedByCompany('artisan', artisanId, ctx.companyId, 'Artisan');
  const artisan = await tenantQuery(ctx.companyId, (_tx) => _tx.artisan.findUniqueOrThrow({
    where: { id: artisanId },
    include: {
      ledgerEntries: {
        where: { ...(from && { date: { gte: from } }), ...(to && { date: { lte: to } }) },
        orderBy: { date: 'desc' },
        include: { issuedBy: { select: { name: true } } },
      },
    },
  }));
  return artisan;
}

export async function generateSubcontractorInvoice(data: {
  artisanId: string; periodFrom: Date; periodTo: Date;
  chargeType: string; baseAmount: number; items?: any;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('artisan', data.artisanId, ctx.companyId, 'Artisan');

  // Calculate total deductions from excess losses in period
  const excessLossEntries = await tenantQuery(ctx.companyId, (_tx) => _tx.karigarLedger.findMany({
    where: {
      companyId: ctx.companyId,
      artisanId: data.artisanId,
      date: { gte: data.periodFrom, lte: data.periodTo },
      lossPercent: { gt: 0 },
    },
  }));

  const deductions = 0; // Would calculate based on excess losses vs tolerances

  const netPayable = data.baseAmount - deductions;

  return tenantTransaction(ctx.companyId, async (tx) => {
    const invoiceNumber = await nextDocumentNumber(ctx.companyId, 'SINV', 'SINV', tx);
    return tx.subcontractorInvoice.create({
      data: {
        companyId: ctx.companyId,
        invoiceNumber,
        artisanId: data.artisanId,
        invoiceDate: new Date(),
        periodFrom: data.periodFrom,
        periodTo: data.periodTo,
        chargeType: data.chargeType,
        grossAmount: data.baseAmount,
        deductions,
        netPayable,
        status: 'DRAFT',
        items: data.items,
      },
    });
  });
}

export async function listArtisans(companyId: string, type?: string) {
  return tenantQuery(companyId, (_tx) => _tx.artisan.findMany({
    where: { companyId, isActive: true, ...(type && { type }) },
    include: { _count: { select: { ledgerEntries: true } } },
    orderBy: { name: 'asc' },
  }));
}

export async function createArtisan(data: {
  name: string; type: string; specializations?: string[];
  phone?: string; address?: string; supplierId?: string;
}, ctx: TenantContext) {
  // Layer 2: a linked Supplier (now company-owned, Phase 3) must belong to this company too.
  if (data.supplierId) {
    await assertOwnedByCompany('supplier', data.supplierId, ctx.companyId, 'Supplier');
  }
  return tenantTransaction(ctx.companyId, async (tx) => {
    const artisanCode = await nextSimpleCode(ctx.companyId, 'ARTISAN', 'ART', 4, tx);
    return tx.artisan.create({
      data: {
        companyId: ctx.companyId,
        artisanCode,
        ...data,
        specializations: data.specializations ?? [],
      },
    });
  });
}
