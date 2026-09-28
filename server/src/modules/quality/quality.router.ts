import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { qs } from '../../shared/query';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { resolveTenantContext, assertOwnedByCompany } from '../../middleware/tenant';
import * as svc from './quality.service';
import { tenantQuery } from '../../shared/tenantContext';

export const qualityRouter = Router();
qualityRouter.use(authenticate, resolveTenantContext);

qualityRouter.get('/hallmarking', requirePermission('hallmark:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listHallmarkingBatches(req.tenant!) });
});

qualityRouter.post('/hallmarking', requirePermission('hallmark:manage'), async (req: Request, res: Response) => {
  const batch = await svc.createHallmarkingBatch(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: batch });
});

qualityRouter.patch('/hallmarking/:id/receive', requirePermission('hallmark:manage'), async (req: Request, res: Response) => {
  await svc.receiveHallmarkingBatch(req.params.id, req.body.items, req.tenant!);
  res.json({ success: true, message: 'Batch received and HUIDs recorded' });
});

qualityRouter.get('/repairs', requirePermission('repair:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listRepairJobs(req.tenant!, qs(req, 'status')) });
});

qualityRouter.post('/repairs', requirePermission('repair:create'), async (req: Request, res: Response) => {
  const repair = await svc.createRepairJob(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: repair });
});

qualityRouter.patch('/repairs/:id/status', requirePermission('repair:manage'), async (req: Request, res: Response) => {
  // DELIVERED goes through deliverRepairJob so deliveredDate gets stamped (G1's "out" tracking);
  // any other status is still a plain update, unchanged from before.
  if (req.body.status === 'DELIVERED') {
    const repair = await svc.deliverRepairJob(req.params.id, req.tenant!);
    res.json({ success: true, data: repair });
    return;
  }
  // Layer 2: a Company-B repair id must 404, not let another company's repair status be forced.
  await assertOwnedByCompany('repairJob', req.params.id, req.tenant!.companyId, 'Repair job');
  const repair = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.repairJob.update({
    where: { id: req.params.id }, data: { status: req.body.status },
  }));
  res.json({ success: true, data: repair });
});

qualityRouter.patch('/repairs/:id', requirePermission('repair:edit'), async (req: Request, res: Response) => {
  const repair = await svc.updateRepairJob(req.params.id, req.body, req.tenant!);
  res.json({ success: true, data: repair });
});

qualityRouter.post('/repairs/:id/transactions', requirePermission('repair:manage'), async (req: Request, res: Response) => {
  const txn = await svc.addRepairTransaction(req.params.id, req.body, req.tenant!);
  res.status(201).json({ success: true, data: txn });
});

// G1: "charge" the customer for a repair — creates a real SalesInvoice, so gated the same way
// every other cross-module invoice-creating endpoint is (sales returns, old gold exchange), not
// by a repair permission. See CLAUDE.md's RBAC note: PRODUCTION_MANAGER also needs invoice:create
// for this to be usable end to end.
qualityRouter.post('/repairs/:id/bill', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const repair = await svc.billRepairJob(req.params.id, req.body.branchId, req.tenant!, req.user!.userId);
  res.json({ success: true, data: repair });
});
