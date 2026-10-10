import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission, requireAnyPermission } from '../../middleware/rbac';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import * as svc from './paymentConfig.service';

// Payment Configuration - provider master, branch availability, POS terminals. The company always comes from the
// authenticated tenant context, never from the body; every foreign id is ownership-checked in the service.
export const paymentConfigRouter = Router();
paymentConfigRouter.use(authenticate, resolveTenantContext);

const q = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const flag = (v: unknown): boolean | undefined => {
  if (v === undefined || v === '') return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new AppError('active must be true or false', 400);
};

// What a collection screen may offer at one branch. Anyone who can take or see a payment may read it; the server
// re-validates every chosen id on save, so this list is a convenience, not the control.
paymentConfigRouter.get('/options', requireAnyPermission('payment:create', 'payment:view', 'paymentConfig:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getCollectionOptions(req.tenant!, q(req.query.branchId) as string) });
});

paymentConfigRouter.get('/providers', requirePermission('paymentConfig:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listProviders(req.tenant!, { q: q(req.query.q), active: flag(req.query.active) }) });
});
paymentConfigRouter.post('/providers', rejectClientTenantSelectors, requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  res.status(201).json({ success: true, data: await svc.createProvider(req.tenant!, req.body ?? {}) });
});
paymentConfigRouter.patch('/providers/:id', rejectClientTenantSelectors, requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.updateProvider(req.tenant!, req.params.id, req.body ?? {}) });
});

paymentConfigRouter.get('/branch-providers', requirePermission('paymentConfig:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listBranchProviders(req.tenant!, q(req.query.branchId)) });
});
paymentConfigRouter.post('/branch-providers', rejectClientTenantSelectors, requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  res.status(201).json({ success: true, data: await svc.allocateProvider(req.tenant!, b.branchId, b.providerId) });
});
paymentConfigRouter.delete('/branch-providers/:branchId/:providerId', requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  await svc.removeAllocation(req.tenant!, req.params.branchId, req.params.providerId);
  res.json({ success: true, message: 'Provider removed from branch' });
});

paymentConfigRouter.get('/terminals', requirePermission('paymentConfig:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listTerminals(req.tenant!, { branchId: q(req.query.branchId), providerId: q(req.query.providerId), active: flag(req.query.active), q: q(req.query.q) }) });
});
paymentConfigRouter.post('/terminals', rejectClientTenantSelectors, requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  res.status(201).json({ success: true, data: await svc.createTerminal(req.tenant!, req.body ?? {}) });
});
paymentConfigRouter.patch('/terminals/:id', rejectClientTenantSelectors, requirePermission('paymentConfig:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.updateTerminal(req.tenant!, req.params.id, req.body ?? {}) });
});
