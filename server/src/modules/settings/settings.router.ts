import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { prisma } from '../../config/database';
import { tenantQuery } from '../../shared/tenantContext';
import * as settingsSvc from './settings.service';

export const settingsRouter = Router();
settingsRouter.use(authenticate, resolveTenantContext);

// Company-scoped — Role is company-owned as of the multi-tenant migration (see schema.prisma's
// Role/RoleTemplate split). "users" -> "memberships": Role no longer relates to User directly,
// only through CompanyUser (see the blueprint's explicit User-stays-global reasoning).
settingsRouter.get('/roles', requirePermission('role:manage'), async (req: Request, res: Response) => {
  const roles = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.role.findMany({
    where: { companyId: req.tenant!.companyId },
    include: { _count: { select: { memberships: true } } },
  }));
  res.json({ success: true, data: roles });
});

settingsRouter.post('/roles', requirePermission('role:manage'), async (req: Request, res: Response) => {
  const { name, displayName, permissions } = req.body;
  const role = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.role.create({
    data: { companyId: req.tenant!.companyId, name, displayName, permissions },
  }));
  res.status(201).json({ success: true, data: role });
});

// Company-scoped — each company has its own value for every key (see settings.service.ts).
settingsRouter.get('/config', requirePermission('system:config'), async (req: Request, res: Response) => {
  const configs = await settingsSvc.listConfigs(req.tenant!.companyId);
  res.json({ success: true, data: configs });
});

settingsRouter.put('/config/:key', requirePermission('system:config'), async (req: Request, res: Response) => {
  const config = await settingsSvc.upsertConfig(req.tenant!.companyId, req.params.key, req.body.value, req.body.category);
  res.json({ success: true, data: config });
});

// Company-owned (Phase 1 of full company isolation) — each company's own design categories.
settingsRouter.get('/design-categories', async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const cats = await tenantQuery(companyId, (tx) =>
    tx.designCategory.findMany({ where: { companyId }, orderBy: { name: 'asc' } })
  );
  res.json({ success: true, data: cats });
});

settingsRouter.post('/design-categories', requirePermission('system:config'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const { code, name } = req.body;
  const cat = await tenantQuery(companyId, (tx) =>
    tx.designCategory.create({ data: { companyId, code: String(code).toUpperCase(), name } })
  );
  res.status(201).json({ success: true, data: cat });
});

settingsRouter.get('/process-tolerances', requirePermission('karigar:view'), async (req: Request, res: Response) => {
  const tolerances = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.processTolerance.findMany({
    where: { companyId: req.tenant!.companyId }, orderBy: { processName: 'asc' },
  }));
  res.json({ success: true, data: tolerances });
});

settingsRouter.put('/process-tolerances/:processName', requirePermission('system:config'), async (req: Request, res: Response) => {
  const tolerance = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.processTolerance.upsert({
    where: { companyId_processName: { companyId: req.tenant!.companyId, processName: req.params.processName } },
    create: { companyId: req.tenant!.companyId, processName: req.params.processName, ...req.body },
    update: req.body,
  }));
  res.json({ success: true, data: tolerance });
});

// companyId is stamped by every tenant-aware service that writes an audit entry — filtering by
// it here is what stops one company's admin from browsing another company's audit trail. A row
// with no companyId (written before this fix, or by a module not tenant-scoped yet — see
// AuditLog's schema comment) never matches this filter and simply doesn't appear here; it isn't
// a leak, just not yet attributable to any one company's view.
settingsRouter.get('/audit-logs', requirePermission('audit:view'), async (req: Request, res: Response) => {
  const logs = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.auditLog.findMany({
    where: { companyId: req.tenant!.companyId, ...(req.query.table && { tableName: req.query.table as string }) },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { timestamp: 'desc' },
    take: 100,
  }));
  res.json({ success: true, data: logs });
});
