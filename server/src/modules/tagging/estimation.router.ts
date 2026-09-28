import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { searchTags } from './tagging.service';
import * as svc from './estimation.service';
import * as templateSvc from './estimateTemplate.service';

// Deliberately its own router/permission set (estimation:view / estimation:manage), not layered on
// top of tag:view/tag:create — Estimation is meant to be assignable to a role (e.g. sales staff)
// independently of Tagging/Inventory access, so even the tag lookup used to find a piece to quote
// lives here rather than reusing tagging.router.ts's tag-search endpoint.
export const estimationRouter = Router();
estimationRouter.use(authenticate, resolveTenantContext);

estimationRouter.get('/tags/search', requirePermission('estimation:view'), async (req: Request, res: Response) => {
  const tags = await searchTags(req.tenant!, req.query.q as string ?? '', undefined, (req.query.status as string | undefined) ?? 'ALL');
  res.json({ success: true, data: tags });
});

// Staff picker for "Send to billing"'s sales-employee field. Lives here (estimation:view) because an estimator
// need not hold invoice:create, which /sales/staff requires. `id` is the User id, as SalesInvoice.salesPersonId expects.
estimationRouter.get('/staff', requirePermission('estimation:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listSalesStaff(req.tenant!) });
});

estimationRouter.get('/tags/:tagId',requirePermission('estimation:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getTagForEstimation(req.tenant!, req.params.tagId) });
});

estimationRouter.get('/tags/:tagId/estimates', requirePermission('estimation:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listTagEstimatesForTag(req.tenant!, req.params.tagId) });
});

estimationRouter.post('/tags/:tagId/estimates', requirePermission('estimation:manage'), async (req: Request, res: Response) => {
  const estimate = await svc.createTagEstimate(req.params.tagId, req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: estimate });
});

// Hand a saved estimate to the billing counter (optionally with the customer's name/phone so the biller can find it).
estimationRouter.post('/estimates/:id/send-to-billing', requirePermission('estimation:manage'), async (req: Request, res: Response) => {
  const estimate = await svc.sendEstimateToBilling(req.tenant!, req.params.id, req.body ?? {}, req.user!.userId);
  res.json({ success: true, data: estimate });
});

estimationRouter.get('/estimates/:id', requirePermission('estimation:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getTagEstimate(req.tenant!, req.params.id) });
});

// ─── Estimate Templates (drag-and-drop print designer) ───────────────────────
// Read (estimateTemplate:view) is separate from write (estimateTemplate:create/edit) — printing an
// estimate only needs to read the templates list to find the default one, so sales/counter roles
// that never touch the designer itself can still print without also getting edit rights on it.

estimationRouter.get('/templates', requirePermission('estimateTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await templateSvc.listEstimateTemplates(req.tenant!.companyId) });
});

estimationRouter.get('/templates/:id', requirePermission('estimateTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await templateSvc.getEstimateTemplateById(req.tenant!.companyId, req.params.id) });
});

estimationRouter.post('/templates', requirePermission('estimateTemplate:create'), async (req: Request, res: Response) => {
  const template = await templateSvc.createEstimateTemplate(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: template });
});

estimationRouter.put('/templates/:id', requirePermission('estimateTemplate:edit'), async (req: Request, res: Response) => {
  const template = await templateSvc.updateEstimateTemplate(req.tenant!.companyId, req.params.id, req.body);
  res.json({ success: true, data: template });
});
