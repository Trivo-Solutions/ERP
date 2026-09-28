import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertBranchAccessible } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { parseDate, parseOptionalDate } from '../../shared/parseDate';
import * as svc from './sales.service';
import * as estimationSvc from '../tagging/estimation.service';
import { canAccessBranch } from '../../shared/tenantContext';
import { prisma } from '../../config/database';
import { tenantQuery } from '../../shared/tenantContext';

const withPaymentDates = (payments: unknown) =>
  Array.isArray(payments)
    ? payments.map((p) => ({ ...p, paymentDate: parseDate(p?.paymentDate, 'Payment date', true) }))
    : payments;

export const salesRouter = Router();
salesRouter.use(authenticate, resolveTenantContext);

// Memo Out
salesRouter.get('/memos', requirePermission('memo:manage'), async (req: Request, res: Response) => {
  const memos = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.memoOut.findMany({
    where: {
      companyId: req.tenant!.companyId,
      ...(req.query.status && { status: req.query.status as string }),
      ...(!req.tenant!.branchAccess.allBranches && { branchId: { in: req.tenant!.branchAccess.branchIds } }),
    },
    include: { client: { select: { name: true, clientCode: true } }, items: true },
    orderBy: { sentDate: 'desc' },
  }));
  res.json({ success: true, data: memos });
});

salesRouter.post('/memos', requirePermission('memo:manage'), async (req: Request, res: Response) => {
  const body = { ...req.body, sentDate: parseDate(req.body.sentDate, 'Sent date'), returnDeadline: parseDate(req.body.returnDeadline, 'Return deadline') };
  const memo = await svc.createMemoOut(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: memo });
});

salesRouter.post('/memos/check-alerts', requirePermission('memo:manage'), async (req: Request, res: Response) => {
  const count = await svc.checkMemoAlerts(req.tenant!.companyId);
  res.json({ success: true, message: `${count} alerts sent` });
});

salesRouter.post('/memos/:id/return', requirePermission('memo:manage'), async (req: Request, res: Response) => {
  const memo = await svc.returnMemoItems(req.params.id, req.body.tagIds, req.tenant!, req.user!.userId);
  res.json({ success: true, data: memo });
});

salesRouter.post('/memos/:id/convert', requirePermission('memo:manage'), async (req: Request, res: Response) => {
  const invoice = await svc.convertMemoToInvoice(req.params.id, req.body.items, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: invoice });
});

// H1: Sales register — every invoice (retail + wholesale) in a date range.
salesRouter.get('/reports/register', requirePermission('report:view'), async (req: Request, res: Response) => {
  const fromStr = req.query.from as string ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const toStr = req.query.to as string ?? new Date().toISOString();
  const data = await svc.getSalesRegister(req.tenant!, {
    from: new Date(fromStr), to: new Date(toStr),
    salesPersonId: req.query.salesPersonId as string | undefined,
    branchId: req.query.branchId as string | undefined,
  });
  res.json({ success: true, data });
});

// Invoices
salesRouter.get('/invoices', requirePermission('sales:view'), async (req: Request, res: Response) => {
  // Optional invoice-date range, both ends inclusive (`to` is a calendar day, so it runs to the end of that day).
  // Without a range only the latest 50 come back; with one, everything in it (capped) — that is how older
  // invoices are reached.
  const from = typeof req.query.from === 'string' ? parseOptionalDate(req.query.from, 'From date') : undefined;
  const toDay = typeof req.query.to === 'string' ? parseOptionalDate(req.query.to, 'To date') : undefined;
  const toExclusive = toDay && new Date(toDay.getTime() + 24 * 60 * 60 * 1000);
  const invoices = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesInvoice.findMany({
    where: {
      companyId: req.tenant!.companyId,
      ...(req.query.status && { status: req.query.status as string }),
      ...((from || toExclusive) && { invoiceDate: { ...(from && { gte: from }), ...(toExclusive && { lt: toExclusive }) } }),
      ...(!req.tenant!.branchAccess.allBranches && { branchId: { in: req.tenant!.branchAccess.branchIds } }),
    },
    include: {
      client: { select: { name: true, clientCode: true } },
      branch: { select: { name: true } },
      salesPerson: { select: { name: true } },
      taxDetails: { select: { placeOfSupply: true, gstin: true, taxableAmount: true, cgst: true, sgst: true, igst: true, totalTax: true } },
      payments: { select: { mode: true } },
      items: { select: { quantity: true, grossWeight: true, netGoldWeight: true, stoneWeight: true } },
      _count: { select: { items: true } },
    },
    orderBy: { invoiceDate: 'desc' },
    take: from || toExclusive ? 2000 : 50,
  }));
  // The list screen's optional columns: pieces and weights summed over the lines (weights are per piece, so x quantity),
  // and the modes the bill was paid in. Computed here so the lines themselves never ride along on a 2,000-row list.
  const data = invoices.map(({ items, payments, ...inv }) => ({
    ...inv,
    totals: {
      quantity: items.reduce((s, i) => s + i.quantity, 0),
      grossWeight: items.reduce((s, i) => s + Number(i.grossWeight) * i.quantity, 0),
      netWeight: items.reduce((s, i) => s + Number(i.netGoldWeight) * i.quantity, 0),
      stoneWeight: items.reduce((s, i) => s + Number(i.stoneWeight) * i.quantity, 0),
    },
    paymentModes: Array.from(new Set(payments.map((p) => p.mode))),
  }));
  res.json({ success: true, data });
});

