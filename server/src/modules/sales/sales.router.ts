import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext, assertBranchAccessible } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { parseDate, parseOptionalDate } from '../../shared/parseDate';
import * as svc from './sales.service';
import * as advanceSvc from './customerAdvance.service';
import * as salesReportSvc from './salesReport.service';
import * as creditNoteSvc from './creditNote.service';
import * as salesDebitNoteSvc from './salesDebitNote.service';
import * as taxInvoiceTemplateSvc from './taxInvoiceTemplate.service';
import * as creditNoteTemplateSvc from './creditNoteTemplate.service';
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

// Sales Report — Summary (one row per invoice) and Detailed (per employee, per line). Same permission as the register.
const salesReportFilters = (req: Request) => {
  const str = (k: string) => (typeof req.query[k] === 'string' && (req.query[k] as string).trim() ? (req.query[k] as string).trim() : undefined);
  return {
    from: parseOptionalDate(str('from'), 'From date'), to: parseOptionalDate(str('to'), 'To date'),
    branchId: str('branchId'), invoiceNo: str('invoiceNo'), customer: str('customer'),
    salesPersonId: str('salesPersonId'), paymentStatus: str('paymentStatus'), status: str('status'),
  };
};
salesRouter.get('/reports/sales-summary', requirePermission('report:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await salesReportSvc.getSalesSummary(req.tenant!, salesReportFilters(req)) });
});
salesRouter.get('/reports/sales-detailed', requirePermission('report:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await salesReportSvc.getSalesDetailed(req.tenant!, salesReportFilters(req)) });
});

// Invoices
salesRouter.get('/invoices',requirePermission('sales:view'), async (req: Request, res: Response) => {
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
      client: true, taxDetails: true,
      items: {
        include: {
          hsnCode: true, category: true,
          // The piece's own particulars + material rows (stones, metal) for the template's jewellery-detail columns.
          tag: {
            select: {
              name: true, metalType: true, settingType: true,
              subCategory: { select: { name: true } }, collection: { select: { name: true } }, size: { select: { name: true } },
              materials: { select: { code: true, materialType: true, size: true, pieces: true, weight: true, unit: true, saleRate: true, saleAmount: true } },
            },
          },
        },
      },
      payments: true, exportDocs: true, salesPerson: { select: { id: true, name: true } },
      // For the tax-invoice template's Branch fields (name/code/address/phone/email).
      branch: { select: { name: true, branchCode: true, address: true, city: true, state: true, phone: true, email: true } },
    },
  }));
  if (!invoice || invoice.companyId !== req.tenant!.companyId ||
    (!req.tenant!.branchAccess.allBranches && !req.tenant!.branchAccess.branchIds.includes(invoice.branchId))) {
    return res.status(404).json({ success: false, error: 'Invoice not found' });
  }
  // G1 Part H: resolve which tax-invoice template this invoice's own branch prints under —
  // branch override, else the company default, else the safe built-in fallback — so the browser
  // print (printInvoice.ts) never needs its own template-resolution logic.
  const printTemplate = await taxInvoiceTemplateSvc.resolveTaxInvoiceTemplate(req.tenant!.companyId, invoice.branchId);
  res.json({ success: true, data: { ...invoice, printTemplate } });
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
  // G1 Part H: same resolved-template attachment as GET /invoices/:id, so an immediate
  // bill-then-print (NewSalePage's own flow) already gets the branch's/company's real template,
  // not just the safe built-in default it would otherwise silently fall back to.
  const printTemplate = await taxInvoiceTemplateSvc.resolveTaxInvoiceTemplate(req.tenant!.companyId, invoice.branchId);
  res.status(201).json({ success: true, data: { ...invoice, printTemplate } });
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

// Customer Advances (Phase 2) — money received before any invoice; a liability, not Store Credit.
salesRouter.get('/advances', requirePermission('payment:view'), async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const day = (v: string | undefined, label: string, endOfDay = false) => {
    if (!v) return undefined;
    const d = parseDate(v, label);
    if (endOfDay) d.setDate(d.getDate() + 1);
    return d;
  };
  const data = await advanceSvc.listCustomerAdvances(req.tenant!, {
    dateFrom: day(q.dateFrom, 'Date from'), dateTo: day(q.dateTo, 'Date to', true),
    clientId: q.clientId, branchId: q.branchId, advanceNumber: q.advanceNumber, mode: q.mode, createdById: q.createdById, status: q.status,
  });
  res.json({ success: true, data });
});

