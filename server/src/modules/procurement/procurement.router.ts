import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { prisma } from '../../config/database';
import * as svc from './procurement.service';
import * as vendorRateSvc from './vendorRate.service';
import * as debitNoteSvc from './debitNote.service';
import * as debitNoteTemplateSvc from './debitNoteTemplate.service';
import { tenantQuery } from '../../shared/tenantContext';
import { parseDate, parseOptionalDate } from '../../shared/parseDate';
import { hasPermission } from '../../middleware/rbac';

export const procurementRouter = Router();
procurementRouter.use(authenticate, resolveTenantContext);

// Purchase Requisitions
procurementRouter.get('/requisitions', requirePermission('po:view'), async (req: Request, res: Response) => {
  const result = await svc.listPRs(req.tenant!, {
    status: req.query.status as string,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
  });
  res.json({ success: true, ...result });
});

procurementRouter.post('/requisitions', requirePermission('po:create'), async (req: Request, res: Response) => {
  const pr = await svc.createPR(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: pr });
});

procurementRouter.get('/requisitions/:id', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getPR(req.tenant!, req.params.id) });
});

procurementRouter.post('/requisitions/:id/submit', requirePermission('po:create'), async (req: Request, res: Response) => {
  const pr = await svc.submitPR(req.params.id, req.tenant!, req.user!.userId);
  res.json({ success: true, data: pr });
});

procurementRouter.post('/requisitions/:id/approve', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const pr = await svc.approvePR(req.params.id, req.tenant!, req.user!.userId, req.body.comments);
  res.json({ success: true, data: pr });
});

procurementRouter.post('/requisitions/:id/reject', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const pr = await svc.rejectPR(req.params.id, req.tenant!, req.user!.userId, req.body.comments);
  res.json({ success: true, data: pr });
});

procurementRouter.post('/requisitions/:id/convert', requirePermission('po:create'), async (req: Request, res: Response) => {
  const po = await svc.convertToPO(req.params.id, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: po });
});

// Suppliers — company-owned (Phase 3 — reversed the earlier "keep global" call: Supplier carries
// private business data, same as Client).
procurementRouter.get('/suppliers', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listSuppliers(req.tenant!.companyId) });
});

procurementRouter.post('/suppliers', requirePermission('po:create'), async (req: Request, res: Response) => {
  const supplier = await svc.createSupplier(req.body, req.tenant!.companyId);
  res.status(201).json({ success: true, data: supplier });
});

// Purchase Orders
procurementRouter.get('/orders', requirePermission('po:view'), async (req: Request, res: Response) => {
  const result = await svc.listPOs(req.tenant!, {
    status: req.query.status as string,
    supplierId: req.query.supplierId as string,
    poType: req.query.poType as string,
    dateFrom: req.query.dateFrom ? new Date(req.query.dateFrom as string) : undefined,
    dateTo: req.query.dateTo ? new Date(req.query.dateTo as string) : undefined,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
  });
  res.json({ success: true, ...result });
});

procurementRouter.get('/orders/:id', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getPO(req.tenant!, req.params.id) });
});

procurementRouter.post('/orders', requirePermission('po:create'), async (req: Request, res: Response) => {
  // JSON dates arrive as strings; createPO calls getFullYear() on orderDate (document number).
  const body = { ...req.body, orderDate: parseDate(req.body.orderDate, 'Order date', true), expectedDate: parseOptionalDate(req.body.expectedDate, 'Expected date') };
  const po = await svc.createPO(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: po });
});

// Layer 2: a Company-B poId must 404, not let a status be forced onto another company's order.
procurementRouter.patch('/orders/:id/status', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const existing = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.purchaseOrder.findUnique({ where: { id: req.params.id }, select: { companyId: true } }));
  if (!existing || existing.companyId !== req.tenant!.companyId) throw new AppError('Purchase Order not found', 404);
  const po = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.purchaseOrder.update({
    where: { id: req.params.id },
    data: { status: req.body.status },
  }));
  res.json({ success: true, data: po });
});

// Vendor component rates (stone / pearl / bead cost rates a new PO line defaults from)
procurementRouter.get('/vendor-rates', requirePermission('po:view'), async (req: Request, res: Response) => {
  const supplierId = typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
  res.json({ success: true, data: await vendorRateSvc.listVendorRates(req.tenant!, { supplierId, activeOnly: req.query.activeOnly === 'true' }) });
});
procurementRouter.get('/vendor-rates/resolve', requirePermission('po:view'), async (req: Request, res: Response) => {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const supplierId = s(req.query.supplierId), stoneTypeId = s(req.query.stoneTypeId);
  if (!supplierId || !stoneTypeId) throw new AppError('supplierId and stoneTypeId are required', 400);
  const asOf = parseOptionalDate(req.query.asOf, 'As-of date');
  res.json({ success: true, data: await vendorRateSvc.previewVendorRate(req.tenant!, { supplierId, stoneTypeId, stoneGradeId: s(req.query.stoneGradeId), unit: s(req.query.unit), asOf }) });
});
procurementRouter.post('/vendor-rates',requirePermission('po:create'), async (req: Request, res: Response) => {
  const body = { ...req.body, effectiveDate: parseOptionalDate(req.body.effectiveDate, 'Effective date') };
  res.status(201).json({ success: true, data: await vendorRateSvc.createVendorRate(req.tenant!, req.user!.userId, body) });
});
procurementRouter.patch('/vendor-rates/:id', requirePermission('po:create'), async (req: Request, res: Response) => {
  const { costRate, notes, isActive } = req.body;
  res.json({ success: true, data: await vendorRateSvc.updateVendorRate(req.tenant!, req.user!.userId, req.params.id, { costRate, notes, isActive }) });
});

