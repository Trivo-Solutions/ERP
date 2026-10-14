import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertBranchAccessible, assertOwnedIfPresent, assertOwnedByCompany } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { qs } from '../../shared/query';
import * as svc from './finance.service';
import * as gstr1 from './gst/gstr1Reporting.service';
import { getGstr3bOutwardReport } from './gst/gstr3bReporting.service';
import { getGstr3bInwardItcReport } from './gst/gstr3bItcReporting.service';
import { getGstr3bRcmReport } from './gst/gstr3bRcmReporting.service';
import { listRcmLiabilities, markRcmLiabilityPaid } from './gst/gstr3bRcmBooking.service';
import { importGstr2bStatement } from './gst/gstr2bImport.service';
import { getGstr2bReconciliationReport } from './gst/gstr2bReconciliation.service';
import { getGstr3bReconciliationReport } from './gst/gstr3bReconciliation.service';
import { parseDate } from '../../shared/parseDate';
import { buildGstr1GstnExport } from './gst/gstr1Export.service';
import { createGstr1FilingSnapshot } from './gst/gstr1FilingSnapshot.service';
import { createGstr1FilingAttempt, recordGstr1FilingAttemptOutcome, listGstr1FilingAttempts } from './gst/gstr1FilingAttempt.service';
import { fileGstr1ReturnPeriod, lockGstr1ReturnPeriod } from './gst/gstr1FilingPeriod.service';
import { buildGstr3bGstnExport } from './gst/gstr3bExport.service';
import { createGstr3bFilingSnapshot } from './gst/gstr3bFilingSnapshot.service';
import { createGstr3bFilingAttempt, recordGstr3bFilingAttemptOutcome, listGstr3bFilingAttempts } from './gst/gstr3bFilingAttempt.service';
import { fileGstr3bReturnPeriod, lockGstr3bReturnPeriod } from './gst/gstr3bFilingPeriod.service';
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
financeRouter.get('/reports/trial-balance', requirePermission('report:trial_balance'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf');
  const data = await svc.getTrialBalance(req.tenant!.companyId, asOfStr ? new Date(asOfStr) : undefined);
  res.json({ success: true, data });
});

financeRouter.get('/reports/pnl', requirePermission('report:pnl'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? `${new Date().getFullYear()}-04-01`;
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const data = await svc.getProfitAndLoss(req.tenant!.companyId, new Date(fromStr), new Date(toStr));
  res.json({ success: true, data });
});

financeRouter.get('/reports/balance-sheet', requirePermission('report:balance_sheet'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf') ?? new Date().toISOString();
  const data = await svc.getBalanceSheet(req.tenant!.companyId, new Date(asOfStr));
  res.json({ success: true, data });
});

financeRouter.get('/reports/cost-centers', requirePermission('report:cost_centers'), async (req: Request, res: Response) => {
  const data = await svc.getCostCenterProfitability(req.tenant!.companyId);
  res.json({ success: true, data });
});

// J4-D1: named explicitly in Decision 1 as sensitive (per-dealer outstanding + credit-limit flags).
financeRouter.get('/reports/dealer-aging', requirePermission('report:dealer_aging'), async (req: Request, res: Response) => {
  const asOfStr = qs(req, 'asOf');
  const data = await svc.getDealerAging(req.tenant!.companyId, asOfStr ? new Date(asOfStr) : undefined);
  res.json({ success: true, data });
});

// J4-D1: named explicitly in Decision 1 as sensitive (named customer balances).
financeRouter.get('/reports/client-ledger/:clientId', requirePermission('report:client_ledger'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const data = await svc.getClientLedger(req.tenant!, req.params.clientId, fromStr ? new Date(fromStr) : undefined, toStr ? new Date(toStr) : undefined);
  res.json({ success: true, data });
});

