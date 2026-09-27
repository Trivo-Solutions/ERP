import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import * as svc from './tagging.service';
import * as lots from './purchaseLot.service';

export const taggingRouter = Router();
taggingRouter.use(authenticate, resolveTenantContext);

// ─── Branches ────────────────────────────────────────────────────────────────

taggingRouter.get('/branches', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listBranches(req.tenant!.companyId) });
});

// E2: inter-branch stock visibility — one screen for the whole network (this company's network).
taggingRouter.get('/branches/stock-summary', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getBranchStockSummary(req.tenant!.companyId) });
});

// H2: stock on hand, by branch x category.
taggingRouter.get('/reports/stock-on-hand', requirePermission('report:view'), async (req: Request, res: Response) => {
  const data = await svc.getStockOnHand(req.tenant!.companyId, {
    branchId: req.query.branchId as string | undefined,
    categoryId: req.query.categoryId as string | undefined,
  });
  res.json({ success: true, data });
});

// Stock Book: one row per tag, branch-scoped to the caller's own grants (see getStockBook).
taggingRouter.get('/reports/stock-book', requirePermission('report:view'), async (req: Request, res: Response) => {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const date = (v: unknown) => {
    const s = str(v); if (!s) return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new AppError('Invalid date', 400);
    return d;
  };
  const data = await svc.getStockBook(req.tenant!, {
    branchId: str(req.query.branchId), status: str(req.query.status), categoryId: str(req.query.categoryId),
    dateFrom: date(req.query.dateFrom), dateTo: date(req.query.dateTo),
  });
  res.json({ success: true, data });
});

// H3: dead stock / ageing.
taggingRouter.get('/reports/dead-stock', requirePermission('report:view'), async (req: Request, res: Response) => {
  const asOfStr = req.query.asOf as string | undefined;
  const data = await svc.getDeadStock(req.tenant!.companyId, asOfStr ? new Date(asOfStr) : undefined);
  res.json({ success: true, data });
});

taggingRouter.post('/branches', requirePermission('branch:manage'), async (req: Request, res: Response) => {
  const branch = await svc.createBranch(req.tenant!.companyId, req.body);
  res.status(201).json({ success: true, data: branch });
});

taggingRouter.patch('/branches/:id', requirePermission('branch:manage'), async (req: Request, res: Response) => {
  const branch = await svc.updateBranch(req.params.id, req.tenant!.companyId, req.body);
  res.json({ success: true, data: branch });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

taggingRouter.get('/tags', requirePermission('tag:view'), async (req: Request, res: Response) => {
  const result = await svc.listTags(req.tenant!, {
    status: req.query.status as string,
    branchId: req.query.branchId as string,
    dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
    dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 30,
  });
  res.json({ success: true, ...result });
});

taggingRouter.get('/tags/search', requirePermission('tag:view'), async (req: Request, res: Response) => {
  const tags = await svc.searchTags(
    req.tenant!,
    req.query.q as string ?? '',
    req.query.branchId as string,
    req.query.status as string | undefined,
  );
  res.json({ success: true, data: tags });
});

taggingRouter.get('/tags/:id', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getTag(req.tenant!, req.params.id) });
});

// Stage 2: generates the TSPL for one tag on demand; the client POSTs the returned string to the
// local print agent running on the counter PC (this server never talks to the printer itself).
taggingRouter.get('/tags/:id/print', requirePermission('tag:view'), async (req: Request, res: Response) => {
  const data = await svc.getTagPrintTspl(req.tenant!, req.params.id, req.query.templateId as string | undefined);
  res.json({ success: true, data });
});

taggingRouter.post('/tags', requirePermission('tag:create'), async (req: Request, res: Response) => {
  const tag = await svc.createTag(req.tenant!, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: tag });
});

// Corrects a tag's own details after the fact — not a stock movement, so it's gated the same as
// creating/retiring a tag (tag:create) rather than needing its own permission.
taggingRouter.patch('/tags/:id', requirePermission('tag:create'), async (req: Request, res: Response) => {
  const tag = await svc.updateTag(req.params.id, req.body, req.tenant!, req.user!.userId);
  res.json({ success: true, data: tag });
});

taggingRouter.patch('/tags/:id/retire', requirePermission('tag:create'), async (req: Request, res: Response) => {
  const tag = await svc.retireTag(req.params.id, req.tenant!, req.user!.userId);
  res.json({ success: true, data: tag });
});

taggingRouter.post('/tags/from-grn-item', requirePermission('tag:create'), async (req: Request, res: Response) => {
  const tag = await svc.createTagFromGrnItem(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: tag });
});

