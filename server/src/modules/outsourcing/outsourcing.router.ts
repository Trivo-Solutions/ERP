import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { qs } from '../../shared/query';
import { prisma } from '../../config/database';
import * as svc from './outsourcing.service';
import { tenantQuery } from '../../shared/tenantContext';

export const outsourcingRouter = Router();
outsourcingRouter.use(authenticate, resolveTenantContext);

outsourcingRouter.get('/artisans', requirePermission('karigar:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listArtisans(req.tenant!.companyId, qs(req, 'type')) });
});

outsourcingRouter.post('/artisans', requirePermission('karigar:issue'), async (req: Request, res: Response) => {
  const artisan = await svc.createArtisan(req.body, req.tenant!);
  res.status(201).json({ success: true, data: artisan });
});

outsourcingRouter.get('/artisans/:id/ledger', requirePermission('karigar:view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const ledger = await svc.getArtisanLedger(
    req.tenant!,
    req.params.id,
    fromStr ? new Date(fromStr) : undefined,
    toStr ? new Date(toStr) : undefined,
  );
  res.json({ success: true, data: ledger });
});

outsourcingRouter.post('/issue', requirePermission('karigar:issue'), async (req: Request, res: Response) => {
  const entry = await svc.issueToArtisan(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: entry });
});

outsourcingRouter.post('/return', requirePermission('karigar:return'), async (req: Request, res: Response) => {
  const result = await svc.returnFromArtisan(req.body, req.tenant!, req.user!.userId);
  res.json({ success: true, data: result });
});

outsourcingRouter.post('/invoices', requirePermission('subcon:invoice'), async (req: Request, res: Response) => {
  const invoice = await svc.generateSubcontractorInvoice(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: invoice });
});

outsourcingRouter.get('/invoices', requirePermission('subcon:invoice'), async (req: Request, res: Response) => {
  const invoices = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.subcontractorInvoice.findMany({
    where: { companyId: req.tenant!.companyId },
    include: { artisan: { select: { name: true, artisanCode: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  }));
  res.json({ success: true, data: invoices });
});
