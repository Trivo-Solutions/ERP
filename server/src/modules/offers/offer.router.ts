import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission, hasPermission } from '../../middleware/rbac';
import { AppError } from '../../middleware/error';
import { resolveTenantContext } from '../../middleware/tenant';
import * as svc from './offer.service';
import * as approvals from './offerApproval.service';

// Offer management. Defining offers is gated by offer:*; the read-only "what would this tag cost on this date"
// resolution is gated by estimation:view — the estimator/biller who needs it need not be allowed to edit offers.
export const offerRouter = Router();
offerRouter.use(authenticate, resolveTenantContext);

offerRouter.get('/', requirePermission('offer:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listOffers(req.tenant!, { status: req.query.status as string | undefined }) });
});

// Registered before '/:id' so "resolve" is not read as an offer id. Read by the Estimation page and by the New Sale screen,
// so either permission is enough (requirePermission is all-of): neither caller needs offer:view.
const canResolve = (req: Request, _res: Response, next: () => void) => {
  const perms = req.user?.permissions ?? [];
  if (!hasPermission(perms, 'estimation:view') && !hasPermission(perms, 'invoice:create')) {
    throw new AppError('Access denied. Required: estimation:view or invoice:create', 403);
  }
  next();
};
offerRouter.get('/resolve', canResolve, async (req: Request, res: Response) => {
  const tagId = req.query.tagId;
  if (typeof tagId !== 'string' || !tagId) return res.status(400).json({ success: false, error: 'tagId is required' });
  const asOf = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
  res.json({ success: true, data: await svc.resolveOfferForTag(req.tenant!, tagId, asOf) });
});


// ─── below-offer approvals (step 3) ──────────────────────────────────────────
// Anyone who can bill may ask (invoice:create, or invoice:edit when amending); only discount:approve decides, and never
// their own request. A non-approver sees only their own requests. Registered before '/:id'.
const canRequest = (req: Request, _res: Response, next: () => void) => {
  const perms = req.user?.permissions ?? [];
  if (!hasPermission(perms, 'invoice:create') && !hasPermission(perms, 'invoice:edit') && !hasPermission(perms, 'discount:approve')) {
    throw new AppError('Access denied. Required: invoice:create, invoice:edit or discount:approve', 403);
  }
  next();
};
const isApprover = (req: Request) => hasPermission(req.user?.permissions ?? [], 'discount:approve');

offerRouter.get('/approvals', canRequest, async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvals.listApprovals(req.tenant!, req.user!.userId, isApprover(req), {
    status: req.query.status as string | undefined, mine: req.query.mine === 'true',
    estimateId: typeof req.query.estimateId === 'string' ? req.query.estimateId : undefined,
  }) });
});

offerRouter.post('/approvals', canRequest, async (req: Request, res: Response) => {
  res.status(201).json({ success: true, data: await approvals.requestApproval(req.tenant!, req.body, req.user!.userId) });
});

offerRouter.get('/approvals/:id', canRequest, async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvals.getApproval(req.tenant!, req.params.id, req.user!.userId, isApprover(req)) });
});

offerRouter.post('/approvals/:id/approve', requirePermission('discount:approve'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvals.decideApproval(req.tenant!, req.params.id, req.user!.userId, 'APPROVE', req.body?.note) });
});

offerRouter.post('/approvals/:id/reject', requirePermission('discount:approve'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvals.decideApproval(req.tenant!, req.params.id, req.user!.userId, 'REJECT', req.body?.note) });
});

offerRouter.post('/approvals/:id/cancel', canRequest, async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvals.cancelApproval(req.tenant!, req.params.id, req.user!.userId) });
});

offerRouter.get('/:id', requirePermission('offer:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getOffer(req.tenant!, req.params.id) });
});

offerRouter.post('/', requirePermission('offer:create'), async (req: Request, res: Response) => {
  res.status(201).json({ success: true, data: await svc.createOffer(req.tenant!, req.body, req.user!.userId) });
});

offerRouter.put('/:id', requirePermission('offer:edit'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.updateOffer(req.tenant!, req.params.id, req.body, req.user!.userId) });
});

offerRouter.post('/:id/activate', requirePermission('offer:edit'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.setOfferActive(req.tenant!, req.params.id, true, req.user!.userId) });
});

offerRouter.post('/:id/deactivate', requirePermission('offer:edit'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.setOfferActive(req.tenant!, req.params.id, false, req.user!.userId) });
});

offerRouter.delete('/:id', requirePermission('offer:delete'), async (req: Request, res: Response) => {
  await svc.deleteOffer(req.tenant!, req.params.id, req.user!.userId);
  res.json({ success: true });
});