// GRN
// J4-D5: view is now its own permission — grn:create still gates POST /grn below.
procurementRouter.get('/grn', requirePermission('grn:view'), async (req: Request, res: Response) => {
  const grns = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.goodsReceiptNote.findMany({
    where: { companyId: req.tenant!.companyId },
    include: {
      po: { include: { supplier: { select: { name: true } } } },
      branch: { select: { id: true, name: true } },
      // Each line, with the tag it became (finished-goods intake) — drives the "Tag" action on the GRN page.
      grnItems: {
        include: {
          poItem: { select: { materialCode: true, materialName: true, materialType: true, karat: true, weight: true, netWeight: true, quantity: true, totalAmount: true } },
          jewelryTag: { select: { id: true, tagNumber: true } },
          // FINISHED_LOT lines: the bag this receipt opened (tagged piece by piece from New Tag).
          // grossWeight/netWeight + what its tags already carry: the GRN page shows how much of the bag is still untagged.
          purchaseLot: { select: { id: true, pieces: true, status: true, netWeight: true, tags: { select: { netWeight: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  }));
  res.json({ success: true, data: grns });
});

procurementRouter.post('/grn', requirePermission('grn:create'), async (req: Request, res: Response) => {
  const body = {
    ...req.body,
    receivedDate: parseDate(req.body.receivedDate, 'Received date', true),
    invoiceDate: parseOptionalDate(req.body.invoiceDate, 'Invoice date'),
  };
  const grn = await svc.createGRN(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: grn });
});

// Layer 2: a Company-B grnId must 404, not let another company's GRN be verified.
procurementRouter.patch('/grn/:id/verify', requirePermission('grn:verify'), async (req: Request, res: Response) => {
  const existing = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.goodsReceiptNote.findUnique({ where: { id: req.params.id }, select: { companyId: true } }));
  if (!existing || existing.companyId !== req.tenant!.companyId) throw new AppError('GRN not found', 404);
  const grn = await tenantQuery(req.tenant!.companyId, (_tx) => _tx.goodsReceiptNote.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED', verifiedBy: req.user!.userId, verifiedAt: new Date() },
  }));
  res.json({ success: true, data: grn });
});

// PO Approval Workflow
procurementRouter.post('/orders/:id/submit', requirePermission('po:create'), async (req: Request, res: Response) => {
  const po = await svc.submitPOForApproval(req.params.id, req.tenant!, req.user!.userId);
  res.json({ success: true, data: po });
});

procurementRouter.post('/orders/:id/approve', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const canApproveHighValue = hasPermission(req.user!.permissions, 'po:approve_high_value');
  const po = await svc.approvePO(req.params.id, req.tenant!, req.user!.userId, canApproveHighValue, req.body.comments);
  res.json({ success: true, data: po });
});

procurementRouter.post('/orders/:id/reject', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const po = await svc.rejectPO(req.params.id, req.tenant!, req.user!.userId, req.body.comments);
  res.json({ success: true, data: po });
});

procurementRouter.delete('/orders/:id', requirePermission('po:create'), async (req: Request, res: Response) => {
  const perms = new Set(req.user!.permissions);
  const canDeleteApproved = perms.has('*') || perms.has('po:*') || perms.has('po:approve');
  await svc.deletePO(req.params.id, req.tenant!, req.user!.userId, canDeleteApproved);
  res.json({ success: true, message: 'Purchase order deleted' });
});

// Supplier Performance
procurementRouter.get('/suppliers/performance', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.getSuppliersPerformance(req.tenant!) });
});

// Purchase Returns (D3)
procurementRouter.get('/suppliers/:id/returnable-tags', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listReturnableTags(req.tenant!, req.params.id) });
});

// Supplier payments (money out). Recording one is an accounting action, so it rides on journal:create
// (accountant) rather than a new permission; reading them is the same po:view that shows the supplier.
procurementRouter.get('/suppliers/:id/payments', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listSupplierPayments(req.tenant!, req.params.id) });
});

