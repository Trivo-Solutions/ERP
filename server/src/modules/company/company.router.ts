import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import * as companyService from './company.service';

export const companyRouter = Router();
companyRouter.use(authenticate, resolveTenantContext);

const grantSchema = z.object({ branchId: z.string().cuid() });

// This company's active branches, for the invite/edit-member branch picker.
companyRouter.get(
  '/branches', requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    res.json({ success: true, data: await companyService.listBranches(req.tenant!.companyId) });
  }
);

// The specific branches a member currently holds (via explicit grants, not the allBranches flag).
companyRouter.get(
  '/users/:companyUserId/branch-access', requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    const branchIds = await companyService.listBranchAccess(req.tenant!, req.params.companyUserId);
    res.json({ success: true, data: branchIds });
  }
);

// Branch access for a member of the caller's own company. Both the membership and the branch must
// belong to that company (see company.service.ts); the company itself is never taken from the body.
companyRouter.post(
  '/users/:companyUserId/branch-access', rejectClientTenantSelectors,
  requirePermission('user:manage'), validate(grantSchema),
  async (req: Request, res: Response) => {
    const grant = await companyService.grantBranchAccess(req.tenant!, req.params.companyUserId, req.body.branchId);
    res.status(201).json({ success: true, data: grant });
  }
);

companyRouter.delete(
  '/users/:companyUserId/branch-access/:branchId',
  requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    await companyService.revokeBranchAccess(req.tenant!, req.params.companyUserId, req.params.branchId);
    res.json({ success: true, message: 'Branch access revoked' });
  }
);

// G1 Part K — GST Registration admin.
const gstRegistrationSchema = z.object({
  gstin: z.string().length(15), legalName: z.string().min(1), tradeName: z.string().optional().nullable(),
  stateCode: z.string().min(1).max(2), address: z.string().optional().nullable(), city: z.string().optional().nullable(),
  district: z.string().optional().nullable(), pincode: z.string().optional().nullable(), country: z.string().optional(),
  isPrimary: z.boolean().optional(), isActive: z.boolean().optional(),
});

companyRouter.get(
  '/gst-registrations', requirePermission('gst:registration_view'),
  async (req: Request, res: Response) => {
    res.json({ success: true, data: await companyService.listGstRegistrations(req.tenant!.companyId) });
  }
);

companyRouter.post(
  '/gst-registrations', rejectClientTenantSelectors,
  requirePermission('gst:registration_create'), validate(gstRegistrationSchema),
  async (req: Request, res: Response) => {
    const reg = await companyService.createGstRegistration(req.tenant!, req.body);
    res.status(201).json({ success: true, data: reg });
  }
);

companyRouter.put(
  '/gst-registrations/:id', rejectClientTenantSelectors,
  requirePermission('gst:registration_edit'), validate(gstRegistrationSchema.partial()),
  async (req: Request, res: Response) => {
    const reg = await companyService.updateGstRegistration(req.tenant!, req.params.id, req.body);
    res.json({ success: true, data: reg });
  }
);

// A registration's active/primary status is a distinct, higher-stakes action than an ordinary
// field edit (it changes which registration new invoices are issued under) — gated on
// gst:registration_manage, following the same "manage" precedent as repair:manage/karigar:issue.
companyRouter.patch(
  '/gst-registrations/:id/status', rejectClientTenantSelectors,
  requirePermission('gst:registration_manage'), validate(z.object({ isActive: z.boolean().optional(), isPrimary: z.boolean().optional() })),
  async (req: Request, res: Response) => {
    const reg = await companyService.updateGstRegistration(req.tenant!, req.params.id, req.body);
    res.json({ success: true, data: reg });
  }
);
