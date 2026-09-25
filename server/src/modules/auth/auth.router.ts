import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { rejectClientTenantSelectors, resolveTenantContext } from '../../middleware/tenant';
import * as authService from './auth.service';

export const authRouter = Router();

// Brute-force protection on the endpoints that take a credential or a secret token. Applied per
// route because the app-level limiter that used to guard '/api/auth' never matched the real mount
// path ('/api/v1/auth'), so login was effectively unthrottled. Skipped under test only, where one
// process legitimately signs in many times in seconds.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, error: 'Too many attempts, please try again later' },
}) as any;

const loginSchema = z.object({
  companyCode: z.string().min(1),
  identifier: z.string().min(1), // email OR company-scoped username
  password: z.string().min(1),
});

const inviteSchema = z.object({
  email: z.string().email(),
  roleId: z.string().cuid(),
  allBranches: z.boolean().optional(),
  branchIds: z.array(z.string().cuid()).optional(),
  username: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  department: z.string().optional(),
  phone: z.string().optional(),
});

const acceptSchema = z.object({
  token: z.string().min(20),
  name: z.string().min(2),
  password: z.string().min(8),
});

const updateMemberSchema = z.object({
  employeeId: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  roleId: z.string().cuid().optional(),
  allBranches: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

// Public — company is resolved from the supplied company code here, and ONLY here; every
// subsequent request derives it from the issued token instead.
authRouter.post('/login', credentialLimiter, rejectClientTenantSelectors, validate(loginSchema), async (req: Request, res: Response) => {
  const { companyCode, identifier, password } = req.body;
  const result = await authService.login(companyCode, identifier, password);
  res.json({ success: true, data: result });
});

authRouter.post('/refresh', rejectClientTenantSelectors, async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: 'Refresh token required' });
  const result = await authService.refreshTokens(refreshToken);
  res.json({ success: true, data: result });
});

authRouter.get('/me', authenticate, resolveTenantContext, async (req: Request, res: Response) => {
  const me = await authService.getMyMembership(req.tenant!.companyId, req.tenant!.companyUserId);
  res.json({ success: true, data: me });
});

authRouter.post('/change-password', credentialLimiter, authenticate, async (req: Request, res: Response) => {
  const { current, next } = req.body;
  await authService.changePassword(req.user!.userId, current, next);
  res.json({ success: true, message: 'Password changed' });
});

// ─── Members of the caller's own company ──────────────────────────────────────

authRouter.get(
  '/users', authenticate, resolveTenantContext, requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    const users = await authService.listCompanyUsers(req.tenant!.companyId);
    res.json({ success: true, data: users });
  }
);

// Edit a member's company-specific details (employee id, department, phone, username, role,
// branch flag, active flag). The membership must belong to the caller's company.
authRouter.patch(
  '/users/:companyUserId', authenticate, resolveTenantContext, rejectClientTenantSelectors,
  requirePermission('user:manage'), validate(updateMemberSchema),
  async (req: Request, res: Response) => {
    const member = await authService.updateCompanyUser(req.tenant!, req.params.companyUserId, req.body);
    res.json({ success: true, data: member });
  }
);

// ─── Invitations ──────────────────────────────────────────────────────────────
// There is deliberately NO "create a user with this email" endpoint any more: a membership is only
// ever created when the recipient accepts an invitation (or by the seed). The old
// POST /auth/users silently attached whichever global User already owned the email.

authRouter.post(
  '/invitations', authenticate, resolveTenantContext, rejectClientTenantSelectors,
  requirePermission('user:manage'), validate(inviteSchema),
  async (req: Request, res: Response) => {
    const invitation = await authService.createInvitation(req.tenant!, req.body);
    res.status(201).json({ success: true, data: invitation });
  }
);

authRouter.get(
  '/invitations', authenticate, resolveTenantContext, requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    const data = await authService.listInvitations(req.tenant!.companyId);
    res.json({ success: true, data });
  }
);

authRouter.delete(
  '/invitations/:id', authenticate, resolveTenantContext, requirePermission('user:manage'),
  async (req: Request, res: Response) => {
    await authService.revokeInvitation(req.tenant!, req.params.id);
    res.json({ success: true, message: 'Invitation revoked' });
  }
);

// PUBLIC. The one-time token is the only credential. Every failure returns the same generic error
// (see acceptInvitation) so this cannot be used to discover whether an email has an account.
authRouter.post(
  '/invitations/accept', credentialLimiter, rejectClientTenantSelectors, validate(acceptSchema),
  async (req: Request, res: Response) => {
    const result = await authService.acceptInvitation(req.body);
    res.status(201).json({ success: true, data: result });
  }
);
