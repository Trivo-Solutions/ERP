import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertBranchAccessible, assertOwnedIfPresent, assertOwnedByCompany } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { qs } from '../../shared/query';
import * as svc from './finance.service';
import * as gstr1 from './gst/gstr1Reporting.service';
import { prisma } from '../../config/database';
import { tenantQuery } from '../../shared/tenantContext';
import { parseIstRangeStart, parseIstRangeEnd, getCurrentFinancialYearStart } from '../../shared/istDate';

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
// G2g-2: optional `branchId` (verified to belong to this company AND be one the caller may
// access — never trusted from the query string alone) and `gstRegistrationId` (verified to
// belong to this company). With no `branchId`, a branch-restricted caller still only ever sees
// their own granted branches (req.tenant!.branchAccess, applied inside the service) — never
// relying on the frontend to have filtered anything.
financeRouter.get('/reports/gst-summary', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedIfPresent('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await svc.getGstSummary(
    req.tenant!.companyId, parseIstRangeStart(fromStr), parseIstRangeEnd(toStr),
    { branchAccess: req.tenant!.branchAccess, branchId, gstRegistrationId },
  );
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
// G2g-2: branch access only (same enforcement as gst-summary above) — no gstRegistrationId filter
// here; see getPurchaseGstSummary's own comment for why the purchase side has no authoritative
// per-document registration identity to filter on without inventing one.
financeRouter.get('/reports/purchase-gst-summary', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  const data = await svc.getPurchaseGstSummary(
    req.tenant!.companyId, parseIstRangeStart(fromStr), parseIstRangeEnd(toStr),
    { branchAccess: req.tenant!.branchAccess, branchId },
  );
  res.json({ success: true, data });
});

// G2g-3e — GSTR-1 outward-supply (B2B/B2CL/B2CS) reporting. Read-only integration for the FROZEN
// pure aggregator (gstr1OutwardAggregation.ts) — this route loads no data itself and performs no
// classification/aggregation; see gstr1Reporting.service.ts for the loading/adapter layer.
// `gstRegistrationId` is REQUIRED (never defaulted to Company.gstin/a primary/another
// registration/a branch GSTIN — rule 1) and ownership-checked with assertOwnedByCompany directly
// (not assertOwnedIfPresent, which SKIPS when absent — this field must never be silently optional).
// Reuses report:financial_view, the same permission already gating gst-summary/purchase-gst-summary
// immediately above — this is the same "GST detail/summary" sensitivity bucket (J4-D1), not a new
// authorization concept.
// Path: kept under the existing flat `/reports/<name>` convention this router already uses for
// every other financial report (gst-summary, purchase-gst-summary, dealer-aging, ...) rather than
// the brief's own suggested `/gst/gstr1/outward` shape, per the brief's explicit "follow the
// existing convention" instruction.
financeRouter.get('/reports/gstr1-outward', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1OutwardReport(
    req.tenant!.companyId, gstRegistrationId, parseIstRangeStart(fromStr), parseIstRangeEnd(toStr),
    { branchAccess: req.tenant!.branchAccess, branchId },
  );
  res.json({ success: true, data });
});

// G2g-3e — GSTR-1 Table 9B CDNR/CDNUR Credit Note reporting. Same posture as the outward route
// immediately above: read-only integration for the FROZEN gstr1CreditNoteAggregation.ts, no
// classification/aggregation performed here.
financeRouter.get('/reports/gstr1-credit-notes', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1CreditNoteReport(
    req.tenant!.companyId, gstRegistrationId, parseIstRangeStart(fromStr), parseIstRangeEnd(toStr),
    { branchAccess: req.tenant!.branchAccess, branchId },
  );
  res.json({ success: true, data });
});

// G2g-3f — GSTR-1 Table 12 (official terminology: "Table 12 — B2B Supplies" / "Table 12 — B2C
// Supplies") HSN-wise summary. Same posture as the two routes immediately above: read-only
// integration for the FROZEN pure aggregator (gstr1Table12Aggregation.ts), no classification/
// aggregation performed here. Same required `gstRegistrationId` / optional `branchId` / `report:
// financial_view` permission contract as gstr1-outward and gstr1-credit-notes.
financeRouter.get('/reports/gstr1-table12', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1Table12Report(
    req.tenant!.companyId, gstRegistrationId, parseIstRangeStart(fromStr), parseIstRangeEnd(toStr),
    { branchAccess: req.tenant!.branchAccess, branchId },
  );
  res.json({ success: true, data });
});

// G2g-3g-3 — GSTR-1 Table 13 (Documents Issued) HTTP/API endpoint. Pure security/routing adapter
// over the FROZEN engine (gstr1Table13Aggregation.ts) and FROZEN reporting adapter
// (getGstr1Table13Report, defined in gstr1Reporting.service.ts alongside the other GSTR-1
// functions above) — this route performs no classification/aggregation itself.
// Unlike the three routes immediately above, getGstr1Table13Report takes the full TenantContext
// and already performs GST registration ownership (assertOwnedByCompany), branch accessibility
// (assertBranchAccessible), and IST date-range validation internally — so this router does not
// repeat that logic (no duplicate assertBranchAccessible/assertOwnedByCompany call here). It only
// validates what the frozen service does not: presence of gstRegistrationId/from/to at the
// boundary (matching the sibling routes' contract), and rejecting an inverted date range
// (to < from), which the service never checks. `from`/`to` are REQUIRED here (no fiscal-year
// default, unlike gstr1-outward/gstr1-credit-notes/gstr1-table12) per the brief's explicit
// contract — never silently defaulted or inferred.
financeRouter.get('/reports/gstr1-table13', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const branchId = qs(req, 'branchId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (!fromStr) throw new AppError('from is required', 400);
  if (!toStr) throw new AppError('to is required', 400);

  const fromDate = parseIstRangeStart(fromStr);
  const toDate = parseIstRangeEnd(toStr);
  if (isNaN(fromDate.getTime())) throw new AppError('Invalid from date', 400);
  if (isNaN(toDate.getTime())) throw new AppError('Invalid to date', 400);
  if (toDate < fromDate) throw new AppError('to must not be before from', 400);

  const data = await gstr1.getGstr1Table13Report(req.tenant!, { gstRegistrationId, from: fromStr, to: toStr, branchId });
  res.json({ success: true, data });
});

financeRouter.get('/cost-centers', requirePermission('finance:view'), async (req: Request, res: Response) => {
  const centers = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.costCenter.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true },
    orderBy: { code: 'asc' },
  }));
  res.json({ success: true, data: centers });
});