salesRouter.post('/advances', requirePermission('payment:create'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const { advance, replayed } = await advanceSvc.createCustomerAdvance(
    { clientId: b.clientId, branchId: b.branchId, amount: b.amount, mode: b.mode, referenceNo: b.referenceNo, notes: b.notes, idempotencyKey: b.idempotencyKey },
    req.tenant!, req.user!.userId,
  );
  res.status(replayed ? 200 : 201).json({ success: true, data: advance, replayed });
});

salesRouter.get('/advances/:id', requirePermission('payment:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await advanceSvc.getCustomerAdvance(req.tenant!, req.params.id) });
});

// Phase 3: the customer's advances still holding money (oldest first) for the bill screen — same gate as Store Credit
// (client:view). Not narrowed to the caller's branches: an advance taken at one branch can be spent at another.
salesRouter.get('/clients/:clientId/advances/available', requirePermission('client:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await advanceSvc.listAvailableAdvances(req.tenant!, req.params.clientId) });
});

salesRouter.get('/advances/:id/applications', requirePermission('payment:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await advanceSvc.listAdvanceApplications(req.tenant!, req.params.id) });
});

// Apply advance(s) to an existing invoice: { allocations: [{ advanceId, amount }] } or { auto: true, maxAmount? }.
salesRouter.post('/invoices/:id/apply-advances', requirePermission('payment:create'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const data = await advanceSvc.applyCustomerAdvance(
    req.params.id,
    { allocations: b.allocations, auto: b.auto === true, maxAmount: b.maxAmount, idempotencyKey: b.idempotencyKey },
    req.tenant!, req.user!.userId,
  );
  res.status(data.replayed ? 200 : 201).json({ success: true, data });
});

salesRouter.post('/advances/:id/reverse', requirePermission('payment:reverse'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await advanceSvc.reverseCustomerAdvance(req.params.id, req.tenant!, req.user!.userId, req.body?.reason) });
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
    include: {
      client: { select: { name: true } },
      invoice: { select: { invoiceNumber: true, branch: { select: { name: true } } } },
      // Each returned tagged line's Repair Register row says what became of the piece (the register itself stays
      // the financial one — repair transactions live in the Repair Register, not here).
      items: { include: {
        tag: { select: { tagNumber: true, name: true, status: true, branch: { select: { name: true } } } },
        repairCase: { select: { id: true, repairNumber: true, status: true, inspectionResult: true } },
      } },
    },
    orderBy: { returnDate: 'desc' },
  }));
  res.json({
    success: true,
    data: returns.map((r) => {
      const cases = r.items.map((i) => i.repairCase).filter((c): c is NonNullable<typeof c> => !!c);
      // Inspection status of the return as a whole: none for a material-only return, PENDING until every piece is cleared.
      const inspectionStatus = cases.length === 0 ? 'NOT_APPLICABLE'
        : cases.every((c) => c.status === 'INSPECTION_PASSED') ? 'PASSED'
        : cases.some((c) => ['MELT_PENDING', 'RETAGGED'].includes(c.status)) && cases.every((c) => ['INSPECTION_PASSED', 'MELT_PENDING', 'RETAGGED'].includes(c.status)) ? 'COMPLETED'
        : 'PENDING';
      return { ...r, customerName: r.client.name, invoiceNumber: r.invoice.invoiceNumber, branchName: r.invoice.branch?.name ?? null, inspectionStatus };
    }),
  });
});

salesRouter.post('/returns', requirePermission('return:create'), async (req: Request, res: Response) => {
  // G2c: issueCreditNote is additive and opt-in — omitted (the existing default), behavior is
  // completely unchanged for every current caller.
  const { issueCreditNote, ...body } = req.body ?? {};
  const salesReturn = await svc.createSalesReturn(body, req.tenant!, req.user!.userId, { issueCreditNote: !!issueCreditNote });
  res.status(201).json({ success: true, data: salesReturn });
});

