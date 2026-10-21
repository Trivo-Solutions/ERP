import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { qs, qsNum } from '../../shared/query';
import { parseVaultMetal } from '../../shared/metalMovement';
import * as svc from './inventory.service';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate, resolveTenantContext);

inventoryRouter.get('/metals', requirePermission('stock:view'), async (req: Request, res: Response) => {
  const stock = await svc.getMetalStock(req.tenant!.companyId, {
    karat: qs(req, 'karat'),
    location: qs(req, 'location'),
    minWeight: qsNum(req, 'minWeight'),
    // GOLD | SILVER: only the lots a sale of that metal can draw from (the New Sale dialog's availability). 400 on anything else.
    metalType: parseVaultMetal(qs(req, 'metalType'), 'metalType'),
  });
  res.json({ success: true, data: stock });
});

inventoryRouter.get('/metals/karats', requirePermission('stock:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listVaultKarats(req.tenant!.companyId) });
});

// The request body is validated and whitelisted by addMetalStockEntry - never spread into the row - and the lot's metal comes
// from the company's Karat master (a client-supplied metalType is only cross-checked against it).
inventoryRouter.post('/metals', requirePermission('stock:adjust'), async (req: Request, res: Response) => {
  const stock = await svc.addMetalStockEntry(req.body ?? {}, req.tenant!.companyId, req.user!.userId);
  res.status(201).json({ success: true, data: stock });
});

inventoryRouter.patch('/metals/:id/adjust', requirePermission('stock:adjust'), async (req: Request, res: Response) => {
  const { adjustment, reason } = req.body;
  const stock = await svc.adjustMetalStock(req.params.id, adjustment, reason, req.tenant!, req.user!.userId);
  res.json({ success: true, data: stock });
});

inventoryRouter.get('/stones', requirePermission('stone:manage'), async (req: Request, res: Response) => {
  const lots = await svc.listStoneLots(req.tenant!.companyId, {
    stoneType: qs(req, 'stoneType'),
    status: qs(req, 'status'),
    color: qs(req, 'color'),
    clarity: qs(req, 'clarity'),
  });
  res.json({ success: true, data: lots });
});

inventoryRouter.post('/stones', requirePermission('stone:manage'), async (req: Request, res: Response) => {
  const lot = await svc.createStoneLot(req.body, req.tenant!.companyId, req.user!.userId);
  res.status(201).json({ success: true, data: lot });
});

inventoryRouter.post('/stones/:id/split', requirePermission('stone:split'), async (req: Request, res: Response) => {
  const result = await svc.splitStoneLot(req.params.id, req.body.splits, req.tenant!, req.user!.userId);
  res.json({ success: true, data: result });
});

inventoryRouter.get('/consumables', requirePermission('consumable:manage'), async (req: Request, res: Response) => {
  const items = await svc.listConsumables(req.tenant!.companyId, qs(req, 'category'));
  res.json({ success: true, data: items });
});

inventoryRouter.post('/consumables/transaction', requirePermission('consumable:manage'), async (req: Request, res: Response) => {
  const { consumableId, type, quantity, reference, notes } = req.body;
  const item = await svc.consumableTransaction(consumableId, type, quantity, req.tenant!, reference, notes);
  res.json({ success: true, data: item });
});
