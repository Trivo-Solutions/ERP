import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission, requireAnyPermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { prisma } from '../../config/database';
import { tenantQuery } from '../../shared/tenantContext';

export const reportsRouter = Router();
reportsRouter.use(authenticate, resolveTenantContext);

reportsRouter.get('/dashboard', requirePermission('report:view'), async (req: Request, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const companyId = req.tenant!.companyId;

  const [
    activeOrders, inProduction, qcPending, readyDelivery,
    todayGRNs, overdueMemoes, totalMetalStock,
    recentInvoices,
  ] = await Promise.all([
    // SalesOrder/JobCard/GoodsReceiptNote/MetalStock all became company-scoped in Phase 3 — every
    // query below is now explicitly filtered. (SalesOrder/JobCard stay dormant per CLAUDE.md, but
    // scoping them is cheap correctness insurance regardless of whether the frontend reaches them.)
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesOrder.count({ where: { companyId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.jobCard.count({ where: { companyId, status: 'IN_PROGRESS' } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.jobCard.count({ where: { companyId, status: 'QC_PENDING' } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesOrder.count({ where: { companyId, status: 'READY' } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.goodsReceiptNote.count({ where: { companyId, createdAt: { gte: today } } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.memoOut.count({ where: { companyId, status: 'OUT', returnDeadline: { lt: new Date() } } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.metalStock.aggregate({ where: { companyId, isActive: true }, _sum: { availableWt: true } })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesInvoice.findMany({
      where: { companyId, createdAt: { gte: today } },
      select: { invoiceNumber: true, totalAmount: true, status: true, client: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })),
  ]);

  res.json({
    success: true,
    data: {
      kpis: { activeOrders, inProduction, qcPending, readyDelivery, todayGRNs, overdueMemoes },
      metalStock: { availableGrams: totalMetalStock._sum.availableWt ?? 0 },
      recentInvoices,
    },
  });
});

reportsRouter.get('/wip-summary', requireAnyPermission('report:wip', 'report:view'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const wipByProcess = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.jobProcess.groupBy({
    by: ['processName', 'status'],
    _count: true,
    where: { companyId, jobCard: { status: 'IN_PROGRESS' } },
  }));

  const jobsByPriority = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.jobCard.groupBy({
    by: ['priority', 'status'],
    _count: true,
    where: { companyId, status: { notIn: ['COMPLETED', 'REJECTED'] } },
  }));

  res.json({ success: true, data: { wipByProcess, jobsByPriority } });
});

reportsRouter.get('/stock-summary', requirePermission('report:stock_summary'), async (req: Request, res: Response) => {
  const companyId = req.tenant!.companyId;
  const [metalByKarat, stonesByType, lowConsumables] = await Promise.all([
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.metalStock.groupBy({
      by: ['karat'],
      where: { companyId, isActive: true },
      _sum: { availableWt: true, netWeight: true },
      _count: true,
    })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.stoneLot.groupBy({
      by: ['stoneType', 'status'],
      where: { companyId },
      _sum: { availableCts: true },
      _count: true,
    })),
    tenantQuery(req.tenant!.companyId, (_tx) => _tx.consumable.findMany({
      where: { companyId, currentQty: { lte: prisma.consumable.fields.reorderLevel } },
      select: { itemCode: true, name: true, currentQty: true, reorderLevel: true, unit: true },
    })),
  ]);

  res.json({ success: true, data: { metalByKarat, stonesByType, lowConsumables } });
});

reportsRouter.get('/karigar-balances', requirePermission('report:karigar'), async (req: Request, res: Response) => {
  const artisans = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.artisan.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true, metalBalance: { gt: 0 } },
    select: { artisanCode: true, name: true, type: true, metalBalance: true },
    orderBy: { metalBalance: 'desc' },
  }));
  res.json({ success: true, data: artisans });
});

// J4-D1: same sensitivity class as finance/reports/dealer-aging (named customer balances + aging) —
// gated consistently rather than leaving an equivalent report reachable via the narrower report:view.
reportsRouter.get('/aging-receivables', requirePermission('report:aging_receivables'), async (req: Request, res: Response) => {
  const invoices = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesInvoice.findMany({
    // J3.5 Finding 1: 'VOID' didn't exist when this list was written — a voided invoice keeps
    // balanceDue == totalAmount by design and must not age here as a live receivable.
    where: { companyId: req.tenant!.companyId, status: { notIn: ['PAID', 'CANCELLED', 'VOID'] }, balanceDue: { gt: 0 } },
    include: { client: { select: { name: true, clientCode: true } } },
    orderBy: { invoiceDate: 'asc' },
  }));

  const now = Date.now();
  const aged = invoices.map((inv) => {
    const daysDue = Math.floor((now - new Date(inv.invoiceDate).getTime()) / 86400000);
    return {
      invoiceNumber: inv.invoiceNumber,
      client: inv.client.name,
      totalAmount: inv.totalAmount,
      balanceDue: inv.balanceDue,
      currency: inv.currency,
      daysDue,
      bucket: daysDue <= 30 ? '0-30' : daysDue <= 60 ? '31-60' : daysDue <= 90 ? '61-90' : '90+',
    };
  });

  res.json({ success: true, data: aged });
});