// G2c — Credit Notes (GST Credit Note lifecycle; see PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §3/§19).
salesRouter.get('/credit-notes', requirePermission('creditNote:view'), async (req: Request, res: Response) => {
  const notes = await creditNoteSvc.listCreditNotes(req.tenant!, {
    clientId: req.query.clientId as string | undefined,
    invoiceId: req.query.invoiceId as string | undefined,
    status: req.query.status as string | undefined,
    from: parseOptionalDate(req.query.from, 'From date'),
    to: parseOptionalDate(req.query.to, 'To date'),
  });
  res.json({ success: true, data: notes });
});

salesRouter.get('/credit-notes/:id', requirePermission('creditNote:view'), async (req: Request, res: Response) => {
  const note = await creditNoteSvc.getCreditNoteById(req.tenant!, req.params.id);
  const printTemplate = await creditNoteTemplateSvc.resolveCreditNoteTemplate(req.tenant!.companyId, note.invoice?.branchId);
  res.json({ success: true, data: { ...note, printTemplate } });
});

// Path B — standalone, value-only credit note against an invoice with no physical return.
salesRouter.post('/credit-notes', requirePermission('creditNote:create'), async (req: Request, res: Response) => {
  const body = { ...req.body, creditNoteDate: parseOptionalDate(req.body?.creditNoteDate, 'Credit note date') };
  const note = await creditNoteSvc.createStandaloneCreditNote(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: note });
});

// Path A — wraps an existing Sales Return with no Credit Note yet, a deliberate, separate,
// auditable action taken after the return itself succeeds (see design §19's note on this shape).
salesRouter.post('/returns/:returnId/credit-note', requirePermission('creditNote:create'), async (req: Request, res: Response) => {
  const note = await creditNoteSvc.createCreditNoteForExistingReturn(req.params.returnId, req.tenant!, req.user!.userId, { reasonNotes: req.body?.reasonNotes });
  res.status(201).json({ success: true, data: note });
});

// SUPER_ADMIN-only initially — same posture as invoice:void/payment:reverse (not granted to any starter role).
salesRouter.post('/credit-notes/:id/cancel', requirePermission('creditNote:cancel'), async (req: Request, res: Response) => {
  const result = await creditNoteSvc.cancelCreditNote(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: result });
});

// G2g-4b — Sales (outward) Debit Note. A wholly separate domain/permission family from the
// procurement-side DebitNote (debitNote:*) — never reused or extended, per CLAUDE.md.
salesRouter.get('/debit-notes', requirePermission('salesDebitNote:view'), async (req: Request, res: Response) => {
  const notes = await salesDebitNoteSvc.listSalesDebitNotes(req.tenant!, {
    clientId: req.query.clientId as string | undefined,
    invoiceId: req.query.invoiceId as string | undefined,
    status: req.query.status as string | undefined,
    from: parseOptionalDate(req.query.from, 'From date'),
    to: parseOptionalDate(req.query.to, 'To date'),
  });
  res.json({ success: true, data: notes });
});

salesRouter.get('/debit-notes/:id', requirePermission('salesDebitNote:view'), async (req: Request, res: Response) => {
  const note = await salesDebitNoteSvc.getSalesDebitNoteById(req.tenant!, req.params.id);
  res.json({ success: true, data: note });
});

salesRouter.post('/debit-notes', requirePermission('salesDebitNote:create'), async (req: Request, res: Response) => {
  const body = { ...req.body, debitNoteDate: parseOptionalDate(req.body?.debitNoteDate, 'Debit note date') };
  const note = await salesDebitNoteSvc.createSalesDebitNote(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: note });
});

// SUPER_ADMIN-only initially — same posture as credit-notes/:id/cancel above (not granted to any starter role).
salesRouter.post('/debit-notes/:id/cancel', requirePermission('salesDebitNote:cancel'), async (req: Request, res: Response) => {
  const result = await salesDebitNoteSvc.cancelSalesDebitNote(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: result });
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

// Material Purchase — non-tagged old gold bought at a tested purity; creates the customer's Store Credit + a Metal Vault lot.
salesRouter.get('/material-purchases', requirePermission('sales:view'), async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: await svc.listMaterialPurchases(req.tenant!, {
      clientId: req.query.clientId as string | undefined,
      from: parseOptionalDate(req.query.from, 'From date'),
      to: parseOptionalDate(req.query.to, 'To date'),
      branchId: (req.query.branchId as string) || undefined,
      metalType: (req.query.metalType as string) || undefined,
      exchangeNumber: (req.query.exchangeNumber as string) || undefined,
      createdById: (req.query.createdById as string) || undefined,
    }),
  });
});