salesRouter.get('/invoices/:id', requirePermission('sales:view'), async (req: Request, res: Response) => {
  // Layer 2: 404 (not findUniqueOrThrow's generic 500-on-P2025) for a wrong-company id — same
  // "look indistinguishable from nonexistent" rule as every other direct-id lookup.
  const invoice = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesInvoice.findUnique({
    where: { id: req.params.id },
    include: {
      client: true, items: { include: { hsnCode: true, category: true } }, taxDetails: true,
      payments: true, exportDocs: true, salesPerson: { select: { id: true, name: true } },
    },
  }));
  if (!invoice || invoice.companyId !== req.tenant!.companyId ||
    (!req.tenant!.branchAccess.allBranches && !req.tenant!.branchAccess.branchIds.includes(invoice.branchId))) {
    return res.status(404).json({ success: false, error: 'Invoice not found' });
  }
  res.json({ success: true, data: invoice });
});

// Lightweight staff picker for the "Sales Executive" field — same permission gate as creating the
// invoice itself, so anyone who can open the New Sale form can already see this list. Scoped via
// CompanyUser (User itself carries no companyId — see the multi-tenant blueprint's explicit
// reasoning for why User stays a global identity) rather than a bare User scan, which would
// otherwise list every company's staff.
salesRouter.get('/staff', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const staff = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.companyUser.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true, user: { isActive: true } },
    // employeeId is this company's own fact about the person (CompanyUser), not a global User field.
    select: { userId: true, employeeId: true, user: { select: { name: true } } },
  }));
  res.json({
    success: true,
    // `id` stays the User id: SalesInvoice.salesPersonId references User.
    data: staff.map((s) => ({ id: s.userId, name: s.user.name, employeeId: s.employeeId })),
  });
});

// The billing screen's "load from estimate": estimates an estimator has sent to billing, findable by estimate
// number, item / tag name, or customer name. Sale-side data only. Rides on invoice:create — the biller does not
// need estimation:view to pick up an estimate that was sent to them.
salesRouter.get('/estimates', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await estimationSvc.searchBillableEstimates(req.tenant!, req.query.q as string | undefined) });
});

// Branches the caller may bill from (the invoice needs one). tag:view is not required just to bill.
salesRouter.get('/branches', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const branches = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.branch.findMany({
    where: { companyId: req.tenant!.companyId, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, branchCode: true },
  }));
  res.json({ success: true, data: branches.filter((b) => canAccessBranch(req.tenant!, b.id)) });
});

// HSN codes/rates + same-state vs inter-state for a customer — the New Sale screen's GST preview.
salesRouter.get('/tax-context', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  res.json({ success: true, data: await svc.getTaxContext(req.tenant!, clientId) });
});

salesRouter.post('/invoices', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  // JSON has no Date type — invoiceDate/dueDate arrive as ISO strings and must be coerced before
  // reaching createInvoice(), which calls real Date methods on them (.getFullYear() for the new
  // company-scoped invoice-number sequence, .toDateString() in an existing error path).
  const body = {
    ...req.body,
    invoiceDate: parseDate(req.body.invoiceDate, 'Invoice date'),
    ...(req.body.dueDate && { dueDate: parseDate(req.body.dueDate, 'Due date') }),
    // bill-and-collect: each split's date is a JSON string too
    ...(req.body.payments !== undefined && { payments: withPaymentDates(req.body.payments) }),
  };
  const invoice = await svc.createInvoice(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: invoice });
});

