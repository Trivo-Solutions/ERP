import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { resolveTenantContext } from '../../middleware/tenant';
import { qs, qsNum } from '../../shared/query';
import { parseDate } from '../../shared/parseDate';
import { prisma } from '../../config/database';
import * as designService from './design.service';
import { tenantQuery } from '../../shared/tenantContext';

export const designRouter = Router();
designRouter.use(authenticate, resolveTenantContext);

const designSchema = z.object({
  name: z.string().min(2),
  categoryId: z.string().cuid(),
  metalKarat: z.enum(['24K', '22K', '18K', '14K', 'SILVER', 'PT']),
  grossWeightMin: z.number().positive(),
  grossWeightMax: z.number().positive(),
  netWeightMin: z.number().positive(),
  netWeightMax: z.number().positive(),
  description: z.string().optional(),
  designCode: z.string().optional(),
});

// ── Static routes MUST come before /:id to avoid Express matching "rates" as an ID ──
// This is the LIVE daily metal-rate entry point (mounted here for historical reasons — see
// design.service.ts's own comment) — resolveMetalRate (used by createInvoice/
// createTagFromGrnItem/createOldGoldExchange) is not dormant, even though the rest of this
// router (designs/BOM/cost-estimates) is.

designRouter.post('/rates', requirePermission('system:config'), async (req: Request, res: Response) => {
  const rate = await designService.upsertMetalRate(req.tenant!.companyId, req.body);
  res.json({ success: true, data: rate });
});

// Rate sheet for ONE date — every active purity with that date's saved rate (editable in one go).
designRouter.get('/rates/sheet', requirePermission('design:view'), async (req: Request, res: Response) => {
  const rows = await designService.getRateSheet(req.tenant!.companyId, parseDate(req.query.date, 'Date'));
  res.json({ success: true, data: rows });
});

// Saves several purities' rates for one date atomically (same rows POST /rates writes).
designRouter.post('/rates/batch', requirePermission('system:config'), async (req: Request, res: Response) => {
  const saved = await designService.saveRateSheet(
    req.tenant!.companyId, parseDate(req.body.date, 'Date'), req.body.rates, typeof req.body.source === 'string' ? req.body.source : undefined,
  );
  res.json({ success: true, data: saved });
});

designRouter.get('/rates/latest', requirePermission('design:view'), async (req: Request, res: Response) => {
  const rates = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.metalRate.findMany({
    where: { companyId: req.tenant!.companyId, date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    orderBy: [{ karat: 'asc' }, { date: 'desc' }],
  }));
  res.json({ success: true, data: rates });
});

// ── Collection routes ──

designRouter.get('/', requirePermission('design:view'), async (req: Request, res: Response) => {
  const result = await designService.listDesigns(req.tenant!.companyId, {
    status: qs(req, 'status'),
    categoryId: qs(req, 'categoryId'),
    search: qs(req, 'search'),
    page: qsNum(req, 'page', 1),
    limit: qsNum(req, 'limit', 20),
  });
  res.json({ success: true, ...result });
});

designRouter.post(
  '/',
  requirePermission('design:create'),
  validate(designSchema),
  async (req: Request, res: Response) => {
    const design = await designService.createDesign(req.body, req.tenant!.companyId, req.user!.userId);
    res.status(201).json({ success: true, data: design });
  }
);

// ── Dynamic :id routes ──

designRouter.get('/:id', requirePermission('design:view'), async (req: Request, res: Response) => {
  const design = await designService.getDesignById(req.tenant!.companyId, req.params.id);
  res.json({ success: true, data: design });
});

designRouter.patch('/:id', requirePermission('design:edit'), async (req: Request, res: Response) => {
  const design = await designService.updateDesign(req.params.id, req.body, req.tenant!.companyId, req.user!.userId);
  res.json({ success: true, data: design });
});

designRouter.put('/:id/bom', requirePermission('bom:manage'), async (req: Request, res: Response) => {
  const { items, processes } = req.body;
  await designService.saveBom(req.params.id, items, processes, req.tenant!.companyId, req.user!.userId);
  res.json({ success: true, message: 'BOM saved' });
});

designRouter.post('/:id/estimate', requirePermission('cost:estimate'), async (req: Request, res: Response) => {
  const estimate = await designService.generateCostEstimate(req.params.id, req.tenant!, qs(req, 'currency'));
  res.json({ success: true, data: estimate });
});
