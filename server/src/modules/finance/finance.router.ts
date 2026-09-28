import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { qs } from '../../shared/query';
import * as svc from './finance.service';
import { prisma } from '../../config/database';
import { tenantQuery } from '../../shared/tenantContext';

export const financeRouter = Router();
financeRouter.use(authenticate, resolveTenantContext);

financeRouter.get('/accounts', requirePermission('finance:view'), async (req: Request, res: Response) => {
  const accounts = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.account.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true },
    include: { parent: { select: { code: true, name: true } } },
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
  }));
  res.json({ success: true, data: accounts });
});

financeRouter.get('/journals', requirePermission('finance:view'), async (req: Request, res: Response) => {
  const postedParam = qs(req, 'posted');
  const entries = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.journalEntry.findMany({
    where: {
      companyId: req.tenant!.companyId,
      ...(postedParam !== undefined && { isPosted: postedParam === 'true' }),
    },
    include: {
      lines: { include: { account: { select: { code: true, name: true } } } },
      costCenter: { select: { name: true } },
    },
    orderBy: { date: 'desc' },
    take: 50,
  }));
  res.json({ success: true, data: entries });
});

financeRouter.post('/journals', requirePermission('journal:create'), async (req: Request, res: Response) => {
  const entry = await svc.createJournalEntry(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: entry });
});

financeRouter.post('/journals/:id/post', requirePermission('journal:post'), async (req: Request, res: Response) => {
  await svc.postJournalEntry(req.tenant!.companyId, req.params.id);
  res.json({ success: true, message: 'Journal entry posted' });
});

// J4-D1: trial balance / P&L / balance sheet are sensitive financial-detail reports — split out of
// report:view into report:financial_view (operational reports like stock/WIP/sales-register stay
// on report:view).
financeRouter.get('/reports/trial-balance', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf');
  const data = await svc.getTrialBalance(req.tenant!.companyId, asOfStr ? new Date(asOfStr) : undefined);
  res.json({ success: true, data });
});

financeRouter.get('/reports/pnl', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const data = await svc.getProfitAndLoss(req.tenant!.companyId, new Date(fromStr), new Date(toStr));
  res.json({ success: true, data });
});

financeRouter.get('/reports/balance-sheet', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf') ?? new Date().toISOString();
  const data = await svc.getBalanceSheet(req.tenant!.companyId, new Date(asOfStr));
  res.json({ success: true, data });
});

financeRouter.get('/reports/cost-centers', requirePermission('report:view'), async (req: Request, res: Response) => {
  const data = await svc.getCostCenterProfitability(req.tenant!.companyId);
  res.json({ success: true, data });
});

// J4-D1: named explicitly in Decision 1 as sensitive (per-dealer outstanding + credit-limit flags).
financeRouter.get('/reports/dealer-aging', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf');
  const data = await svc.getDealerAging(req.tenant!.companyId, asOfStr ? new Date(asOfStr) : undefined);
  res.json({ success: true, data });
});

// J4-D1: named explicitly in Decision 1 as sensitive (named customer balances).
financeRouter.get('/reports/client-ledger/:clientId', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const data = await svc.getClientLedger(req.tenant!, req.params.clientId, fromStr ? new Date(fromStr) : undefined, toStr ? new Date(toStr) : undefined);
  res.json({ success: true, data });
});

// H4: day-book — one day's company-wide sales/payments/returns/exchanges rollup. J4-D1: named
// explicitly in Decision 1 as sensitive.
financeRouter.get('/reports/day-book', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const dateStr = qs(req, 'date') ?? new Date().toISOString();
  const data = await svc.getDayBook(req.tenant!.companyId, new Date(dateStr));
  res.json({ success: true, data });
});

// H5: GST HSN-wise summary for a period (return-filing prep). J4-D1: "GST detail/summary where it
// exposes sensitive financial information" — named explicitly in Decision 1.
financeRouter.get('/reports/gst-summary', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const data = await svc.getGstSummary(req.tenant!.companyId, new Date(fromStr), new Date(toStr));
  res.json({ success: true, data });
});

// One supplier's statement (purchases, returns, payments) with a running payable balance. J4-D1:
// named explicitly in Decision 1 as sensitive.
financeRouter.get('/reports/supplier-ledger/:supplierId', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from'), toStr = qs(req, 'to');
  const data = await svc.getSupplierLedger(req.tenant!, req.params.supplierId, fromStr ? new Date(fromStr) : undefined, toStr ? new Date(toStr) : undefined);
  res.json({ success: true, data });
});

// Purchase-side GST (input tax credit) for a period — ITC prep, mirror of the sales GST summary.
// J4-D1: same "GST detail/summary" bucket as the sales-side gst-summary above — kept consistent
// rather than leaving its mirror route on the broader report:view.
financeRouter.get('/reports/purchase-gst-summary', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const data = await svc.getPurchaseGstSummary(req.tenant!.companyId, new Date(fromStr), new Date(toStr));
  res.json({ success: true, data });
});

financeRouter.get('/cost-centers', requirePermission('finance:view'), async (req: Request, res: Response) => {
  const centers = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.costCenter.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true },
    orderBy: { code: 'asc' },
  }));
  res.json({ success: true, data: centers });
});