salesRouter.post('/material-purchases', requirePermission('invoice:create'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  // Only the physical facts are read: value, fine weight and rates are always the server's own.
  const purchase = await svc.createMaterialPurchase({
    clientId: b.clientId, branchId: b.branchId, metalType: b.metalType, grossWeight: b.grossWeight,
    testedPurityPercent: b.testedPurityPercent, description: b.description, notes: b.notes, idempotencyKey: b.idempotencyKey,
    ...(b.purchaseDate && { purchaseDate: parseDate(b.purchaseDate, 'Purchase date') }),
  }, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: purchase });
});

// G1 Part F/L — Tax Invoice Templates. view is separate from create/edit (same reasoning as
// estimateTemplate: printing/resolving a template needs read access, not edit rights on the designer).
salesRouter.get('/tax-invoice-templates', requirePermission('taxInvoiceTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await taxInvoiceTemplateSvc.listTaxInvoiceTemplates(req.tenant!.companyId) });
});

salesRouter.get('/tax-invoice-templates/default-layout', requirePermission('taxInvoiceTemplate:view'), async (_req: Request, res: Response) => {
  res.json({ success: true, data: taxInvoiceTemplateSvc.buildDefaultLayout() });
});

salesRouter.get('/tax-invoice-templates/:id', requirePermission('taxInvoiceTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await taxInvoiceTemplateSvc.getTaxInvoiceTemplateById(req.tenant!.companyId, req.params.id) });
});

salesRouter.post('/tax-invoice-templates', requirePermission('taxInvoiceTemplate:create'), async (req: Request, res: Response) => {
  const t = await taxInvoiceTemplateSvc.createTaxInvoiceTemplate(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});

salesRouter.put('/tax-invoice-templates/:id', requirePermission('taxInvoiceTemplate:edit'), async (req: Request, res: Response) => {
  const t = await taxInvoiceTemplateSvc.updateTaxInvoiceTemplate(req.tenant!.companyId, req.params.id, req.body);
  res.json({ success: true, data: t });
});

salesRouter.post('/tax-invoice-templates/:id/duplicate', requirePermission('taxInvoiceTemplate:create'), async (req: Request, res: Response) => {
  const t = await taxInvoiceTemplateSvc.duplicateTaxInvoiceTemplate(req.tenant!.companyId, req.params.id, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});

// G2d — Credit Note Templates (mirrors Tax Invoice Templates)
salesRouter.get('/credit-note-templates', requirePermission('creditNoteTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await creditNoteTemplateSvc.listCreditNoteTemplates(req.tenant!.companyId) });
});

salesRouter.get('/credit-note-templates/default-layout', requirePermission('creditNoteTemplate:view'), async (_req: Request, res: Response) => {
  res.json({ success: true, data: creditNoteTemplateSvc.buildDefaultCreditNoteLayout() });
});

salesRouter.get('/credit-note-templates/:id', requirePermission('creditNoteTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await creditNoteTemplateSvc.getCreditNoteTemplateById(req.tenant!.companyId, req.params.id) });
});

salesRouter.post('/credit-note-templates', requirePermission('creditNoteTemplate:create'), async (req: Request, res: Response) => {
  const t = await creditNoteTemplateSvc.createCreditNoteTemplate(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});

salesRouter.put('/credit-note-templates/:id', requirePermission('creditNoteTemplate:edit'), async (req: Request, res: Response) => {
  const t = await creditNoteTemplateSvc.updateCreditNoteTemplate(req.tenant!.companyId, req.params.id, req.body);
  res.json({ success: true, data: t });
});

salesRouter.post('/credit-note-templates/:id/duplicate', requirePermission('creditNoteTemplate:create'), async (req: Request, res: Response) => {
  const t = await creditNoteTemplateSvc.duplicateCreditNoteTemplate(req.tenant!.companyId, req.params.id, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});