// Amend an issued invoice (full new state — see amendInvoice). Its own permission, deliberately not invoice:create:
// changing a bill that already moved stock, GST and the ledger is an admin-level act.
salesRouter.put('/invoices/:id', requirePermission('invoice:edit'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const body = {
    ...b,
    ...(b.invoiceDate !== undefined && { invoiceDate: parseDate(b.invoiceDate, 'Invoice date') }),
    ...(b.dueDate ? { dueDate: parseDate(b.dueDate, 'Due date') } : b.dueDate === null || b.dueDate === '' ? { dueDate: null } : { dueDate: undefined }),
  };
  const invoice = await svc.amendInvoice(req.params.id, body, req.tenant!, req.user!.userId);
  res.json({ success: true, data: invoice });
});

salesRouter.post('/invoices/:id/payment', requirePermission('payment:create'), async (req: Request, res: Response) => {
  await svc.recordPayment({ invoiceId: req.params.id, ...req.body, paymentDate: parseDate(req.body.paymentDate, 'Payment date', true) }, req.tenant!, req.user!.userId);
  res.json({ success: true, message: 'Payment recorded' });
});

// J3 Decision 5: Void — a whole-invoice reversal, distinct from invoice:edit (amend). SUPER_ADMIN-only
// initially (not granted to any starter role — see permissionCatalog.ts / CLAUDE.md).
salesRouter.post('/invoices/:id/void', requirePermission('invoice:void'), async (req: Request, res: Response) => {
  const result = await svc.voidInvoice(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: result });
});

// J3 Decision 1/2: reverse a receipt (never edit/delete the original row) — see reverseInvoicePayment.
// SUPER_ADMIN-only initially, same posture as invoice:void.
salesRouter.post('/payments/:id/reverse', requirePermission('payment:reverse'), async (req: Request, res: Response) => {
  const result = await svc.reverseInvoicePayment(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: { paymentId: req.params.id, invoice: result.invoiceAfter, exchangeReversed: result.exchangeReversal } });
});

salesRouter.get('/invoices/:id/packing-list', requirePermission('export:doc'), async (req: Request, res: Response) => {
  const packingList = await svc.generatePackingList(req.tenant!, req.params.id);
  res.json({ success: true, data: packingList });
});

// On-account client payments (F2) — an advance, or a payment against a client's general
// outstanding balance rather than one specific invoice. J4-D6: payment:view is now its own
// permission, independently delegable from general sales visibility.
salesRouter.get('/clients/:clientId/payments', requirePermission('payment:view'), async (req: Request, res: Response) => {
  const payments = await svc.listClientPayments(req.tenant!, req.params.clientId);
  res.json({ success: true, data: payments });
});

salesRouter.post('/clients/:clientId/payments', requirePermission('payment:create'), async (req: Request, res: Response) => {
  const payment = await svc.recordClientPayment({ clientId: req.params.clientId, ...req.body, paymentDate: parseDate(req.body.paymentDate, 'Payment date', true) }, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: payment });
});

// Credit a customer holds (from sales returns / old-gold exchanges) that the New Sale screen can spend as the
// "Store Credit" payment mode. J3 Decision 7: reclassified from invoice:create to client:view — it only reads
// Client-domain data (Client.currentBalance), it does not create anything.
salesRouter.get('/clients/:clientId/credit', requirePermission('client:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getClientCredit(req.tenant!, req.params.clientId) });
});

// Sale Returns (D1)
salesRouter.get('/returns', requirePermission('sales:view'), async (req: Request, res: Response) => {
  const returns = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.salesReturn.findMany({
    where: {
      companyId: req.tenant!.companyId,
      ...(req.query.invoiceId && { invoiceId: req.query.invoiceId as string }),
    },
    include: { items: { include: { tag: { select: { tagNumber: true } } } } },
    orderBy: { returnDate: 'desc' },
  }));
  res.json({ success: true, data: returns });
});

salesRouter.post('/returns', requirePermission('return:create'), async (req: Request, res: Response) => {
  const salesReturn = await svc.createSalesReturn(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: salesReturn });
});

// Old Gold Exchange (D4)
salesRouter.get('/exchanges', requirePermission('sales:view'), async (req: Request, res: Response) => {
  const exchanges = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.oldGoldExchange.findMany({
    where: {
      companyId: req.tenant!.companyId,
      ...(req.query.clientId && { clientId: req.query.clientId as string }),
    },
    include: { client: { select: { name: true, clientCode: true } }, metalStock: { select: { stockCode: true } } },
    orderBy: { exchangeDate: 'desc' },
  }));
  res.json({ success: true, data: exchanges });
});

salesRouter.post('/exchanges', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const body = { ...req.body, ...(req.body.exchangeDate && { exchangeDate: parseDate(req.body.exchangeDate, 'Exchange date') }) };
  const exchange = await svc.createOldGoldExchange(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: exchange });
});
