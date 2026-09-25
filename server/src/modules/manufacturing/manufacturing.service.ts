import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { emit } from '../../shared/websocket';
import { nextDocumentNumber } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { assertOwnedByCompany } from '../../middleware/tenant';

const PROCESS_SEQUENCE = [
  'MELTING', 'CASTING', 'FILING', 'PRE_POLISH', 'SETTING', 'POLISH', 'RHODIUM',
];

export async function createJobCard(data: {
  orderId?: string; orderItemId?: string; designId: string;
  batchSize?: number; jobType?: string; issuedWeight: number;
  priority?: string; notes?: string;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('design', data.designId, ctx.companyId, 'Design');
  if (data.orderId) await assertOwnedByCompany('salesOrder', data.orderId, ctx.companyId, 'Sales order');
  const barcodeData = `JC-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  const design = await tenantQuery(ctx.companyId, (_tx) => _tx.design.findUniqueOrThrow({
    where: { id: data.designId }, include: { bomProcesses: { orderBy: { sequence: 'asc' } } },
  }));

  const jobCard = await tenantTransaction(ctx.companyId, async (tx) => {
    const jobNumber = await nextDocumentNumber(ctx.companyId, 'JC', 'JC', tx);
    const jc = await tx.jobCard.create({
      data: {
        companyId: ctx.companyId,
        jobNumber, designId: data.designId,
        orderId: data.orderId, orderItemId: data.orderItemId,
        batchSize: data.batchSize ?? 1,
        jobType: data.jobType ?? 'PRODUCTION',
        issuedWeight: data.issuedWeight,
        priority: data.priority ?? 'NORMAL',
        notes: data.notes, barcodeData,
        currentProcess: PROCESS_SEQUENCE[0],
        status: 'IN_PROGRESS',
        processes: {
          createMany: {
            data: design.bomProcesses.map((p) => ({
              companyId: ctx.companyId,
              processName: p.processName, sequence: p.sequence,
              status: p.sequence === 1 ? 'IN_PROGRESS' : 'PENDING',
            })),
          },
        },
      },
      include: { design: true, processes: { orderBy: { sequence: 'asc' } } },
    });

    // Update order item status if linked
    if (data.orderItemId) {
      await tx.orderItem.update({ where: { id: data.orderItemId }, data: { status: 'IN_PRODUCTION' } });
    }
    if (data.orderId) {
      await tx.salesOrder.update({ where: { id: data.orderId }, data: { status: 'IN_PRODUCTION' } });
    }

    return jc;
  });

  await createAuditEntry('job_cards', jobCard.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  emit.jobCardUpdate(jobCard.id, { status: 'CREATED', jobNumber: jobCard.jobNumber }, ctx.companyId);
  return jobCard;
}

export async function recordWipEntry(data: {
  jobCardId: string; processId: string; workerId: string;
  issuedWeight: number; returnedWeight: number; scrapWeight: number;
  scaleReading?: number; deviceId?: string;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('jobCard', data.jobCardId, ctx.companyId, 'Job card');
  const process = await tenantQuery(ctx.companyId, (_tx) => _tx.jobProcess.findUniqueOrThrow({ where: { id: data.processId } }));
  const tolerance = await tenantQuery(ctx.companyId, (_tx) => _tx.processTolerance.findUnique({
    where: { companyId_processName: { companyId: ctx.companyId, processName: process.processName } },
  }));

  const lossWeight = data.issuedWeight - data.returnedWeight - data.scrapWeight;
  const lossPercent = (lossWeight / data.issuedWeight) * 100;

  // Check against tolerance
  const maxLoss = tolerance ? Number(tolerance.maxLossPercent) : 5;
  const exceedsThreshold = lossPercent > maxLoss;

  const entry = await tenantTransaction(ctx.companyId, async (tx) => {
    const wip = await tx.wipTracking.create({
      data: { ...data, companyId: ctx.companyId, lossWeight, lossPercent },
    });

    await tx.jobProcess.update({
      where: { id: data.processId },
      data: { returnedWeight: data.returnedWeight, lossWeight, lossPercent },
    });

    await tx.jobCard.update({
      where: { id: data.jobCardId },
      data: { scrapWeight: { increment: data.scrapWeight } },
    });

    return wip;
  });

  if (exceedsThreshold) {
    // Emit alert for excess loss
    emit.stockAlert(data.jobCardId, `⚠️ Excess loss ${lossPercent.toFixed(2)}% on process ${process.processName} (max ${maxLoss}%)`, ctx.companyId);
  }

  emit.jobCardUpdate(data.jobCardId, { type: 'wip', processId: data.processId, lossPercent }, ctx.companyId);
  return { entry, lossPercent, exceedsThreshold };
}

export async function advanceProcess(jobCardId: string, processId: string, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('jobCard', jobCardId, ctx.companyId, 'Job card');
  const jobCard = await tenantQuery(ctx.companyId, (_tx) => _tx.jobCard.findUniqueOrThrow({
    where: { id: jobCardId }, include: { processes: { orderBy: { sequence: 'asc' } } },
  }));

  const currentProcess = jobCard.processes.find((p) => p.id === processId);
  if (!currentProcess) throw new AppError('Process not found on this job card', 404);

  const nextProcess = jobCard.processes.find((p) => p.sequence === currentProcess.sequence + 1);

  await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.jobProcess.update({
      where: { id: processId },
      data: { status: 'COMPLETED', endTime: new Date() },
    });

    if (nextProcess) {
      await tx.jobProcess.update({
        where: { id: nextProcess.id },
        data: { status: 'IN_PROGRESS', startTime: new Date() },
      });
      await tx.jobCard.update({
        where: { id: jobCardId }, data: { currentProcess: nextProcess.processName },
      });
    } else {
      await tx.jobCard.update({
        where: { id: jobCardId }, data: { status: 'QC_PENDING', currentProcess: 'QC' },
      });
    }
  });

  emit.jobCardUpdate(jobCardId, { type: 'process-advance', currentProcess: nextProcess?.processName ?? 'QC' }, ctx.companyId);
}

export async function submitQcCheckpoint(data: {
  jobCardId: string; processId: string; inspectorId: string;
  result: 'PASSED' | 'FAILED' | 'CONDITIONAL';
  checklistData?: any; defects?: any; stoneCount?: number; stoneSecure?: boolean; notes?: string;
}, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('jobCard', data.jobCardId, ctx.companyId, 'Job card');
  const qc = await tenantTransaction(ctx.companyId, async (tx) => {
    const checkpoint = await tx.qcCheckpoint.create({ data: { ...data, companyId: ctx.companyId } });

    if (data.result === 'PASSED') {
      await tx.jobCard.update({
        where: { id: data.jobCardId },
        data: { status: 'QC_PASSED' },
      });
    } else if (data.result === 'FAILED') {
      await tx.jobCard.update({
        where: { id: data.jobCardId },
        data: { status: 'REJECTED' },
      });
    }

    return checkpoint;
  });

  await createAuditEntry('qc_checkpoints', qc.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  emit.jobCardUpdate(data.jobCardId, { type: 'qc', result: data.result }, ctx.companyId);
  return qc;
}

export async function listJobCards(companyId: string, filters: {
  status?: string; designId?: string; orderId?: string;
  priority?: string; page?: number; limit?: number;
}) {
  const { status, designId, orderId, priority, page = 1, limit = 20 } = filters;
  const where = {
    companyId,
    ...(status && { status }),
    ...(designId && { designId }),
    ...(orderId && { orderId }),
    ...(priority && { priority }),
  };
  const [jobCards, total] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.jobCard.findMany({
      where,
      include: {
        design: { select: { name: true, designCode: true, metalKarat: true } },
        processes: { orderBy: { sequence: 'asc' } },
        order: { select: { orderNumber: true, client: { select: { name: true } } } },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    })),
    tenantQuery(companyId, (_tx) => _tx.jobCard.count({ where })),
  ]);
  return { jobCards, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getFactoryFloorStatus(companyId: string) {
  const [inProgress, qcPending, completed, urgent] = await Promise.all([
    tenantQuery(companyId, (_tx) => _tx.jobCard.count({ where: { companyId, status: 'IN_PROGRESS' } })),
    tenantQuery(companyId, (_tx) => _tx.jobCard.count({ where: { companyId, status: 'QC_PENDING' } })),
    tenantQuery(companyId, (_tx) => _tx.jobCard.count({ where: { companyId, status: 'QC_PASSED', completedAt: { gte: new Date(Date.now() - 86400000) } } })),
    tenantQuery(companyId, (_tx) => _tx.jobCard.count({ where: { companyId, priority: 'URGENT', status: { not: 'COMPLETED' } } })),
  ]);

  const processSummary = await tenantQuery(companyId, (_tx) => _tx.jobProcess.groupBy({
    by: ['processName', 'status'],
    _count: true,
    where: { companyId, jobCard: { status: 'IN_PROGRESS' } },
  }));

  return { inProgress, qcPending, completed, urgent, processSummary };
}
