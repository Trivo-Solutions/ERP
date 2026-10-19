import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { resolveTenantContext, rejectClientTenantSelectors } from '../../middleware/tenant';
import * as svc from './salesEmployees.service';

export const salesEmployeesRouter = Router();
salesEmployeesRouter.use(authenticate, resolveTenantContext, rejectClientTenantSelectors);

// Issuing credentials is throttled like every other credential endpoint (skipped under test only).
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: env.AUTH_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, error: 'Too many attempts, please try again later' },
}) as any;

const text = (max: number) => z.string().trim().max(max);
const createSchema = z.object({
  name: text(120).min(2), email: z.string().trim().email().max(200),
  employeeId: text(40).nullable().optional(), phone: text(20).nullable().optional(), designation: text(80).nullable().optional(),
  roleId: z.string().cuid(), allBranches: z.boolean().optional(), branchIds: z.array(z.string().cuid()).max(200).optional(),
}).strict();
const updateSchema = z.object({
  name: text(120).min(2).optional(), employeeId: text(40).nullable().optional(), phone: text(20).nullable().optional(),
  designation: text(80).nullable().optional(), roleId: z.string().cuid().optional(), allBranches: z.boolean().optional(),
  branchIds: z.array(z.string().cuid()).max(200).optional(), isActive: z.boolean().optional(),
}).strict();

// All of it rides user:manage (the permission that already guards Users & Invitations) - no parallel permission system.
// Role escalation and "someone more privileged than me" are enforced in the service, not just here.
salesEmployeesRouter.get('/', requirePermission('user:manage'), async (req: Request, res: Response) => {
  const status = ['active', 'inactive', 'all'].includes(String(req.query.status)) ? (req.query.status as 'active' | 'inactive' | 'all') : 'all';
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  res.json({ success: true, data: await svc.listSalesEmployees(req.tenant!, { search, status }) });
});

// Existing company members who are not yet sales employees (the picker for "Add existing member").
salesEmployeesRouter.get('/members', requirePermission('user:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.listMarkableMembers(req.tenant!) });
});

salesEmployeesRouter.post('/existing', requirePermission('user:manage'),
  validate(z.object({ companyUserId: z.string().cuid(), designation: text(80).nullable().optional() }).strict()),
  async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await svc.markExistingMemberAsSalesEmployee(req.tenant!, req.body.companyUserId, req.body.designation) });
  });

// Removes the sales-employee designation only. The login, role and branch access are untouched.
salesEmployeesRouter.post('/:id/unmark', requirePermission('user:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.unmarkSalesEmployee(req.tenant!, req.params.id) });
});

salesEmployeesRouter.post('/', credentialLimiter, requirePermission('user:manage'), validate(createSchema), async (req: Request, res: Response) => {
  res.status(201).json({ success: true, data: await svc.createSalesEmployee(req.tenant!, req.body) });
});

salesEmployeesRouter.patch('/:id', requirePermission('user:manage'), validate(updateSchema), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.updateSalesEmployee(req.tenant!, req.params.id, req.body) });
});

salesEmployeesRouter.post('/:id/temporary-password', credentialLimiter, requirePermission('user:manage'), async (req: Request, res: Response) => {
  res.json({ success: true, data: await svc.issueTemporaryPassword(req.tenant!, req.params.id) });
});
