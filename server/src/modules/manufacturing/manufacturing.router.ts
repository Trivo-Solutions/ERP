import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { qs, qsNum } from '../../shared/query';
import { prisma } from '../../config/database';
import * as svc from './manufacturing.service';
import { tenantQuery } from '../../shared/tenantContext';

export const manufacturingRouter = Router();
manufacturingRouter.use(authenticate, resolveTenantContext);

manufacturingRouter.get('/floor', requirePermission('job:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getFactoryFloorStatus(req.tenant!.companyId) });
});

manufacturingRouter.get('/jobs', requirePermission('job:view'), async (req: Request, res: Response) => {
  const result = await svc.listJobCards(req.tenant!.companyId, {
    status: qs(req, 'status'),
    designId: qs(req, 'designId'),
    orderId: qs(req, 'orderId'),
    priority: qs(req, 'priority'),
    page: qsNum(req, 'page', 1),
    limit: qsNum(req, 'limit', 20),
  });
  res.json({ success: true, ...result });
});

manufacturingRouter.get('/jobs/:id', requirePermission('job:view'), async (req: Request, res: Response) => {
  const jc = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.jobCard.findUnique({
    where: { id: req.params.id },
    include: {
      design: { include: { bomProcesses: true } },
      order: { include: { client: true } },
      processes: { orderBy: { sequence: 'asc' } },
      wipTracking: { include: { worker: { select: { name: true } } }, orderBy: { timestamp: 'desc' } },
      qcCheckpoints: { include: { inspector: { select: { name: true } } } },
    },
  }));
  if (!jc || jc.companyId !== req.tenant!.companyId) throw new AppError('Job card not found', 404);
  res.json({ success: true, data: jc });
});

manufacturingRouter.post('/jobs', requirePermission('job:create'), async (req: Request, res: Response) => {
  const jc = await svc.createJobCard(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: jc });
});

manufacturingRouter.post('/jobs/:id/wip', requirePermission('wip:update'), async (req: Request, res: Response) => {
  const result = await svc.recordWipEntry(
    { jobCardId: req.params.id, ...req.body },
    req.tenant!, req.user!.userId
  );
  res.json({ success: true, data: result });
});

manufacturingRouter.post('/jobs/:id/advance', requirePermission('job:update'), async (req: Request, res: Response) => {
  await svc.advanceProcess(req.params.id, req.body.processId, req.tenant!, req.user!.userId);
  res.json({ success: true, message: 'Process advanced' });
});

manufacturingRouter.post('/jobs/:id/qc', requirePermission('qc:inspect'), async (req: Request, res: Response) => {
  const qc = await svc.submitQcCheckpoint(
    { jobCardId: req.params.id, inspectorId: req.user!.userId, ...req.body },
    req.tenant!, req.user!.userId
  );
  res.json({ success: true, data: qc });
});
