import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenantContext } from '../../middleware/tenant';
import { AppError } from '../../middleware/error';
import { prisma } from '../../config/database';
import * as svc from './procurement.service';
import { tenantQuery } from '../../shared/tenantContext';
import { parseDate, parseOptionalDate } from '../../shared/parseDate';

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

// GRN
procurementRouter.get('/grn', requirePermission('grn:create'), async (req: Request, res: Response) => {
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
          purchaseLot: { select: { id: true, pieces: true, status: true } },
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
  const po = await svc.approvePO(req.params.id, req.tenant!, req.user!.userId, req.user!.roleName, req.body.comments);
  res.json({ success: true, data: po });
});

procurementRouter.post('/orders/:id/reject', requirePermission('po:approve'), async (req: Request, res: Response) => {
  const po = await svc.rejectPO(req.params.id, req.tenant!, req.user!.userId, req.body.comments);
  res.json({ success: true, data: po });
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
  const purchaseReturn = await svc.createPurchaseReturn(req.body, req.tenant!, req.user!.userId);
  res.status(201).json({ success: true, data: purchaseReturn });
});
