import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { qs, qsNum } from '../../shared/query';
import * as svc from './orders.service';
import { prisma } from '../../config/database';
import { tenantQuery, tenantTransaction } from '../../shared/tenantContext';

export const ordersRouter = Router();
ordersRouter.use(authenticate, resolveTenantContext);

// Static routes before /:id
ordersRouter.get('/reservations', requirePermission('reservation:manage'), async (req: Request, res: Response) => {
  const status = qs(req, 'status') ?? 'ACTIVE';
  const reservations = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.materialReservation.findMany({
    where: { companyId: req.tenant!.companyId, status },
    include: {
      order: { select: { orderNumber: true, status: true, client: { select: { name: true } } } },
      metalStock: { select: { stockCode: true, karat: true, materialName: true } },
      stoneLot: { select: { lotNumber: true, stoneType: true, color: true, clarity: true } },
    },
    orderBy: { reservedAt: 'desc' },
    take: 100,
  }));
  res.json({ success: true, data: reservations });
});

ordersRouter.patch('/reservations/:id/release', requirePermission('reservation:manage'), async (req: Request, res: Response) => {
  const reservation = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.materialReservation.findUnique({ where: { id: req.params.id } }));
  if (!reservation || reservation.companyId !== req.tenant!.companyId) {
    return res.status(404).json({ success: false, error: 'Reservation not found' });
  }

  await tenantTransaction(req.tenant!.companyId, async (tx) => {
    await tx.materialReservation.update({ where: { id: req.params.id }, data: { status: 'RELEASED' } });
    if (reservation.metalStockId) {
      await tx.metalStock.update({
        where: { id: reservation.metalStockId },
        data: { availableWt: { increment: Number(reservation.reservedWeight) } },
      });
    }
    if (reservation.stoneLotId) {
      await tx.stoneLot.update({
        where: { id: reservation.stoneLotId },
        data: { availableCts: { increment: Number(reservation.reservedWeight) } },
      });
    }
  });

  res.json({ success: true, message: 'Reservation released — stock returned to vault' });
});

// Client CRUD: gated by client:* rather than order:* — a client (customer/dealer) is retail/wholesale
// party data, unrelated to the order:* permission family, which is production-order (SalesOrder, a
// dormant manufacturing concept per CLAUDE.md §2). It lives in this router only because listClients/
// createClient/updateClient already did (orders.service.ts predates the pivot); not moved to reduce
// diff noise on an otherwise-unrelated change.
ordersRouter.get('/clients', requirePermission('client:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listClients(req.tenant!.companyId, qs(req, 'search')) });
});

ordersRouter.post('/clients', requirePermission('client:create'), async (req: Request, res: Response) => {
  const client = await svc.createClient(req.tenant!.companyId, req.body);
  res.status(201).json({ success: true, data: client });
});

ordersRouter.patch('/clients/:id', requirePermission('client:edit'), async (req: Request, res: Response) => {
  const client = await svc.updateClient(req.params.id, req.tenant!.companyId, req.body);
  res.json({ success: true, data: client });
});

// J3 Decision 3: deactivate/reactivate is its own permission, distinct from client:edit — a
// lifecycle action (blocks future sales/memos/payments once set) rather than a detail edit.
ordersRouter.patch('/clients/:id/deactivate', requirePermission('client:deactivate'), async (req: Request, res: Response) => {
  const client = await svc.setClientActive(req.params.id, req.tenant!.companyId, false, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: client });
});

ordersRouter.patch('/clients/:id/reactivate', requirePermission('client:deactivate'), async (req: Request, res: Response) => {
  const client = await svc.setClientActive(req.params.id, req.tenant!.companyId, true, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: client });
});

// J3 Decision 3: permanent removal, only when the client has zero transaction history anywhere —
// see deleteClient(). Not the generic Delete button's behavior (that's Deactivate); a distinct,
// higher-trust, reason-required action.
ordersRouter.delete('/clients/:id', requirePermission('client:delete'), async (req: Request, res: Response) => {
  const result = await svc.deleteClient(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: result });
});

ordersRouter.get('/', requirePermission('order:view'), async (req: Request, res: Response) => {
  const result = await svc.listOrders(req.tenant!.companyId, {
    status: qs(req, 'status'),
    clientId: qs(req, 'clientId'),
    priority: qs(req, 'priority'),
    page: qsNum(req, 'page', 1),
    limit: qsNum(req, 'limit', 20),
  });
  res.json({ success: true, ...result });
});

ordersRouter.get('/:id', requirePermission('order:view'), async (req: Request, res: Response) => {
  const order = await svc.getOrder(req.tenant!.companyId, req.params.id);
  res.json({ success: true, data: order });
});

ordersRouter.post('/', requirePermission('order:create'), async (req: Request, res: Response) => {
  const order = await svc.createOrder(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: order });
});

ordersRouter.patch('/:id/status', requirePermission('order:approve'), async (req: Request, res: Response) => {
  const order = await svc.updateOrderStatus(req.params.id, req.body.status, req.tenant!, req.user!.userId);
  res.json({ success: true, data: order });
});
