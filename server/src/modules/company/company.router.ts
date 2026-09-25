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