// The Manufacturer (a Client) that matches a PO's supplier — found, or created once from the supplier's details —
// so the tag screen can pre-select it for pieces cut from that supplier's goods.
taggingRouter.post('/manufacturers/from-supplier', requirePermission('tag:create'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.manufacturerForSupplier(req.tenant!, req.body?.supplierId) });
});

// ─── Purchase lots (bags of bought-in pieces, tagged one at a time) ───────────
// A piece is cut from a lot by POST /tags with purchaseLotId; these are the lot's own read/close endpoints.

taggingRouter.get('/lots', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await lots.listPurchaseLots(req.tenant!, { status: req.query.status as string | undefined }) });
});

taggingRouter.get('/lots/:id', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await lots.getPurchaseLot(req.tenant!, req.params.id) });
});

taggingRouter.post('/lots/:id/close', requirePermission('tag:create'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await lots.closePurchaseLot(req.tenant!, req.params.id, req.user!.userId, req.body?.note) });
});

// ─── Tag Templates (Stage 3: the visual designer) ─────────────────────────────

taggingRouter.get('/templates', requirePermission('tagTemplate:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listTagTemplates(req.tenant!.companyId) });
});

taggingRouter.get('/templates/:id', requirePermission('tagTemplate:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getTagTemplateById(req.tenant!.companyId, req.params.id) });
});

taggingRouter.post('/templates', requirePermission('tagTemplate:manage'), async (req: Request, res: Response) => {
  const template = await svc.createTagTemplate(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: template });
});

taggingRouter.put('/templates/:id', requirePermission('tagTemplate:manage'), async (req: Request, res: Response) => {
  const template = await svc.updateTagTemplate(req.tenant!.companyId, req.params.id, req.body);
  res.json({ success: true, data: template });
});

// ─── Transfers ────────────────────────────────────────────────────────────────

taggingRouter.get('/transfers', requirePermission('tag:view'), async (req: Request, res: Response) => {
  const result = await svc.listTransfers(req.tenant!, {
    status: req.query.status as string,
    fromBranchId: req.query.fromBranchId as string,
    toBranchId: req.query.toBranchId as string,
    incoming: req.query.incoming === 'true',
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
  });
  res.json({ success: true, ...result });
});

taggingRouter.get('/transfers/:id', requirePermission('tag:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getTransfer(req.tenant!, req.params.id) });
});

taggingRouter.post('/transfers', requirePermission('branch:transfer'), async (req: Request, res: Response) => {
  const transfer = await svc.createTransfer(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: transfer });
});

taggingRouter.post('/transfers/:id/submit', requirePermission('branch:transfer'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.submitTransfer(req.params.id, req.tenant!, req.user!.userId) });
});

taggingRouter.post('/transfers/:id/approve', requirePermission('branch:approve'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.approveTransfer(req.params.id, req.tenant!, req.user!.userId) });
});

taggingRouter.post('/transfers/:id/receive', requirePermission('branch:transfer'), async (req: Request, res: Response) => {
  const { tagIds } = req.body ?? {};
  if (tagIds !== undefined && (!Array.isArray(tagIds) || tagIds.some((x: unknown) => typeof x !== 'string'))) {
    return res.status(400).json({ success: false, error: 'tagIds must be a list of tag ids' });
  }
  res.json({ success: true, data: await svc.receiveTransfer(req.params.id, req.tenant!, req.user!.userId, tagIds) });
});

taggingRouter.post('/transfers/:id/cancel', requirePermission('branch:transfer'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.cancelTransfer(req.params.id, req.tenant!, req.user!.userId) });
});

// ─── Stock Audits (E3) ──────────────────────────────────────────────────────

taggingRouter.get('/audits', requirePermission('stock:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listStockAudits(req.tenant!, req.query.branchId as string | undefined) });
});

taggingRouter.get('/audits/:id', requirePermission('stock:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getStockAudit(req.tenant!, req.params.id) });
});

taggingRouter.post('/audits', requirePermission('stock:adjust'), async (req: Request, res: Response) => {
  const audit = await svc.startStockAudit(req.body.branchId, req.tenant!, req.user!.userId, req.body.notes);
  res.status(201).json({ success: true, data: audit });
});

taggingRouter.post('/audits/:id/scan', requirePermission('stock:adjust'), async (req: Request, res: Response) => {
  const audit = await svc.scanAuditItem(req.params.id, req.body.tagId, req.tenant!, req.user!.userId);
  res.json({ success: true, data: audit });
});

taggingRouter.post('/audits/:id/complete', requirePermission('stock:adjust'), async (req: Request, res: Response) => {
  const audit = await svc.completeStockAudit(req.params.id, req.tenant!, req.user!.userId);
  res.json({ success: true, data: audit });
});