procurementRouter.post('/suppliers/:id/payments', requirePermission('journal:create'), async (req: Request, res: Response) => {
  const payment = await svc.recordSupplierPayment(
    { ...req.body, supplierId: req.params.id, paymentDate: parseDate(req.body.paymentDate, 'Payment date', true) },
    req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: payment });
});

procurementRouter.get('/returns', requirePermission('po:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listPurchaseReturns(req.tenant!, req.query.supplierId as string | undefined) });
});

procurementRouter.post('/returns', requirePermission('po:approve'), async (req: Request, res: Response) => {
  // G2e: issueDebitNote is additive and opt-in — omitted (the existing default), behavior is
  // completely unchanged for every current caller (mirrors sales.router.ts's issueCreditNote flag).
  const { issueDebitNote, ...body } = req.body ?? {};
  const purchaseReturn = await svc.createPurchaseReturn(body, req.tenant!, req.user!.userId, { issueDebitNote: !!issueDebitNote });
  res.status(201).json({ success: true, data: purchaseReturn });
});

// G2e — Debit Notes (purchase-side mirror of Credit Notes; see PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §4/§19).
procurementRouter.get('/debit-notes', requirePermission('debitNote:view'), async (req: Request, res: Response) => {
  const notes = await debitNoteSvc.listDebitNotes(req.tenant!, {
    supplierId: req.query.supplierId as string | undefined,
    grnId: req.query.grnId as string | undefined,
    status: req.query.status as string | undefined,
    from: parseOptionalDate(req.query.from, 'From date'),
    to: parseOptionalDate(req.query.to, 'To date'),
  });
  res.json({ success: true, data: notes });
});

procurementRouter.get('/debit-notes/:id', requirePermission('debitNote:view'), async (req: Request, res: Response) => {
  const note = await debitNoteSvc.getDebitNoteById(req.tenant!, req.params.id);
  const printTemplate = await debitNoteTemplateSvc.resolveDebitNoteTemplate(req.tenant!.companyId);
  res.json({ success: true, data: { ...note, printTemplate } });
});

// Path B — standalone, value-only debit note against a GRN with no physical return.
procurementRouter.post('/debit-notes', requirePermission('debitNote:create'), async (req: Request, res: Response) => {
  const body = { ...req.body, debitNoteDate: parseOptionalDate(req.body?.debitNoteDate, 'Debit note date') };
  const note = await debitNoteSvc.createStandaloneDebitNote(body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: note });
});

// Path A — wraps an existing Purchase Return with no Debit Note yet, a deliberate, separate,
// auditable action taken after the return itself succeeds (mirrors sales.router.ts's own note).
procurementRouter.post('/returns/:returnId/debit-note', requirePermission('debitNote:create'), async (req: Request, res: Response) => {
  const note = await debitNoteSvc.createDebitNoteForExistingReturn(req.params.returnId, req.tenant!, req.user!.userId, { reasonNotes: req.body?.reasonNotes });
  res.status(201).json({ success: true, data: note });
});

// SUPER_ADMIN-only initially — same posture as creditNote:cancel (not granted to any starter role).
procurementRouter.post('/debit-notes/:id/cancel', requirePermission('debitNote:cancel'), async (req: Request, res: Response) => {
  const result = await debitNoteSvc.cancelDebitNote(req.params.id, req.tenant!, req.user!.userId, req.body?.reason);
  res.json({ success: true, data: result });
});

// G2e — Debit Note Templates (mirrors Credit Note Templates)
procurementRouter.get('/debit-note-templates', requirePermission('debitNoteTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await debitNoteTemplateSvc.listDebitNoteTemplates(req.tenant!.companyId) });
});

procurementRouter.get('/debit-note-templates/default-layout', requirePermission('debitNoteTemplate:view'), async (_req: Request, res: Response) => {
  res.json({ success: true, data: debitNoteTemplateSvc.buildDefaultDebitNoteLayout() });
});

procurementRouter.get('/debit-note-templates/:id', requirePermission('debitNoteTemplate:view'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await debitNoteTemplateSvc.getDebitNoteTemplateById(req.tenant!.companyId, req.params.id) });
});

procurementRouter.post('/debit-note-templates', requirePermission('debitNoteTemplate:create'), async (req: Request, res: Response) => {
  const t = await debitNoteTemplateSvc.createDebitNoteTemplate(req.tenant!.companyId, req.body, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});

procurementRouter.put('/debit-note-templates/:id', requirePermission('debitNoteTemplate:edit'), async (req: Request, res: Response) => {
  const t = await debitNoteTemplateSvc.updateDebitNoteTemplate(req.tenant!.companyId, req.params.id, req.body);
  res.json({ success: true, data: t });
});

procurementRouter.post('/debit-note-templates/:id/duplicate', requirePermission('debitNoteTemplate:create'), async (req: Request, res: Response) => {
  const t = await debitNoteTemplateSvc.duplicateDebitNoteTemplate(req.tenant!.companyId, req.params.id, req.user!.userId);
  res.status(201).json({ success: true, data: t });
});