// H4: day-book — one day's company-wide sales/payments/returns/exchanges rollup. J4-D1: named
// explicitly in Decision 1 as sensitive.
financeRouter.get('/reports/day-book', requirePermission('report:day_book'), async (req: Request, res: Response) => {
  const dateStr = qs(req, 'date');
  // A bare 'YYYY-MM-DD' is an India calendar day: pin it to noon IST so it can never land on a neighbouring day
  // whatever timezone the server runs in (new Date('2026-10-12') is UTC midnight, i.e. the 11th in the Americas).
  const at = !dateStr ? new Date() : /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T12:00:00.000+05:30`) : new Date(dateStr);
  if (Number.isNaN(at.getTime())) throw new AppError('Invalid date', 400);
  const data = await svc.getDayBook(req.tenant!.companyId, at);
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
financeRouter.get('/reports/supplier-ledger/:supplierId', requirePermission('report:supplier_ledger'), async (req: Request, res: Response) => {
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
// G2g-4b.3: calls the Sales-Debit-Note-aware wrapper (`getGstr1OutwardReportWithSalesDebitNotes`)
// instead of the bare `getGstr1OutwardReport` — this is the ONLY thing that changed here. The
// wrapper runs the identical frozen `aggregateGstr1OutwardSupplies()` first and only ADDS eligible
// B2CS-origin Sales Debit Note value on top (b2b/b2cl are the base aggregation's own untouched
// references) — a company with zero Sales Debit Notes gets byte-identical b2b/b2cl/b2cs figures to
// before, plus always-present (zero-valued) `debitNote*Addition` fields on each b2cs row.
financeRouter.get('/reports/gstr1-outward', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1OutwardReportWithSalesDebitNotes(
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

// G2g-4b.3 — GSTR-1 Table 9B CDNR/CDNUR Sales (outward) Debit Note reporting. Structural sibling of
// the Credit Note route immediately above, over the FROZEN-engines-plus-adapter
// `gstr1SalesDebitNoteAdapter.ts` (itself unmodified by this wiring) via
// `getGstr1SalesDebitNoteReport`. A deliberately SEPARATE endpoint/response from
// `/reports/gstr1-credit-notes` — a Sales Debit Note is a positive CDNR/CDNUR adjustment, a Credit
// Note a negative one; merging them into one bucket would misrepresent which direction each
// document moves Table 9B. Same required `gstRegistrationId` / optional `branchId` /
// `report:financial_view` contract as every other GSTR-1 route in this file. Never touches the
// procurement-side DebitNote — this route (like the adapter/service functions it calls) only ever
// reads the `salesDebitNote` table.
financeRouter.get('/reports/gstr1-debit-notes', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1SalesDebitNoteReport(
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
// G2g-4b.3: calls the Sales-Debit-Note-aware wrapper (`getGstr1Table12ReportWithSalesDebitNotes`)
// instead of the bare `getGstr1Table12Report` — same posture as the `/reports/gstr1-outward` change
// above: the wrapper runs the identical frozen `aggregateGstr1Table12()` first and only ADDS
// eligible Sales Debit Note value on top of the matching B2B_SUPPLIES/B2C_SUPPLIES bucket, tracked
// in its own `debitNote*Addition` fields — the base `recordCount` per row is never touched.
financeRouter.get('/reports/gstr1-table12', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from') ?? getCurrentFinancialYearStart();
  const toStr = qs(req, 'to') ?? new Date().toISOString();
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');
  const data = await gstr1.getGstr1Table12ReportWithSalesDebitNotes(
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

// G2g-7b — GSTR-3B Outward Tax Liability report (Table 3.1(a) and Table 3.2).
// Pure, deterministic outward tax liability aggregation for a specified GST registration and period.
// Required: `gstRegistrationId`, and either `(financialYear + taxPeriod)` or `(from + to)`.
financeRouter.get('/reports/gstr3b-outward', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const financialYear = qs(req, 'financialYear');
  const taxPeriod = qs(req, 'taxPeriod');
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const dateQuery = (financialYear || taxPeriod)
    ? { financialYear, taxPeriod }
    : { from: fromStr ?? getCurrentFinancialYearStart(), to: toStr ?? new Date().toISOString() };

  const data = await getGstr3bOutwardReport(
    req.tenant!.companyId,
    gstRegistrationId,
    dateQuery,
    { branchAccess: req.tenant!.branchAccess, branchId },
  );

  res.json({ success: true, data });
});

// G2g-7c — GSTR-3B Table 4(A)(5) inward ITC foundation report ("All other ITC" — domestic
// registered purchases other than RCM/import/ISD). Every amount is classified ELIGIBLE /
// UNRESOLVED / INELIGIBLE against only the facts this phase's data model can actually establish —
// see gstr3bItcEligibility.ts's header. NOT a complete GSTR-3B Table 4 implementation (no GSTR-2B
// reconciliation, no Section 16(4)/17(5)/180-day engine — see the response's own eligibilityMatrix
// for exactly what remains NOT_DETERMINABLE). Same contract shape as gstr3b-outward immediately
// above: required `gstRegistrationId`, and either `(financialYear + taxPeriod)` or `(from + to)`.
financeRouter.get('/reports/gstr3b-itc', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const financialYear = qs(req, 'financialYear');
  const taxPeriod = qs(req, 'taxPeriod');
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const dateQuery = (financialYear || taxPeriod)
    ? { financialYear, taxPeriod }
    : { from: fromStr ?? getCurrentFinancialYearStart(), to: toStr ?? new Date().toISOString() };

  const data = await getGstr3bInwardItcReport(
    req.tenant!.companyId,
    gstRegistrationId,
    dateQuery,
    { branchAccess: req.tenant!.branchAccess, branchId },
  );

  res.json({ success: true, data });
});

// G2g-7d — GSTR-3B Table 3.1(d) (RCM liability) / Table 4(A)(3) (RCM ITC) foundation report.
// Deliberately NOT a complete RCM implementation — see gstr3bRcmClassification.ts's header and
// PHASE_G2G7D_AUDIT.md. Same contract shape as gstr3b-itc immediately above: required
// `gstRegistrationId`, and either `(financialYear + taxPeriod)` or `(from + to)`. Reuses
// `report:financial_view` — the same sensitivity bucket every other GST/financial report in this
// router uses, per the established J4-D1 convention; no new permission was introduced.
financeRouter.get('/reports/gstr3b-rcm', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const financialYear = qs(req, 'financialYear');
  const taxPeriod = qs(req, 'taxPeriod');
  const branchId = qs(req, 'branchId');
  const gstRegistrationId = qs(req, 'gstRegistrationId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const dateQuery = (financialYear || taxPeriod)
    ? { financialYear, taxPeriod }
    : { from: fromStr ?? getCurrentFinancialYearStart(), to: toStr ?? new Date().toISOString() };

  const data = await getGstr3bRcmReport(
    req.tenant!.companyId,
    gstRegistrationId,
    dateQuery,
    { branchAccess: req.tenant!.branchAccess, branchId },
  );

  res.json({ success: true, data });
});

// G2g-7d — list self-assessed RCM liabilities (almost always empty today — see PHASE_G2G7D_AUDIT.md
// §B.1), so a mark-paid action has something to act on.
financeRouter.get('/rcm-liabilities', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const status = qs(req, 'status');
  const page = qs(req, 'page') ? Number(qs(req, 'page')) : undefined;
  const limit = qs(req, 'limit') ? Number(qs(req, 'limit')) : undefined;
  const data = await listRcmLiabilities(req.tenant!, { status, page, limit });
  res.json({ success: true, data });
});

// G2g-7d — records that an RCM liability's tax was actually paid (Rule 86(2)) — the only action
// that can make its future ITC claim ELIGIBLE. An accounting action, like recordSupplierPayment,
// so it rides on journal:create rather than a new permission.
financeRouter.post('/rcm-liabilities/:id/mark-paid', requirePermission('journal:create'), async (req: Request, res: Response) => {
  if (!req.body.mode || typeof req.body.mode !== 'string') throw new AppError('Payment mode is required', 400);
  const data = await markRcmLiabilityPaid(
    req.tenant!,
    req.params.id,
    { paymentDate: parseDate(req.body.paymentDate, 'Payment date', true), mode: req.body.mode },
    req.user!.userId,
  );
  res.json({ success: true, data });
});

// G2g-7e — GSTR-2B import (brief §21). The request BODY is the raw GSTN GSTR-2B JSON payload
// itself (not wrapped in an envelope) — gstRegistrationId/financialYear/taxPeriod travel as query
// parameters so the hashed/stored payload is exactly, and only, what GSTN generated.
// `req.rawBody` is populated by app.ts's express.json() verify hook (the exact uploaded bytes);
// falling back to a re-serialization only if that hook somehow didn't run (defensive, not expected
// in practice). Reuses `report:financial_view` for both new G2g-7e routes, per the brief's own §22
// instruction ("do not create unnecessary permissions") applied consistently — see
// PHASE_G2G7E_AUDIT.md §4. No automatic reconciliation/accounting happens on import (brief §21/§23).
financeRouter.post('/gstr2b/import', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new AppError('Request body must be the GSTR-2B JSON payload (a JSON object).', 400);
  }
  const rawBytes = req.rawBody ?? Buffer.from(JSON.stringify(req.body), 'utf8');

  const data = await importGstr2bStatement(
    req.tenant!,
    {
      gstRegistrationId,
      rawPayload: req.body,
      rawBytes,
      financialYear: qs(req, 'financialYear'),
      taxPeriod: qs(req, 'taxPeriod'),
    },
    req.user!.userId,
  );
  res.status(201).json({ success: true, data });
});

// G2g-7e — GSTR-2B vs. books reconciliation report (brief §22). gstRegistrationId + taxPeriod
// (MMYYYY) are required; financialYear is optional (derived from taxPeriod when omitted). Returns a
// match for every current-statement document and every book document in scope — never a persisted
// cache, computed fresh every call (same posture as gstr3b-itc/gstr3b-rcm above).
financeRouter.get('/reports/gstr2b-reconciliation', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const taxPeriod = qs(req, 'taxPeriod');
  const financialYear = qs(req, 'financialYear');
  const branchId = qs(req, 'branchId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (!taxPeriod) throw new AppError('taxPeriod (MMYYYY) is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const data = await getGstr2bReconciliationReport(req.tenant!.companyId, {
    gstRegistrationId,
    taxPeriod,
    financialYear,
    branchAccess: req.tenant!.branchAccess,
    branchId,
  });
  res.json({ success: true, data });
});

// G2g-7f — composed GSTR-3B reconciliation report: outward liability (G2g-7b) + RCM (G2g-7d) + book
// ITC (G2g-7c) + GSTR-2B reconciliation (G2g-7e), merged into one report, plus a read-only GSTR-3B
// filing-period status lookup. This endpoint reimplements none of those four engines — see
// gstr3bReconciliation.service.ts. `gstRegistrationId` and `taxPeriod` (MMYYYY) are required (like
// gstr2b-reconciliation immediately above, not the from/to-flexible individual GSTR-3B reports,
// since GSTR-2B — one of the four composed inputs — is inherently a single calendar-month
// statement); `financialYear`/`branchId` are optional. Reuses `report:financial_view` — the same
// sensitivity bucket every GST/financial report in this router uses (J4-D1 convention); no new
// permission introduced, and this route creates/files/locks nothing.
financeRouter.get('/reports/gstr3b-reconciliation', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const taxPeriod = qs(req, 'taxPeriod');
  const financialYear = qs(req, 'financialYear');
  const branchId = qs(req, 'branchId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (!taxPeriod) throw new AppError('taxPeriod (MMYYYY) is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const data = await getGstr3bReconciliationReport(
    req.tenant!.companyId,
    { gstRegistrationId, taxPeriod, financialYear },
    { branchAccess: req.tenant!.branchAccess, branchId },
  );
  res.json({ success: true, data });
});

// G2g-4c-4 — GSTR-1 GSTN JSON export. Orchestrates the frozen adapter (G2g-4c-1) -> validator
// (G2g-4c-2) -> serializer (G2g-4c-3) pipeline (gstr1Export.service.ts) into a downloadable GSTN
// offline-tool-compatible JSON file, scoped to exactly one GST registration + period (+ optional
// branch). Reuses `report:financial_view` — the same permission every other GSTR-1 report route in
// this file already requires; no new permission was introduced for this phase. `gstRegistrationId`/
// `from`/`to` are all REQUIRED (same posture as gstr1-table13 immediately above — never defaulted).
// A validator-blocked export returns 400 with structured `blockers`/`warnings` and generates no
// file; a successful export returns the serializer's own output completely unwrapped (no
// `{success, data}` envelope) as a downloadable attachment — see gstr1Export.service.ts's own header
// for why that distinction matters for a filing artifact.
financeRouter.get('/reports/gstr1-export', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const fromStr = qs(req, 'from');
  const toStr = qs(req, 'to');
  const branchId = qs(req, 'branchId');

  const result = await buildGstr1GstnExport(
    req.tenant!,
    { gstRegistrationId: gstRegistrationId ?? '', from: fromStr ?? '', to: toStr ?? '', branchId },
    req.user!.userId,
  );

  if (!result.ok) {
    res.status(400).json({ success: false, error: 'GSTR-1 export failed filing-grade validation', blockers: result.blockers, warnings: result.warnings });
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.setHeader('X-Gstr1-Export-Warning-Count', String(result.warnings.length));
  res.send(JSON.stringify(result.wire));
});

// G2g-6b — GSTR-1 filing snapshot creation. Minimal route whose only job is to exercise
// gstr1FilingSnapshot.service.ts's full authorization chain (authenticate -> tenant context ->
// gst:snapshot_create -> the service's own registration/branch ownership checks) over real HTTP —
// no filing/GSP/ASP/API integration, no period-lock override, nothing beyond the one documented
// capability (see CLAUDE.md's G2g-6b entry). Uses the NEW `gst:snapshot_create` permission
// (G2g-6a's permission-catalog entry, cataloged but not granted to any starter role yet — same
// Role-Editor-delegates-it-when-ready posture as every other J4-class permission in this codebase).
financeRouter.post('/gstr1/snapshots', requirePermission('gst:snapshot_create'), async (req: Request, res: Response) => {
  const { gstRegistrationId, from, to, branchId } = req.body ?? {};
  const snapshot = await createGstr1FilingSnapshot(
    req.tenant!,
    { gstRegistrationId, from, to, branchId: branchId ?? null },
    req.user!.userId,
  );
  res.status(201).json({ success: true, data: snapshot });
});

// G2g-6c — GSTR-1 filing-attempt persistence/history, built on top of G2g-6a/6b above. Minimal
// routes whose only job is to exercise gstr1FilingAttempt.service.ts's full authorization chain
// over real HTTP — no GSTN/GSP/ASP integration, no FILED/LOCKED transition (see that file's own
// header / CLAUDE.md's G2g-6c scope boundary). Reuses the EXISTING `gst:filing_record` /
// `gst:period_view` permissions from G2g-6a's catalog entry — no new permission was introduced.
financeRouter.post('/gstr1/filing-attempts', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode } = req.body ?? {};
  const attempt = await createGstr1FilingAttempt(
    req.tenant!,
    { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode },
    req.user!.userId,
  );
  res.status(201).json({ success: true, data: attempt });
});

financeRouter.post('/gstr1/filing-attempts/:attemptId/outcome', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const { outcome, arn, externalReference, errorCode, errorMessage, responseMetadata } = req.body ?? {};
  const attempt = await recordGstr1FilingAttemptOutcome(
    req.tenant!,
    { attemptId: req.params.attemptId, outcome, arn, externalReference, errorCode, errorMessage, responseMetadata },
    req.user!.userId,
  );
  res.json({ success: true, data: attempt });
});

financeRouter.get('/gstr1/filing-attempts', requirePermission('gst:period_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const financialYear = qs(req, 'financialYear');
  const taxPeriod = qs(req, 'taxPeriod');
  const attempts = await listGstr1FilingAttempts(
    req.tenant!,
    { gstRegistrationId: gstRegistrationId ?? '', financialYear: financialYear ?? '', taxPeriod: taxPeriod ?? '' },
  );
  res.json({ success: true, data: attempts });
});

// G2g-6e — the authoritative FILED/LOCKED period-lifecycle boundary, built on top of G2g-6a/6b/6c/6d
// above. Reuses the EXISTING `gst:filing_record` permission (no new permission introduced — brief
// §17). The request body/path intentionally carry nothing but the one id each transition resolves
// everything else from server-side (brief §18): `attemptId` for /file (never a companyId/
// returnPeriodId/snapshotId the caller could use to point the transition at the wrong row), and
// `periodId` for /lock (the period being locked IS the resource in the URL, same convention as
// every other `/:id/action` route in this codebase — there is no narrower identity to resolve it
// from). See gstr1FilingPeriod.service.ts's own header for the full transition/concurrency rules.
financeRouter.post('/gstr1/filing-attempts/:attemptId/file', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const period = await fileGstr1ReturnPeriod(req.tenant!, { attemptId: req.params.attemptId }, req.user!.userId);
  res.json({ success: true, data: period });
});

financeRouter.post('/gstr1/periods/:periodId/lock', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const period = await lockGstr1ReturnPeriod(req.tenant!, { periodId: req.params.periodId }, req.user!.userId);
  res.json({ success: true, data: period });
});

// G2g-7g — GSTR-3B filing/export preparation. Composes the frozen G2g-7f reconciliation report into
// a canonical, statutorily-labeled export DTO + filing-readiness validation (gstr3bExport.service.ts)
// — no GSTN upload file exists for GSTR-3B the way GSTR-1 has one (see gstr3bGstnWire.types.ts's own
// header), so this returns a normal {success,data} JSON envelope rather than a downloadable
// attachment. Reuses `report:financial_view` per the brief's own explicit instruction for this exact
// route — same registration-ownership/branch-access checks as every sibling report route in this
// file (gstr3b-reconciliation immediately above), never left to the service layer alone.
financeRouter.get('/reports/gstr3b-export', requirePermission('report:financial_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const taxPeriod = qs(req, 'taxPeriod');
  const financialYear = qs(req, 'financialYear');
  const branchId = qs(req, 'branchId');

  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (!taxPeriod) throw new AppError('taxPeriod (MMYYYY) is required', 400);
  if (branchId) await assertBranchAccessible(branchId, req.tenant!);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, req.tenant!.companyId, 'GST registration');

  const data = await buildGstr3bGstnExport(req.tenant!, { gstRegistrationId, taxPeriod, financialYear, branchId }, req.user!.userId);
  res.json({ success: true, data });
});

// G2g-7g — GSTR-3B filing snapshot/attempt/period lifecycle, mirroring the GSTR-1 routes immediately
// above over the SAME generic GstReturnPeriod/GstFilingSnapshot/GstFilingAttempt tables with
// returnType='GSTR3B' (gstr3bFilingSnapshot/Attempt/Period.service.ts). Reuses the EXISTING
// `gst:snapshot_create`/`gst:filing_record`/`gst:period_view` permissions from G2g-6a's catalog entry
// — no new permission introduced, and these permissions were never GSTR1-specific in their string
// name to begin with.
financeRouter.post('/gstr3b/snapshots', requirePermission('gst:snapshot_create'), async (req: Request, res: Response) => {
  const { gstRegistrationId, taxPeriod, financialYear, branchId } = req.body ?? {};
  const snapshot = await createGstr3bFilingSnapshot(req.tenant!, { gstRegistrationId, taxPeriod, financialYear, branchId: branchId ?? null }, req.user!.userId);
  res.status(201).json({ success: true, data: snapshot });
});

financeRouter.post('/gstr3b/filing-attempts', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode } = req.body ?? {};
  const attempt = await createGstr3bFilingAttempt(req.tenant!, { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode }, req.user!.userId);
  res.status(201).json({ success: true, data: attempt });
});

financeRouter.post('/gstr3b/filing-attempts/:attemptId/outcome', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const { outcome, arn, externalReference, errorCode, errorMessage, responseMetadata } = req.body ?? {};
  const attempt = await recordGstr3bFilingAttemptOutcome(
    req.tenant!,
    { attemptId: req.params.attemptId, outcome, arn, externalReference, errorCode, errorMessage, responseMetadata },
    req.user!.userId,
  );
  res.json({ success: true, data: attempt });
});

financeRouter.get('/gstr3b/filing-attempts', requirePermission('gst:period_view'), async (req: Request, res: Response) => {
  const gstRegistrationId = qs(req, 'gstRegistrationId');
  const financialYear = qs(req, 'financialYear');
  const taxPeriod = qs(req, 'taxPeriod');
  const attempts = await listGstr3bFilingAttempts(
    req.tenant!,
    { gstRegistrationId: gstRegistrationId ?? '', financialYear: financialYear ?? '', taxPeriod: taxPeriod ?? '' },
  );
  res.json({ success: true, data: attempts });
});

financeRouter.post('/gstr3b/filing-attempts/:attemptId/file', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const period = await fileGstr3bReturnPeriod(req.tenant!, { attemptId: req.params.attemptId }, req.user!.userId);
  res.json({ success: true, data: period });
});

financeRouter.post('/gstr3b/periods/:periodId/lock', requirePermission('gst:filing_record'), async (req: Request, res: Response) => {
  const period = await lockGstr3bReturnPeriod(req.tenant!, { periodId: req.params.periodId }, req.user!.userId);
  res.json({ success: true, data: period });
});

financeRouter.get('/cost-centers', requirePermission('finance:view'), async (req: Request, res: Response) => {
  const centers = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.costCenter.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true },
    orderBy: { code: 'asc' },
  }));
  res.json({ success: true, data: centers });
});
